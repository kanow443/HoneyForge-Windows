"""Actual URL/file markers and protocol persona; fixture-free live bonus acceptance."""

import json
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import httpx
import paramiko
import stix2

from honeyforge.infrastructure.settings import settings


def wait(predicate):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.25)
    raise AssertionError("Live bonus acceptance timed out")


def main():
    proof = {"at": datetime.now(UTC).isoformat(), "checks": {}, "run_id": uuid4().hex[:8]}
    foundation = json.loads(Path("docs/evidence/backend/foundation.json").read_text())
    deployments = foundation["deployments"]
    with httpx.Client(base_url="http://127.0.0.1:8100", trust_env=False, timeout=15) as api:
        login = api.post(
            "/api/v1/auth/login",
            json={"username": settings.admin_username, "password": settings.admin_password},
        )
        login.raise_for_status()
        api.headers["X-CSRF-Token"] = login.json()["csrf_token"]
        tokens = {}
        for adapter, kind, path in [("http", "url", None), ("cowrie", "file", "/home/root/backup.key")]:
            trap = next(d for d in deployments if d["adapter"] == adapter)
            trap = api.get("/api/v1/deployments/" + trap["id"]).json()
            issued = api.post(
                "/api/v1/honeytokens",
                json={
                    "profile_version_id": trap["profile_version_id"],
                    "kind": kind,
                    "name": "Live marker " + proof["run_id"],
                    "file_path": path,
                },
            )
            issued.raise_for_status()
            token = issued.json()
            assert not token["bindings"]
            api.post("/api/v1/deployments/" + trap["id"] + "/redeploy", json={}).raise_for_status()
            wait(lambda: api.get("/api/v1/deployments/" + trap["id"]).json()["state"] == "running")
            token = next(t for t in api.get("/api/v1/honeytokens").json() if t["id"] == token["id"])
            binding = token["bindings"][0]
            tokens[adapter] = (trap, token, binding)
        http_trap, http_token, http_binding = tokens["http"]
        url = "http://" + http_trap["endpoint"] + http_binding["resource_path"]
        response = httpx.get(url, trust_env=False)
        assert (
            response.status_code == 200
            and ("BACKUP_ACCESS_KEY=" + http_binding["public_value"]) in response.text
        )
        wait(
            lambda: (
                next(t for t in api.get("/api/v1/honeytokens").json() if t["id"] == http_token["id"])[
                    "bindings"
                ][0]["use_count"]
                == 1
            )
        )
        ssh_trap, ssh_token, ssh_binding = tokens["cowrie"]
        address, port = ssh_trap["endpoint"].rsplit(":", 1)
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(
            address,
            port=int(port),
            username="root",
            password="Honeypot-Demo-7826",
            look_for_keys=False,
            allow_agent=False,
            timeout=10,
        )
        banner = client.get_transport().remote_version
        shell = client.invoke_shell()

        def command(text):
            while shell.recv_ready():
                shell.recv(65536)
            shell.send(text + "\n")
            end = time.monotonic() + 2
            data = b""
            while time.monotonic() < end:
                if shell.recv_ready():
                    data += shell.recv(65536)
                else:
                    time.sleep(0.05)
            return data.decode(errors="replace")

        marker_output = command("cat " + ssh_binding["resource_path"])
        assert "BACKUP_ACCESS_KEY=" + ssh_binding["public_value"] in marker_output
        uname = command("uname -a")
        os_release = command("cat /etc/os-release")
        missing = command("cat /home/root/does-not-exist-" + proof["run_id"])
        assert "OpenSSH_8.9p1 Ubuntu" in banner and "5.15.0-121-generic" in uname and "#131-Ubuntu" in uname
        assert "Ubuntu 22.04.5 LTS" in os_release and "No such file or directory" in missing
        client.close()
        wait(
            lambda: (
                next(t for t in api.get("/api/v1/honeytokens").json() if t["id"] == ssh_token["id"])[
                    "bindings"
                ][0]["use_count"]
                >= 1
            )
        )
        api.post("/api/v1/honeytokens/" + http_token["id"] + "/revoke").raise_for_status()
        revoked = next(t for t in api.get("/api/v1/honeytokens").json() if t["id"] == http_token["id"])
        count = revoked["bindings"][0]["use_count"]
        assert (
            httpx.get(url, trust_env=False).status_code == 200
        )  # Stale bait deliberately stays until explicit redeploy.
        time.sleep(2)
        assert (
            next(t for t in api.get("/api/v1/honeytokens").json() if t["id"] == http_token["id"])["bindings"][
                0
            ]["use_count"]
            == count
        )
        api.post("/api/v1/deployments/" + http_trap["id"] + "/redeploy", json={}).raise_for_status()
        wait(lambda: api.get("/api/v1/deployments/" + http_trap["id"]).json()["state"] == "running")
        assert httpx.get(url, trust_env=False).status_code == 404
        exported = api.post(
            "/api/v1/ioc-exports", json={"format": "stix", "filters": {"deployment_id": ssh_trap["id"]}}
        )
        exported.raise_for_status()
        parsed = stix2.parse(exported.json()["content"], allow_custom=True)
        assert any(o.type == "observed-data" for o in parsed.objects)
        geo = api.get("/api/v1/geo-sources").json()
        assert (
            geo["city_database"]["status"] == "unavailable" and geo["asn_database"]["status"] == "unavailable"
        )
        assert all(
            s["status"] == "unavailable" for s in geo["sources"] if s["source_ip"].startswith("192.168.")
        )
        proof["checks"] = {
            "real_http_unique_url": True,
            "real_ssh_file_marker_output": True,
            "marker_bound_to_deployment_generation": True,
            "revoke_disables_attribution_until_explicit_redeploy_removes_bytes": True,
            "real_ubuntu_banner_kernel_release_and_error": True,
            "real_observed_data_export_parsed_stix21": True,
            "missing_production_mmdb_and_private_sources_unavailable": True,
        }
        proof["markers"] = [
            {"id": t["id"], "deployment_id": d["id"], "generation": b["generation"], "kind": t["kind"]}
            for d, t, b in tokens.values()
        ]
        proof["persona"] = {
            "banner": banner,
            "uname": uname,
            "os_release": os_release,
            "missing_file_error": missing,
        }
        proof["stix_observed_count"] = len([o for o in parsed.objects if o.type == "observed-data"])
    Path("docs/evidence/backend/bonuses.json").write_text(
        json.dumps(proof, ensure_ascii=False, indent=2) + "\n"
    )
    print(json.dumps(proof["checks"]), flush=True)


if __name__ == "__main__":
    main()
