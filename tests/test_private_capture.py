import json
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from cryptography.exceptions import InvalidTag
from sqlalchemy import select

from honeyforge.infrastructure.capture_keys import CaptureKeys
from honeyforge.infrastructure.models import Audit, PrivateCapture, User
from honeyforge.sensors.sealed_capture import seal


def test_envelope_authenticates_scope_and_preserves_key(tmp_path):
    keys = CaptureKeys(tmp_path / "keys")
    public = keys.public()
    context = {"capture_id": str(uuid4()), "host_id": "host", "deployment_id": "trap", "generation": "run",
        "event_id": "event", "source_session_id": "session", "event_type": "http.login"}
    envelope = seal(public["public_key"], public["key_id"], context, {"password": "Synthetic-Sensitive-123"})
    assert "Synthetic-Sensitive-123" not in json.dumps(envelope)
    assert CaptureKeys(tmp_path / "keys").public() == public
    assert keys.decrypt(envelope)["password"] == "Synthetic-Sensitive-123"
    envelope["context"]["event_id"] = "other"
    with pytest.raises(InvalidTag):
        keys.decrypt(envelope)


def test_private_capture_atomic_dedupe_reveal_permissions(operator, deployment, sensor, database):
    runtimes = operator.get("/agent/v1/runtimes", headers=sensor["headers"]).json()
    public = runtimes[0]["capture_key"]
    item = {"event_id": str(uuid4()), "deployment_id": deployment["id"], "generation": deployment["runtime_generation"],
        "event_type": "http.login", "source_ip": "203.0.113.44", "source_session_id": "capture-session",
        "observed_at": datetime.now(UTC).isoformat(), "payload": {"username": "synthetic"}}
    context = {k: item[k] for k in ["event_id", "deployment_id", "generation", "source_session_id", "event_type"]}
    context.update(host_id=sensor["host_id"], capture_id=str(uuid4()))
    item["private_capture"] = seal(public["public_key"], public["key_id"], context, {"password": "Synthetic-Unique-234"})
    for _ in range(2):
        result = operator.post("/agent/v1/events/batch", headers=sensor["headers"], json={"events": [item]})
        assert result.status_code == 200 and result.json()["accepted"] == [item["event_id"]]
    page = operator.get("/api/v1/events").json()
    assert "Synthetic-Unique-234" not in json.dumps(page)
    event = page["items"][0]
    assert event["private_capture_available"]
    reveal = operator.post(f'/api/v1/events/{event["id"]}/private-capture')
    assert reveal.status_code == 200 and reveal.json()["content"]["password"] == "Synthetic-Unique-234"
    assert reveal.headers["cache-control"] == "no-store"
    with database.sessions.begin() as s:
        assert len(list(s.scalars(select(PrivateCapture)))) == 1
        assert "Synthetic-Unique-234" not in json.dumps([a.details for a in s.scalars(select(Audit))])
        s.scalars(select(User).where(User.username == "tester")).one().role = "viewer"
    assert operator.post(f'/api/v1/events/{event["id"]}/private-capture').status_code == 403
    item["event_id"] = str(uuid4())
    response = operator.post("/agent/v1/events/batch", headers=sensor["headers"], json={"events": [item]})
    assert response.json()["rejected"][0]["reason"] == "invalid_private_capture"
