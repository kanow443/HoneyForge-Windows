import base64
import errno
import hashlib
from uuid import uuid4

from honeyforge.infrastructure.models import now


def test_full_disk_preserves_received_offset_and_verified_evidence(operator, sensor, deployment, monkeypatch):
    content = b"previously accepted evidence"
    stamp = now().isoformat()
    def manifest():
        return {"id": str(uuid4()), "deployment_id": deployment["id"], "generation": deployment["runtime_generation"],
            "kind": "file", "sha256": hashlib.sha256(content).hexdigest(), "size_bytes": len(content),
            "started_at": stamp, "ended_at": stamp, "details": {}}
    first, second = manifest(), manifest()
    for item in [first, second]:
        operator.post("/agent/v1/artifacts", headers=sensor["headers"], json=item).raise_for_status()
    chunk = {"offset": 0, "data_base64": base64.b64encode(content).decode()}
    operator.post(f'/agent/v1/artifacts/{first["id"]}/chunks', headers=sensor["headers"], json=chunk).raise_for_status()
    def full(*args):
        raise OSError(errno.ENOSPC, "Controlled disk exhaustion")
    with monkeypatch.context() as m:
        m.setattr(operator.app.state.evidence, "write_chunk", full)
        response = operator.post(f'/agent/v1/artifacts/{second["id"]}/chunks', headers=sensor["headers"], json=chunk)
        assert response.status_code == 503 and response.json()["error"]["code"] == "artifact_storage_unavailable"
        assert operator.get(f'/api/v1/artifacts/{first["id"]}/download').content == content
        assert operator.post("/agent/v1/artifacts", headers=sensor["headers"], json=second).json()["received_bytes"] == 0
    assert operator.post(f'/agent/v1/artifacts/{second["id"]}/chunks', headers=sensor["headers"], json=chunk).json()["state"] == "available"
