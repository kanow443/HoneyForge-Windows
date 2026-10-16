import csv
import io
import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
import stix2
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from sqlalchemy import select

from honeyforge.agent.identity import AgentIdentity
from honeyforge.application.geo import GeoService
from honeyforge.domain.errors import DomainError
from honeyforge.infrastructure.models import Audit, Finding, HoneyTokenUse
from tests.test_backend import event
from tests.test_evidence import chunk, manifest


def batch(operator, sensor, items):
    response = operator.post("/agent/v1/events/batch", json={"events": items}, headers=sensor["headers"])
    assert response.status_code == 200, response.text
    return response.json()


def test_scoped_honeytoken_redeploy_dedupe_revoke_and_delayed_delivery(
    operator, sensor, profile, deployment, database
):
    token = operator.post(
        "/api/v1/honeytokens",
        json={"profile_version_id": profile["versions"][0]["id"], "name": "URL proof", "kind": "url"},
    ).json()
    assert token["bindings"] == []
    updated = operator.post(f"/api/v1/deployments/{deployment['id']}/redeploy", json={}).json()
    token = next(t for t in operator.get("/api/v1/honeytokens").json() if t["id"] == token["id"])
    binding = token["bindings"][0]
    specs = operator.get("/agent/v1/runtimes", headers=sensor["headers"]).json()
    assert specs[0]["honeytokens"][0]["binding_id"] == binding["id"]
    assert (
        operator.get(f"/api/v1/profiles/{profile['id']}").json()["versions"][0]["config_hash"]
        == profile["versions"][0]["config_hash"]
    )
    original = event(updated, payload={"path": binding["resource_path"], "bait_binding_id": binding["id"]})
    batch(operator, sensor, [original, original])
    batch(operator, sensor, [event(deployment, payload=original["payload"])])  # Wrong immutable generation.
    batch(operator, sensor, [event(updated, payload={**original["payload"], "path": "/wrong"})])
    delayed = event(updated, payload=original["payload"])
    assert operator.post(f"/api/v1/honeytokens/{token['id']}/revoke").status_code == 200
    batch(operator, sensor, [delayed])  # Observed before revocation, delivered after.
    batch(operator, sensor, [event(updated, payload=original["payload"])])  # Observed after revocation.
    with database.sessions() as s:
        assert len(list(s.scalars(select(HoneyTokenUse)))) == 2
        assert len(list(s.scalars(select(Finding).where(Finding.rule_id == "honeytoken-used")))) == 2


def test_file_honeytoken_requires_observed_output_and_safe_unique_path(operator, sensor, database):
    profile = operator.post(
        "/api/v1/profiles", json={"name": "SSH marker", "config": {"schema_version": 2, "adapter": "cowrie"}}
    ).json()
    version = profile["versions"][0]["id"]
    body = {
        "profile_version_id": version,
        "name": "Backup marker",
        "kind": "file",
        "file_path": "/home/admin//backup.key",
    }
    token = operator.post("/api/v1/honeytokens", json=body)
    assert token.status_code == 201, token.text
    assert token.json()["file_path"] == "/home/admin/backup.key"
    assert (
        operator.post("/api/v1/honeytokens", json={**body, "file_path": "/home/../etc/shadow"}).status_code
        == 422
    )
    assert (
        operator.post("/api/v1/honeytokens", json={**body, "file_path": "/home/admin/backup.key"}).status_code
        == 409
    )
    assert (
        operator.post("/api/v1/honeytokens", json={**body, "kind": "url", "file_path": None}).status_code
        == 409
    )
    deployment = operator.post(
        "/api/v1/deployments",
        json={"name": "SSH", "host_id": sensor["host_id"], "profile_version_id": version, "port": 18099},
        headers={"Idempotency-Key": "marker-deploy-01"},
    ).json()
    binding = operator.get("/api/v1/honeytokens").json()[0]["bindings"][0]
    marker = "BACKUP_ACCESS_KEY=" + binding["public_value"]
    batch(
        operator,
        sensor,
        [event(deployment, event_type="ssh.command", payload={"command": "cat /home/admin/backup.key"})],
    )
    with database.sessions() as s:
        assert len(list(s.scalars(select(HoneyTokenUse)))) == 0
    batch(operator, sensor, [event(deployment, event_type="ssh.output", payload={"text": marker + "\n"})])
    with database.sessions() as s:
        assert len(list(s.scalars(select(HoneyTokenUse)))) == 1


