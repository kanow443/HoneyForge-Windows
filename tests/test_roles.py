import pytest

from honeyforge.domain.authorization import authorize
from honeyforge.domain.errors import DomainError


@pytest.mark.parametrize("role,deploy_status,export_status,user_status", [
    ("admin", 422, 200, 200), ("operator", 422, 200, 403), ("analyst", 403, 200, 403), ("viewer", 403, 403, 403),
])
def test_role_permissions_are_checked_on_server(operator, role, deploy_status, export_status, user_status):
    password = "role-test-password-123"
    created = operator.post("/api/v1/users", json={"username": "role-user", "password": password, "role": role})
    assert created.status_code == 201 and "password" not in created.text
    login = operator.post("/api/v1/auth/login", json={"username": "role-user", "password": password})
    assert login.json()["user"]["role"] == role
    operator.headers["X-CSRF-Token"] = login.json()["csrf_token"]
    assert operator.get("/api/v1/overview").status_code == 200
    assert operator.get("/api/v1/users").status_code == user_status
    assert operator.post("/api/v1/deployments", json={}).status_code == deploy_status
    assert operator.post("/api/v1/exports", json={}).status_code == export_status
    if role != "admin":
        assert operator.post("/api/v1/hosts/enrollment-tokens").status_code == 403
    assert operator.post("/api/v1/auth/logout").status_code == 200


def test_last_admin_is_preserved_and_role_change_revokes_existing_sessions(operator):
    me = operator.get("/api/v1/auth/me").json()
    assert operator.post(f'/api/v1/users/{me["id"]}/role', json={"role": "viewer"}).status_code == 409
    user = operator.post("/api/v1/users", json={"username": "other", "password": "other-user-password", "role": "admin"}).json()
    response = operator.post(f'/api/v1/users/{me["id"]}/role', json={"role": "viewer"})
    assert response.status_code == 200
    assert operator.get("/api/v1/overview").status_code == 401
    login = operator.post("/api/v1/auth/login", json={"username": "other", "password": "other-user-password"})
    operator.headers["X-CSRF-Token"] = login.json()["csrf_token"]
    assert operator.get("/api/v1/users").status_code == 200
    assert user["role"] == "admin"


def test_unclassified_operator_routes_fail_closed():
    for role in ("admin", "operator", "analyst", "viewer", "invalid"):
        with pytest.raises(DomainError):
            authorize(role, "new_unclassified_action")
