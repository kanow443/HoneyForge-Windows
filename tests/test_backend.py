import json
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import func, select

from honeyforge.agent.spool import Spool
from honeyforge.infrastructure.models import (
    Audit,
    Event,
    Host,
    Job,
    StreamEntry,
    StreamState,
    now,
)


def event(deployment, **changes):
    return {"event_id": str(uuid4()), "deployment_id": deployment["id"], "generation": deployment["runtime_generation"],
        "event_type": "http.request", "source_ip": "192.0.2.10", "observed_at": now().isoformat(),
        "payload": {"method": "GET", "path": "/", "password": "must-not-persist"}, **changes}


def claim(operator, sensor):
    return operator.post("/agent/v1/jobs/claim", headers=sensor["headers"]).json()["job"]


def test_authentication_csrf_and_logout(client):
    for route in ("hosts", "events", "overview", "sessions", "audit", "findings"):
        assert client.get("/api/v1/" + route).status_code == 401
    assert client.get("/api/v1/stream").status_code == 401
    assert client.post("/api/v1/auth/login", json={"username": "tester", "password": "bad"}).status_code == 401
    result = client.post("/api/v1/auth/login", json={"username": "tester", "password": "testing-password-123"})
    assert result.status_code == 200
    assert client.post("/api/v1/hosts/enrollment-tokens").status_code == 403
    client.headers["X-CSRF-Token"] = result.json()["csrf_token"]
    assert client.post("/api/v1/hosts/enrollment-tokens", headers={"Origin": "https://evil.test"}).status_code == 403
    assert client.post("/api/v1/auth/logout").status_code == 200
    assert client.get("/api/v1/auth/me").status_code == 401


def test_one_time_enrollment_and_revocation(operator, sensor):
    body = {"token": sensor["token"], "name": "Replay", "address": "127.0.0.1", "capabilities": ["http"]}
    assert operator.post("/agent/v1/enroll", json=body).status_code == 401
    assert operator.post("/agent/v1/heartbeat", json={}, headers=sensor["headers"]).status_code == 200
    assert operator.post(f'/api/v1/hosts/{sensor["host_id"]}/revoke').status_code == 200
    assert operator.post("/agent/v1/jobs/claim", headers=sensor["headers"]).status_code == 401
    assert "key_hash" not in operator.get("/api/v1/hosts").json()[0]


def test_profile_validation_and_immutable_version(operator, profile):
    original = profile["versions"][0]
    result = operator.post(f'/api/v1/profiles/{profile["id"]}/versions', json={"config": {"adapter": "http", "hostname": "new-host"}})
    assert result.status_code == 201
    versions = operator.get(f'/api/v1/profiles/{profile["id"]}').json()["versions"]
    assert versions[0]["number"] == 2
    assert versions[1] == original
    assert versions[0]["config_hash"] != original["config_hash"]
    assert operator.post("/api/v1/profiles", json={"name": "Bad", "config": {"adapter": "http", "image": "privileged"}}).status_code == 422
    assert operator.post("/api/v1/profiles", json={"name": "Bad", "config": {"adapter": "http", "decoy_files": [{"path": "/home/../etc/shadow", "content": "x"}]}}).status_code == 422
    assert operator.post(f'/api/v1/profiles/{profile["id"]}/versions', json={"config": {"adapter": "cowrie"}}).status_code == 400


def test_idempotency_port_collision_and_offline(operator, sensor, profile, deployment, database):
    body = {"name": "Test trap", "host_id": sensor["host_id"], "profile_version_id": profile["versions"][0]["id"], "port": 18088}
    response = operator.post("/api/v1/deployments", json=body, headers={"Idempotency-Key": "test-deploy-key-01"})
    assert response.json()["id"] == deployment["id"]
    assert operator.post("/api/v1/deployments", json={**body, "name": "Changed"}, headers={"Idempotency-Key": "test-deploy-key-01"}).status_code == 409
    assert operator.post("/api/v1/deployments", json=body, headers={"Idempotency-Key": "another-deploy-key"}).status_code == 409
    with database.sessions.begin() as s:
        s.get(Host, sensor["host_id"]).last_seen = now() - timedelta(minutes=1)
    assert operator.post("/api/v1/deployments", json={**body, "port": 18089}, headers={"Idempotency-Key": "offline-deploy-key"}).status_code == 409


