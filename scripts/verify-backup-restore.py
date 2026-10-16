"""Independent restore of a labelled API fixture, binary bytes and centre envelope keys."""
import base64
import fcntl
import hashlib
import json
import ssl
import subprocess
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import httpx
from acceptance_transport import enrolled_sync
from cryptography import x509
from cryptography.hazmat.primitives import hashes

from honeyforge.agent.identity import AgentIdentity
from honeyforge.infrastructure.settings import Settings
from honeyforge.sensors.sealed_capture import seal

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / ".runtime/production-acceptance"


def command(*parts):
    return subprocess.run(parts, check=True, capture_output=True).stdout


def client(port, env, ca):
    config = Settings(_env_file=env)
    connection = httpx.Client(base_url=f"https://localhost:{port}", verify=ssl.create_default_context(cafile=ca), trust_env=False, timeout=20)
    response = connection.post("/api/v1/auth/login", json={"username": config.admin_username, "password": config.admin_password})
    response.raise_for_status()
    connection.headers["X-CSRF-Token"] = response.json()["csrf_token"]
    return connection


def main():
    lock = (PRIVATE / "centre-acceptance.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    for previous in PRIVATE.glob("restore-????????.env"):
        previous_project = "hf-restore-" + previous.stem.removeprefix("restore-")
        command("docker", "compose", "--env-file", str(previous), "-p", previous_project,
            "-f", str(ROOT / "compose.production.yml"), "down")
    suffix = uuid4().hex[:8]
    source_env = PRIVATE / "stack-a.env"
    target_env = PRIVATE / ("restore-" + suffix + ".env")
    target_env.write_text(source_env.read_text().replace("19443", "21443").replace("19080", "21080").replace("19444", "21444"))
    target_env.chmod(0o600)
    project = "hf-restore-" + suffix
    for service in ["api", "gateway"]:
        command("docker", "tag", "hf-prod-acceptance-a-" + service, project + "-" + service)
    compose = ["docker", "compose", "--env-file", str(target_env), "-p", project, "-f", str(ROOT / "compose.production.yml")]
    command(*compose, "up", "-d", "--no-build", "--wait")
    ca = PRIVATE / ("restore-" + suffix + "-ca.crt")
    command("docker", "cp", project + "-gateway-1:/data/caddy/pki/authorities/local/root.crt", str(ca))
    command("docker", "cp", "hf-prod-acceptance-a-management-1:/data/caddy/pki/authorities/local/root.crt", str(PRIVATE / "ca-sync-a.crt"))
    proof = {"at": datetime.now(UTC).isoformat(), "fixture": "controlled API fixture; no simulated attack claimed", "checks": {}}
    with closing(client(19443, source_env, PRIVATE / "ca-a.crt")) as api:
        token = api.post("/api/v1/hosts/enrollment-tokens").json()["token"]
        sync, sensor = enrolled_sync('https://localhost:19444', PRIVATE / 'ca-sync-a.crt', token,
            'Backup fixture ' + suffix, '192.0.2.77', PRIVATE / ('fixture-identity-' + suffix))
        profile = api.post("/api/v1/profiles", json={"name": "Restore fixture " + suffix, "config": {"schema_version": 2, "adapter": "http"}}).json()
        deployment = api.post("/api/v1/deployments", json={"name": "Backup fixture", "host_id": sensor["host_id"],
            "profile_version_id": profile["versions"][0]["id"], "port": 18077}, headers={"Idempotency-Key": "restore-" + suffix}).json()
        public = sync.get("/runtimes").json()[0]["capture_key"]
        event = {"event_id": str(uuid4()), "deployment_id": deployment["id"], "generation": deployment["runtime_generation"],
            "event_type": "http.login", "source_ip": "203.0.113.77", "source_session_id": "restore-fixture-" + suffix,
            "observed_at": datetime.now(UTC).isoformat(), "payload": {"capture": "controlled-backup-fixture"}, "provenance": "lab-fixture"}
        context = {k: event[k] for k in ["event_id", "deployment_id", "generation", "event_type", "source_session_id"]}
        context.update(host_id=sensor["host_id"], capture_id=str(uuid4()))
        sensitive = "RestoreSynthetic-" + suffix
        event["private_capture"] = seal(public["public_key"], public["key_id"], context, {"password": sensitive})
        ingested = sync.post("/events/batch", json={"events": [event]})
        assert ingested.json()["inserted"] == 1
        event_id = api.get("/api/v1/events", params={"deployment_id": deployment["id"]}).json()["items"][0]["id"]
        content = b"SAFE CONSISTENT RESTORE FIXTURE\n" + suffix.encode()
        sha = hashlib.sha256(content).hexdigest()
        stamp = datetime.now(UTC).isoformat()
        artifact_id = str(uuid4())
        manifest = {"id": artifact_id, "deployment_id": deployment["id"], "generation": deployment["runtime_generation"],
            "source_session_id": event["source_session_id"], "kind": "file", "size_bytes": len(content), "sha256": sha,
            "started_at": stamp, "ended_at": stamp, "details": {"capture": "controlled-backup-fixture"}}
        sync.post("/artifacts", json=manifest).raise_for_status()
        assert sync.post(f"/artifacts/{artifact_id}/chunks", json={"offset": 0, "data_base64": base64.b64encode(content).decode()}).json()["state"] == "available"
        api.post("/api/v1/hosts/" + sensor["host_id"] + "/revoke").raise_for_status()
        sync.close()
    backup = PRIVATE / ("full-backup-" + suffix)
    command("uv", "run", "python", "scripts/backup-production.py", "--env-file", str(source_env), "--project", "hf-prod-acceptance-a", "--output", str(backup))
    command("uv", "run", "python", "scripts/restore-production.py", "--env-file", str(target_env), "--project", project, "--backup", str(backup))
    with closing(client(21443, source_env, ca)) as restored:
        page = restored.get("/api/v1/events", params={"deployment_id": deployment["id"]})
        assert page.json()["items"][0]["id"] == event_id
        assert sensitive.encode() not in page.content
        capture = restored.post(f"/api/v1/events/{event_id}/private-capture")
        capture.raise_for_status()
        assert capture.json()["content"]["password"] == sensitive
        binary = restored.get(f"/api/v1/artifacts/{artifact_id}/download")
        binary.raise_for_status()
        assert binary.content == content and hashlib.sha256(binary.content).hexdigest() == sha
        target_sync_ca = PRIVATE / ("restore-" + suffix + "-sync-ca.crt")
        command("docker", "cp", project + "-management-1:/data/caddy/pki/authorities/local/root.crt", str(target_sync_ca))
        token = restored.post("/api/v1/hosts/enrollment-tokens").json()["token"]
        restored_identity = PRIVATE / ("restored-identity-" + suffix)
        fresh_sync, fresh_sensor = enrolled_sync("https://localhost:21444", target_sync_ca, token,
            "Restored centre CA verification", "192.0.2.78", restored_identity)
        source_pair = AgentIdentity(PRIVATE / ("fixture-identity-" + suffix)).current()
        target_pair = AgentIdentity(restored_identity).current()
        original_ca = x509.load_pem_x509_certificate(source_pair[0].parent.joinpath("authority.pem").read_bytes())
        restored_ca = x509.load_pem_x509_certificate(target_pair[0].parent.joinpath("authority.pem").read_bytes())
        assert original_ca.fingerprint(hashes.SHA256()) == restored_ca.fingerprint(hashes.SHA256())
        x509.load_pem_x509_certificate(target_pair[0].read_bytes()).verify_directly_issued_by(original_ca)
        assert fresh_sync.get("/runtimes").status_code == 200
        restored.post("/api/v1/hosts/" + fresh_sensor["host_id"] + "/revoke").raise_for_status()
        fresh_sync.close()
        proof["checks"] = {"independent_database_restore": True, "independent_binary_volume_restore": True,
            "centre_private_key_restore_and_actual_decryption": True, "no_plaintext_in_general_api": True,
            "source_agent_identity_revoked_before_copy": True,
            "original_agent_ca_restored": True, "restored_gateway_actual_mtls_and_new_issuance": True}
        proof.update(event_id=event_id, artifact_id=artifact_id, sha256=sha, target_project=project,
            backup_format="honeyforge-backup-v1", schema=json.loads((backup / "manifest.json").read_text())["schema"])
    command(*compose, "down")
    # Preserve private volumes for inspection, release disposable containers and networks.
    Path("docs/evidence/backend/backup-restore.json").write_text(json.dumps(proof, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(proof, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
