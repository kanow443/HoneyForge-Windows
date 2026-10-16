"""Scoped public bait identifiers, minted once per immutable runtime generation."""
import re
import secrets

from sqlalchemy import func, select

from honeyforge.domain.errors import DomainError
from honeyforge.domain.profiles import runtime_config
from honeyforge.infrastructure.models import (
    Deployment,
    Finding,
    HoneyToken,
    HoneyTokenBinding,
    HoneyTokenUse,
    Profile,
    ProfileVersion,
    now,
)
from honeyforge.infrastructure.projections import record


def required(row, label):
    if row is None:
        raise DomainError('not_found', label + ' was not found', 404)
    return row


class HoneyTokenService:
    def __init__(self, database):
        self.database = database

    def create(self, actor, command):
        with self.database.unit_of_work() as u:
            u.lock_write()
            version = required(u.repo.get(ProfileVersion, str(command.profile_version_id)), 'Version')
            profile = required(u.repo.get(Profile, version.profile_id), 'Profile')
            if profile.archived_at:
                raise DomainError('profile_archived', 'Restore the profile before issuing bait', 409)
            try:
                config = runtime_config(version.config, command.service_key)
            except ValueError as error:
                raise DomainError('unknown_service', str(error)) from error
            adapter = config['adapter']
            if adapter not in {'http', 'cowrie'}:
                raise DomainError('unsupported_adapter', 'Low has no files or URLs', 409)
            if command.kind == 'url' and adapter != 'http':
                raise DomainError('unsupported_adapter', 'URL tokens require an HTTP decoy', 409)
            count = u.session.scalar(select(func.count()).select_from(HoneyToken).where(
                HoneyToken.profile_version_id == version.id, HoneyToken.revoked_at.is_(None)))
            if count >= 8:
                raise DomainError('token_limit', 'At most eight active tokens per profile version', 409)
            if command.kind == 'file':
                if command.file_path in {f['path'] for f in config.get('decoy_files', [])}:
                    raise DomainError('path_conflict', 'A profile file already uses this path', 409)
                if u.session.scalar(select(HoneyToken.id).where(HoneyToken.profile_version_id == version.id,
                    HoneyToken.file_path == command.file_path, HoneyToken.service_key == command.service_key, HoneyToken.revoked_at.is_(None))):
                    raise DomainError('path_conflict', 'A token already uses this path', 409)
            row = u.repo.add(HoneyToken(profile_id=profile.id, profile_version_id=version.id,
                name=command.name, kind=command.kind, file_path=command.file_path, service_key=command.service_key,
                created_by=actor))
            u.audit(actor, 'honeytoken.issued', row.id, {'profile_version_id': version.id, 'kind': row.kind})
            u.emit('honeytoken.changed', {'id': row.id, 'profile_id': profile.id})
            return self._view(u.session, row)

    def revoke(self, actor, token_id):
        with self.database.unit_of_work() as u:
            u.lock_write()
            row = required(u.repo.get(HoneyToken, token_id), 'Token')
            if row.revoked_at is None:
                row.revoked_at = now()
                u.audit(actor, 'honeytoken.revoked', row.id)
                u.emit('honeytoken.changed', {'id': row.id, 'profile_id': row.profile_id})
            return self._view(u.session, row)

    def list(self, profile_id=None):
        with self.database.sessions() as s:
            query = select(HoneyToken).order_by(HoneyToken.created_at.desc()).limit(500)
            if profile_id:
                query = query.where(HoneyToken.profile_id == profile_id)
            return [self._view(s, token) for token in s.scalars(query)]

    @staticmethod
    def _view(s, token):
        bindings = []
        for binding in s.scalars(select(HoneyTokenBinding).where(HoneyTokenBinding.token_id == token.id)
            .order_by(HoneyTokenBinding.created_at.desc()).limit(100)):
            usage = s.execute(select(func.count(), func.max(HoneyTokenUse.observed_at)).where(
                HoneyTokenUse.binding_id == binding.id)).one()
            deployment = s.get(Deployment, binding.deployment_id)
            bindings.append({**record(binding), 'current_runtime': bool(deployment and deployment.runtime_generation == binding.generation),
                'use_count': usage[0], 'last_used_at': usage[1]})
        return {**record(token), 'bindings': bindings,
            'application': 'issue applies on next explicit redeploy; revoke immediately disables attribution, stale bait bytes persist until redeploy'}

    @staticmethod
    def bind(u, deployment, generation):
        for token in u.session.scalars(select(HoneyToken).where(
            HoneyToken.profile_version_id == deployment.profile_version_id, HoneyToken.service_key == deployment.service_key, HoneyToken.revoked_at.is_(None))):
            value = secrets.token_hex(24)
            u.repo.add(HoneyTokenBinding(token_id=token.id, deployment_id=deployment.id,
                generation=generation, public_value=value,
                resource_path=token.file_path if token.kind == 'file' else '/api/resources/' + value))

    @staticmethod
    def runtime(u, deployment):
        query = select(HoneyTokenBinding, HoneyToken).join(HoneyToken, HoneyTokenBinding.token_id == HoneyToken.id).where(
            HoneyTokenBinding.deployment_id == deployment.id, HoneyTokenBinding.generation == deployment.runtime_generation,
            HoneyToken.revoked_at.is_(None)).order_by(HoneyTokenBinding.id)
        return [{'binding_id': b.id, 'kind': t.kind, 'path': b.resource_path,
            'content': 'BACKUP_ACCESS_KEY=' + b.public_value + '\nCTF_FLAG=HF{' + b.public_value + '}\n'}
            for b, t in u.session.execute(query)]

    @staticmethod
    def observe(u, event):
        # Markers are public bait. Never infer successful execution from an input command.
        bindings = []
        if event.event_type == 'http.request' and event.payload.get('bait_binding_id'):
            binding = u.repo.get(HoneyTokenBinding, str(event.payload['bait_binding_id']))
            if binding and event.payload.get('path') == binding.resource_path:
                bindings.append(binding)
        elif event.event_type == 'ssh.output':
            values = set(re.findall(r'BACKUP_ACCESS_KEY=([a-f0-9]{48})\b', str(event.payload.get('text', ''))))
            if values:
                bindings = list(u.session.scalars(select(HoneyTokenBinding).where(
                    HoneyTokenBinding.public_value.in_(list(values)[:8]))))
        found = []
        for binding in bindings:
            if binding.deployment_id != event.deployment_id or binding.generation != event.generation:
                continue
            token = u.repo.get(HoneyToken, binding.token_id)
            if not token or (token.revoked_at and event.observed_at >= token.revoked_at):
                continue
            if u.repo.find(HoneyTokenUse, event_id=event.id, binding_id=binding.id):
                continue
            u.repo.add(HoneyTokenUse(event_id=event.id, binding_id=binding.id, observed_at=event.observed_at))
            found.append(token.id)
            u.repo.add(Finding(deployment_id=event.deployment_id, session_id=event.session_id,
                rule_id='honeytoken-used', rule_version=1, title='Использована уникальная приманка', severity='high',
                explanation=('Зафиксирован запрос уникального URL/файла либо появление уникального маркера в выводе эмулятора. '
                    'Идентификатор связан с конкретным профилем и запуском. Адрес не доказывает личность.'),
                observation='observed', evidence_ids=[event.id], dedupe_key='honeytoken:' + binding.id + ':' + event.id))
        if found:
            event.payload = {**event.payload, 'honeytoken_ids': found}
            u.emit('honeytoken.used', {'event_id': event.id, 'deployment_id': event.deployment_id, 'token_ids': found})
