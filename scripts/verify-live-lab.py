"""Real acceptance on dedicated lab ports. Restores temporary policies even on failure."""
import argparse
import json
import socket
import statistics
import subprocess
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import httpx
import paramiko

from honeyforge.infrastructure.settings import settings

ORB = "/Applications/OrbStack.app/Contents/MacOS/bin/orbctl"
API = "http://127.0.0.1:8100"
SENSOR = "192.168.139.142"


def remote(command):
    result = subprocess.run([ORB, "run", "-m", "honeyforge-sensor", "-u", "root", "bash", "-c", command],
        check=True, capture_output=True, text=True)
    return result.stdout.strip()


def wait(predicate, maximum=45):
    deadline = time.monotonic() + maximum
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.3)
    raise AssertionError("Acceptance condition did not become true before the deadline")


def ssh(port):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(SENSOR, port=port, username="root", password="hackathon-demo", timeout=3,
        allow_agent=False, look_for_keys=False)
    return client


def connects(port):
    try:
        with socket.create_connection((SENSOR, port), timeout=1) as connection:
            return connection.recv(64).startswith(b"SSH-")
    except OSError:
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="Test 60-second sensor/control loss and autonomous TTL")
    args = parser.parse_args()
    evidence = {"at": datetime.now(UTC).isoformat(), "checks": {}}
    policy = None
    deployments = []
    with httpx.Client(base_url=API, trust_env=False, timeout=10) as operator:
        login = operator.post("/api/v1/auth/login", json={"username": settings.admin_username, "password": settings.admin_password})
        login.raise_for_status()
        operator.headers["X-CSRF-Token"] = login.json()["csrf_token"]
        host = next(h for h in operator.get("/api/v1/hosts").json() if h["address"] == SENSOR and h["status"] in {"online", "degraded"})
        profiles = operator.get("/api/v1/profiles").json()
        try:
            for adapter, port in [("http", 18380), ("cowrie", 12222)]:
                profile = next(p for p in profiles if p["adapter"] == adapter and p["name"].startswith("Demo:"))
                response = operator.post("/api/v1/deployments", headers={"Idempotency-Key": f"accept-live-tls-{host['id']}-{adapter}-{uuid4().hex}"},
                    json={"name": f"Backend acceptance · {adapter}", "host_id": host["id"], "profile_version_id": profile["versions"][0]["id"], "port": port})
                response.raise_for_status()
                deployment = response.json()
                if deployment["desired_state"] == "stopped":
                    operator.post(f'/api/v1/deployments/{deployment["id"]}/redeploy', json={}).raise_for_status()
                key = deployment["id"]
                wait(lambda: operator.get("/api/v1/deployments/" + key).json()["state"] == "running")
                deployments.append(operator.get("/api/v1/deployments/" + key).json())
            http_trap, ssh_trap = deployments
            marker = "hf-live-" + uuid4().hex[:10]
            sent, latencies, stop = {}, {}, threading.Event()
            watermark = operator.get("/api/v1/events", params={"limit": 1}).json()["watermark"]
            connected = threading.Event()
            errors = []

            def observe():
                try:
                    with httpx.Client(base_url=API, cookies=operator.cookies, trust_env=False,
                        timeout=httpx.Timeout(15, connect=5)) as observer:
                        with observer.stream("GET", "/api/v1/stream", params={"after": watermark}) as stream:
                            stream.raise_for_status()
                            connected.set()
                            for line in stream.iter_lines():
                                if stop.is_set():
                                    break
                                if not line.startswith("data:"):
                                    continue
                                data = json.loads(line[5:].strip())
                                if data.get("kind") != "event.created":
                                    continue
                                rows = observer.get("/api/v1/events", params={"deployment_id": ssh_trap["id"], "q": marker}).json()["items"]
                                for event in rows:
                                    command = event["payload"].get("command")
                                    if command in sent and command not in latencies:
                                        latencies[command] = time.monotonic() - sent[command]
                except httpx.ReadTimeout:
                    if not stop.is_set():
                        errors.append("SSE read timed out")
                except Exception as error:
                    errors.append(type(error).__name__)

            observer = threading.Thread(target=observe, daemon=True)
            observer.start()
            assert connected.wait(5)
            attacker = ssh(12222)
            shell = attacker.invoke_shell()
            for i in range(10):
                command = f"echo {marker}-{i}"
                sent[command] = time.monotonic()
                shell.send(command + "\n")
                time.sleep(0.1)
            wait(lambda: len(latencies) == 10)
            shell.send("exit\n")
            attacker.close()
            stop.set()
            observer.join(timeout=16)
            assert not errors, errors
            values = sorted(latencies.values())
            evidence["checks"]["sse_command_delivery"] = {"events": len(values), "p95_seconds": round(values[-1], 3),
                "median_seconds": round(statistics.median(values), 3), "rate": "10 commands/s", "measurement": "command send to SSE-triggered API read; excludes browser rendering"}
            assert values[-1] <= 2, evidence["checks"]["sse_command_delivery"]
            print("Real SSH → SSE delivery:", evidence["checks"]["sse_command_delivery"], flush=True)
            rows = operator.get("/api/v1/events", params={"deployment_id": ssh_trap["id"], "q": marker}).json()["items"]
            source = rows[0]["source_ip"]
            response = operator.post("/api/v1/source-blocks", headers={"Idempotency-Key": "lab-check-" + uuid4().hex},
                json={"deployment_id": ssh_trap["id"], "source_ip": source, "ttl_seconds": 60, "reason": "Controlled backend acceptance"})
            response.raise_for_status()
            policy = response.json()

            def applied():
                rows = operator.get("/api/v1/source-blocks", params={"deployment_id": ssh_trap["id"]}).json()
                return next((r for r in rows if r["id"] == policy["id"] and r["state"] == "applied"), None)

            wait(applied)
            assert not connects(12222)
            remote("systemctl restart asset-sync.service")
            wait(lambda: next(h for h in operator.get('/api/v1/hosts').json() if h['id'] == host['id'])['status'] in {'online', 'degraded'})
            assert not connects(12222)
            evidence["checks"]["sensor_restart_preserved_policy"] = True
            assert httpx.get(f"http://{SENSOR}:18380/", trust_env=False, timeout=3).status_code == 200
            # A different observed source can still establish a new connection.
            banner = remote("python3 -c \"import socket; s=socket.create_connection(('192.168.139.142',12222),timeout=3); print(s.recv(64).decode().split()[0]); s.close()\"")
            assert banner.startswith("SSH-2.0-")
            evidence["checks"]["source_scope"] = {"blocked_source": source, "blocked_port": 12222,
                "same_source_http_allowed": True, "different_sensor_source_ssh_allowed": True, "management_available": True}
            print("Source scope verified: only new SSH connections to the selected trap are blocked.", flush=True)
            if args.offline:
                # Only the sensor's connection to this API is interrupted; frontend/API remain running.
                remote("for firewall in iptables ip6tables; do $firewall -w -N HF-LAB-LOSS; $firewall -w -A HF-LAB-LOSS -j DROP; $firewall -w -I OUTPUT 1 -p tcp --dport 18443 -j HF-LAB-LOSS; done")
                outage_start = time.monotonic()
                marker_http = "hf-outage-" + uuid4().hex[:10]
                with httpx.Client(base_url=f"http://{SENSOR}:18380", trust_env=False, timeout=3) as visitor:
                    for i in range(12):
                        time.sleep(0.2)
                        visitor.get("/", params={"visit": marker_http + "-" + str(i)}).raise_for_status()
                # Raw query values are deliberately not stored; track a unique request path instead.
                    for i in range(12):
                        visitor.get("/" + marker_http + "-" + str(i))
                while time.monotonic() - outage_start < 45:
                    time.sleep(0.5)
                queued = int(remote("python3 -c \"import sqlite3; c=sqlite3.connect('/var/lib/asset-sync/outbox.sqlite3'); print(c.execute('SELECT count(*) FROM outbox').fetchone()[0])\""))
                assert queued > 0
                deadline = datetime.fromisoformat(policy["expires_at"].replace("Z", "+00:00"))
                while datetime.now(UTC) <= deadline + timedelta_seconds(2) or time.monotonic() - outage_start < 60:
                    time.sleep(0.5)
                assert connects(12222), "The local TTL worker must remove a policy while API connectivity is lost"
                offline = operator.get("/api/v1/hosts").json()
                assert next(h for h in offline if h["id"] == host["id"])["status"] == "offline"
                remote("for firewall in iptables ip6tables; do $firewall -w -D OUTPUT -p tcp --dport 18443 -j HF-LAB-LOSS; $firewall -w -F HF-LAB-LOSS; $firewall -w -X HF-LAB-LOSS; done")

                def recovered():
                    page = operator.get("/api/v1/events", params={"deployment_id": http_trap["id"], "q": marker_http}).json()
                    return page if page["total"] == 12 else None

                page = wait(recovered, maximum=60)
                assert len({e["event_id"] for e in page["items"]}) == 12
                evidence["checks"]["offline_recovery"] = {"outage_seconds": 60, "queued_during_outage": queued,
                    "unique_marked_requests_recovered": 12, "autonomous_ttl_verified": True, "duplicate_requests": 0}
                print("60-second loss, local TTL and recovery without duplicate marked events verified.", flush=True)
            else:
                operator.post(f'/api/v1/source-blocks/{policy["id"]}/cancel', json={"revision": policy["revision"]}).raise_for_status()
                wait(lambda: connects(12222))
                evidence["checks"]["cancellation"] = True
            evidence["deployments"] = [d["id"] for d in deployments]
            path = Path("docs/evidence/backend/live-lab.json")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
        finally:
            remote("for firewall in iptables ip6tables; do $firewall -w -D OUTPUT -p tcp --dport 18443 -j HF-LAB-LOSS 2>/dev/null || true; $firewall -w -F HF-LAB-LOSS 2>/dev/null || true; $firewall -w -X HF-LAB-LOSS 2>/dev/null || true; done")
            if policy:
                policies = operator.get("/api/v1/source-blocks", params={"deployment_id": policy["deployment_id"]}).json()
                current = next((p for p in policies if p["id"] == policy["id"]), None)
                if current and current["desired_state"] != "released":
                    operator.post(f'/api/v1/source-blocks/{policy["id"]}/cancel', json={"revision": current["revision"]})
            for deployment in deployments:
                operator.post(f'/api/v1/deployments/{deployment["id"]}/stop').raise_for_status()
            operator.post("/api/v1/auth/logout").raise_for_status()


def timedelta_seconds(value):
    from datetime import timedelta
    return timedelta(seconds=value)


if __name__ == "__main__":
    main()
