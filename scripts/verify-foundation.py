"""Real Low/Medium, sealed observations, SFTP and strict management TLS acceptance."""
import base64
import hashlib
import json
import socket
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import httpx
import paramiko

from honeyforge.infrastructure.settings import settings

ORB = "/Applications/OrbStack.app/Contents/MacOS/bin/orbctl"


def remote(*command):
    return subprocess.check_output([ORB, "run", "-m", "honeyforge-sensor", "-u", "root", *command])


def wait(predicate, seconds=60):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.25)
    raise AssertionError("Real acceptance condition timed out")


def main():
    run_id = uuid4().hex[:8]
    evidence = {"at": datetime.now(UTC).isoformat(), "run_id": run_id, "checks": {}, "deployments": []}
    with httpx.Client(base_url="http://127.0.0.1:8100", timeout=15, trust_env=False) as api:
        login = api.post("/api/v1/auth/login", json={"username": settings.admin_username, "password": settings.admin_password})
        login.raise_for_status()
        api.headers["X-CSRF-Token"] = login.json()["csrf_token"]
        host = wait(lambda: next((h for h in api.get("/api/v1/hosts").json()
            if h["address"] == "192.168.139.142" and "tcp-banner" in h["capabilities"] and h["status"] in {"online", "degraded"}), None))
        scenarios = [("tcp-banner", 18223, {"banner": "SSH-2.0-OpenSSH_8.9p1", "response": "Protocol mismatch."}),
            ("http", 18280, {}), ("cowrie", 18222, {"download_mode": "fixture"})]
        for previous in api.get("/api/v1/deployments").json():
            if previous["host_id"] == host["id"] and previous["name"].startswith("Acceptance ") and previous["port"] in {18223, 18280, 18222}:
                response = api.post(f'/api/v1/deployments/{previous["id"]}/stop')
                response.raise_for_status()
                wait(lambda: api.get(f'/api/v1/deployments/{previous["id"]}').json()["state"] == "stopped")
        for adapter, port, extra in scenarios:
            profile = api.post("/api/v1/profiles", json={"name": f"Acceptance {adapter} {run_id}", "config": {
                "schema_version": 2, "adapter": adapter, "recommended_port": port,
                "decoy_accounts": [{"username": "root", "password": "Honeypot-Demo-7826"}], **extra}})
            profile.raise_for_status()
            version = profile.json()["versions"][0]
            deployment = api.post("/api/v1/deployments", headers={"Idempotency-Key": f"foundation-{run_id}-{adapter}"},
                json={"name": f"Acceptance {adapter} {run_id}", "host_id": host["id"], "profile_version_id": version["id"], "port": port})
            deployment.raise_for_status()
            item = deployment.json()
            item = wait(lambda: (d if (d := api.get(f'/api/v1/deployments/{item["id"]}').json())["state"] == "running" else None))
            evidence["deployments"].append({k: item[k] for k in ["id", "adapter", "runtime_generation", "interaction_level", "endpoint"]})
        low, http, ssh = evidence["deployments"]
        with socket.create_connection((host["address"], 18223), timeout=10) as connection:
            assert connection.recv(256).startswith(b"SSH-2.0-")
            connection.sendall(b"A" * 2100)
            assert b"Protocol mismatch" in connection.recv(256)
        low_events = wait(lambda: api.get("/api/v1/events", params={"deployment_id": low["id"], "event_type": "tcp.request"}).json()["items"])
        assert low["interaction_level"] == "low"
        assert len(base64.b64decode(low_events[0]["payload"]["data_base64"])) == 2048
        assert low_events[0]["payload"]["truncated"] is True
        evidence["checks"]["low_real_banner_bounded_input"] = True
        submitted_http = "SubmittedOnly-Http-" + run_id
        response = httpx.post(f'http://{host["address"]}:18280/login', data={"username": "root", "password": submitted_http}, trust_env=False)
        assert response.status_code == 401
        http_event = wait(lambda: api.get("/api/v1/events", params={"deployment_id": http["id"], "event_type": "http.login"}).json()["items"])[0]
        capture = api.post(f'/api/v1/events/{http_event["id"]}/private-capture')
        capture.raise_for_status()
        assert capture.json()["content"]["password"] == submitted_http
        assert submitted_http.encode() in base64.b64decode(capture.json()["content"]["http_payload_base64"])
        evidence["checks"]["http_password_and_original_payload_decrypted"] = True
        submitted_ssh = "SubmittedOnly-Ssh-" + run_id
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            client.connect(host["address"], port=18222, username="root", password=submitted_ssh, allow_agent=False, look_for_keys=False, timeout=10)
            raise AssertionError("Wrong v2 decoy password was accepted")
        except paramiko.AuthenticationException:
            pass
        finally:
            client.close()
        client.connect(host["address"], port=18222, username="root", password="Honeypot-Demo-7826", allow_agent=False, look_for_keys=False, timeout=10)
        shell = client.invoke_shell()
        shell.send("whoami\n")
        time.sleep(1)
        assert b"root" in shell.recv(4096)
        content = b"SAFE SFTP LAB EVIDENCE\n" + run_id.encode() + b"\n"
        sftp = client.open_sftp()
        with sftp.open(f"/tmp/acceptance-{run_id}.txt", "wb") as destination:
            destination.write(content)
        sftp.close()
        client.close()
        failed = wait(lambda: api.get("/api/v1/events", params={"deployment_id": ssh["id"], "event_type": "ssh.login.failed"}).json()["items"])[0]
        revealed = api.post(f'/api/v1/events/{failed["id"]}/private-capture')
        revealed.raise_for_status()
        assert revealed.json()["content"]["password"] == submitted_ssh
        evidence["checks"]["ssh_exact_account_and_password_envelope"] = True
        sha = hashlib.sha256(content).hexdigest()
        artifact = wait(lambda: next((a for a in api.get("/api/v1/artifacts", params={"deployment_id": ssh["id"]}).json()
            if a["sha256"] == sha and a["state"] == "available"), None))
        downloaded = api.get(f'/api/v1/artifacts/{artifact["id"]}/download')
        downloaded.raise_for_status()
        assert downloaded.content == content and hashlib.sha256(downloaded.content).hexdigest() == sha
        evidence["checks"]["sftp_client_upload_independent_sha256"] = True
        evidence["sftp_artifact"] = {"id": artifact["id"], "sha256": sha, "size_bytes": len(content)}
        for deployment, value in [(http, submitted_http), (ssh, submitted_ssh)]:
            logs = remote("docker", "logs", "hf-" + deployment["id"])
            assert value.encode() not in logs
            page = api.get("/api/v1/events", params={"deployment_id": deployment["id"]}).content
            assert value.encode() not in page
        queue_check = remote("/opt/asset-sync/.venv/bin/python", "-c",
            "from pathlib import Path; values=" + repr([submitted_http, submitted_ssh]) + "; "
            "assert all(v.encode() not in p.read_bytes() for p in Path('/var/lib/asset-sync').glob('outbox.sqlite3*') for v in values); print('encrypted')")
        assert queue_check.strip() == b"encrypted"
        evidence["checks"]["no_submitted_password_in_docker_sqlite_general_api"] = True
        evidence["capture_events"] = {"http": http_event["id"], "ssh": failed["id"]}
        tls = remote("/opt/asset-sync/.venv/bin/python", "-c",
            "import httpx,ssl; url='https://host.orb.internal:18443'; "
            "c=httpx.Client(base_url=url,verify=ssl.create_default_context(cafile='/etc/asset-sync/management-ca.crt'),trust_env=False); "
            "assert c.get('/').status_code==200; "
            "assert all(c.get(p).status_code==404 for p in ['/docs','/openapi.json','/agent/v1/runtimes','/health/ready']); "
            "assert c.get('/assets/sync/v1/runtimes').status_code==401; print('trusted')")
        assert tls.strip() == b"trusted"
        bad_tls = remote("/opt/asset-sync/.venv/bin/python", "-c",
            "import httpx; "
            "\ntry: httpx.get('https://host.orb.internal:18443/',trust_env=False)"
            "\nexcept httpx.ConnectError: print('rejected')"
            "\nelse: raise AssertionError('Untrusted CA accepted')")
        assert bad_tls.strip() == b"rejected"
        evidence["checks"]["real_https_hidden_prefix_and_untrusted_ca_rejection"] = True
        api.post("/api/v1/auth/logout").raise_for_status()
    Path("docs/evidence/backend/foundation.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"checks": evidence["checks"], "sftp_artifact": evidence["sftp_artifact"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
