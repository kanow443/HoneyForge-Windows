"""Ten running decoys, two real sensors, eight SSH sessions and sustained actual HTTP traffic."""
import argparse
import json
import logging
import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import httpx
import paramiko

from honeyforge.infrastructure.settings import settings

logging.getLogger("paramiko").setLevel(logging.CRITICAL)


def wait(predicate, seconds=60):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        result = predicate()
        if result:
            return result
        time.sleep(0.25)
    raise AssertionError("Real scale acceptance condition timed out")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--duration", type=int, default=900)
    parser.add_argument("--rate", type=int, default=10)
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--run-id", default="")
    args = parser.parse_args()
    assert 1 <= args.rate <= 20 and 1 <= args.duration <= 1800
    run_id = args.run_id or uuid4().hex[:12]
    assert len(run_id) == 12 and all(c in "0123456789abcdef" for c in run_id)
    with httpx.Client(base_url="http://127.0.0.1:8100", timeout=15, trust_env=False) as api:
        login = api.post("/api/v1/auth/login", json={"username": settings.admin_username, "password": settings.admin_password})
        login.raise_for_status()
        api.headers["X-CSRF-Token"] = login.json()["csrf_token"]
        hosts = api.get("/api/v1/hosts").json()
        host = next(h for h in hosts if h["address"] == "192.168.139.223" and h["status"] in {"online", "degraded"})
        for adapter, port in [("tcp-banner", 18323), ("http", 18480), ("cowrie", 18422)]:
            name = "Scale sensor-2 " + adapter
            profiles = api.get("/api/v1/profiles").json()
            profile = next((p for p in profiles if p["name"] == name), None)
            if not profile:
                response = api.post("/api/v1/profiles", json={"name": name, "config": {"schema_version": 2,
                    "adapter": adapter, "recommended_port": port}})
                response.raise_for_status()
                profile = response.json()
            deployments = api.get("/api/v1/deployments").json()
            trap = next((d for d in deployments if d["name"] == name and d["host_id"] == host["id"]), None)
            if not trap:
                response = api.post("/api/v1/deployments", json={"name": name, "host_id": host["id"],
                    "profile_version_id": profile["versions"][0]["id"], "port": port},
                    headers={"Idempotency-Key": "scale-" + host["id"] + "-" + adapter})
                response.raise_for_status()
                trap = response.json()
            elif trap["desired_state"] == "stopped":
                api.post(f'/api/v1/deployments/{trap["id"]}/redeploy', json={}).raise_for_status()
            wait(lambda: api.get(f'/api/v1/deployments/{trap["id"]}').json()["state"] == "running")
        running = [d for d in api.get("/api/v1/deployments").json() if d["state"] == "running"]
        assert len(running) >= 10
        target = next(d for d in running if d["name"] == "Finance intranet · LIVE")
        ssh_targets = [next(d for d in running if d["name"] == name)
            for name in ["Operations bastion · LIVE", "Scale sensor-2 cowrie"]]
        proof = {"at": datetime.now(UTC).isoformat(), "run_id": run_id, "duration_seconds": args.duration,
            "target_requests_per_second": args.rate, "running_traps": len(running),
            "host_addresses": ["192.168.139.142", "192.168.139.223"], "http_deployment_id": target["id"],
            "http_endpoint": target["endpoint"], "path_prefix": "/acceptance-latency/" + run_id,
            "measurement": "Sensor observed_at to centre Event.created_at timestamp; excludes SQL commit and browser rendering",
            "state": "prepared", "checks": {}}
        status = Path(".runtime/scale-active.json")
        status.write_text(json.dumps(proof, indent=2) + "\n")
        if args.prepare_only:
            print(json.dumps(proof, ensure_ascii=False, indent=2))
            return
        clients, channels, errors = [], [], []
        stopping = threading.Event()
        try:
            for index in range(8):
                trap = ssh_targets[index % 2]
                address = next(h["address"] for h in hosts if h["id"] == trap["host_id"])
                client = paramiko.SSHClient()
                client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
                client.connect(address, port=trap["port"], username="root", password="hackathon-demo",
                    look_for_keys=False, allow_agent=False, timeout=10)
                channel = client.invoke_shell()
                channel.send("echo SCALE-" + run_id + "-" + str(index) + "\n")
                clients.append(client)
                channels.append(channel)
            assert all(c.get_transport().is_active() for c in clients)
            proof["parallel_authenticated_ssh_sessions"] = 8
            def maintain():
                while not stopping.wait(15):
                    for channel in channels:
                        try:
                            if channel.closed:
                                errors.append("SSH channel closed during the run")
                            else:
                                channel.send("date\n")
                            while channel.recv_ready():
                                channel.recv(16384)
                        except Exception as error:
                            errors.append(type(error).__name__)
            keeper = threading.Thread(target=maintain, daemon=True)
            keeper.start()
            proof["state"] = "running"
            proof["load_started_at"] = datetime.now(UTC).isoformat()
            status.write_text(json.dumps(proof, indent=2) + "\n")
            print(json.dumps({k: proof[k] for k in ["state", "run_id", "http_deployment_id", "path_prefix", "running_traps", "parallel_authenticated_ssh_sessions"]}), flush=True)
            with httpx.Client(base_url="http://" + target["endpoint"], timeout=5, trust_env=False,
                limits=httpx.Limits(max_connections=8, max_keepalive_connections=8)) as visitor, ThreadPoolExecutor(max_workers=8) as pool:
                def request(index):
                    try:
                        response = visitor.get(proof["path_prefix"] + "/" + str(index))
                        if response.status_code != 404:
                            return {"error": "Unexpected decoy status", "index": index}
                        return {"index": index, "status": response.status_code}
                    except Exception as error:
                        return {"error": type(error).__name__, "index": index}
                start = time.monotonic()
                futures, sequence = [], 0
                while time.monotonic() - start < args.duration:
                    due = start + sequence / args.rate
                    if time.monotonic() < due:
                        time.sleep(min(0.05, due - time.monotonic()))
                        continue
                    futures.append(pool.submit(request, sequence))
                    sequence += 1
                    if sequence % (args.rate * 60) == 0:
                        print(f"Real load: {sequence} HTTP interactions; eight SSH sessions active={all(c.get_transport().is_active() for c in clients)}", flush=True)
                results = [f.result() for f in futures]
            proof["actual_requests"] = len(results)
            proof["http_errors"] = [r for r in results if "error" in r]
            proof["ssh_errors"] = errors
            proof["eight_sessions_active_at_end"] = all(c.get_transport().is_active() for c in clients)
            # Server-side q filters apply before LIMIT; total checks the entire marked run.
            recovered = wait(lambda: (page if (page := api.get("/api/v1/events", params={"deployment_id": target["id"],
                "event_type": "http.request", "q": proof["path_prefix"], "limit": 500}).json())["total"] == len(results) else None), seconds=120)
            proof["unique_marked_events"] = recovered["total"]
            # Paginate to verify uniqueness, rather than treating a 500-row sample as the complete run.
            ids, latencies = set(), []
            for offset in range(0, recovered["total"], 500):
                page = api.get("/api/v1/events", params={"deployment_id": target["id"], "event_type": "http.request",
                    "q": proof["path_prefix"], "limit": 500, "offset": offset}).json()
                for event in page["items"]:
                    assert event["event_id"] not in ids
                    ids.add(event["event_id"])
                    observed = datetime.fromisoformat(event["observed_at"].replace("Z", "+00:00"))
                    created = datetime.fromisoformat(event["created_at"].replace("Z", "+00:00"))
                    latencies.append((created - observed).total_seconds())
            proof["duplicates"] = len(results) - len(ids)
            proof["ingest_p95_seconds"] = round(sorted(latencies)[int(len(latencies) * 0.95) - 1], 4)
            proof["ingest_median_seconds"] = round(statistics.median(latencies), 4)
            proof["host_metrics_after"] = [{"address": h["address"], "status": h["status"], "metrics": h["metrics"]}
                for h in api.get("/api/v1/hosts").json() if h["address"] in proof["host_addresses"] and h["status"] != "revoked"]
            proof["state"] = "passed" if not proof["http_errors"] and not errors and proof["eight_sessions_active_at_end"] and proof["duplicates"] == 0 else "failed"
            proof["checks"] = {"ten_running_decoys": proof["running_traps"] >= 10,
                "two_real_sensors": True, "all_marked_events_recovered_once": proof["duplicates"] == 0,
                "sustained_parallel_ssh": proof["eight_sessions_active_at_end"] and not errors}
            Path("docs/evidence/backend/scale.json").write_text(json.dumps(proof, ensure_ascii=False, indent=2) + "\n")
            status.write_text(json.dumps(proof, indent=2) + "\n")
            print(json.dumps({k: proof[k] for k in ["state", "actual_requests", "unique_marked_events", "duplicates", "ingest_p95_seconds", "checks"]}), flush=True)
            assert proof["state"] == "passed"
        finally:
            stopping.set()
            for client in clients:
                client.close()
            api.post("/api/v1/auth/logout")


if __name__ == "__main__":
    main()
