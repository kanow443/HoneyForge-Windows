"""Bounded, resumable expiry. Receiving uploads and case pins are never collected."""
from datetime import timedelta

from sqlalchemy import and_, delete, false, or_, select
from sqlalchemy.dialects.postgresql import array

from honeyforge.application.control import required
from honeyforge.domain.errors import DomainError
from honeyforge.infrastructure.models import (
    Audit,
    Event,
    EvidenceArtifact,
    Finding,
    InvestigationCase,
    Session,
    StreamEntry,
    now,
)
from honeyforge.infrastructure.projections import record


class RetentionService:
    def __init__(self, database, settings, evidence):
        self.database, self.settings, self.evidence = database, settings, evidence

    def pin(self, actor, case_id, command):
        with self.database.unit_of_work() as u:
            u.lock_write()
            case = required(u.repo.get(InvestigationCase, case_id), "Case")
            if case.revision != command.revision:
                raise DomainError("stale_revision", "The case was changed; refresh before pinning", 409)
            if command.pinned:
                sessions = list(u.session.scalars(select(Session).where(Session.id.in_(case.session_ids))))
                for session in sessions:
                    disappearing = u.session.scalar(select(EvidenceArtifact.id).where(
                        EvidenceArtifact.deployment_id == session.deployment_id,
                        EvidenceArtifact.generation == session.generation,
                        EvidenceArtifact.state == "purging",
                        or_(EvidenceArtifact.source_session_id == session.source_id,
                            and_(EvidenceArtifact.source_session_id.is_(None),
                                EvidenceArtifact.started_at <= (session.ended_at or now()),
                                EvidenceArtifact.ended_at >= session.started_at))).limit(1))
                    if disappearing:
                        raise DomainError("evidence_expiry_in_progress",
                            "Evidence expiry already started; refresh the case before pinning", 409)
            case.retention_pinned = command.pinned
            case.revision += 1
            case.updated_at = now()
            u.audit(actor, "case.retention_changed", case_id, {"pinned": command.pinned})
            u.emit("case.changed", {"id": case_id})
            return record(case)

    def sweep(self, limit=200):
        limit = min(500, max(1, limit))
        counts = {"events": 0, "artifacts": 0, "audit": 0, "stream": 0}
        with self.database.unit_of_work() as u:
            u.lock_write()
            pinned = set()
            for case in u.session.scalars(select(InvestigationCase).where(InvestigationCase.retention_pinned.is_(True))):
                pinned.update(case.session_ids)
            sessions = list(u.session.scalars(select(Session).where(Session.id.in_(pinned)))) if pinned else []
            # Resolve shared PCAP segments against session intervals, matching the evidence list projection.
            protected = or_(*(and_(EvidenceArtifact.deployment_id == s.deployment_id,
                EvidenceArtifact.generation == s.generation,
                or_(EvidenceArtifact.source_session_id == s.source_id,
                    and_(EvidenceArtifact.source_session_id.is_(None), EvidenceArtifact.started_at <= (s.ended_at or now()),
                        EvidenceArtifact.ended_at >= s.started_at))) for s in sessions)) if sessions else false()
            rows = list(u.session.scalars(select(EvidenceArtifact).where(
                EvidenceArtifact.state.in_(["available", "purging"]), EvidenceArtifact.expires_at < now(), ~protected)
                .order_by(EvidenceArtifact.expires_at).limit(limit)))
            pending = []
            for artifact in rows:
                artifact.state = "purging"
                pending.append(artifact.id)
            cutoff = now() - timedelta(days=self.settings.event_retention_days)
            ids = list(u.session.scalars(select(Event.id).where(Event.created_at < cutoff,
                Event.session_id.not_in(pinned) | Event.session_id.is_(None)).order_by(Event.created_at).limit(limit)))
            if ids:
                # Findings refer to event identifiers in JSON. Do not leave misleading partial evidence lists.
                for finding in u.session.scalars(select(Finding).where(
                    Finding.evidence_ids.op("?|")(array(ids)),
                    Finding.session_id.not_in(pinned) | Finding.session_id.is_(None))):
                    u.session.delete(finding)
                u.session.execute(delete(Event).where(Event.id.in_(ids)))
                counts["events"] = len(ids)
            for model, label, days in [(Audit, "audit", 30), (StreamEntry, "stream", self.settings.event_retention_days)]:
                column = model.id if model is Audit else model.position
                old = list(u.session.scalars(select(column).where(model.created_at < now() - timedelta(days=days)).limit(limit)))
                if old:
                    u.session.execute(delete(model).where(column.in_(old)))
                counts[label] = len(old)
        # Crash here leaves an explicit purging row. A subsequent sweep completes it.
        for artifact_id in pending:
            self.evidence.path(artifact_id).unlink(missing_ok=True)
            self.evidence.path(artifact_id, True).unlink(missing_ok=True)
            with self.database.unit_of_work() as u:
                u.lock_write()
                row = u.repo.get(EvidenceArtifact, artifact_id)
                if row and row.state == "purging":
                    row.state = "expired"
                    u.emit("artifact.changed", {"id": artifact_id, "deployment_id": row.deployment_id})
                    counts["artifacts"] += 1
        return counts

    def status(self):
        from sqlalchemy import func
        with self.database.sessions() as s:
            reserved = s.scalar(select(func.coalesce(func.sum(EvidenceArtifact.size_bytes), 0))
                .where(EvidenceArtifact.state != "expired"))
            pins = s.scalar(select(func.count()).select_from(InvestigationCase).where(InvestigationCase.retention_pinned.is_(True)))
            return {"event_retention_days": self.settings.event_retention_days, "audit_retention_days": 30,
                "reserved_bytes": reserved, "quota_bytes": self.settings.artifact_quota_bytes,
                "collection_available": reserved < self.settings.artifact_quota_bytes, "pinned_cases": pins}
