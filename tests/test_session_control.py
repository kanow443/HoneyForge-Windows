from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest

from honeyforge.agent.collector import DockerCollector
from honeyforge.agent.policies import PolicyExecutor
from honeyforge.application.schemas import TelemetryEvent
from honeyforge.infrastructure.models import now
from honeyforge.sensors.session_control import SessionRegistry
from tests.test_live import ingest, new_policy, running


def test_termination_closes_only_matching_transports_and_is_idempotent():
    registry = SessionRegistry()
    ids = ["a" * 12, "b" * 12, "c" * 12]
    calls = []
    for identifier, source in zip(ids, ["192.0.2.10", "192.0.2.10", "192.0.2.11"], strict=True):
        registry.register(identifier, source, SimpleNamespace(abortConnection=lambda key=identifier: calls.append(key)))
    operation = str(uuid4())
    key = registry.terminate("192.0.2.10", operation, 1)
    assert calls == ids[:2]
    assert registry.result(key)["termination_state"] == "pending"
    registry.unregister(ids[0])
    assert registry.result(key)["terminated_sessions"] == [ids[0]]
    registry.unregister(ids[1])
    assert registry.result(key)["termination_state"] == "completed"
    registry.terminate("192.0.2.10", operation, 1)
    assert calls == ids[:2] and ids[2] in registry.sessions
    with pytest.raises(ValueError):
        registry.terminate("192.0.2.11", operation, 1)
    with pytest.raises(ValueError):
        registry.terminate("192.0.2.10;id", operation, 1)


def test_registry_refuses_untracked_connections_at_capacity():
    registry, aborted = SessionRegistry(maximum=1), []
    transport = SimpleNamespace(abortConnection=lambda: aborted.append(True))
    assert registry.register("a" * 12, "192.0.2.10", transport)
    assert not registry.register("b" * 12, "192.0.2.11", transport)
    assert aborted == [True] and len(registry.sessions) == 1


def test_firewall_ack_does_not_imply_ssh_termination(operator, sensor):
    profile = operator.post("/api/v1/profiles", json={"name": "SSH control", "config": {"adapter": "cowrie"}}).json()
    deployment = operator.post("/api/v1/deployments", json={"name": "SSH control", "host_id": sensor["host_id"],
        "profile_version_id": profile["versions"][0]["id"], "port": 12223},
        headers={"Idempotency-Key": "ssh-control-test"}).json()
    running(operator, sensor)
    ingest(operator, sensor, deployment, event_type="ssh.connect")
    policy = new_policy(operator, deployment).json()
    assert policy["terminate_sessions"] and policy["termination_state"] == "pending"
    route = f'/agent/v1/source-policies/{policy["id"]}/ack'
    assert operator.post(route, json={"state": "applied", "revision": 1}, headers=sensor["headers"]).status_code == 200
    row = operator.get("/api/v1/source-blocks").json()[0]
    assert row["state"] == "applied" and row["termination_state"] == "pending"
    ack = {"state": "applied", "revision": 1, "termination_state": "completed", "terminated_sessions": ["a" * 12]}
    assert operator.post(route, json=ack, headers=sensor["headers"]).status_code == 200
    assert operator.post(route, json={**ack, "terminated_sessions": ["../bad"]}, headers=sensor["headers"]).status_code == 422
    # A sensor restart cannot erase already acknowledged closure evidence.
    operator.post(route, json={**ack, "terminated_sessions": []}, headers=sensor["headers"])
    assert operator.get("/api/v1/source-blocks").json()[0]["terminated_sessions"] == ["a" * 12]
    operator.post(f'/api/v1/source-blocks/{policy["id"]}/cancel', json={"revision": 1})
    operator.post(route, json={"state": "released", "revision": 2}, headers=sensor["headers"])
    row = operator.get("/api/v1/source-blocks").json()[0]
    assert row["state"] == "cancelled" and row["termination_state"] == "completed"


def test_termination_failure_does_not_erase_verified_firewall_state(tmp_path):
    class Firewall:
        def apply(self, policies, instant):
            return {str(p.id): "applied" for p in policies}

        def terminate(self, policy):
            raise OSError("Control socket is unavailable")

    instant = now()
    policy = {"id": str(uuid4()), "deployment_id": str(uuid4()), "generation": str(uuid4()), "source_ip": "192.0.2.10",
        "expires_at": (instant + timedelta(seconds=60)).isoformat(), "revision": 1, "desired_state": "blocked",
        "terminate_sessions": True}
    report = PolicyExecutor(tmp_path / "policies.json", Firewall(), lambda: instant).reconcile([policy])[0]
    assert report["state"] == "applied" and report["termination_state"] == "error"
    assert report["terminated_sessions"] == []


def test_client_and_file_observations_preserve_scope_without_claiming_identity_or_bytes():
    collector = DockerCollector(None, None, "host")
    container = SimpleNamespace(id="runtime", labels={"hf.adapter": "cowrie", "hf.deployment": str(uuid4()), "hf.generation": str(uuid4())})
    stamp = now()
    for event_id, fields, expected in [
        ("cowrie.client.version", {"version": "SSH-2.0-OpenSSH_9.9"}, "ssh.client.version"),
        ("cowrie.client.kex", {"hassh": "observed"}, "ssh.client.kex"),
        ("cowrie.session.file_download", {"url": "https://example.org/a", "shasum": "a" * 64}, "ssh.file.download"),
        ("cowrie.session.file_download.failed", {"error": "timeout"}, "ssh.file.download.failed"),
    ]:
        data = {"eventid": event_id, "session": "a" * 12, "src_ip": "192.0.2.10", **fields}
        result = collector.normalize(container, data, stamp, stamp.isoformat(), event_id.encode())
        TelemetryEvent.model_validate(result)
        assert result["event_type"] == expected and result["source_session_id"] == "a" * 12
        if expected.startswith("ssh.file"):
            assert result["payload"]["artifact_verified"] is False
        else:
            assert result["payload"]["identity"] == "unknown"
