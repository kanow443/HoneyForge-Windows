from honeyforge.domain.profiles import validate_profile


def test_v1_immutable_and_v2_lifecycle(operator, sensor):
    old = operator.post("/api/v1/profiles", json={"name": "Legacy", "config": {"adapter": "http"}}).json()
    original = old["versions"][0]
    modern = operator.post(f'/api/v1/profiles/{old["id"]}/versions', json={"config": {
        "schema_version": 2, "adapter": "http", "decoy_accounts": [{"username": "admin", "password": "synthetic-demo"}]}})
    assert modern.status_code == 201, modern.text
    assert operator.get(f'/api/v1/profiles/{old["id"]}').json()["versions"][1] == original
    base = f'/api/v1/profiles/{old["id"]}'
    assert operator.post(base + "/metadata", json={"name": "Renamed", "description": "Test"}).json()["name"] == "Renamed"
    assert operator.post(base + "/archive").json()["archived_at"]
    body = {"name": "Trap", "host_id": sensor["host_id"], "profile_version_id": original["id"], "port": 18100}
    assert operator.post("/api/v1/deployments", json=body, headers={"Idempotency-Key": "archive-test-001"}).status_code == 409
    assert operator.post(base + "/restore").json()["archived_at"] is None
    assert operator.post("/api/v1/deployments", json=body, headers={"Idempotency-Key": "archive-test-001"}).status_code == 202
    assert operator.post(base + "/delete").status_code == 409
    unused = operator.post("/api/v1/profiles", json={"name": "Unused", "config": {"schema_version": 2, "adapter": "tcp-banner"}}).json()
    assert unused["interaction_level"] == "low" and old["interaction_level"] == "medium"
    assert operator.post(f'/api/v1/profiles/{unused["id"]}/delete').status_code == 200
    assert operator.get(f'/api/v1/profiles/{unused["id"]}').status_code == 404


def test_profile_versions_validate_recording_beacon_and_plain_banners():
    assert validate_profile({"adapter": "cowrie"}).schema_version == 1
    for adapter in ("http", "cowrie", "tcp-banner"):
        config = validate_profile({"schema_version": 2, "adapter": adapter})
        assert config.beacon.jitter_ratio == 0.2
        assert config.recording.capture_credentials
    import pytest
    for invalid in ({"banner": "line\nheader"}, {"beacon": {"interval_seconds": 0}},
            {"decoy_accounts": [{"username": "root", "password": "bad:entry"}]},
            {"recording": {"http_payload_bytes": 90000}}):
        with pytest.raises(ValueError):
            validate_profile({"schema_version": 2, "adapter": "tcp-banner", **invalid})


def test_removed_adapter_is_rejected_by_profile_and_sensor_contracts(operator, sensor):
    profile = operator.post("/api/v1/profiles", json={
        "name": "Unsupported", "config": {"schema_version": 2, "adapter": "cowrie-high"}})
    assert profile.status_code == 422
    heartbeat = operator.post("/agent/v1/heartbeat", headers=sensor["headers"], json={
        "capabilities": ["http", "cowrie-high"]})
    assert heartbeat.status_code == 422
