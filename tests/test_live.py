import hashlib
import json
import struct
import threading
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest

from honeyforge.agent.collector import DockerCollector, terminal_text
from honeyforge.agent.network import decode_metadata
from honeyforge.agent.policies import PolicyExecutor, SourceFirewall
from honeyforge.agent.spool import Spool
from honeyforge.infrastructure.models import Host, SourceBlock, now
from honeyforge.sensors.terminal_capture import OutputCapture
from tests.test_backend import claim, event


def ingest(operator, sensor, deployment, **values):
    item = event(deployment, source_session_id="live-session", **values)
    result = operator.post("/agent/v1/events/batch", json={"events": [item]}, headers=sensor["headers"])
    assert result.status_code == 200 and result.json()["inserted"] == 1
    return operator.get("/api/v1/sessions").json()[0]["id"]


def running(operator, sensor):
    job = claim(operator, sensor)
    result = operator.post(f'/agent/v1/jobs/{job["id"]}/result',
        json={"attempt": job["attempt"], "succeeded": True}, headers=sensor["headers"])
    assert result.status_code == 200


def checksum(document):
    data = dict(document)
    expected = data.pop("sha256")
    actual = hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()).hexdigest()
    assert actual == expected


def test_playback_snapshot_pagination_late_events_and_dedup(operator, sensor, deployment, database):
    session = ingest(operator, sensor, deployment, source_seq=9)
    ingest(operator, sensor, deployment, source_seq=1, observed_at=(now() - timedelta(minutes=1)).isoformat())
    path = f"/api/v1/sessions/{session}/playback"
    first = operator.get(path, params={"limit": 1}).json()
    assert first["has_more"] and first["items"][0]["source_seq"] == 9
    second = operator.get(path, params={"after": first["next_cursor"], "limit": 1}).json()
    assert not second["has_more"] and second["items"][0]["source_seq"] == 1
    assert second["next_cursor"] == second["watermark"]
    assert first["items"][0]["ingest_position"] < second["items"][0]["ingest_position"]
    ingest(operator, sensor, deployment, source_seq=2)
    continuation = operator.get(path, params={"after": second["next_cursor"]}).json()
    assert len(continuation["items"]) == 1 and continuation["total"] == 3
    assert operator.get(path, params={"after": continuation["watermark"] + 1}).status_code == 409
    query = operator.app.state.queries
    assert query.stream(continuation["watermark"] + 100)["reset"]
    assert not query.stream(continuation["watermark"])["reset"]


def test_export_and_report_hash_exact_json_with_unicode(operator, sensor, deployment):
    session = ingest(operator, sensor, deployment, payload={"command": "cat /home/admin/счёт.txt"})
    checksum(operator.post("/api/v1/exports", json={"session_id": session}).json())
    report = operator.get(f"/api/v1/sessions/{session}/report").json()
    checksum(report)
    assert report["total"] == 1 and report["profile_version"]["id"] == deployment["profile_version_id"]
    assert report["events"][0]["observed_at"].endswith("Z")
    assert any("not a person" in line for line in report["limitations"])


def test_topology_inbound_edges_and_exact_severity(operator, sensor, deployment):
    session = ingest(operator, sensor, deployment, event_type="ssh.command", payload={"command": "wget https://example.invalid/a"})
    ingest(operator, sensor, deployment, event_type="network.traffic", source_ip="172.19.0.2", payload={"outbound_packets": 5})
    result = operator.get("/api/v1/topology").json()
    assert len(result["links"]) == 1
    edge = result["links"][0]
    assert edge["source_ip"] == "192.0.2.10" and edge["session_id"] == session
    assert edge["deployment_id"] == deployment["id"] and edge["severity"] == "high"
    assert result["sources"][0]["event_count"] == 1


def new_policy(operator, deployment, key="live-policy-01", **changes):
    return operator.post("/api/v1/source-blocks", json={"deployment_id": deployment["id"], "source_ip": "192.0.2.10",
        "ttl_seconds": 60, "reason": "Demo investigation", **changes}, headers={"Idempotency-Key": key})


