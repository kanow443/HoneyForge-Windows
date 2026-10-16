import base64
import hashlib
import json
import struct
from types import SimpleNamespace
from uuid import uuid4

import pytest

from honeyforge.agent.evidence import PCAP_HEADER, EvidenceOutbox, PcapRecorder
from honeyforge.infrastructure.models import now


def manifest(deployment, content, **changes):
    stamp = now().isoformat()
    return {"id": str(uuid4()), "deployment_id": deployment["id"], "generation": deployment["runtime_generation"],
        "kind": "file", "sha256": hashlib.sha256(content).hexdigest(), "size_bytes": len(content),
        "started_at": stamp, "ended_at": stamp, "details": {"capture": "unit-fixture"}, **changes}


def chunk(content, offset=0):
    return {"offset": offset, "data_base64": base64.b64encode(content).decode()}


def test_artifact_upload_resume_dedup_conflict_hash_and_download(operator, sensor, deployment):
    content = b"controlled fixture" * 20000
    item = manifest(deployment, content)
    response = operator.post("/agent/v1/artifacts", json=item, headers=sensor["headers"])
    assert response.status_code == 200, response.text
    path = f'/agent/v1/artifacts/{item["id"]}/chunks'
    first = content[:262144]
    assert operator.post(path, json=chunk(first), headers=sensor["headers"]).json()["received_bytes"] == len(first)
    assert operator.post(path, json=chunk(first), headers=sensor["headers"]).json()["received_bytes"] == len(first)
    assert operator.post(path, json=chunk(b"different"), headers=sensor["headers"]).status_code == 409
    # Receiver state is persisted; re-announcing the manifest resumes at its committed offset.
    assert operator.post("/agent/v1/artifacts", json=item, headers=sensor["headers"]).json()["received_bytes"] == len(first)
    tail = content[len(first):]
    complete = operator.post(path, json=chunk(tail, len(first)), headers=sensor["headers"])
    assert complete.status_code == 200 and complete.json()["state"] == "available"
    assert operator.post(path, json=chunk(tail, len(first)), headers=sensor["headers"]).json()["state"] == "available"
    received = operator.get(f'/api/v1/artifacts/{item["id"]}/download')
    assert received.content == content and received.headers["x-content-sha256"] == item["sha256"]
    assert len(operator.get("/api/v1/artifacts", params={"deployment_id": deployment["id"]}).json()) == 1
    assert operator.post("/agent/v1/artifacts", json={**item, "sha256": "a" * 64}, headers=sensor["headers"]).status_code == 409


def test_wrong_hash_never_marks_bytes_available_and_foreign_agent_is_denied(operator, sensor, deployment):
    item = manifest(deployment, b"original")
    operator.post("/agent/v1/artifacts", json=item, headers=sensor["headers"])
    path = f'/agent/v1/artifacts/{item["id"]}/chunks'
    assert operator.post(path, json=chunk(b"modified"), headers=sensor["headers"]).status_code == 409
    assert operator.get(f'/api/v1/artifacts/{item["id"]}/download').status_code == 409
    token = operator.post("/api/v1/hosts/enrollment-tokens").json()["token"]
    second = operator.post("/agent/v1/enroll", json={"token": token, "name": "Other", "address": "192.0.2.11", "capabilities": ["http"]}).json()
    headers = {"Authorization": "Bearer " + second["key"]}
    assert operator.post(path, json=chunk(b"original"), headers=headers).status_code == 403
    assert operator.post("/agent/v1/artifacts", json=item, headers=headers).status_code == 403
    assert operator.post(path, json=chunk(b"original"), headers=sensor["headers"]).json()["state"] == "available"


def test_pcap_records_packet_bytes_non_ipv4_and_recovers_incomplete_tail(tmp_path):
    outbox = EvidenceOutbox(tmp_path, 100000)
    recorder = PcapRecorder(outbox, 65536, 30)
    container = SimpleNamespace(id="runtime", labels={"hf.deployment": str(uuid4()), "hf.generation": str(uuid4())})
    packet = b"\x00" * 12 + b"\x86\xdd" + b"controlled ipv6 frame"
    recorder.packet(container, "hfbridge", packet)
    path, metadata, _ = recorder.active["runtime"]
    outbox.write(path, b"incomplete")
    recovered = EvidenceOutbox(tmp_path, 100000)
    assert recovered.pending_count() == 1
    blob = next(tmp_path.glob("*.blob")).read_bytes()
    assert blob[:24] == PCAP_HEADER
    _, _, captured, full = struct.unpack("<IIII", blob[24:40])
    assert captured == full == len(packet) and blob[40:] == packet
    manifest = json.loads(next(tmp_path.glob("*.json")).read_text())
    assert manifest["sha256"] == hashlib.sha256(blob).hexdigest()
    assert manifest["details"]["packet_count"] == 1 and manifest["details"]["kernel_drops"] is None


def test_evidence_quota_never_silently_overwrites(tmp_path):
    outbox = EvidenceOutbox(tmp_path, 10)
    path = tmp_path / "private.part"
    outbox.write(path, b"12345")
    with pytest.raises(OSError):
        outbox.write(path, b"678901")
    assert path.read_bytes() == b"12345" and outbox.used == 5


def test_cowrie_file_uses_fixed_reader_and_is_independently_hashed(tmp_path):
    content = b"a harmless test artifact\n"
    sha = hashlib.sha256(content).hexdigest()
    calls = []
    def read(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(exit_code=0, output=(content, b""))
    container = SimpleNamespace(exec_run=read)
    event = {"event_id": str(uuid4()), "deployment_id": str(uuid4()), "generation": str(uuid4()),
        "source_session_id": "a" * 12, "observed_at": now().isoformat()}
    outbox = EvidenceOutbox(tmp_path, 100000)
    identifier = outbox.capture_file(container, {"shasum": sha}, event)
    assert (tmp_path / (identifier + ".blob")).read_bytes() == content
    assert calls[0] == ["/cowrie/cowrie-env/bin/python3", "/app/cowrie_file.py", sha]
    assert outbox.capture_file(container, {"shasum": sha}, event) == identifier
    assert len(list(tmp_path.glob("*.blob"))) == 1
    with pytest.raises(ValueError):
        outbox.capture_file(container, {"shasum": "../secret"}, event)
    with pytest.raises(ValueError):
        outbox.capture_file(container, {"shasum": "a" * 64}, {**event, "event_id": str(uuid4())})
