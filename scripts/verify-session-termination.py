"""Real, scoped SSH termination acceptance; restores its temporary source policy."""
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


def wait(predicate, maximum=45):
    deadline = time.monotonic() + maximum
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.2)
    raise AssertionError("Live termination condition did not become true")


def main():
    policy, clients, other = None, [], None
    evidence = {"at": datetime.now(UTC).isoformat(), "checks": {}}
    with httpx.Client(base_url="http://127.0.0.1:8100", trust_env=False, timeout=10) as operator:
        login = operator.post("/api/v1/auth/login", json={"username": settings.admin_username, "password": settings.admin_password})
        login.raise_for_status()
        operator.headers["X-CSRF-Token"] = login.json()["csrf_token"]
        trap = next(d for d in operator.get("/api/v1/deployments").json() if d["adapter"] == "cowrie" and d["name"] == "Operations bastion · LIVE")
        host = next(h for h in operator.get("/api/v1/hosts").json() if h["id"] == trap["host_id"])
        address = host["address"]
        operator.post(f'/api/v1/deployments/{trap["id"]}/redeploy', json={}).raise_for_status()
        trap = wait(lambda: (d if (d := operator.get(f'/api/v1/deployments/{trap["id"]}').json())["state"] == "running" else None))
        marker = "hf-close-" + uuid4().hex[:12]
        try:
            for index in range(2):
                client = paramiko.SSHClient()
                client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
                client.connect(address, port=trap["port"], username="root", password="hackathon-demo",
                    allow_agent=False, look_for_keys=False, timeout=5)
                channel = client.invoke_shell()
                channel.send(f"echo {marker}-{index}\n")
                clients.append(client)
            rows = wait(lambda: (r if len(r := operator.get("/api/v1/events", params={"deployment_id": trap["id"], "q": marker}).json()["items"]) >= 2 else None))
            source = rows[0]["source_ip"]
            source_ids = {r["session_id"] for r in rows}
            raw_ids = {operator.get(f"/api/v1/sessions/{key}").json()["source_id"] for key in source_ids}
            # Separate source on the sensor VM: hold an actual unauthenticated SSH transport open.
            remote_code = ("import socket,time; s=socket.create_connection((" + repr(address) + "," + str(trap["port"]) + "),timeout=3); "
                "assert s.recv(256).startswith(b'SSH-'); s.sendall(b'SSH-2.0-HoneyForgeOtherClient\\r\\n'); "
                "print('ready',flush=True); time.sleep(5); s.settimeout(2); data=s.recv(4096); "
                "assert data; print('still-open',flush=True); s.close()")
            other = subprocess.Popen([ORB, "run", "-m", "honeyforge-sensor", "-u", "root", "python3", "-c", remote_code],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            assert other.stdout.readline().strip() == "ready"
            start = time.monotonic()
            response = operator.post("/api/v1/source-blocks", json={"deployment_id": trap["id"], "source_ip": source,
                "ttl_seconds": 60, "reason": "Real SSH transport termination acceptance", "terminate_sessions": True},
                headers={"Idempotency-Key": "close-" + uuid4().hex})
            response.raise_for_status()
            policy = response.json()
            def closed():
                row = next(r for r in operator.get("/api/v1/source-blocks", params={"deployment_id": trap["id"]}).json() if r["id"] == policy["id"])
                if row["termination_state"] in {"error", "unsupported"}:
                    raise AssertionError(row["termination_error"])
                return row if row["state"] == "applied" and row["termination_state"] == "completed" else None
            result = wait(closed)
            ack_seconds = time.monotonic() - start
            wait(lambda: all(not client.get_transport().is_active() for client in clients))
            assert raw_ids <= set(result["terminated_sessions"]), (raw_ids, result)
            assert httpx.get(f"http://{address}:18080/", trust_env=False, timeout=3).status_code == 200
            assert operator.get("/health/ready").status_code == 200
            denied = False
            try:
                with socket.create_connection((address, trap["port"]), timeout=1) as connection:
                    denied = not connection.recv(64).startswith(b"SSH-")
            except OSError:
                denied = True
            assert denied
            stdout, stderr = other.communicate(timeout=10)
            assert other.returncode == 0 and "still-open" in stdout, stderr[-500:]
            evidence["checks"] = {"firewall_state": result["state"], "termination_state": result["termination_state"],
                "terminated_transport_ids": result["terminated_sessions"], "two_authenticated_ssh_clients_closed": True,
                "different_source_unauthenticated_ssh_transport_preserved": True, "same_source_http_preserved": True,
                "new_source_connections_denied": True, "management_available": True,
                "request_to_ack_seconds": round(ack_seconds, 3), "deployment_id": trap["id"],
                "generation": trap["runtime_generation"], "policy_id": policy["id"]}
            print(json.dumps(evidence["checks"], ensure_ascii=False))
        finally:
            if policy:
                operator.post(f'/api/v1/source-blocks/{policy["id"]}/cancel', json={"revision": policy["revision"]}).raise_for_status()
                wait(lambda: next(r for r in operator.get("/api/v1/source-blocks").json() if r["id"] == policy["id"])["state"] == "cancelled")
            for client in clients:
                client.close()
            if other and other.poll() is None:
                other.terminate()
                other.wait(timeout=5)
            operator.post("/api/v1/auth/logout").raise_for_status()
    path = Path("docs/evidence/backend/session-termination.json")
    path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
