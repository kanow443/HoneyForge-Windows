"""Verify real HTTP packet bytes and Cowrie wget/curl file receipt through the public API."""
import hashlib
import json
import struct
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import httpx
import paramiko

from honeyforge.infrastructure.settings import settings

EXPECTED = b"SYNTHETIC LAB ARTIFACT\nHoneyForge download verification\n"


def wait(predicate, maximum=60):
    deadline = time.monotonic() + maximum
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.3)
    raise AssertionError("Real evidence did not become available before the deadline")


def packet_payloads(content):
    assert content[:4] == b"\xd4\xc3\xb2\xa1" and len(content) >= 24
    position, packets = 24, []
    while position < len(content):
        assert position + 16 <= len(content)
        _, micros, captured, full = struct.unpack_from("<IIII", content, position)
        assert micros < 1000000 and captured <= full and position + 16 + captured <= len(content)
        packets.append(content[position + 16:position + 16 + captured])
        position += 16 + captured
    return packets


def main():
    evidence = {"at": datetime.now(UTC).isoformat(), "checks": {}}
    client = None
    with httpx.Client(base_url="http://127.0.0.1:8100", trust_env=False, timeout=15) as operator:
        login = operator.post("/api/v1/auth/login", json={"username": settings.admin_username, "password": settings.admin_password})
        login.raise_for_status()
        operator.headers["X-CSRF-Token"] = login.json()["csrf_token"]
        deployments = operator.get("/api/v1/deployments").json()
        ssh = next(d for d in deployments if d["name"] == "Operations bastion · LIVE")
        http = next(d for d in deployments if d["name"] == "Finance intranet · LIVE")
        host = next(h for h in operator.get("/api/v1/hosts").json() if h["id"] == ssh["host_id"])
        profile = next(p for p in operator.get("/api/v1/profiles").json() if p["name"] == "Demo: Operations bastion · LIVE")
        version = profile["versions"][0]
        if version["config"].get("download_mode") != "fixture":
            response = operator.post(f'/api/v1/profiles/{profile["id"]}/versions', json={"config": {**version["config"], "download_mode": "fixture"}})
            response.raise_for_status()
            version = response.json()
        operator.post(f'/api/v1/deployments/{ssh["id"]}/redeploy', json={"profile_version_id": version["id"]}).raise_for_status()
        ssh = wait(lambda: (d if (d := operator.get(f'/api/v1/deployments/{ssh["id"]}').json())["state"] == "running" else None))
        marker = "hf-pcap-" + uuid4().hex
        response = httpx.get(f'http://{host["address"]}:{http["port"]}/{marker}', trust_env=False, timeout=5)
        assert response.status_code == 404
        try:
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            client.connect(host["address"], port=ssh["port"], username="root", password="hackathon-demo", timeout=5,
                allow_agent=False, look_for_keys=False)
            shell = client.invoke_shell()
            shell.send("wget http://downloads.honeyforge.test:18090/sample.txt\n")
            def file_events():
                events = operator.get("/api/v1/events", params={"deployment_id": ssh["id"], "event_type": "ssh.file.download"}).json()["items"]
                return [e for e in events if e["generation"] == ssh["runtime_generation"] and e["payload"].get("artifact_id")]
            first = wait(file_events)[0]
            shell.send("curl -o second-sample.txt http://downloads.honeyforge.test:18090/sample.txt\n")
            files = wait(lambda: (rows if len(rows := file_events()) >= 2 else None))
            ids = {e["payload"]["artifact_id"] for e in files}
            expected_sha = hashlib.sha256(EXPECTED).hexdigest()
            def available_files():
                items = operator.get("/api/v1/artifacts", params={"deployment_id": ssh["id"]}).json()
                result = [a for a in items if a["id"] in ids and a["state"] == "available"]
                return result if len(result) == len(ids) else None
            artifacts = wait(available_files)
            for item in artifacts:
                result = operator.get(f'/api/v1/artifacts/{item["id"]}/download')
                result.raise_for_status()
                assert result.content == EXPECTED and hashlib.sha256(result.content).hexdigest() == item["sha256"] == expected_sha
            shell.send("wget http://downloads.honeyforge.test:18090/denied.txt\n")
            failures = wait(lambda: [e for e in operator.get("/api/v1/events", params={"deployment_id": ssh["id"],
                "event_type": "ssh.file.download.failed"}).json()["items"] if e["generation"] == ssh["runtime_generation"]])
            assert all(not e["payload"].get("artifact_id") for e in failures)
            shell.send("wget http://127.0.0.1:8100/private-target\n")
            wait(lambda: [e for e in operator.get("/api/v1/events", params={"deployment_id": ssh["id"],
                "event_type": "ssh.output"}).json()["items"] if e["generation"] == ssh["runtime_generation"]
                and "127.0.0.1" in e["payload"].get("text", "") and "unable to resolve" in e["payload"].get("text", "")])
            shell.send("exit\n")
            evidence["checks"]["file_receipt"] = {"wget_and_curl_received": True, "artifact_ids": sorted(ids),
                "sha256": expected_sha, "bytes_per_file": len(EXPECTED), "independent_server_and_download_hash": True,
                "fixture_only_not_malware": True, "private_destination_denied": True,
                "failed_download_not_claimed_as_available": True, "generation": ssh["runtime_generation"],
                "session_id": first["session_id"]}
            found = None
            def find_packet():
                nonlocal found
                for item in operator.get("/api/v1/artifacts", params={"deployment_id": http["id"]}).json():
                    if item["kind"] != "pcap" or item["state"] != "available":
                        continue
                    data = operator.get(f'/api/v1/artifacts/{item["id"]}/download').content
                    if marker.encode() in data:
                        packets = packet_payloads(data)
                        assert hashlib.sha256(data).hexdigest() == item["sha256"]
                        assert item["details"]["packet_count"] == len(packets)
                        found = {"artifact_id": item["id"], "sha256": item["sha256"], "size_bytes": len(data),
                            "packet_count": len(packets), "kernel_drops": item["details"]["kernel_drops"],
                            "http_payload_marker_present": True, "complete_records_and_hash_verified": True,
                            "capture_scope": item["details"]["capture"]}
                        return found
                return None
            evidence["checks"]["pcap"] = wait(find_packet)
            client.close()
            print(json.dumps(evidence["checks"], ensure_ascii=False))
        finally:
            if client:
                client.close()
            operator.post("/api/v1/auth/logout").raise_for_status()
    Path("docs/evidence/backend/binary-evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