def test_detection_uses_observation_windows_and_distinguishes_late_burst(
    operator, sensor, deployment, database
):
    policy = operator.get("/api/v1/detection-policy").json()
    body = {"revision": policy["revision"], "failed_logins": 3, "window_seconds": 60, "enabled": True}
    saved = operator.post("/api/v1/detection-policy", json=body)
    assert saved.status_code == 200, saved.text
    assert operator.post("/api/v1/detection-policy", json=body).status_code == 409
    old = datetime(2020, 1, 1, tzinfo=UTC)

    def failure(stamp, address="192.0.2.20"):
        return event(
            deployment,
            event_type="ssh.login.failed",
            observed_at=stamp.isoformat(),
            source_ip=address,
            payload={"username": "admin", "password": "must-not-export"},
            provenance="lab-fixture",
        )

    # Three records arriving together from three real observation windows do not make a burst.
    batch(operator, sensor, [failure(old + timedelta(minutes=i), "192.0.2.30") for i in range(3)])
    with database.sessions() as s:
        assert len(list(s.scalars(select(Finding)))) == 0
    batch(operator, sensor, [failure(old + timedelta(seconds=i)) for i in range(3)])
    current = datetime.now(UTC).replace(second=0, microsecond=0)
    batch(operator, sensor, [failure(current + timedelta(seconds=i), "192.0.2.40") for i in range(3)])
    with database.sessions() as s:
        findings = list(s.scalars(select(Finding)))
        assert {f.notification_state for f in findings} == {"current", "historical"}
        assert all(len(f.evidence_ids) == 3 for f in findings)
    body.update(revision=saved.json()["revision"], enabled=False)
    assert operator.post("/api/v1/detection-policy", json=body).status_code == 200
    batch(operator, sensor, [failure(current + timedelta(seconds=i), "192.0.2.50") for i in range(3)])
    with database.sessions() as s:
        assert len(list(s.scalars(select(Finding)))) == 2


def test_ioc_stix_21_validated_and_only_available_files_with_provenance(
    operator, sensor, deployment, database
):
    content = b"harmless verified test fixture"
    verified = manifest(deployment, content)
    receiving = manifest(deployment, b"not uploaded")
    for item in (verified, receiving):
        assert operator.post("/agent/v1/artifacts", json=item, headers=sensor["headers"]).status_code == 200
    assert (
        operator.post(
            f"/agent/v1/artifacts/{verified['id']}/chunks", json=chunk(content), headers=sensor["headers"]
        ).status_code
        == 200
    )
    items = [
        event(
            deployment,
            payload={"artifact_id": item["id"], "password": "never-export"},
            provenance="lab-fixture",
        )
        for item in (verified, receiving)
    ]
    batch(operator, sensor, items)
    result = operator.post("/api/v1/ioc-exports", json={"format": "stix"}).json()
    parsed = stix2.parse(result["content"], allow_custom=True)
    assert parsed.type == "bundle"
    objects = json.loads(result["content"])["objects"]
    files = [obj for obj in objects if obj["type"] == "file"]
    assert len(files) == 1 and files[0]["hashes"]["SHA-256"] == verified["sha256"]
    observations = [obj for obj in objects if obj["type"] == "observed-data"]
    assert len(observations) == 2
    assert all(o["x_honeyforge_provenance"] == ["lab-fixture"] for o in observations)
    assert "never-export" not in result["content"]
    exported_csv = operator.post("/api/v1/ioc-exports", json={"format": "csv"}).json()
    rows = list(csv.DictReader(io.StringIO(exported_csv["content"])))
    assert len(rows) == 2 and all(row["event_ids"] for row in rows)
    with database.sessions() as s:
        assert len(list(s.scalars(select(Audit).where(Audit.action == "ioc.exported")))) == 2


def csr():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    request = (
        x509.CertificateSigningRequestBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "untrusted-caller-subject")]))
        .sign(key, hashes.SHA256())
    )
    return request.public_bytes(serialization.Encoding.PEM).decode()


