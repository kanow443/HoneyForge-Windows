"""CTF scoring uses a placed honeytoken; analyst flags never alter raw evidence."""
from honeyforge.infrastructure.models import Deployment, Event, EventFlag, FlagSolve
from tests.test_backend import event


def login_as(client, username, password):
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200
    client.headers["X-CSRF-Token"] = response.json()["csrf_token"]
    return response.json()


def test_event_flags_are_audited_and_role_checked(operator, sensor, deployment, database):
    original = event(deployment)
    assert operator.post("/agent/v1/events/batch", json={"events": [original]}, headers=sensor["headers"]).status_code == 200
    observed = operator.get("/api/v1/events").json()["items"][0]
    path = f"/api/v1/events/{observed['id']}/flags"
    command = {"flag": "suspicious", "enabled": True, "note": "Повторный вход"}
    assert operator.post(path, json=command).json()["flags"][0]["note"] == "Повторный вход"
    assert operator.get("/api/v1/events?flag=suspicious").json()["total"] == 1
    assert operator.get("/api/v1/events?flag=reviewed").json()["total"] == 0
    assert len(operator.post(path, json=command).json()["flags"]) == 1
    with database.sessions() as s:
        assert s.get(Event, observed["id"]).payload == observed["payload"]
        assert len(s.query(EventFlag).all()) == 1
    operator.post("/api/v1/users", json={"username": "readonly", "password": "readonly-password-123", "role": "viewer"})
    login_as(operator, "readonly", "readonly-password-123")
    assert operator.post(path, json=command).status_code == 403
    login_as(operator, "tester", "testing-password-123")
    assert operator.post(path, json={**command, "enabled": False}).json()["flags"] == []
    assert operator.get("/api/v1/events?flag=suspicious").json()["total"] == 0


def test_ctf_role_scope_score_once_and_revoke(operator, sensor, profile, deployment, database):
    token = operator.post("/api/v1/honeytokens", json={
        "profile_version_id": profile["versions"][0]["id"], "name": "CTF marker", "kind": "url"
    }).json()
    operator.post(f"/api/v1/deployments/{deployment['id']}/redeploy", json={})
    binding = next(t for t in operator.get("/api/v1/honeytokens").json() if t["id"] == token["id"])["bindings"][0]
    payload = {
        "binding_id": binding["id"], "title": "Найти резервный ключ", "points": 150
    }
    assert operator.post("/api/v1/flags/challenges", json=payload).status_code == 409
    with database.sessions.begin() as s:
        s.get(Deployment, deployment["id"]).observed_state = "running"
    created = operator.post("/api/v1/flags/challenges", json=payload)
    assert created.status_code == 201, created.text
    challenge = created.json()
    assert challenge["active"]
    operator.post("/api/v1/users", json={"username": "team-uni", "password": "participant-password-123", "role": "participant"})
    login_as(operator, "team-uni", "participant-password-123")
    assert operator.get("/api/v1/events").status_code == 403
    assert operator.get("/api/v1/honeytokens").status_code == 403
    listed = operator.get("/api/v1/flags/challenges").json()
    assert len(listed) == 1 and "binding_id" not in listed[0]
    assert binding["public_value"] not in str(listed)
    assert operator.post("/api/v1/flags/submit", json={"challenge_id": challenge["id"], "flag": "HF{wrong}"}).status_code == 400
    answer = "HF{" + binding["public_value"] + "}"
    assert operator.post("/api/v1/flags/submit", json={"challenge_id": challenge["id"], "flag": answer}).json()["points"] == 150
    assert operator.post("/api/v1/flags/submit", json={"challenge_id": challenge["id"], "flag": answer}).status_code == 409
    assert operator.get("/api/v1/flags/scoreboard").json() == [{"username": "team-uni", "points": 150, "solves": 1}]
    with database.sessions() as s:
        assert len(s.query(FlagSolve).all()) == 1
    login_as(operator, "tester", "testing-password-123")
    operator.post(f"/api/v1/honeytokens/{token['id']}/revoke")
    assert operator.get("/api/v1/flags/admin/challenges").json()[0]["active"] is False
