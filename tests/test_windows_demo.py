"""Contract and failure tests for the Windows setup helper; no synthetic runtime acceptance claims."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from honeyforge.domain.profiles import validate_profile


@pytest.fixture
def demo_module():
    spec = importlib.util.spec_from_file_location("hf_windows_demo", Path("scripts/windows/prepare-demo.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def transport_for(module, monkeypatch, hosts, deployment_state="running"):
    requests = []
    profiles = {}
    original = httpx.Client

    def handler(request):
        path = request.url.path
        requests.append((request.method, path))
        if path == "/api/v1/auth/login":
            return httpx.Response(200, json={"csrf_token": "test-csrf"},
                headers={"set-cookie": "hf_session=test-session; Secure; HttpOnly; Path=/"})
        assert request.headers["Origin"] == "https://localhost:8443"
        assert request.headers["X-CSRF-Token"] == "test-csrf"
        assert "hf_session=test-session" in request.headers["Cookie"]
        if path == "/api/v1/auth/logout":
            return httpx.Response(200, json={"ok": True})
        if path == "/api/v1/hosts":
            return httpx.Response(200, json=hosts)
        if path == "/api/v1/profiles" and request.method == "GET":
            return httpx.Response(200, json=[])
        if path == "/api/v1/deployments" and request.method == "GET":
            return httpx.Response(200, json=[])
        if path == "/api/v1/profiles":
            import json
            body = json.loads(request.content)
            config = validate_profile(body["config"])
            assert config.schema_version == 2
            adapter = config.adapter
            profiles[adapter] = config
            return httpx.Response(201, json={"id": adapter, "versions": [{"id": adapter}]})
        if path == "/api/v1/deployments":
            import json
            body = json.loads(request.content)
            assert body["host_id"] == "sensor-id"
            assert body["port"] == profiles[body["profile_version_id"]].recommended_port
            return httpx.Response(202, json={"id": body["profile_version_id"], "state": "queued"})
        if path.startswith("/api/v1/deployments/"):
            return httpx.Response(200, json={"id": path.split("/")[-1],
                "state": deployment_state, "endpoint": "192.168.56.101:test"})
        raise AssertionError(f"Unexpected request: {path}")

    monkeypatch.setattr(module, "settings", SimpleNamespace(admin_username="tester",
        admin_password="unit-test-only", public_origin="https://localhost:8443"))
    monkeypatch.setattr(module.httpx, "Client", lambda **kwargs: original(
        **kwargs, transport=httpx.MockTransport(handler)))
    return requests, profiles


def test_demo_validates_v2_and_preserves_origin_and_secure_session(demo_module, monkeypatch):
    requests, profiles = transport_for(demo_module, monkeypatch,
        [{"id": "sensor-id", "name": "unit-sensor", "address": "192.168.56.101", "status": "online"}])
    demo_module.prepare("192.168.56.101")
    assert set(profiles) == {"tcp-banner", "cowrie", "http"}
    assert requests[-1] == ("POST", "/api/v1/auth/logout")


@pytest.mark.parametrize("hosts", [[], [
    {"id": "sensor-id", "address": "192.168.56.101", "status": "offline"},
], [
    {"id": "a", "address": "192.168.56.101", "status": "online"},
    {"id": "b", "address": "192.168.56.101", "status": "online"},
]])
def test_demo_rejects_missing_offline_or_ambiguous_sensor(demo_module, monkeypatch, hosts):
    requests, profiles = transport_for(demo_module, monkeypatch, hosts)
    with pytest.raises(RuntimeError, match="exactly one"):
        demo_module.prepare("192.168.56.101")
    assert not profiles
    assert requests[-1] == ("POST", "/api/v1/auth/logout")


def test_demo_does_not_report_error_as_running(demo_module, monkeypatch, capsys):
    requests, _ = transport_for(demo_module, monkeypatch,
        [{"id": "sensor-id", "name": "unit-sensor", "address": "192.168.56.101", "status": "online"}],
        deployment_state="error")
    with pytest.raises(RuntimeError, match="review the job"):
        demo_module.prepare("192.168.56.101")
    assert "Windows demo:" not in capsys.readouterr().out
    assert requests[-1] == ("POST", "/api/v1/auth/logout")