def test_job_lease_fencing_and_stop(operator, sensor, deployment):
    job = claim(operator, sensor)
    assert job["attempt"] == 1
    assert claim(operator, sensor) is None
    path = f'/agent/v1/jobs/{job["id"]}/result'
    assert operator.post(path, json={"attempt": 2, "succeeded": True}, headers=sensor["headers"]).status_code == 409
    assert operator.post(path, json={"attempt": 1, "succeeded": True, "image_digest": "sha256:example"}, headers=sensor["headers"]).status_code == 200
    assert operator.get(f'/api/v1/deployments/{deployment["id"]}').json()["state"] == "running"
    assert operator.post(path, json={"attempt": 1, "succeeded": True}, headers=sensor["headers"]).status_code == 409
    stop = operator.post(f'/api/v1/deployments/{deployment["id"]}/stop').json()
    assert stop["desired_revision"] == 2 and stop["state"] == "stopping"
    stopped_job = claim(operator, sensor)
    assert stopped_job["kind"] == "stop"
    assert operator.post(f'/agent/v1/jobs/{stopped_job["id"]}/result', json={"attempt": 1, "succeeded": True}, headers=sensor["headers"]).status_code == 200
    assert operator.get(f'/api/v1/deployments/{deployment["id"]}').json()["state"] == "stopped"


def test_lease_reclaim_rejects_old_attempt(operator, sensor, deployment, database):
    first = claim(operator, sensor)
    with database.sessions.begin() as s:
        s.get(Job, first["id"]).lease_until = now() - timedelta(seconds=1)
    second = claim(operator, sensor)
    assert second["id"] == first["id"] and second["attempt"] == 2
    path = f'/agent/v1/jobs/{first["id"]}/result'
    assert operator.post(path, json={"attempt": 1, "succeeded": True}, headers=sensor["headers"]).status_code == 409
    assert operator.post(path, json={"attempt": 2, "succeeded": True}, headers=sensor["headers"]).status_code == 200


def test_stop_cancels_in_flight_deployment(operator, sensor, deployment):
    job = claim(operator, sensor)
    operator.post(f'/api/v1/deployments/{deployment["id"]}/stop')
    assert operator.post(f'/agent/v1/jobs/{job["id"]}/result', json={"attempt": 1, "succeeded": True}, headers=sensor["headers"]).status_code == 409
    assert claim(operator, sensor)["kind"] == "stop"


def test_batch_dedup_redaction_and_foreign_runtime(operator, sensor, deployment, database):
    item = event(deployment)
    body = {"events": [item] * 100}
    first = operator.post("/agent/v1/events/batch", json=body, headers=sensor["headers"])
    assert first.status_code == 200 and first.json()["inserted"] == 1
    second = operator.post("/agent/v1/events/batch", json=body, headers=sensor["headers"])
    assert second.json()["inserted"] == 0
    items = operator.get("/api/v1/events").json()["items"]
    assert len(items) == 1 and items[0]["payload"]["password"] == "[redacted]"
    invalid = event(deployment, generation=str(uuid4()))
    result = operator.post("/agent/v1/events/batch", json={"events": [invalid]}, headers=sensor["headers"]).json()
    assert result["accepted"] == [] and len(result["rejected"]) == 1
    with database.sessions() as s:
        assert s.scalar(select(func.count()).select_from(Event)) == 1


def test_sessions_rules_and_evidence(operator, sensor, deployment):
    items = [event(deployment, event_type="ssh.login.failed", source_session_id="ssh-fixture", source_seq=i,
        payload={"username": "root", "password": "never-export"}, provenance="lab-fixture") for i in range(5)]
    items.append(event(deployment, event_type="ssh.command", source_session_id="ssh-fixture", source_seq=6,
        payload={"command": "wget https://example.invalid/sample"}, provenance="lab-fixture"))
    response = operator.post("/agent/v1/events/batch", json={"events": items}, headers=sensor["headers"])
    assert response.json()["inserted"] == 6
    sessions = operator.get("/api/v1/sessions").json()
    assert len(sessions) == 1
    detail = operator.get('/api/v1/sessions/' + sessions[0]["id"]).json()
    findings = detail["findings"]
    assert {f["rule_id"] for f in findings} == {"download-intent", "repeated-login-failure"}
    assert next(f for f in findings if f["rule_id"] == "download-intent")["observation"] == "intent"
    assert len(next(f for f in findings if f["rule_id"] == "repeated-login-failure")["evidence_ids"]) == 5
    exported = operator.post("/api/v1/exports", json={"session_id": sessions[0]["id"]}).json()
    assert exported["total"] == 6 and "never-export" not in json.dumps(exported)
    assert len(exported["sha256"]) == 64


