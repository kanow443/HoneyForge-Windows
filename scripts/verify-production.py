"""Verify two local HTTPS installations and an isolated database restore; no secrets in evidence."""

import fcntl
import hashlib
import json
import os
import ssl
import subprocess
import time
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import httpx
from acceptance_transport import enrolled_sync

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / ".runtime/production-acceptance"


def compose(stack, *args, data=None):
    return subprocess.run(
        [
            "docker",
            "compose",
            "--env-file",
            str(PRIVATE / f"stack-{stack}.env"),
            "-p",
            f"hf-prod-acceptance-{stack}",
            "-f",
            str(ROOT / "compose.production.yml"),
            *args,
        ],
        input=data,
        capture_output=True,
        check=True,
    ).stdout


def client(stack):
    environment = dict(
        line.split("=", 1)
        for line in (PRIVATE / f"stack-{stack}.env").read_text().splitlines()
        if line and not line.startswith("#")
    )
    ca = PRIVATE / f"ca-{stack}.crt"
    ca.write_bytes(
        compose(stack, "exec", "-T", "gateway", "cat", "/data/caddy/pki/authorities/local/root.crt")
    )
    ca.chmod(0o600)
    context = ssl.create_default_context(cafile=str(ca))
    connection = httpx.Client(
        base_url=environment["HF_PUBLIC_ORIGIN"], verify=context, trust_env=False, timeout=15
    )
    connection.headers["Origin"] = environment["HF_PUBLIC_ORIGIN"]
    login = connection.post(
        "/api/v1/auth/login",
        json={"username": environment["HF_ADMIN_USERNAME"], "password": environment["HF_ADMIN_PASSWORD"]},
    )
    login.raise_for_status()
    assert all(
        "Secure" in value and "SameSite=strict" in value for value in login.headers.get_list("set-cookie")
    )
    connection.headers["X-CSRF-Token"] = login.json()["csrf_token"]
    return connection


def main():
    lock = (PRIVATE / "centre-acceptance.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    evidence = {
        "at": datetime.now(UTC).isoformat(),
        "topology": "Two local Docker Compose stacks; HTTPS with separate trusted local CAs. No external cloud SLA.",
        "checks": {},
    }
    with closing(client("a")) as a, closing(client("b")) as b:
        assert a.get("/health/ready").status_code == b.get("/health/ready").status_code == 200
        page = a.get("/traps/new")
        assert page.status_code == 200 and '<div id="root">' in page.text
        assert "frame-ancestors 'none'" in page.headers["content-security-policy"]
        name = "HTTPS restore acceptance " + uuid4().hex
        response = a.post("/api/v1/profiles", json={"name": name, "config": {"adapter": "http"}})
        response.raise_for_status()
        profile = response.json()
        assert b.get("/api/v1/profiles/" + profile["id"]).status_code == 404
        # Distinct DB-backed sessions and credentials, even if IDs are supplied directly.
        own_cookie = b.cookies.get("hf_session")
        b.cookies.set("hf_session", a.cookies.get("hf_session"), domain="localhost.local", path="/")
        assert b.get("/api/v1/auth/me").status_code == 401
        b.cookies.set("hf_session", own_cookie, domain="localhost.local", path="/")
        assert b.get("/api/v1/auth/me").status_code == 200
        key = a.post(
            "/api/v1/integration-tokens", json={"name": "Isolation acceptance", "expires_days": 1}
        ).json()
        try:
            assert (
                b.get(
                    "/integration/v1/events", headers={"Authorization": "Bearer " + key["token"]}
                ).status_code
                == 401
            )
        finally:
            a.post("/api/v1/integration-tokens/" + key["integration"]["id"] + "/revoke").raise_for_status()
        token = a.post("/api/v1/hosts/enrollment-tokens").json()["token"]
        for stack, port in [("a", 19444), ("b", 20444)]:
            (PRIVATE / ("sync-ca-" + stack + ".crt")).write_bytes(
                compose(
                    stack, "exec", "-T", "management", "cat", "/data/caddy/pki/authorities/local/root.crt"
                )
            )
        sync, enrolled = enrolled_sync(
            "https://localhost:19444",
            PRIVATE / "sync-ca-a.crt",
            token,
            "API-only isolation fixture; no running agent",
            "192.0.2.44",
            PRIVATE / ("isolation-identity-" + uuid4().hex),
        )
        other = httpx.Client(
            base_url="https://localhost:20444",
            verify=ssl.create_default_context(cafile=PRIVATE / "sync-ca-b.crt"),
            trust_env=False,
        )
        assert (
            other.get(
                "/assets/sync/v1/runtimes", headers={"Authorization": "Bearer " + enrolled["key"]}
            ).status_code
            == 401
        )
        other.close()
        sync.close()
        a.post("/api/v1/hosts/" + enrolled["host_id"] + "/revoke").raise_for_status()
        start = time.monotonic()
        compose("a", "restart", "api")
        for _ in range(100):
            try:
                if a.get("/health/ready").status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            time.sleep(0.2)
        else:
            raise AssertionError("API did not recover after restart")
        assert a.get("/api/v1/profiles/" + profile["id"]).json()["name"] == name
        recovery = round(time.monotonic() - start, 3)
        dump = compose(
            "a", "exec", "-T", "postgres", "pg_dump", "-U", "honeyforge", "-d", "honeyforge", "-Fc"
        )
        backup = PRIVATE / ("restore-proof-" + uuid4().hex + ".dump")
        with os.fdopen(os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as file:
            file.write(dump)
        restore_name = "verify_restore_" + uuid4().hex
        compose("a", "exec", "-T", "postgres", "createdb", "-U", "honeyforge", restore_name)
        started = time.monotonic()
        try:
            compose(
                "a",
                "exec",
                "-T",
                "postgres",
                "pg_restore",
                "-U",
                "honeyforge",
                "--exit-on-error",
                "-d",
                restore_name,
                data=dump,
            )
            query = (
                "SELECT count(*) FROM profiles WHERE id='"
                + profile["id"]
                + "'; SELECT version_num FROM alembic_version;"
            )
            restored = (
                compose(
                    "a",
                    "exec",
                    "-T",
                    "postgres",
                    "psql",
                    "-U",
                    "honeyforge",
                    "-d",
                    restore_name,
                    "-Atc",
                    query,
                )
                .decode()
                .splitlines()
            )
            assert restored == ["1", "012"]
        finally:
            compose("a", "exec", "-T", "postgres", "dropdb", "-U", "honeyforge", restore_name)
        evidence["checks"] = {
            "tls_certificate_verified": True,
            "secure_same_site_cookies": True,
            "spa_deep_link_and_headers": True,
            "cross_stack_profile_denied": True,
            "cross_stack_cookie_denied": True,
            "cross_stack_agent_key_denied": True,
            "cross_stack_integration_key_denied": True,
            "api_restart_preserved_profile_and_session": True,
            "api_restart_recovery_seconds": recovery,
            "database_restore_in_separate_database": True,
            "restored_schema": restored[-1],
            "restore_seconds": round(time.monotonic() - started, 3),
            "backup_sha256": hashlib.sha256(dump).hexdigest(),
            "backup_bytes": len(dump),
            "binary_volume_restore": "not part of this database-only check",
        }
        for connection in (a, b):
            connection.post("/api/v1/auth/logout").raise_for_status()
    target = ROOT / "docs/evidence/backend/production-local.json"
    target.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(evidence["checks"], ensure_ascii=False))


if __name__ == "__main__":
    main()
