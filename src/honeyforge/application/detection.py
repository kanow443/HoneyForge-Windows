"""Configurable fixed observation-time windows, independent of delivery time."""
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from honeyforge.domain.errors import DomainError
from honeyforge.infrastructure.models import DetectionPolicy, Event, Finding, now
from honeyforge.infrastructure.projections import record


class DetectionService:
    def __init__(self, database):
        self.database = database

    def policy(self):
        with self.database.sessions() as s:
            row = s.get(DetectionPolicy, 1)
            return record(row) if row else {'id': 1, 'revision': 1, 'failed_logins': 5,
                'window_seconds': 60, 'enabled': True, 'updated_at': None}

    def update(self, actor, command):
        with self.database.unit_of_work() as u:
            u.lock_write()
            row = u.repo.get(DetectionPolicy, 1)
            if row is None:
                row = u.repo.add(DetectionPolicy(id=1))
            if row.revision != command.revision:
                raise DomainError('stale_revision', 'The policy changed; refresh before saving', 409)
            row.failed_logins, row.window_seconds, row.enabled = command.failed_logins, command.window_seconds, command.enabled
            row.revision += 1
            row.updated_at = now()
            u.audit(actor, 'detection.updated', 'failed-login', {'revision': row.revision,
                'failed_logins': row.failed_logins, 'window_seconds': row.window_seconds, 'enabled': row.enabled})
            u.emit('detection.changed', {'id': 1})
            return record(row)

    @staticmethod
    def observe(u, event):
        policy = u.repo.get(DetectionPolicy, 1)
        if policy and not policy.enabled:
            return
        threshold, seconds, revision = (policy.failed_logins, policy.window_seconds, policy.revision) if policy else (5, 60, 1)
        stamp = int(event.observed_at.timestamp() // seconds) * seconds
        start = datetime.fromtimestamp(stamp, UTC)
        end = start + timedelta(seconds=seconds)
        rows = list(u.session.scalars(select(Event).where(Event.deployment_id == event.deployment_id,
            Event.source_ip == event.source_ip, Event.event_type == 'ssh.login.failed',
            Event.observed_at >= start, Event.observed_at < end).order_by(Event.observed_at, Event.id).limit(threshold)))
        if len(rows) < threshold:
            return
        key = f'failed-login-v2:{event.deployment_id}:{event.source_ip}:{revision}:{stamp}'
        if u.repo.find(Finding, dedupe_key=key):
            return
        fresh = max(r.observed_at for r in rows) >= now() - timedelta(seconds=seconds)
        finding = u.repo.add(Finding(deployment_id=event.deployment_id, session_id=event.session_id,
            rule_id='repeated-login-failure', rule_version=2, title='Повторные попытки входа', severity='high',
            explanation=f'В фиксированном окне {seconds} секунд времени наблюдения отмечено не менее {threshold} неудачных входов. '
                'Поздняя доставка не объединяет разные временные окна. Адрес не доказывает личность клиента.',
            observation='observed', evidence_ids=[r.id for r in rows], dedupe_key=key,
            observed_first_at=min(r.observed_at for r in rows), observed_last_at=max(r.observed_at for r in rows),
            notification_state='current' if fresh else 'historical'))
        # Historical detections remain available for investigation without a false new live burst.
        u.emit('finding.created', {'id': finding.id, 'deployment_id': event.deployment_id,
            'notification_state': finding.notification_state})
