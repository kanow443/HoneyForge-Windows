from sqlalchemy import func, select

from honeyforge.domain.profiles import interaction_level
from honeyforge.infrastructure.models import (
    Deployment,
    Event,
    EventFlag,
    Host,
    Job,
    Profile,
    ProfileVersion,
    now,
)


def record(row, exclude=()):
    return {column.key: getattr(row, column.key) for column in row.__table__.columns if column.key not in exclude}


def host_view(row: Host, offline_seconds: int):
    result = record(row, {"key_hash"})
    result["status"] = "revoked" if row.revoked_at else "online" if row.last_seen and (
        now() - row.last_seen).total_seconds() <= offline_seconds else "offline"
    if result["status"] == "online" and any(row.metrics.get(k, 0) for k in ("dropped_events", "parser_errors", "network_dropped_packets",
            "artifact_errors", "artifact_dropped_packets")):
        result["status"] = "degraded"
    if result["status"] == "online" and row.metrics.get("network_capture_state") == "unavailable":
        result["status"] = "degraded"
    return result


def profile_view(session, row: Profile):
    return {**record(row), "interaction_level": interaction_level(row.adapter), "versions": [record(v)
        for v in session.scalars(select(ProfileVersion).where(ProfileVersion.profile_id == row.id)
        .order_by(ProfileVersion.number.desc()))]}


def deployment_view(session, row: Deployment, offline_seconds: int):
    host = session.get(Host, row.host_id)
    version = session.get(ProfileVersion, row.profile_version_id)
    profile = session.get(Profile, version.profile_id)
    state = row.observed_state
    if state not in {"stopped", "requested"} and host_view(host, offline_seconds)["status"] in {"offline", "revoked"}:
        state = "unknown"
    return {**record(row, {"idempotency_key", "request_hash"}), "host_name": host.name,
        "endpoint": f"{host.address}:{row.port}", "profile_name": profile.name, "version_number": version.number,
        "interaction_level": interaction_level(row.adapter), "state": state,
        "event_count": session.scalar(select(func.count()).select_from(Event).where(Event.deployment_id == row.id)),
        "jobs": [record(j) for j in session.scalars(select(Job).where(Job.deployment_id == row.id)
            .order_by(Job.created_at.desc()).limit(20))]}


def event_view(session, row: Event):
    deployment = session.get(Deployment, row.deployment_id)
    flags = session.scalars(select(EventFlag).where(EventFlag.event_id == row.id).order_by(EventFlag.created_at))
    return {**record(row), "deployment_name": deployment.name, "flags": [record(flag) for flag in flags]}


def block_effective_state(block, deployment):
    if block.desired_state == "released" or block.expires_at <= now() or deployment.runtime_generation != block.generation or deployment.desired_state != "running":
        return "released"
    return "blocked"


def block_view(session, row, offline_seconds):
    deployment = session.get(Deployment, row.deployment_id)
    host = session.get(Host, row.host_id)
    expected = "released" if block_effective_state(row, deployment) == "released" else "applied"
    acknowledged = row.observed_revision == row.revision and row.observed_state == expected
    stale = host_view(host, offline_seconds)["status"] in {"offline", "revoked"}
    if stale:
        state = "unknown"
    elif row.observed_state == "error" and row.observed_revision == row.revision:
        state = "error"
    elif not acknowledged:
        state = "unknown" if expected == "released" and row.observed_state == "applied" else "pending"
    elif deployment.runtime_generation != row.generation or deployment.desired_state != "running":
        state = "superseded"
    elif row.desired_state == "released":
        state = "cancelled"
    elif row.expires_at <= now():
        state = "expired"
    else:
        state = "applied"
    return {**record(row, {"idempotency_key", "request_hash"}), "state": state, "deployment_name": deployment.name}


def group_view(session, row, offline_seconds):
    children = [deployment_view(session, d, offline_seconds) for d in session.scalars(
        select(Deployment).where(Deployment.group_id == row.id).order_by(Deployment.service_key))]
    states = {d["state"] for d in children}
    state = "error" if "error" in states else "unknown" if "unknown" in states else (
        next(iter(states)) if len(states) == 1 else "mixed")
    return {**record(row, {"idempotency_key", "request_hash"}), "state": state, "services": children}