def test_policy_ack_fencing_idempotency_cancel_expiry_offline(operator, sensor, deployment, database):
    running(operator, sensor)
    ingest(operator, sensor, deployment)
    result = new_policy(operator, deployment)
    assert result.status_code == 202
    policy = result.json()
    assert policy["state"] == "pending" and policy["observed_revision"] == 0
    assert new_policy(operator, deployment).json()["id"] == policy["id"]
    assert new_policy(operator, deployment, reason="Different").status_code == 409
    assert new_policy(operator, deployment, key="live-policy-02").status_code == 409
    policies = operator.get("/agent/v1/source-policies", headers=sensor["headers"]).json()
    assert policies[0]["desired_state"] == "blocked"
    ack = f'/agent/v1/source-policies/{policy["id"]}/ack'
    assert operator.post(ack, json={"revision": 2, "state": "applied"}, headers=sensor["headers"]).status_code == 409
    assert operator.post(ack, json={"revision": 1, "state": "applied"}, headers=sensor["headers"]).status_code == 200
    before = len(operator.get("/api/v1/audit").json())
    operator.post(ack, json={"revision": 1, "state": "applied"}, headers=sensor["headers"])
    assert len(operator.get("/api/v1/audit").json()) == before
    assert operator.get("/api/v1/source-blocks").json()[0]["state"] == "applied"
    with database.sessions.begin() as s:
        s.get(Host, sensor["host_id"]).last_seen = now() - timedelta(minutes=1)
    assert operator.get("/api/v1/source-blocks").json()[0]["state"] == "unknown"
    operator.post("/agent/v1/heartbeat", json={}, headers=sensor["headers"])
    cancel = f'/api/v1/source-blocks/{policy["id"]}/cancel'
    assert operator.post(cancel, json={"revision": 9}).status_code == 409
    cancelled = operator.post(cancel, json={"revision": 1}).json()
    assert cancelled["revision"] == 2 and cancelled["state"] != "cancelled"
    assert operator.post(ack, json={"revision": 1, "state": "applied"}, headers=sensor["headers"]).status_code == 409
    assert operator.post(ack, json={"revision": 2, "state": "released"}, headers=sensor["headers"]).status_code == 200
    assert operator.get("/api/v1/source-blocks").json()[0]["state"] == "cancelled"
    second = new_policy(operator, deployment, key="live-policy-03").json()
    with database.sessions.begin() as s:
        s.get(SourceBlock, second["id"]).expires_at = now() - timedelta(seconds=1)
    policies = operator.get("/agent/v1/source-policies", headers=sensor["headers"]).json()
    assert policies[0]["desired_state"] == "released"
    operator.post(f'/agent/v1/source-policies/{second["id"]}/ack', json={"revision": 1, "state": "released"}, headers=sensor["headers"])
    assert operator.get("/api/v1/source-blocks").json()[0]["state"] == "expired"


def test_policy_source_validation_host_scope_and_generation(operator, sensor, deployment):
    running(operator, sensor)
    ingest(operator, sensor, deployment)
    for source in ["127.0.0.1", "0.0.0.0", "224.0.0.1", "169.254.1.2", "::1", "192.0.2.10; reboot", "255.255.255.255"]:
        assert new_policy(operator, deployment, source_ip=source).status_code == 422
    assert new_policy(operator, deployment, source_ip="192.0.2.11").status_code == 409
    policy = new_policy(operator, deployment).json()
    token = operator.post("/api/v1/hosts/enrollment-tokens").json()["token"]
    other = operator.post("/agent/v1/enroll", json={"token": token, "name": "Other", "address": "192.0.2.99", "capabilities": ["http"]}).json()
    assert operator.post(f'/agent/v1/source-policies/{policy["id"]}/ack', json={"revision": 1, "state": "applied"},
        headers={"Authorization": "Bearer " + other["key"]}).status_code == 403
    operator.post(f'/api/v1/deployments/{deployment["id"]}/redeploy', json={})
    assert operator.get("/agent/v1/source-policies", headers=sensor["headers"]).json()[0]["desired_state"] == "released"
    assert operator.post(f'/agent/v1/source-policies/{policy["id"]}/ack', json={"revision": 1, "state": "applied"}, headers=sensor["headers"]).status_code == 409


