
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from honeyforge.api.main import create_app
from honeyforge.infrastructure.database import Database
from honeyforge.infrastructure.models import Base, User
from honeyforge.infrastructure.security import password_hasher
from honeyforge.infrastructure.settings import Settings, settings


@pytest.fixture(scope="session")
def test_database():
    url = make_url(settings.database_url)
    if url.host not in {"localhost", "127.0.0.1"}:
        pytest.exit("Tests require a local isolated PostgreSQL database")
    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    # Multiple Codex chats may verify the same repo: serialize whole suites before any DROP/TRUNCATE.
    # Keep this session lock until teardown; per-test transaction locks cannot protect create_all.
    with admin.connect() as c:
        c.execute(text("SELECT pg_advisory_lock(72501013)"))
        try:
            if not c.scalar(text("SELECT 1 FROM pg_database WHERE datname='honeyforge_test'")):
                c.execute(text("CREATE DATABASE honeyforge_test"))
            db = Database(url.set(database="honeyforge_test").render_as_string(hide_password=False))
            Base.metadata.drop_all(db.engine)
            db.initialize()
            yield db
            db.engine.dispose()
        finally:
            c.execute(text("SELECT pg_advisory_unlock(72501013)"))
    admin.dispose()



@pytest.fixture()
def database(test_database):
    with test_database.engine.begin() as c:
        tables = [name for name in test_database.engine.dialect.get_table_names(c) if name != "stream_state"]
        c.execute(text("TRUNCATE " + ",".join('"' + name + '"' for name in tables) + " RESTART IDENTITY CASCADE"))
        c.execute(text("UPDATE stream_state SET position=0 WHERE id=1"))
    with test_database.sessions.begin() as s:
        s.add(User(username="tester", password_hash=password_hasher.hash("testing-password-123")))
    return test_database


@pytest.fixture()
def client(database, tmp_path):
    config = Settings(database_url=database.engine.url.render_as_string(hide_password=False),
        admin_username="tester", admin_password="testing-password-123", cookie_secure=False,
        geo_city_db="", geo_asn_db="", require_agent_mtls=False, sync_proxy_secret="test-gateway", agent_ca_public_dir=str(tmp_path / "public-ca"),
        artifact_dir=str(tmp_path / "evidence"), capture_key_dir=str(tmp_path / "keys"))
    with TestClient(create_app(config, database)) as c:
        yield c


@pytest.fixture()
def operator(client):
    response = client.post("/api/v1/auth/login", json={"username": "tester", "password": "testing-password-123"})
    assert response.status_code == 200
    client.headers["X-CSRF-Token"] = response.json()["csrf_token"]
    return client


@pytest.fixture()
def sensor(operator):
    token = operator.post("/api/v1/hosts/enrollment-tokens").json()["token"]
    result = operator.post("/agent/v1/enroll", json={"token": token, "name": "Test sensor", "address": "127.0.0.1",
        "capabilities": ["http", "cowrie"]})
    assert result.status_code == 200
    data = result.json()
    return {**data, "headers": {"Authorization": "Bearer " + data["key"]}, "token": token}


@pytest.fixture()
def profile(operator):
    response = operator.post("/api/v1/profiles", json={"name": "Test profile", "config": {"adapter": "http"}})
    assert response.status_code == 201
    return response.json()


@pytest.fixture()
def deployment(operator, sensor, profile):
    body = {"name": "Test trap", "host_id": sensor["host_id"], "profile_version_id": profile["versions"][0]["id"], "port": 18088}
    response = operator.post("/api/v1/deployments", json=body, headers={"Idempotency-Key": "test-deploy-key-01"})
    assert response.status_code == 202, response.text
    return response.json()
