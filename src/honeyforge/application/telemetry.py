import json
from datetime import timedelta

from honeyforge.application.detection import DetectionService
from honeyforge.application.honeytokens import HoneyTokenService
from honeyforge.application.schemas import EventBatch
from honeyforge.domain.errors import DomainError
from honeyforge.domain.rules import match_event
from honeyforge.infrastructure.models import (
    Deployment,
    DeploymentRun,
    Event,
    Finding,
    Host,
    PrivateCapture,
    Session,
    now,
)
from honeyforge.infrastructure.security import sanitize


class TelemetryService:
    def __init__(self, uow_factory, capture_keys=None):
        self.uow_factory, self.capture_keys = uow_factory, capture_keys

    def ingest(self, host_id: str, batch: EventBatch):
        accepted, rejected, inserted = [], [], 0
        with self.uow_factory() as u:
            u.lock_write()
            host = u.repo.get(Host, host_id)
            if not host or host.revoked_at:
                raise DomainError("invalid_agent_key", "Agent key is invalid or revoked", 401)
            for item in batch.events:
                deployment = u.repo.get(Deployment, str(item.deployment_id))
                run = u.repo.get(DeploymentRun, str(item.generation))
                if not deployment or deployment.host_id != host_id or not run or run.deployment_id != deployment.id:
                    rejected.append({"event_id": item.event_id, "reason": "foreign_or_unknown_runtime"})
                    continue
                existing = u.repo.find(Event, host_id=host_id, event_id=item.event_id)
                if existing:
                    accepted.append(item.event_id)
                    continue
                if len(json.dumps(item.payload).encode()) > 65536 or item.observed_at > now() + timedelta(minutes=5):
                    rejected.append({"event_id": item.event_id, "reason": "invalid_size_or_timestamp"})
                    continue
                session = None
                if item.private_capture:
                    try:
                        context = {"host_id": host_id, "deployment_id": deployment.id,
                            "generation": run.id, "event_id": item.event_id,
                            "source_session_id": item.source_session_id, "event_type": item.event_type}
                        self.capture_keys.decrypt(item.private_capture, context)
                        from uuid import UUID
                        capture_id = str(UUID(item.private_capture["context"]["capture_id"]))
                        if u.repo.find(PrivateCapture, capture_id=capture_id):
                            raise ValueError("Capture already belongs to another event")
                    except Exception:
                        rejected.append({"event_id": item.event_id, "reason": "invalid_private_capture"})
                        continue
                if item.source_session_id:
                    session = u.repo.find(Session, deployment_id=deployment.id, generation=str(item.generation),
                        source_id=item.source_session_id)
                    if not session:
                        session = u.repo.add(Session(deployment_id=deployment.id, generation=str(item.generation),
                            profile_version_id=run.profile_version_id, source_id=item.source_session_id,
                            source_ip=item.source_ip, protocol="ssh" if item.event_type.startswith("ssh.") else "tcp" if item.event_type.startswith("tcp.") else "http",
                            started_at=item.observed_at))
                    session.started_at = min(session.started_at, item.observed_at)
                    if item.source_ip != "unknown" and session.source_ip == "unknown":
                        session.source_ip = item.source_ip
                    if item.event_type in {"ssh.disconnect", "tcp.disconnect"}:
                        session.ended_at = item.observed_at
                event = u.repo.add(Event(event_id=item.event_id, host_id=host_id, deployment_id=deployment.id,
                    profile_version_id=run.profile_version_id, session_id=session.id if session else None,
                    generation=str(item.generation), event_type=item.event_type,
                    source_ip=session.source_ip if item.source_ip == "unknown" and session else item.source_ip,
                    source_seq=item.source_seq, observed_at=item.observed_at, payload=sanitize(item.payload),
                    provenance=item.provenance, ingest_position=u.stream.position + 1,
                    private_capture_available=bool(item.private_capture)))
                if item.private_capture:
                    u.repo.add(PrivateCapture(event_id=event.id, capture_id=capture_id, envelope=item.private_capture))
                for match in match_event(event.event_type, event.payload):
                    u.repo.add(Finding(deployment_id=deployment.id, session_id=event.session_id,
                        rule_id=match.rule_id, rule_version=1, title=match.title, severity=match.severity,
                        explanation=match.explanation, observation=match.observation, evidence_ids=[event.id],
                        dedupe_key=f"{match.rule_id}:{event.id}"))
                if event.event_type == "ssh.login.failed":
                    DetectionService.observe(u, event)
                HoneyTokenService.observe(u, event)
                u.emit("event.created", {"id": event.id, "deployment_id": deployment.id,
                    "session_id": event.session_id, "event_type": event.event_type})
                accepted.append(item.event_id)
                inserted += 1
        # UnitOfWork commits before these acknowledgements are returned.
        return {"accepted": accepted, "rejected": rejected, "inserted": inserted}