def test_cases_conflict_and_audited_updates(operator, sensor, deployment):
    session = ingest(operator, sensor, deployment)
    assert operator.post("/api/v1/cases", json={"title": "Unknown", "session_ids": [str(uuid4())]}).status_code == 404
    response = operator.post("/api/v1/cases", json={"title": "SSH investigation", "session_ids": [session, session], "note": "Check evidence"})
    assert response.status_code == 201
    case = response.json()
    assert case["session_ids"] == [session]
    path = f'/api/v1/cases/{case["id"]}'
    update = operator.post(path, json={"revision": 1, "status": "investigating", "note": "Confirmed"})
    assert update.json()["revision"] == 2
    assert operator.post(path, json={"revision": 1, "status": "closed"}).status_code == 409
    assert operator.get("/api/v1/cases").json()[0]["note"] == "Confirmed"
    assert {a["action"] for a in operator.get("/api/v1/audit").json()} >= {"case.created", "case.updated"}


class MemoryFirewall:
    def __init__(self):
        self.active = set()
        self.fail = False

    def apply(self, policies, instant):
        if self.fail:
            raise OSError("unavailable")
        self.active = {str(p.id) for p in policies if p.desired_state == "blocked" and p.expires_at > instant}
        return {str(p.id): "applied" if str(p.id) in self.active else "released" for p in policies}


def test_local_policy_restart_expiry_and_failed_application(tmp_path):
    instant = now()
    policy = {"id": str(uuid4()), "deployment_id": str(uuid4()), "generation": str(uuid4()), "source_ip": "192.0.2.10",
        "expires_at": (instant + timedelta(seconds=60)).isoformat(), "revision": 1, "desired_state": "blocked"}
    path, firewall = tmp_path / "policies.json", MemoryFirewall()
    executor = PolicyExecutor(path, firewall, lambda: instant)
    assert executor.reconcile([policy])[0]["state"] == "applied"
    assert policy["id"] in firewall.active and path.stat().st_mode & 0o777 == 0o600
    restored = PolicyExecutor(path, firewall, lambda: instant + timedelta(seconds=61))
    assert restored.reconcile()[0]["state"] == "released" and not firewall.active
    firewall.fail = True
    assert executor.reconcile()[0]["state"] == "error"
    with pytest.raises(ValueError):
        executor.reconcile([{**policy, "revision": 0}])
    firewall.fail = False
    executor.reconcile([])
    assert not firewall.active and json.loads(path.read_text()) == []