def test_mtls_bootstrap_confirmation_overlap_revocation_and_no_rebootstrap(operator, sensor, monkeypatch):
    app = operator.app
    app.state.settings.require_agent_mtls = True
    service = app.state.certificates
    headers = {**sensor["headers"], "X-Asset-Gateway": "test-gateway", "X-Asset-Scheme": "https"}
    assert operator.get("/agent/v1/runtimes", headers=headers).status_code == 401
    request = csr()
    assert (
        operator.post(
            "/agent/v1/certificates/issue", json={"csr": request}, headers=sensor["headers"]
        ).status_code
        == 403
    )
    first = operator.post("/agent/v1/certificates/issue", json={"csr": request}, headers=headers)
    assert first.status_code == 200, first.text
    first = first.json()
    assert first["state"] == "pending"
    certificate = x509.load_pem_x509_certificate(first["certificate_pem"].encode())
    certificate.verify_directly_issued_by(service.authority.certificate)
    assert certificate.subject != x509.load_pem_x509_csr(request.encode()).subject
    headers["X-Asset-Client-Fingerprint"] = first["fingerprint"]
    assert (
        operator.post("/agent/v1/certificates/confirm", json={}, headers=headers).json()["state"] == "active"
    )
    assert operator.get("/agent/v1/runtimes", headers=headers).status_code == 200
    assert (
        operator.post(
            "/agent/v1/certificates/issue", json={"csr": csr()}, headers=sensor["headers"]
        ).status_code
        == 403
    )
    second = operator.post("/agent/v1/certificates/issue", json={"csr": csr()}, headers=headers).json()
    service.authorize(sensor["host_id"], first["fingerprint"])  # Old remains active until confirmation.
    headers["X-Asset-Client-Fingerprint"] = second["fingerprint"]
    confirmed = operator.post("/agent/v1/certificates/confirm", json={}, headers=headers).json()
    rows = service.list(sensor["host_id"])
    old = next(row for row in rows if row["id"] == first["id"])
    assert old["state"] == "overlap"
    grace = (
        old["accept_until"] - confirmed["confirmed_at"]
        if isinstance(confirmed["confirmed_at"], datetime)
        else old["accept_until"] - datetime.fromisoformat(confirmed["confirmed_at"])
    )
    assert 299 <= grace.total_seconds() <= 300.1
    import honeyforge.infrastructure.certificates as certificates

    original_now = certificates.now
    monkeypatch.setattr(certificates, "now", lambda: original_now() + timedelta(seconds=301))
    with pytest.raises(DomainError) as error:
        service.authorize(sensor["host_id"], first["fingerprint"])
    assert error.value.code == "agent_certificate_rejected"
    service.authorize(sensor["host_id"], second["fingerprint"])
    assert operator.post("/api/v1/agent-certificates/" + second["id"] + "/revoke").status_code == 200
    assert operator.get("/agent/v1/runtimes", headers=headers).status_code == 401
    assert (
        operator.post("/agent/v1/certificates/issue", json={"csr": csr()}, headers=headers).status_code == 401
    )


def test_identity_resume_after_confirm_failure_without_losing_private_key(operator, sensor, tmp_path):
    identity = AgentIdentity(tmp_path)
    service = operator.app.state.certificates
    installed = []

    def install(certificate, key):
        installed.append((certificate, key))

    fail = [True]

    def request(method, route, **kwargs):
        if route.endswith("/issue"):
            return service.issue(sensor["host_id"], kwargs["json"]["csr"])
        if fail.pop() if fail else False:
            raise OSError("Controlled lost confirmation response")
        cert = x509.load_pem_x509_certificate(installed[-1][0].read_bytes())
        return service.confirm(sensor["host_id"], cert.fingerprint(hashes.SHA256()).hex())

    with pytest.raises(OSError):
        identity.ensure(sensor["host_id"], request, install)
    original_key = installed[0][1].read_bytes()
    assert identity.pending_path.exists()
    assert AgentIdentity(tmp_path).ensure(sensor["host_id"], request, install)
    assert installed[-1][1].read_bytes() == original_key
    assert not identity.pending_path.exists()
    assert not identity.ensure(sensor["host_id"], request, install)
    assert len(service.list(sensor["host_id"])) == 1


