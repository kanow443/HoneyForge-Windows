"""Real ECS pull receipt and scoped automatic response; revoke and release on exit."""
import hashlib
import json
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import httpx

from honeyforge.infrastructure.settings import settings
from honeyforge.infrastructure.siem_receiver import Receiver


def wait(predicate, maximum=30):
    deadline = time.monotonic() + maximum
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.2)
    raise AssertionError("Integration condition did not become true")


def main():
    issued, policy, receiver = None, None, None
    evidence = {"at": datetime.now(UTC).isoformat(), "checks": {}}
    with httpx.Client(base_url="http://127.0.0.1:8100", trust_env=False, timeout=10) as operator:
        login = operator.post("/api/v1/auth/login", json={"username": settings.admin_username, "password": settings.admin_password})
        login.raise_for_status()
        operator.headers["X-CSRF-Token"] = login.json()["csrf_token"]
        trap = next(d for d in operator.get("/api/v1/deployments").json() if d["name"] == "Finance intranet · LIVE")
        host = next(h for h in operator.get("/api/v1/hosts").json() if h["id"] == trap["host_id"])
        marker = "hf-integration-" + uuid4().hex
        try:
            response = operator.post("/api/v1/integration-tokens", json={"name": "Controlled integration acceptance",
                "deployment_id": trap["id"], "allow_response": True, "expires_days": 1})
            response.raise_for_status()
            issued = response.json()
            headers = {"Authorization": "Bearer " + issued["token"]}
            httpx.get(f'http://{host["address"]}:{trap["port"]}/{marker}', trust_env=False, timeout=3)
            observed = wait(lambda: (page["items"][0] if (page := operator.get("/api/v1/events",
                params={"deployment_id": trap["id"], "q": marker}).json())["items"] else None))
            receiver = Receiver(Path(".runtime") / ("receiver-" + uuid4().hex + ".sqlite3"), "http://127.0.0.1:8100")
            for _ in range(1000):
                after = receiver.cursor()
                response = operator.get("/integration/v1/events", params={"after": after, "limit": 500}, headers=headers)
                response.raise_for_status()
                page = response.json()
                receiver.accept(page, after)
                if not page["has_more"]:
                    break
            row = receiver.db.execute("SELECT body FROM events WHERE id=?", (observed["id"],)).fetchone()
            assert row, "Marker was not committed at the receiver"
            received = json.loads(row[0])
            assert received["service"]["id"] == trap["id"] and received["event"]["action"] == "http.request"
            assert receiver.db.execute("SELECT count(*) FROM events WHERE id=?", (observed["id"],)).fetchone()[0] == 1
            # Replaying an already stored event does not duplicate it.
            receiver.accept({"format": "honeyforge-ecs-events-v1", "items": [received], "next_cursor": receiver.cursor(),
                "reset_required": False}, receiver.cursor())
            assert receiver.db.execute("SELECT count(*) FROM events WHERE id=?", (observed["id"],)).fetchone()[0] == 1
            assert operator.post("/agent/v1/jobs/claim", headers=headers).status_code == 401
            response = operator.post("/integration/v1/source-blocks", json={"event_id": observed["id"], "ttl_seconds": 60,
                "reason": "Controlled external rule response"}, headers={**headers, "Idempotency-Key": "integration-" + uuid4().hex})
            response.raise_for_status()
            policy = response.json()
            applied = wait(lambda: (r if (r := operator.get(f'/integration/v1/source-blocks/{policy["id"]}', headers=headers).json())["state"] == "applied" else None))
            denied = False
            try:
                httpx.get(f'http://{host["address"]}:{trap["port"]}/', trust_env=False, timeout=1)
            except httpx.TimeoutException:
                denied = True
            assert denied and operator.get("/health/ready").status_code == 200
            operator.post(f'/api/v1/integration-tokens/{issued["integration"]["id"]}/revoke').raise_for_status()
            wait(lambda: next(p for p in operator.get("/api/v1/source-blocks").json() if p["id"] == policy["id"])["state"] == "cancelled")
            assert operator.get("/integration/v1/events", headers=headers).status_code == 401
            assert httpx.get(f'http://{host["address"]}:{trap["port"]}/', trust_env=False, timeout=3).status_code == 200
            evidence["checks"] = {"ecs_event_received_and_persisted": True, "event_id": observed["id"],
                "receipt_sha256": hashlib.sha256(row[0].encode()).hexdigest(), "duplicate_replay_count": 1,
                "agent_control_access_denied": True, "deployment_scoped_response": True, "policy_id": policy["id"],
                "agent_ack": applied["state"], "new_http_connection_denied": True, "management_available": True,
                "credential_revocation_released_policy": True, "revoked_credential_denied": True,
                "receiver": "HoneyForge reference receiver; no external vendor SIEM tested"}
            print(json.dumps(evidence["checks"], ensure_ascii=False))
        finally:
            if issued:
                operator.post(f'/api/v1/integration-tokens/{issued["integration"]["id"]}/revoke').raise_for_status()
            if receiver:
                receiver.close()
            operator.post("/api/v1/auth/logout").raise_for_status()
    Path("docs/evidence/backend/integrations.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