def test_old_generation_keeps_exact_profile_version(operator, sensor, profile, deployment):
    old = event(deployment)
    version = operator.post(f'/api/v1/profiles/{profile["id"]}/versions', json={"config": {"adapter": "http", "hostname": "new-host"}}).json()
    updated = operator.post(f'/api/v1/deployments/{deployment["id"]}/redeploy', json={"profile_version_id": version["id"]}).json()
    assert updated["runtime_generation"] != deployment["runtime_generation"]
    assert operator.post("/agent/v1/events/batch", json={"events": [old]}, headers=sensor["headers"]).json()["inserted"] == 1
    saved = operator.get("/api/v1/events").json()["items"][0]
    assert saved["profile_version_id"] == deployment["profile_version_id"]


def test_event_filters_and_overview(operator, sensor, deployment):
    items = [event(deployment, payload={"path": "/opt/decoy/notes.txt", "decoy_access": True}),
        event(deployment, source_ip="192.0.2.20", event_type="ssh.connect")]
    operator.post("/agent/v1/events/batch", json={"events": items}, headers=sensor["headers"])
    assert operator.get("/api/v1/events", params={"q": "notes.txt"}).json()["total"] == 1
    assert operator.get("/api/v1/events", params={"source_ip": "192.0.2.20"}).json()["total"] == 1
    overview = operator.get("/api/v1/overview")
    assert overview.status_code == 200
    assert overview.json()["events_24h"] == 2
    assert sum(x["count"] for x in overview.json()["histogram"]) == 2
    assert overview.json()["findings_24h"] == 1


def test_body_limit_does_not_expose_input(operator):
    assert operator.post("/api/v1/profiles", content=b"x" * 530000, headers={"Content-Type": "application/json"}).status_code == 413
    result = operator.post("/api/v1/auth/login", json={"username": "tester", "password": "secret-invalid-value", "extra": 1})
    assert result.status_code == 422 and "secret-invalid-value" not in result.text


def test_atomic_audit_and_stream_rollback(database):
    with pytest.raises(RuntimeError):
        with database.unit_of_work() as u:
            u.lock_write()
            u.audit("tester", "must.rollback", "test")
            u.emit("test", {"value": 1})
            raise RuntimeError("simulated command failure")
    with database.sessions() as s:
        assert s.get(StreamState, 1).position == 0
        assert s.scalar(select(func.count()).select_from(Audit)) == 0
        assert s.scalar(select(func.count()).select_from(StreamEntry)) == 0


def test_stream_cursor_cannot_overtake_uncommitted_writer(database):
    locked, release, second_started = threading.Event(), threading.Event(), threading.Event()

    def first():
        with database.unit_of_work() as u:
            u.lock_write()
            u.emit("first", {})
            locked.set()
            assert release.wait(3)

    def second():
        assert locked.wait(3)
        second_started.set()
        with database.unit_of_work() as u:
            u.lock_write()
            u.emit("second", {})

    with ThreadPoolExecutor(2) as pool:
        a, b = pool.submit(first), pool.submit(second)
        assert second_started.wait(3)
        with database.sessions() as s:
            assert s.get(StreamState, 1).position == 0
        release.set()
        a.result(timeout=5)
        b.result(timeout=5)
    with database.sessions() as s:
        rows = list(s.scalars(select(StreamEntry).order_by(StreamEntry.position)))
        assert [(x.position, x.kind) for x in rows] == [(1, "first"), (2, "second")]


def test_spool_restart_ack_and_quota(tmp_path):
    path = tmp_path / "queue.sqlite"
    spool = Spool(path, quota=256)
    item = {"event_id": "one", "payload": "synthetic"}
    spool.collect("source", "10", [item])
    spool.db.close()
    restored = Spool(path, quota=256)
    assert restored.cursor("source") == "10" and restored.batch() == [item]
    restored.collect("source", "11", [item, {"event_id": "two", "payload": "x" * 500}])
    assert restored.metrics()["queued_events"] == 1
    assert restored.metrics()["dropped_events"] == 1
    restored.acknowledge(["one"], [])
    assert restored.batch() == []
    restored.collect("source", "12", [item])
    assert restored.batch() == []  # acknowledged overlap cannot re-enter the outbox
