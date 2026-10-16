from datetime import timedelta
from uuid import uuid4

import pytest

from honeyforge.infrastructure.models import IntegrationToken, now
from honeyforge.infrastructure.siem_receiver import Receiver
from tests.test_backend import event
from tests.test_live import ingest, running


def test_ecs_pagination_scope_receiver_dedup_and_revocation(operator, sensor, deployment, tmp_path):
    first = event(deployment, source_session_id="integration", payload={"message": "controlled"})
    second = event(deployment, source_session_id="integration", event_id=str(uuid4()))
    operator.post("/agent/v1/events/batch", json={"events": [first, second]}, headers=sensor["headers"])
    issued = operator.post("/api/v1/integration-tokens", json={"name": "Test receiver", "deployment_id": deployment["id"]})
    assert issued.status_code == 201
    body = issued.json()
    headers = {"Authorization": "Bearer " + body["token"]}
    page = operator.get("/integration/v1/events", params={"limit": 1}, headers=headers).json()
    assert len(page["items"]) == 1 and page["has_more"]
    assert page["items"][0]["event"]["action"] == "http.request"
    assert page["items"][0]["source"]["ip"] == first["source_ip"]
    receiver = Receiver(tmp_path / "receiver.sqlite3", "http://localhost")
    receiver.accept(page, 0)
    after = receiver.cursor()
    page2 = operator.get("/integration/v1/events", params={"after": after}, headers=headers).json()
    receiver.accept(page2, after)
    assert receiver.db.execute("SELECT count(*) FROM events").fetchone()[0] == 2
    receiver.accept({**page2, "next_cursor": receiver.cursor()}, receiver.cursor())
    assert receiver.db.execute("SELECT count(*) FROM events").fetchone()[0] == 2
    with pytest.raises(ValueError):
        receiver.accept({**page2, "reset_required": True}, receiver.cursor())
    assert operator.post("/agent/v1/jobs/claim", headers=headers).status_code == 401
    assert "token_hash" not in operator.get("/api/v1/integration-tokens").text
    operator.post(f'/api/v1/integration-tokens/{body["integration"]["id"]}/revoke')
    assert operator.get("/integration/v1/events", headers=headers).status_code == 401
    receiver.close()


def test_response_requires_explicit_scope_is_idempotent_and_revocation_releases_policy(operator, sensor, deployment):
    running(operator, sensor)
    ingest(operator, sensor, deployment)
    event_id = operator.get("/api/v1/events").json()["items"][0]["id"]
    assert operator.post("/api/v1/integration-tokens", json={"name": "Invalid", "allow_response": True}).status_code == 422
    readonly = operator.post("/api/v1/integration-tokens", json={"name": "Readonly"}).json()
    payload = {"event_id": event_id, "reason": "Controlled response", "ttl_seconds": 60}
    assert operator.post("/integration/v1/source-blocks", json=payload,
        headers={"Authorization": "Bearer " + readonly["token"], "Idempotency-Key": "response-01"}).status_code == 403
    active = operator.post("/api/v1/integration-tokens", json={"name": "Bounded responder", "deployment_id": deployment["id"], "allow_response": True}).json()
    headers = {"Authorization": "Bearer " + active["token"], "Idempotency-Key": "response-01"}
    response = operator.post("/integration/v1/source-blocks", json=payload, headers=headers)
    assert response.status_code == 202, response.text
    row = response.json()
    assert operator.post("/integration/v1/source-blocks", json=payload, headers=headers).json()["id"] == row["id"]
    assert operator.get(f'/integration/v1/source-blocks/{row["id"]}', headers=headers).status_code == 200
    assert operator.post("/integration/v1/source-blocks", json={**payload, "ttl_seconds": 3600}, headers=headers).status_code == 422
    operator.post(f'/api/v1/integration-tokens/{active["integration"]["id"]}/revoke')
    assert operator.get("/api/v1/source-blocks").json()[0]["desired_state"] == "released"
    assert operator.post("/integration/v1/source-blocks", json=payload, headers=headers).status_code == 401


def test_expired_credential_and_stale_runtime_evidence_cannot_execute(operator, sensor, deployment, database):
    running(operator, sensor)
    ingest(operator, sensor, deployment)
    event_id = operator.get("/api/v1/events").json()["items"][0]["id"]
    issued = operator.post("/api/v1/integration-tokens", json={"name": "Response", "deployment_id": deployment["id"], "allow_response": True}).json()
    headers = {"Authorization": "Bearer " + issued["token"], "Idempotency-Key": "response-01"}
    operator.post(f'/api/v1/deployments/{deployment["id"]}/redeploy', json={})
    assert operator.post("/integration/v1/source-blocks", json={"event_id": event_id, "reason": "Old event"}, headers=headers).status_code == 409
    with database.sessions.begin() as session:
        session.get(IntegrationToken, issued["integration"]["id"]).expires_at = now() - timedelta(seconds=1)
    assert operator.get("/integration/v1/events", headers=headers).status_code == 401