def test_firewall_rule_scope_is_new_inbound_only(monkeypatch):
    deployment, generation = str(uuid4()), str(uuid4())
    container = SimpleNamespace(labels={"hf.deployment": deployment, "hf.generation": generation})
    runtime = SimpleNamespace(host_id="test", client=SimpleNamespace(containers=SimpleNamespace(list=lambda **kw: [container])))
    calls = []

    def run(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(returncode=1 if "-C" in args and "DOCKER-USER" in args else 0)

    monkeypatch.setattr("honeyforge.agent.policies.subprocess.run", run)
    instant = now()
    from honeyforge.application.schemas import AgentPolicy
    policy = AgentPolicy(id=uuid4(), deployment_id=deployment, generation=generation, source_ip="192.0.2.10",
        expires_at=instant + timedelta(seconds=60), revision=1, desired_state="blocked")
    firewall = SourceFirewall(runtime)
    assert firewall.apply([policy], instant)[str(policy.id)] == "applied"
    restore = next(kw["input"] for args, kw in calls if args[0] == "iptables-restore")
    assert "--ctstate NEW -j DROP" in restore and "-s 192.0.2.10/32" in restore
    jump = next(args for args, kw in calls if "-I" in args)
    assert "-o" in jump and SourceFirewall.names(deployment)[0] in jump
    assert "INPUT" not in jump and "FORWARD" not in jump
    protected = SourceFirewall(runtime, ["192.0.2.10"])
    assert protected.apply([policy], instant)[str(policy.id)] == "error"


def test_packet_parser_bounds_fragments_and_transport():
    from socket import inet_aton
    packet = bytearray(54)
    packet[12:14] = b"\x08\x00"
    packet[14], packet[23] = 0x45, 6
    packet[26:30], packet[30:34] = inet_aton("192.0.2.10"), inet_aton("172.19.0.2")
    struct.pack_into("!HH", packet, 34, 50000, 2222)
    packet[47] = 2
    parsed = decode_metadata(bytes(packet))
    assert parsed["source_ip"] == "192.0.2.10" and parsed["destination_port"] == 2222 and parsed["tcp_flags"] == 2
    assert decode_metadata(bytes(packet[:53])) is None
    packet[21] = 1
    assert decode_metadata(bytes(packet)) is None
    assert decode_metadata(b"short") is None


def test_concurrent_collector_and_upload_ack_preserve_outbox(tmp_path):
    spool = Spool(tmp_path / "threaded.sqlite3")
    finished = threading.Event()
    received = set()

    def collect():
        for i in range(300):
            spool.collect("log", str(i), [{"event_id": str(i), "payload": {"text": "captured"}}])
        finished.set()

    worker = threading.Thread(target=collect)
    worker.start()
    while not finished.is_set() or spool.metrics()["queued_events"]:
        batch = spool.batch()
        received.update(e["event_id"] for e in batch)
        spool.acknowledge([e["event_id"] for e in batch], [])
    worker.join()
    assert received == {str(i) for i in range(300)}
    assert spool.cursor("log") == "299" and spool.metrics().get("dropped_events", 0) == 0


def test_terminal_capture_unicode_bounds_loss_and_plaintext():
    records = []

    class Timer:
        def active(self):
            return True

        def cancel(self):
            pass

    def emit(kind, fmt, **fields):
        records.append({"kind": kind, **fields})

    capture = OutputCapture(emit, lambda delay, fn: Timer(), budget=20, pending_limit=20, frame_limit=3)
    raw = "Привет\n".encode()
    capture.add(raw)
    capture.close()
    assert "".join(r["text"] for r in records if r["kind"].endswith("output")) == "Привет\n"
    assert all(r["byte_count"] <= 3 for r in records)
    records.clear()
    capture = OutputCapture(emit, lambda delay, fn: Timer(), budget=8, pending_limit=8, frame_limit=4)
    capture.add(b"0123456789abcdef")
    assert len(capture.buffer) == 8
    capture.close()
    assert "".join(r["text"] for r in records if "text" in r) == "01234567"
    assert sum(r["kind"].endswith("truncated") for r in records) == 1
    assert terminal_text("\x1b[31mred\x1b[0m\r\n\x1b]0;bad-title\x07ok\x00\u202e") == "red\nok"
    assert terminal_text("<script>alert(1)</script>") == "<script>alert(1)</script>"


def test_log_overlap_does_not_starve_same_timestamp_batch(tmp_path):
    spool = Spool(tmp_path / "collector.sqlite3")
    stamp = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    deployment, generation = str(uuid4()), str(uuid4())
    lines = [(stamp + " " + json.dumps({"event_type": "http.request", "source_ip": "192.0.2.10",
        "observed_at": stamp, "payload": {"path": f"/{i}"}})).encode() for i in range(1100)]
    container = SimpleNamespace(id="log", labels={"hf.adapter": "http", "hf.deployment": deployment,
        "hf.generation": generation}, logs=lambda **kwargs: iter(lines))
    client = SimpleNamespace(containers=SimpleNamespace(list=lambda **kwargs: [container]))
    collector = DockerCollector(client, spool, "host")
    collector.collect()
    assert spool.metrics()["queued_events"] == 1000
    collector.collect()
    assert spool.metrics()["queued_events"] == 1100
    collector.collect()
    assert spool.metrics()["queued_events"] == 1100


def test_removed_container_does_not_stop_other_collectors(tmp_path):
    from docker.errors import APIError
    from requests import Response
    response = Response()
    response.status_code = 409
    def removed(**kwargs):
        raise APIError('being removed', response=response)
    stamp = datetime.now(UTC).isoformat().replace('+00:00', 'Z')
    line = (stamp + ' ' + json.dumps({'event_type':'http.request','source_ip':'192.0.2.1',
        'observed_at':stamp,'payload':{'path':'/still-collecting'}})).encode()
    dead = SimpleNamespace(id='dead', logs=removed)
    healthy = SimpleNamespace(id='healthy', labels={'hf.adapter':'http','hf.deployment':str(uuid4()),
        'hf.generation':str(uuid4())}, logs=lambda **kwargs: iter([line]))
    spool = Spool(tmp_path / 'collector.sqlite3')
    collector = DockerCollector(SimpleNamespace(containers=SimpleNamespace(list=lambda **kw:[dead,healthy])), spool, 'host')
    collector.collect()
    assert spool.metrics()['queued_events'] == 1
