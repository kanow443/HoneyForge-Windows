"""Cursor-based ECS event delivery. Integration credentials grant no runtime control."""
from datetime import timedelta
from ipaddress import ip_address

from sqlalchemy import func, select

from honeyforge.application.control import required
from honeyforge.application.schemas import CreateSourceBlock
from honeyforge.domain.errors import DomainError
from honeyforge.infrastructure.models import (
    Deployment,
    Event,
    IntegrationToken,
    SourceBlock,
    StreamState,
    now,
)
from honeyforge.infrastructure.projections import block_view, record
from honeyforge.infrastructure.security import digest, sanitize, secret


def ecs_event(row):
    category = "authentication" if ".login" in row.event_type else "file" if ".file." in row.event_type else (
        "network" if row.event_type.startswith("network.") else "web" if row.event_type.startswith("http.") else "session")
    value = {"@timestamp": row.observed_at.isoformat(), "ecs": {"version": "8.0.0"},
        "event": {"id": row.id, "action": row.event_type, "module": "honeyforge", "dataset": "honeyforge.telemetry",
            "kind": "metric" if row.event_type == "network.traffic" else "event", "category": [category],
            "type": ["info"], "sequence": row.ingest_position, "ingested": row.created_at.isoformat()},
        "observer": {"id": row.host_id, "product": "HoneyForge", "type": "honeypot"},
        "service": {"id": row.deployment_id}, "honeyforge": {"event_id": row.event_id, "session_id": row.session_id,
            "generation": row.generation, "profile_version_id": row.profile_version_id, "provenance": row.provenance,
            "payload": sanitize(row.payload)}}
    try:
        value["source"] = {"ip": str(ip_address(row.source_ip))}
    except ValueError:
        value["honeyforge"]["source_observation"] = row.source_ip
    if row.event_type in {"ssh.login.success", "ssh.login.failed"}:
        value["event"]["outcome"] = "success" if row.event_type.endswith("success") else "failure"
    return value


class IntegrationService:
    def __init__(self, database, investigation=None, settings=None):
        self.database, self.investigation, self.settings = database, investigation, settings

    def principal(self, u, token):
        row = u.repo.find(IntegrationToken, token_hash=digest(token))
        if not row or row.revoked_at or row.expires_at <= now():
            raise DomainError("invalid_integration_key", "Integration credential is invalid or expired", 401)
        return row

    def list(self):
        with self.database.sessions() as s:
            return [record(row, {"token_hash"}) for row in s.scalars(select(IntegrationToken).order_by(IntegrationToken.created_at.desc()).limit(200))]

    def create(self, actor, command):
        with self.database.unit_of_work() as u:
            u.lock_write()
            if command.deployment_id:
                required(u.repo.get(Deployment, str(command.deployment_id)), "Deployment")
            count = u.session.scalar(select(func.count()).select_from(IntegrationToken).where(
                IntegrationToken.revoked_at.is_(None), IntegrationToken.expires_at > now()))
            if count >= 100:
                raise DomainError("integration_quota", "Revoke unused credentials before creating more", 409)
            token = secret()
            row = u.repo.add(IntegrationToken(name=command.name, token_hash=digest(token),
                deployment_id=str(command.deployment_id) if command.deployment_id else None,
                allow_response=command.allow_response,
                expires_at=now() + timedelta(days=command.expires_days), created_by=actor))
            u.audit(actor, "integration.created", row.id, {"name": row.name, "deployment_id": row.deployment_id,
                "scope": "events:read", "allow_response": row.allow_response, "expires_at": row.expires_at.isoformat()})
            return {"token": token, "integration": record(row, {"token_hash"})}

    def revoke(self, actor, key):
        with self.database.unit_of_work() as u:
            u.lock_write()
            row = required(u.repo.get(IntegrationToken, key), "Integration")
            if not row.revoked_at:
                row.revoked_at = now()
                u.audit(actor, "integration.revoked", key)
                for policy in u.session.scalars(select(SourceBlock).where(SourceBlock.created_by == "integration:" + row.id,
                        SourceBlock.desired_state == "blocked", SourceBlock.expires_at > now())):
                    policy.desired_state = "released"
                    policy.revision += 1
                    u.audit(actor, "source.block.cancelled", policy.id, {"revision": policy.revision, "integration_revoked": key})
                    u.emit("policy.changed", {"id": policy.id, "deployment_id": policy.deployment_id})
            return record(row, {"token_hash"})

    def events(self, token, after, limit):
        with self.database.unit_of_work() as u:
            row = self.principal(u, token)
            if not row.last_used_at or row.last_used_at < now() - timedelta(minutes=1):
                row.last_used_at = now()
                u.audit("integration:" + row.id, "integration.read", row.id, {"after": after, "scope": "events:read"})
            watermark = u.session.get(StreamState, 1).position
            query = select(Event).where(Event.ingest_position > after, Event.ingest_position <= watermark).order_by(Event.ingest_position).limit(limit + 1)
            if row.deployment_id:
                query = query.where(Event.deployment_id == row.deployment_id)
            events = list(u.session.scalars(query))
            has_more = len(events) > limit
            chosen = events[:limit]
            return {"format": "honeyforge-ecs-events-v1", "items": [ecs_event(event) for event in chosen],
                "next_cursor": chosen[-1].ingest_position if has_more else watermark, "watermark": watermark,
                "has_more": has_more, "reset_required": after > watermark}

    def respond(self, token, command, key):
        with self.database.unit_of_work() as u:
            principal = self.principal(u, token)
            if not principal.allow_response or not principal.deployment_id:
                raise DomainError("permission_denied", "This credential is read-only", 403)
            event = required(u.repo.get(Event, str(command.event_id)), "Event")
            if event.deployment_id != principal.deployment_id:
                raise DomainError("foreign_evidence", "Event is outside this integration scope", 403)
            if event.event_type not in {"http.request", "http.login", "ssh.connect", "ssh.login.success", "ssh.login.failed", "ssh.command"}:
                raise DomainError("invalid_response_evidence", "Response requires an observed service interaction", 409)
            actor, generation = "integration:" + principal.id, event.generation
            response = CreateSourceBlock(deployment_id=event.deployment_id, source_ip=event.source_ip,
                ttl_seconds=command.ttl_seconds, reason=command.reason.strip() + " [event " + event.id + "]", terminate_sessions=True)
            # Separate credential namespace prevents collisions with operator idempotency keys.
            scoped_key = digest(principal.id + ":" + key)
        return self.investigation.create_block(actor, response, scoped_key, expected_generation=generation, integration_id=principal.id)

    def policy(self, token, key):
        with self.database.unit_of_work() as u:
            principal = self.principal(u, token)
            row = required(u.repo.get(SourceBlock, key), "Policy")
            if not principal.allow_response or row.created_by != "integration:" + principal.id:
                raise DomainError("permission_denied", "Policy is outside this integration scope", 403)
            return block_view(u.session, row, self.settings.offline_seconds)
