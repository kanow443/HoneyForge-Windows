import hashlib
from datetime import timedelta
from uuid import uuid4

from sqlalchemy import select

from honeyforge.application.evidence import EvidenceService
from honeyforge.application.retention import RetentionService
from honeyforge.infrastructure.models import Event, EvidenceArtifact, now
from honeyforge.infrastructure.settings import Settings


def test_pin_retention_receiving_and_interrupted_cleanup(operator, deployment, sensor, database, tmp_path):
    event = {"event_id": str(uuid4()), "deployment_id": deployment["id"], "generation": deployment["runtime_generation"],
        "event_type": "http.request", "source_ip": "203.0.113.66", "source_session_id": "retained-session",
        "observed_at": now().isoformat(), "payload": {}}
    operator.post("/agent/v1/events/batch", json={"events": [event]}, headers=sensor["headers"])
    session_id = operator.get("/api/v1/events").json()["items"][0]["session_id"]
    case = operator.post("/api/v1/cases", json={"title": "Preserved proof", "session_ids": [session_id]}).json()
    pin_path = f'/api/v1/cases/{case["id"]}/retention'
    assert operator.post(pin_path, json={"revision": 1, "pinned": True}).json()["retention_pinned"]
    assert operator.post(pin_path, json={"revision": 1, "pinned": False}).status_code == 409
    config = Settings(artifact_dir=str(tmp_path / "files"))
    evidence = EvidenceService(database, config)
    retention = RetentionService(database, config, evidence)
    content = b"Evidence must survive pin"
    stamp = now()
    fields = dict(host_id=sensor["host_id"], deployment_id=deployment["id"], generation=deployment["runtime_generation"],
        kind="file", sha256=hashlib.sha256(content).hexdigest(), size_bytes=len(content),
        started_at=stamp, ended_at=stamp, expires_at=stamp - timedelta(days=1))
    with database.sessions.begin() as s:
        s.scalars(select(Event)).one().created_at = now() - timedelta(days=8)
        available = EvidenceArtifact(**fields, state="available", source_session_id="retained-session")
        receiving = EvidenceArtifact(**fields, state="receiving")
        interrupted = EvidenceArtifact(**fields, state="purging", source_session_id="other-session")
        s.add_all([available, receiving, interrupted])
        s.flush()
        available_id, receiving_id, interrupted_id = available.id, receiving.id, interrupted.id
    for artifact_id in [available_id, interrupted_id]:
        evidence.path(artifact_id).write_bytes(content)
    assert retention.sweep()["artifacts"] == 1
    assert evidence.path(available_id).read_bytes() == content
    assert not evidence.path(interrupted_id).exists()
    assert retention.sweep()["events"] == 0
    with database.sessions() as s:
        assert s.get(EvidenceArtifact, receiving_id).state == "receiving"
        assert s.get(EvidenceArtifact, interrupted_id).state == "expired"
    assert operator.post(pin_path, json={"revision": 2, "pinned": False}).status_code == 200
    swept = retention.sweep()
    assert swept["events"] == 1 and swept["artifacts"] == 1
    assert not evidence.path(available_id).exists()
    assert retention.sweep()["events"] == 0
    assert operator.get("/api/v1/storage").json()["audit_retention_days"] == 30


def test_pin_cannot_accept_evidence_already_being_deleted(operator, deployment, sensor, database):
    event = {"event_id": str(uuid4()), "deployment_id": deployment["id"], "generation": deployment["runtime_generation"],
        "event_type": "http.request", "source_ip": "203.0.113.77", "source_session_id": "expiry-race",
        "observed_at": now().isoformat(), "payload": {}}
    operator.post("/agent/v1/events/batch", json={"events": [event]}, headers=sensor["headers"])
    session_id = operator.get("/api/v1/events").json()["items"][0]["session_id"]
    case = operator.post("/api/v1/cases", json={"title": "Expiry concurrency", "session_ids": [session_id]}).json()
    with database.sessions.begin() as s:
        stamp = now()
        s.add(EvidenceArtifact(host_id=sensor["host_id"], deployment_id=deployment["id"],
            generation=deployment["runtime_generation"], source_session_id="expiry-race", kind="file",
            sha256="0" * 64, size_bytes=1, started_at=stamp, ended_at=stamp,
            expires_at=stamp - timedelta(days=1), state="purging"))
    response = operator.post(f'/api/v1/cases/{case["id"]}/retention', json={"revision": 1, "pinned": True})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "evidence_expiry_in_progress"
    unchanged = next(c for c in operator.get("/api/v1/cases").json() if c["id"] == case["id"])
    assert unchanged["revision"] == 1 and not unchanged["retention_pinned"]
