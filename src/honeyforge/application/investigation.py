"""Typed investigation commands; policy application belongs to the sensor, not HTTP handlers."""
import hashlib
import json
from datetime import timedelta
from ipaddress import ip_address

from sqlalchemy import func, select

from honeyforge.application.control import required
from honeyforge.domain.errors import DomainError
from honeyforge.infrastructure.models import (
    Deployment,
    Event,
    Host,
    IntegrationToken,
    InvestigationCase,
    Session,
    SourceBlock,
    now,
)
from honeyforge.infrastructure.projections import block_effective_state, block_view, record


class InvestigationService:
    def __init__(self, uow_factory, settings):
        self.uow_factory, self.settings = uow_factory, settings

    def create_block(self, actor, command, key, expected_generation=None, integration_id=None):
        fingerprint = hashlib.sha256(json.dumps(command.model_dump(mode="json"), sort_keys=True).encode()).hexdigest()
        with self.uow_factory() as u:
            u.lock_write()
            if integration_id:
                integration = u.repo.get(IntegrationToken, integration_id)
                if not integration or integration.revoked_at or integration.expires_at <= now():
                    raise DomainError("invalid_integration_key", "Integration credential is invalid or expired", 401)
                if not integration.allow_response or integration.deployment_id != str(command.deployment_id):
                    raise DomainError("permission_denied", "This response is outside the integration scope", 403)
            previous = u.repo.find(SourceBlock, idempotency_key=key)
            if previous:
                if previous.request_hash != fingerprint:
                    raise DomainError("idempotency_conflict", "This key was used with a different request", 409)
                return block_view(u.session, previous, self.settings.offline_seconds)
            deployment = required(u.repo.get(Deployment, str(command.deployment_id)), "Deployment")
            if expected_generation is not None and deployment.runtime_generation != expected_generation:
                raise DomainError("stale_evidence", "This event belongs to an earlier runtime generation", 409)
            if actor.startswith("integration:"):
                recent = u.session.scalar(select(func.count()).select_from(SourceBlock).where(SourceBlock.created_by == actor,
                    SourceBlock.created_at > now() - timedelta(hours=1)))
                if recent >= 10:
                    raise DomainError("response_rate_limit", "Automated response budget is 10 new policies per hour", 429)
            host = required(u.repo.get(Host, deployment.host_id), "Host")
            if host.revoked_at or deployment.desired_state != "running" or deployment.observed_state != "running":
                raise DomainError("runtime_unavailable", "Select a deployed running trap", 409)
            try:
                sensor_ip = str(ip_address(host.address))
            except ValueError:
                sensor_ip = None
            if sensor_ip == command.source_ip:
                raise DomainError("protected_source", "The sensor management address cannot be blocked", 409)
            observed = u.session.scalar(select(Event.id).where(Event.deployment_id == deployment.id,
                Event.generation == deployment.runtime_generation, Event.source_ip == command.source_ip,
                Event.event_type.in_(["ssh.connect", "ssh.login.failed", "ssh.login.success", "ssh.command", "http.request", "http.login"])).limit(1))
            if not observed:
                raise DomainError("unobserved_source", "The source must have an observed interaction with this runtime", 409)
            outstanding = u.session.scalar(select(func.count()).select_from(SourceBlock).where(
                SourceBlock.host_id == host.id, SourceBlock.observed_state != "released"))
            if outstanding >= 500:
                raise DomainError("policy_limit", "Resolve existing policies before creating more", 409)
            duplicate = u.session.scalar(select(SourceBlock.id).where(SourceBlock.deployment_id == deployment.id,
                SourceBlock.generation == deployment.runtime_generation, SourceBlock.source_ip == command.source_ip,
                SourceBlock.desired_state == "blocked", SourceBlock.expires_at > now()))
            if duplicate:
                raise DomainError("already_blocked", "An unexpired policy already exists for this source", 409)
            row = u.repo.add(SourceBlock(deployment_id=deployment.id, host_id=host.id,
                generation=deployment.runtime_generation, source_ip=command.source_ip, reason=command.reason,
                expires_at=now() + timedelta(seconds=command.ttl_seconds), created_by=actor,
                terminate_sessions=command.terminate_sessions and deployment.adapter == "cowrie",
                termination_state="pending" if command.terminate_sessions and deployment.adapter == "cowrie" else "not_requested",
                idempotency_key=key, request_hash=fingerprint))
            u.audit(actor, "source.block.requested", row.id, {"deployment_id": row.deployment_id,
                "source_ip": row.source_ip, "reason": row.reason, "expires_at": row.expires_at.isoformat(),
                "revision": row.revision, "terminate_sessions": row.terminate_sessions})
            u.emit("policy.changed", {"id": row.id, "deployment_id": row.deployment_id})
            return block_view(u.session, row, self.settings.offline_seconds)

    def cancel_block(self, actor, key, revision):
        with self.uow_factory() as u:
            u.lock_write()
            row = required(u.repo.get(SourceBlock, key), "Policy")
            if row.revision != revision:
                raise DomainError("stale_revision", "Policy has changed; refresh before cancelling", 409)
            if row.desired_state != "released":
                row.desired_state = "released"
                row.revision += 1
                row.error = None
                u.audit(actor, "source.block.cancelled", row.id, {"revision": row.revision, "deployment_id": row.deployment_id})
                u.emit("policy.changed", {"id": row.id, "deployment_id": row.deployment_id})
            return block_view(u.session, row, self.settings.offline_seconds)

    def policies(self, host_id):
        with self.uow_factory() as u:
            host = u.repo.get(Host, host_id)
            if not host or host.revoked_at:
                raise DomainError("invalid_agent_key", "Agent key is invalid or revoked", 401)
            rows = u.session.scalars(select(SourceBlock).where(SourceBlock.host_id == host_id,
                (SourceBlock.observed_state != "released") | ((SourceBlock.desired_state == "blocked") & (SourceBlock.expires_at > now()))))
            return [{"id": row.id, "deployment_id": row.deployment_id, "generation": row.generation,
                "source_ip": row.source_ip, "expires_at": row.expires_at, "revision": row.revision,
                "terminate_sessions": row.terminate_sessions,
                "desired_state": block_effective_state(row, u.repo.get(Deployment, row.deployment_id))} for row in rows]

    def acknowledge(self, host_id, key, command):
        with self.uow_factory() as u:
            u.lock_write()
            host = u.repo.get(Host, host_id)
            if not host or host.revoked_at:
                raise DomainError("invalid_agent_key", "Agent key is invalid or revoked", 401)
            row = required(u.repo.get(SourceBlock, key), "Policy")
            if row.host_id != host_id:
                raise DomainError("foreign_policy", "Policy belongs to another host", 403)
            if row.revision != command.revision:
                raise DomainError("stale_revision", "Policy revision is stale", 409)
            deployment = u.repo.get(Deployment, row.deployment_id)
            expected = "applied" if block_effective_state(row, deployment) == "blocked" else "released"
            if command.state not in {expected, "error"}:
                raise DomainError("unexpected_policy_state", "Reported state does not match the current policy", 409)
            termination_state, termination_error = row.termination_state, row.termination_error
            terminated = row.terminated_sessions
            if row.terminate_sessions and command.state == "applied":
                if command.termination_state == "not_requested":
                    raise DomainError("unexpected_termination_state", "This policy requests SSH termination", 409)
                if command.termination_state != "pending":
                    termination_state, termination_error = command.termination_state, command.termination_error
                terminated = sorted(set(terminated) | set(command.terminated_sessions))
                if len(terminated) > 1000:
                    raise DomainError("termination_evidence_limit", "Too many transport identifiers", 409)
            elif command.terminated_sessions:
                raise DomainError("unexpected_termination_evidence", "No active SSH termination was requested", 409)
            if (row.observed_revision == command.revision and row.observed_state == command.state
                    and row.error == command.error and row.termination_state == termination_state
                    and row.termination_error == termination_error and row.terminated_sessions == terminated):
                return {"ok": True}
            row.observed_revision, row.observed_state = command.revision, command.state
            row.observed_at, row.error = now(), command.error if command.state == "error" else None
            row.termination_state, row.termination_error, row.terminated_sessions = termination_state, termination_error, terminated
            u.audit("agent:" + host_id, "source.block." + command.state, row.id,
                {"revision": command.revision, "deployment_id": row.deployment_id, "error": row.error,
                    "termination_state": row.termination_state, "terminated_sessions": row.terminated_sessions,
                    "termination_error": row.termination_error})
            u.emit("policy.changed", {"id": row.id, "deployment_id": row.deployment_id})
            return {"ok": True}

    def create_case(self, actor, command):
        with self.uow_factory() as u:
            u.lock_write()
            ids = list(dict.fromkeys(str(key) for key in command.session_ids))
            for key in ids:
                required(u.repo.get(Session, key), "Session")
            row = u.repo.add(InvestigationCase(title=command.title, session_ids=ids, note=command.note, created_by=actor))
            u.audit(actor, "case.created", row.id, {"session_ids": ids, "revision": row.revision})
            u.emit("case.changed", {"id": row.id})
            return record(row)

    def update_case(self, actor, key, command):
        with self.uow_factory() as u:
            u.lock_write()
            row = required(u.repo.get(InvestigationCase, key), "Case")
            if row.revision != command.revision:
                raise DomainError("stale_revision", "Case has changed; refresh before editing", 409)
            row.status, row.note = command.status, command.note
            row.revision += 1
            row.updated_at = now()
            u.audit(actor, "case.updated", row.id, {"status": row.status, "revision": row.revision})
            u.emit("case.changed", {"id": row.id})
            return record(row)