def test_geo_missing_private_and_invalid_database_fail_honestly(client, database, tmp_path):
    service = GeoService(database, client.app.state.settings)
    assert service.top()["city_database"]["reason"] == "not_configured"
    assert service.lookup("192.168.1.5")["reason"] == "private_or_reserved_address"
    assert service.lookup("8.8.8.8")["status"] == "unavailable"
    assert service.lookup("not-an-ip")["reason"] == "invalid_address"
    path = tmp_path / "invalid.mmdb"
    path.write_bytes(b"invalid binary fixture")
    service.city.filename = str(path)
    assert service.city.status()["reason"] == "unreadable_database"
    assert str(tmp_path) not in json.dumps(service.city.status())


def test_geo_reads_real_upstream_mmdb_metadata_and_local_fixture(client, database):
    from pathlib import Path

    from honeyforge.application.geo import GeoDatabase

    root = Path(__file__).parent / "fixtures" / "mmdb"
    service = GeoService(database, client.app.state.settings)
    service.city.filename = str(root / "GeoIP2-City-Test.mmdb")
    service.asn.filename = str(root / "GeoLite2-ASN-Test.mmdb")
    metadata = service.top()
    assert metadata["city_database"]["status"] == "available"
    assert metadata["city_database"]["built_at"] == "2026-02-04T22:49:29+00:00"
    assert metadata["asn_database"]["database_type"] == "GeoLite2-ASN"
    location = service.lookup("81.2.69.160")
    assert location["city"] == "Лондон" and location["accuracy_radius_km"] == 100
    assert service.lookup("192.168.1.1")["status"] == "unavailable"
    wrong = GeoDatabase(str(root / "GeoIP2-City-Test.mmdb"), "ASN")
    assert wrong.status()["reason"] == "wrong_database_type"


def test_certificate_rejection_preserves_queue_and_does_not_revoke_agent(tmp_path):
    import httpx

    from honeyforge.agent.main import Agent
    from honeyforge.agent.spool import Spool
    from honeyforge.infrastructure.settings import Settings

    agent = Agent(
        Settings(
            _env_file=None, allow_insecure_agent=True, agent_api="http://test", agent_state_dir=str(tmp_path)
        )
    )
    agent.http.close()
    code = ["agent_certificate_rejected"]
    agent.http = httpx.Client(
        base_url="http://test",
        transport=httpx.MockTransport(lambda request: httpx.Response(401, json={"error": {"code": code[0]}})),
    )
    spool = Spool(tmp_path / "outbox.sqlite3")
    item = {"event_id": str(uuid4()), "payload": {"path": "/public-bait"}}
    spool.collect("fixture", "1", [item])
    with pytest.raises(httpx.HTTPStatusError):
        agent.request("GET", "/agent/v1/runtimes")
    assert not agent.revoked.is_set() and spool.batch()[0]["event_id"] == item["event_id"]
    code[0] = "invalid_agent_key"
    with pytest.raises(httpx.HTTPStatusError):
        agent.request("GET", "/agent/v1/runtimes")
    assert agent.revoked.is_set() and spool.batch()
    agent.http.close()
    spool.db.close()


def test_enrollment_credentials_private_and_preserved_on_disk_failure(tmp_path, monkeypatch):
    import os
    import stat

    import httpx

    from honeyforge.agent.main import Agent
    from honeyforge.infrastructure.settings import Settings

    agent = Agent(Settings(_env_file=None, allow_insecure_agent=True,
        agent_api="http://test", agent_state_dir=str(tmp_path)))
    agent.http.close()
    reply = {"host_id": str(uuid4()), "key": "synthetic-private-enrollment-key"}
    agent.http = httpx.Client(base_url="http://test", transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json=reply)))
    agent.enroll("synthetic-enrollment-token")
    original = agent.credentials_path.read_bytes()
    assert json.loads(original) == reply
    assert stat.S_IMODE(agent.credentials_path.stat().st_mode) == 0o600
    assert stat.S_IMODE(tmp_path.stat().st_mode) & 0o077 == 0
    reply["key"] = "new-synthetic-key-that-must-not-replace-original"
    def disk_failure(fd):
        raise OSError("synthetic durable-write failure")
    monkeypatch.setattr(os, "fsync", disk_failure)
    with pytest.raises(OSError, match="durable-write"):
        agent.enroll("synthetic-enrollment-token")
    assert agent.credentials_path.read_bytes() == original
    assert not list(tmp_path.glob(".credentials.json-*"))
    agent.http.close()
