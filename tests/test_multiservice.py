import pytest
from sqlalchemy import func, select

from honeyforge.domain.profiles import runtime_config, validate_profile
from honeyforge.infrastructure.models import DeploymentGroup, PortReservation


def bundle_config():
    return {'schema_version': 3, 'adapter': 'bundle', 'hostname': 'finance-stage', 'persona': 'Finance Operations',
        'services': [{'key': 'web', 'port': 18880, 'config': {'schema_version': 2, 'adapter': 'http'}},
            {'key': 'ssh', 'port': 18822, 'config': {'schema_version': 2, 'adapter': 'cowrie'}}]}


def create(operator, sensor):
    profile = operator.post('/api/v1/profiles', json={'name': 'Finance', 'config': bundle_config()})
    assert profile.status_code == 201, profile.text
    body = {'name': 'Finance node', 'host_id': sensor['host_id'], 'profile_version_id': profile.json()['versions'][0]['id']}
    return profile.json(), body


def test_bundle_validation():
    parsed = validate_profile(bundle_config()).model_dump(mode='json')
    assert runtime_config(parsed, 'web')['hostname'] == 'finance-stage'
    assert runtime_config(parsed, 'ssh')['adapter'] == 'cowrie'
    for kind in ('port', 'key'):
        invalid = bundle_config()
        invalid['services'][1][kind] = invalid['services'][0][kind]
        with pytest.raises(ValueError):
            validate_profile(invalid)
    with pytest.raises(ValueError):
        runtime_config(parsed, 'missing')


def test_group_atomic_creation_idempotency_and_lifecycle(operator, sensor, database):
    profile, body = create(operator, sensor)
    headers = {'Idempotency-Key': 'multiservice-test-001'}
    group = operator.post('/api/v1/deployment-groups', json=body, headers=headers)
    assert group.status_code == 202, group.text
    group = group.json()
    assert group['state'] == 'requested' and len(group['services']) == 2
    assert operator.post('/api/v1/deployment-groups', json=body, headers=headers).json() == group
    assert operator.post('/api/v1/deployment-groups', json={**body, 'name': 'different'}, headers=headers).status_code == 409
    specs = operator.get('/agent/v1/runtimes', headers=sensor['headers']).json()
    assert {s['config']['adapter'] for s in specs} == {'http', 'cowrie'}
    assert all(s['config']['hostname'] == 'finance-stage' for s in specs)
    assert all(s['group_id'] == group['id'] for s in specs)
    assert operator.post(f"/api/v1/deployments/{group['services'][0]['id']}/redeploy", json={}).status_code == 409
    assert operator.post(f"/api/v1/deployment-groups/{group['id']}/stop").status_code == 202
    updated = operator.post(f"/api/v1/deployment-groups/{group['id']}/redeploy", json={})
    assert updated.status_code == 202, updated.text
    assert all(d['desired_revision'] == 3 for d in updated.json()['services'])
    assert all(d['runtime_generation'] not in {d['runtime_generation'] for d in group['services']} for d in updated.json()['services'])
    token = operator.post('/api/v1/honeytokens', json={'profile_version_id': body['profile_version_id'],
        'service_key': 'web', 'name': 'Web URL', 'kind': 'url'})
    assert token.status_code == 201, token.text
    operator.post(f"/api/v1/deployment-groups/{group['id']}/redeploy", json={})
    token = operator.get('/api/v1/honeytokens').json()[0]
    assert len(token['bindings']) == 1
    assert token['bindings'][0]['deployment_id'] == next(d['id'] for d in group['services'] if d['service_key'] == 'web')
    with database.sessions() as s:
        assert s.scalar(select(func.count()).select_from(PortReservation)) == 2
        assert s.scalar(select(func.count()).select_from(DeploymentGroup)) == 1
    assert operator.post(f"/api/v1/profiles/{profile['id']}/delete").status_code == 409


def test_group_conflicting_port_rolls_back_every_service(operator, sensor, deployment, database):
    _, body = create(operator, sensor)
    response = operator.post('/api/v1/deployment-groups', json={**body, 'ports': {'ssh': deployment['port']}},
        headers={'Idempotency-Key': 'atomic-conflict-001'})
    assert response.status_code == 409
    with database.sessions() as s:
        assert s.scalar(select(func.count()).select_from(DeploymentGroup)) == 0
        assert s.scalar(select(func.count()).select_from(PortReservation)) == 1
    assert operator.post('/api/v1/deployment-groups', json={**body, 'ports': {'web': 18822}},
        headers={'Idempotency-Key': 'duplicate-ports-001'}).status_code == 409


def test_changed_topology_and_readonly_permissions(operator, sensor):
    profile, body = create(operator, sensor)
    group = operator.post('/api/v1/deployment-groups', json=body, headers={'Idempotency-Key': 'topology-test-001'}).json()
    config = bundle_config()
    config['services'][1]['key'] = 'replacement'
    version = operator.post(f"/api/v1/profiles/{profile['id']}/versions", json={'config': config}).json()
    result = operator.post(f"/api/v1/deployment-groups/{group['id']}/redeploy", json={'profile_version_id': version['id']})
    assert result.status_code == 409 and result.json()['error']['code'] == 'topology_changed'
    user = operator.post('/api/v1/users', json={'username': 'readonly', 'password': 'reader-password-123', 'role': 'viewer'})
    assert user.status_code == 201
    operator.post('/api/v1/auth/logout')
    auth = operator.post('/api/v1/auth/login', json={'username': 'readonly', 'password': 'reader-password-123'}).json()
    operator.headers['X-CSRF-Token'] = auth['csrf_token']
    assert operator.get('/api/v1/deployment-groups').status_code == 200
    assert operator.post(f"/api/v1/deployment-groups/{group['id']}/stop").status_code == 403
