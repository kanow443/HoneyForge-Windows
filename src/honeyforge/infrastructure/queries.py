from datetime import timedelta

from sqlalchemy import Text, func, or_, select, text

from honeyforge.application.control import required
from honeyforge.application.schemas import ExportView, QueryFilters, SessionReport
from honeyforge.domain.errors import DomainError
from honeyforge.infrastructure.documents import canonical_document
from honeyforge.infrastructure.models import (
    Audit,
    Deployment,
    Event,
    EventFlag,
    Finding,
    Host,
    InvestigationCase,
    Profile,
    ProfileVersion,
    Session,
    SourceBlock,
    StreamEntry,
    StreamState,
    now,
)
from honeyforge.infrastructure.projections import (
    block_view,
    deployment_view,
    event_view,
    host_view,
    profile_view,
    record,
)


class Queries:
    """Read projections are independent of transactional commands (lightweight CQRS)."""
    def __init__(self, database, settings):
        self.database, self.settings = database, settings

    def hosts(self):
        with self.database.sessions() as s:
            return [host_view(h, self.settings.offline_seconds) for h in s.scalars(select(Host).order_by(Host.created_at.desc()))]

    def profiles(self):
        with self.database.sessions() as s:
            return [profile_view(s, p) for p in s.scalars(select(Profile).order_by(Profile.created_at.desc()))]

    def profile(self, key):
        with self.database.sessions() as s:
            return profile_view(s, required(s.get(Profile, key), "Profile"))

    def deployments(self):
        with self.database.sessions() as s:
            return [deployment_view(s, d, self.settings.offline_seconds) for d in s.scalars(select(Deployment).order_by(Deployment.created_at.desc()))]

    def deployment(self, key):
        with self.database.sessions() as s:
            return deployment_view(s, required(s.get(Deployment, key), "Deployment"), self.settings.offline_seconds)

    def _conditions(self, filters: QueryFilters):
        conditions = []
        for key in ("host_id", "deployment_id", "event_type", "source_ip"):
            value = getattr(filters, key)
            if value is not None:
                conditions.append(getattr(Event, key) == str(value))
        if filters.since:
            conditions.append(Event.created_at >= filters.since)
        if filters.flag:
            conditions.append(select(EventFlag.id).where(EventFlag.event_id == Event.id,
                EventFlag.flag == filters.flag).exists())
        if filters.until:
            conditions.append(Event.created_at <= filters.until)
        if filters.q:
            term = "%" + filters.q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            conditions.append(or_(Event.payload.cast(Text).ilike(term, escape="\\"), Event.source_ip.ilike(term, escape="\\"),
                Event.event_type.ilike(term, escape="\\")))
        return conditions

    def events(self, filters: QueryFilters):
        with self.database.sessions() as s:
            s.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
            conditions = self._conditions(filters)
            total = s.scalar(select(func.count()).select_from(Event).where(*conditions))
            rows = s.scalars(select(Event).where(*conditions).order_by(Event.created_at.desc(), Event.id)
                .limit(filters.limit).offset(filters.offset))
            return {"items": [event_view(s, e) for e in rows], "total": total,
                "watermark": s.get(StreamState, 1).position}

    def sessions(self, deployment_id=None):
        with self.database.sessions() as s:
            query = select(Session).order_by(Session.started_at.desc()).limit(100)
            if deployment_id:
                query = query.where(Session.deployment_id == deployment_id)
            result = []
            for row in s.scalars(query):
                deployment = s.get(Deployment, row.deployment_id)
                result.append({**record(row), "deployment_name": deployment.name,
                    "event_count": s.scalar(select(func.count()).select_from(Event).where(Event.session_id == row.id))})
            return result

    def session(self, key):
        with self.database.sessions() as s:
            row = required(s.get(Session, key), "Session")
            deployment = s.get(Deployment, row.deployment_id)
            version = s.get(ProfileVersion, row.profile_version_id)
            events = list(s.scalars(select(Event).where(Event.session_id == key)
                .order_by(Event.source_seq, Event.observed_at).limit(500)))
            count = s.scalar(select(func.count()).select_from(Event).where(Event.session_id == key))
            return {**record(row), "deployment_name": deployment.name, "profile_version": record(version),
                "events": [event_view(s, e) for e in events], "event_count": count, "truncated": count > len(events),
                "findings": [record(f) for f in s.scalars(select(Finding).where(Finding.session_id == key).order_by(Finding.created_at))]}

    def findings(self):
        with self.database.sessions() as s:
            return [{**record(f), "deployment_name": s.get(Deployment, f.deployment_id).name}
                for f in s.scalars(select(Finding).order_by(Finding.created_at.desc()).limit(100))]

    def audit(self):
        with self.database.sessions() as s:
            return [record(a) for a in s.scalars(select(Audit).order_by(Audit.created_at.desc()).limit(200))]

    def overview(self):
        with self.database.sessions() as s:
            s.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
            cutoff = now() - timedelta(hours=24)
            hosts = [host_view(h, self.settings.offline_seconds) for h in s.scalars(select(Host))]
            deployments = [deployment_view(s, d, self.settings.offline_seconds) for d in s.scalars(select(Deployment))]
            hour_bucket = func.date_trunc("hour", Event.created_at)
            buckets = s.execute(select(hour_bucket, func.count()).where(Event.created_at >= cutoff)
                .group_by(hour_bucket)).all()
            counts = {stamp.isoformat(): count for stamp, count in buckets}
            hour = now().replace(minute=0, second=0, microsecond=0)
            histogram = [{"at": (hour - timedelta(hours=i)).isoformat(), "count": counts.get((hour - timedelta(hours=i)).isoformat(), 0)}
                for i in reversed(range(24))]
            return {"running_traps": sum(d["state"] == "running" for d in deployments),
                "total_traps": len(deployments), "online_hosts": sum(h["status"] in {"online", "degraded"} for h in hosts),
                "total_hosts": len(hosts), "events_24h": s.scalar(select(func.count()).select_from(Event).where(Event.created_at >= cutoff)),
                "unique_sources": s.scalar(select(func.count(func.distinct(Event.source_ip))).where(Event.created_at >= cutoff)),
                "findings_24h": s.scalar(select(func.count()).select_from(Finding).where(Finding.created_at >= cutoff)),
                "queued_events": sum(h["metrics"].get("queued_events", 0) for h in hosts),
                "dropped_events": sum(h["metrics"].get("dropped_events", 0) for h in hosts), "histogram": histogram,
                "hosts": hosts, "deployments": deployments, "server_time": now()}

    def stream(self, after):
        with self.database.sessions() as s:
            s.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
            watermark = s.get(StreamState, 1).position
            lowest = s.scalar(select(func.min(StreamEntry.position)))
            if after > watermark or (lowest and after < lowest - 1):
                return {"reset": True, "items": [], "watermark": watermark}
            return {"reset": False, "items": [record(e) for e in s.scalars(select(StreamEntry)
                .where(StreamEntry.position > after).order_by(StreamEntry.position).limit(200))],
                "watermark": watermark}

    def playback(self, key, after, limit):
        with self.database.sessions() as s:
            s.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
            required(s.get(Session, key), "Session")
            watermark = s.get(StreamState, 1).position
            if after > watermark:
                raise DomainError("invalid_cursor", "Cursor is ahead of the current snapshot", 409)
            rows = list(s.scalars(select(Event).where(Event.session_id == key, Event.ingest_position > after)
                .order_by(Event.ingest_position).limit(limit + 1)))
            has_more = len(rows) > limit
            rows = rows[:limit]
            total = s.scalar(select(func.count()).select_from(Event).where(Event.session_id == key))
            return {"items": [event_view(s, row) for row in rows], "total": total,
                "next_cursor": rows[-1].ingest_position if has_more else watermark, "watermark": watermark, "has_more": has_more}

    def blocks(self, deployment_id=None):
        with self.database.sessions() as s:
            query = select(SourceBlock).order_by(SourceBlock.created_at.desc()).limit(500)
            if deployment_id:
                required(s.get(Deployment, deployment_id), "Deployment")
                query = query.where(SourceBlock.deployment_id == deployment_id)
            return [block_view(s, row, self.settings.offline_seconds) for row in s.scalars(query)]

    def cases(self):
        with self.database.sessions() as s:
            return [record(row) for row in s.scalars(select(InvestigationCase).order_by(InvestigationCase.updated_at.desc()).limit(200))]

    def _session_view(self, s, row):
        return {**record(row), "deployment_name": s.get(Deployment, row.deployment_id).name,
            "event_count": s.scalar(select(func.count()).select_from(Event).where(Event.session_id == row.id))}

    def topology(self, hours):
        with self.database.sessions() as s:
            s.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
            until, since = now(), now() - timedelta(hours=hours)
            inbound = or_(Event.event_type.like("http.%"), Event.event_type.like("ssh.%"), Event.event_type.like("tcp.%"),
                (Event.event_type == "network.connection") & (Event.payload["direction"].as_string() == "inbound"))
            conditions = (Event.created_at >= since, Event.created_at <= until, Event.source_ip != "unknown", inbound)
            source_query = select(Event.source_ip, func.count(), func.max(Event.observed_at)).where(*conditions)
            source_rows = s.execute(source_query.group_by(Event.source_ip).order_by(func.max(Event.created_at).desc()).limit(101)).all()
            visible_sources = [r[0] for r in source_rows[:100]]
            link_rows = s.execute(select(Event.source_ip, Event.deployment_id, func.count(), func.max(Event.observed_at))
                .where(*conditions, Event.source_ip.in_(visible_sources)).group_by(Event.source_ip, Event.deployment_id)
                .order_by(func.max(Event.created_at).desc()).limit(201)).all()
            severities = {}
            rank = {"none": 0, "low": 1, "medium": 2, "high": 3}
            for source, dep, severity in s.execute(select(Session.source_ip, Session.deployment_id, Finding.severity)
                .join(Finding, Finding.session_id == Session.id).where(Finding.created_at >= since)):
                previous = severities.get((source, dep), "none")
                if rank.get(severity, 0) > rank[previous]:
                    severities[(source, dep)] = severity
            links = []
            for source, dep, count, last in link_rows[:200]:
                session_id = s.scalar(select(Session.id).where(Session.source_ip == source, Session.deployment_id == dep)
                    .order_by(Session.started_at.desc()).limit(1))
                links.append({"source_ip": source, "deployment_id": dep, "event_count": count,
                    "last_seen": last, "severity": severities.get((source, dep), "none"), "session_id": session_id})
            hosts = list(s.scalars(select(Host).order_by(Host.created_at.desc()).limit(101)))
            deployments = list(s.scalars(select(Deployment).order_by(Deployment.created_at.desc()).limit(101)))
            sessions = list(s.scalars(select(Session).where(Session.started_at >= since)
                .order_by(Session.started_at.desc()).limit(100)))
            return {"hosts": [host_view(h, self.settings.offline_seconds) for h in hosts[:100]],
                "deployments": [deployment_view(s, d, self.settings.offline_seconds) for d in deployments[:100]],
                "sources": [{"source_ip": source, "event_count": count, "last_seen": last} for source, count, last in source_rows[:100]],
                "links": links, "sessions": [self._session_view(s, row) for row in sessions],
                "watermark": s.get(StreamState, 1).position, "since": since, "until": until,
                "truncated": len(source_rows) > 100 or len(link_rows) > 200 or len(hosts) > 100 or len(deployments) > 100}

    def report(self, key):
        with self.database.sessions() as s:
            s.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
            session = required(s.get(Session, key), "Session")
            deployment = s.get(Deployment, session.deployment_id)
            host = s.get(Host, deployment.host_id)
            rows = list(s.scalars(select(Event).where(Event.session_id == key).order_by(Event.source_seq, Event.observed_at, Event.id).limit(5000)))
            total = s.scalar(select(func.count()).select_from(Event).where(Event.session_id == key))
            blocks = list(s.scalars(select(SourceBlock).where(SourceBlock.deployment_id == deployment.id,
                SourceBlock.generation == session.generation, SourceBlock.source_ip == session.source_ip).order_by(SourceBlock.created_at)))
            objects = [session.id, deployment.id, *[b.id for b in blocks]]
            audits = list(s.scalars(select(Audit).where(Audit.object_id.in_(objects)).order_by(Audit.created_at).limit(200)))
            limitations = ["IP identifies an observed network source, not a person; client OS is unknown.",
                "SSH commands and captured output describe an emulated shell, not the client's operating system.",
                "Intent findings are distinguished from observed network activity.",
                "Source policies apply to the selected trap. SSH termination is a separate sensor acknowledgment; inspect termination_state and terminated_sessions.",
                "SHA-256 checks content integrity and is not a digital signature."]
            if total > len(rows):
                limitations.append("Event selection is truncated to 5000 records.")
            if session.protocol == "ssh" and not any(e.event_type == "ssh.output" for e in rows):
                limitations.append("No terminal output was captured in this selected session history.")
            if any(e.event_type == "sensor.error" for e in rows):
                limitations.append("The session includes a sensor error or a terminal capture quota event; inspect the timeline for gaps.")
            audit_total = s.scalar(select(func.count()).select_from(Audit).where(Audit.object_id.in_(objects)))
            if audit_total > len(audits):
                limitations.append("Related audit selection is truncated to 200 records.")
            return canonical_document(SessionReport, {"format": "honeyforge-session-report-v1", "generated_at": now(),
                "session": self._session_view(s, session), "profile_version": record(s.get(ProfileVersion, session.profile_version_id)),
                "deployment": deployment_view(s, deployment, self.settings.offline_seconds),
                "events": [event_view(s, row) for row in rows],
                "findings": [record(row) for row in s.scalars(select(Finding).where(Finding.session_id == key).order_by(Finding.created_at))],
                "source_blocks": [block_view(s, b, self.settings.offline_seconds) for b in blocks], "audit": [record(a) for a in audits],
                "total": total, "truncated": total > len(rows),
                "collection": {"host_status": host_view(host, self.settings.offline_seconds)["status"], "metrics": host.metrics,
                    "watermark": s.get(StreamState, 1).position}, "limitations": limitations})

    def export(self, request, actor):
        with self.database.unit_of_work() as u:
            u.lock_write()
            conditions = self._conditions(request.filters)
            if request.session_id:
                required(u.repo.get(Session, str(request.session_id)), "Session")
                conditions.append(Event.session_id == str(request.session_id))
            rows = list(u.session.scalars(select(Event).where(*conditions).order_by(Event.created_at).limit(5000)))
            count = u.session.scalar(select(func.count()).select_from(Event).where(*conditions))
            data = {"format": "honeyforge-events-v1", "exported_at": now().isoformat(), "retention_days": self.settings.event_retention_days,
                "filters": request.model_dump(mode="json"), "total": count, "truncated": count > len(rows),
                "events": [event_view(u.session, row) for row in rows]}
            data = canonical_document(ExportView, data)
            u.audit(actor, "events.exported", str(request.session_id or "selection"), {"count": len(rows), "sha256": data["sha256"]})
            return data
