from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def now() -> datetime:
    return datetime.now(UTC)


def uid() -> str:
    return str(uuid4())


class Base(DeclarativeBase):
    pass


class Record:
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


json_type = JSON().with_variant(JSONB, "postgresql")


class User(Record, Base):
    __tablename__ = "users"
    username: Mapped[str] = mapped_column(String(80), unique=True)
    password_hash: Mapped[str] = mapped_column(Text)
    role: Mapped[str] = mapped_column(String(20), default="admin")


class OperatorSession(Record, Base):
    __tablename__ = "operator_sessions"
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    csrf_hash: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class LoginAttempt(Record, Base):
    __tablename__ = "login_attempts"
    identity: Mapped[str] = mapped_column(String(64), index=True)
    succeeded: Mapped[bool]


class Host(Record, Base):
    __tablename__ = "hosts"
    name: Mapped[str] = mapped_column(String(100))
    address: Mapped[str] = mapped_column(String(120))
    key_hash: Mapped[str] = mapped_column(String(64), unique=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    capabilities: Mapped[list] = mapped_column(json_type, default=list)
    metrics: Mapped[dict] = mapped_column(json_type, default=dict)
    runtime_version: Mapped[str] = mapped_column(String(100), default="")


class Enrollment(Record, Base):
    __tablename__ = "enrollments"
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Profile(Record, Base):
    __tablename__ = "profiles"
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(String(500), default="")
    adapter: Mapped[str] = mapped_column(String(20))
    latest_version: Mapped[int] = mapped_column(default=1)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ProfileVersion(Record, Base):
    __tablename__ = "profile_versions"
    __table_args__ = (UniqueConstraint("profile_id", "number"),)
    profile_id: Mapped[str] = mapped_column(ForeignKey("profiles.id"))
    number: Mapped[int]
    config: Mapped[dict] = mapped_column(json_type)
    config_hash: Mapped[str] = mapped_column(String(64))


class DeploymentGroup(Record, Base):
    __tablename__ = "deployment_groups"
    name: Mapped[str] = mapped_column(String(100))
    host_id: Mapped[str] = mapped_column(ForeignKey("hosts.id"), index=True)
    profile_version_id: Mapped[str] = mapped_column(ForeignKey("profile_versions.id"))
    idempotency_key: Mapped[str] = mapped_column(String(100), unique=True)
    request_hash: Mapped[str] = mapped_column(String(64))


class Deployment(Record, Base):
    __tablename__ = "deployments"
    __table_args__ = (UniqueConstraint("group_id", "service_key", name="uq_deployments_group_service"),)
    name: Mapped[str] = mapped_column(String(100))
    host_id: Mapped[str] = mapped_column(ForeignKey("hosts.id"), index=True)
    profile_version_id: Mapped[str] = mapped_column(ForeignKey("profile_versions.id"))
    group_id: Mapped[str | None] = mapped_column(ForeignKey("deployment_groups.id"), index=True)
    service_key: Mapped[str | None] = mapped_column(String(24))
    adapter: Mapped[str] = mapped_column(String(20))
    port: Mapped[int]
    desired_state: Mapped[str] = mapped_column(String(20), default="running")
    desired_revision: Mapped[int] = mapped_column(default=1)
    observed_state: Mapped[str] = mapped_column(String(20), default="requested")
    observed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    runtime_generation: Mapped[str] = mapped_column(String(36), default=uid)
    image_digest: Mapped[str] = mapped_column(String(200), default="")
    error: Mapped[str | None] = mapped_column(Text)
    idempotency_key: Mapped[str] = mapped_column(String(100), unique=True)
    request_hash: Mapped[str] = mapped_column(String(64))


class PortReservation(Base):
    __tablename__ = "port_reservations"
    __table_args__ = (UniqueConstraint("host_id", "port"),)
    deployment_id: Mapped[str] = mapped_column(ForeignKey("deployments.id"), primary_key=True)
    host_id: Mapped[str] = mapped_column(ForeignKey("hosts.id"))
    port: Mapped[int]


class DeploymentRun(Record, Base):
    __tablename__ = "deployment_runs"
    deployment_id: Mapped[str] = mapped_column(ForeignKey("deployments.id"), index=True)
    profile_version_id: Mapped[str] = mapped_column(ForeignKey("profile_versions.id"))


class Job(Record, Base):
    __tablename__ = "jobs"
    deployment_id: Mapped[str] = mapped_column(ForeignKey("deployments.id"), index=True)
    host_id: Mapped[str] = mapped_column(ForeignKey("hosts.id"), index=True)
    kind: Mapped[str] = mapped_column(String(20))
    revision: Mapped[int]
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True)
    attempt: Mapped[int] = mapped_column(default=0)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    stages: Mapped[list] = mapped_column(json_type, default=list)
    error: Mapped[str | None] = mapped_column(Text)


class Session(Record, Base):
    __tablename__ = "sessions"
    __table_args__ = (UniqueConstraint("deployment_id", "generation", "source_id"),)
    deployment_id: Mapped[str] = mapped_column(ForeignKey("deployments.id"), index=True)
    generation: Mapped[str] = mapped_column(String(36))
    profile_version_id: Mapped[str] = mapped_column(ForeignKey("profile_versions.id"))
    source_id: Mapped[str] = mapped_column(String(100))
    source_ip: Mapped[str] = mapped_column(String(80))
    protocol: Mapped[str] = mapped_column(String(20))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Event(Record, Base):
    __tablename__ = "events"
    __table_args__ = (UniqueConstraint("host_id", "event_id"),
        Index("ix_event_deployment_time", "deployment_id", "created_at"),
        Index("ix_event_session_seq", "session_id", "source_seq"),
        Index("ix_event_observation_detection", "deployment_id", "event_type", "source_ip", "observed_at"))
    event_id: Mapped[str] = mapped_column(String(100))
    host_id: Mapped[str] = mapped_column(ForeignKey("hosts.id"))
    deployment_id: Mapped[str] = mapped_column(ForeignKey("deployments.id"))
    session_id: Mapped[str | None] = mapped_column(ForeignKey("sessions.id"))
    generation: Mapped[str] = mapped_column(String(36))
    profile_version_id: Mapped[str] = mapped_column(ForeignKey("profile_versions.id"))
    event_type: Mapped[str] = mapped_column(String(40), index=True)
    source_ip: Mapped[str] = mapped_column(String(80))
    source_seq: Mapped[int] = mapped_column(BigInteger, default=0)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    payload: Mapped[dict] = mapped_column(json_type)
    provenance: Mapped[str] = mapped_column(String(40), default="sensor")
    ingest_position: Mapped[int] = mapped_column(BigInteger, unique=True)
    private_capture_available: Mapped[bool] = mapped_column(Boolean, default=False)


class EventFlag(Record, Base):
    __tablename__ = "event_flags"
    __table_args__ = (UniqueConstraint("event_id", "flag", name="uq_event_flag"),)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    flag: Mapped[str] = mapped_column(String(30))
    note: Mapped[str] = mapped_column(String(500), default="")
    created_by: Mapped[str] = mapped_column(String(100))


class FlagChallenge(Record, Base):
    __tablename__ = "flag_challenges"
    binding_id: Mapped[str] = mapped_column(ForeignKey("honeytoken_bindings.id"), unique=True)
    title: Mapped[str] = mapped_column(String(100))
    points: Mapped[int] = mapped_column(Integer)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[str] = mapped_column(String(100))


class FlagSolve(Record, Base):
    __tablename__ = "flag_solves"
    __table_args__ = (UniqueConstraint("challenge_id", "user_id", name="uq_flag_solve"),)
    challenge_id: Mapped[str] = mapped_column(ForeignKey("flag_challenges.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    points: Mapped[int] = mapped_column(Integer)


class PrivateCapture(Record, Base):
    __tablename__ = "private_captures"
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), unique=True)
    capture_id: Mapped[str] = mapped_column(String(36), unique=True)
    envelope: Mapped[dict] = mapped_column(json_type)


class SourceBlock(Record, Base):
    __tablename__ = "source_blocks"
    deployment_id: Mapped[str] = mapped_column(ForeignKey("deployments.id"), index=True)
    host_id: Mapped[str] = mapped_column(ForeignKey("hosts.id"), index=True)
    generation: Mapped[str] = mapped_column(String(36))
    source_ip: Mapped[str] = mapped_column(String(45))
    reason: Mapped[str] = mapped_column(String(500))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    desired_state: Mapped[str] = mapped_column(String(20), default="blocked")
    revision: Mapped[int] = mapped_column(default=1)
    observed_revision: Mapped[int] = mapped_column(default=0)
    observed_state: Mapped[str] = mapped_column(String(20), default="pending")
    observed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(String(500))
    created_by: Mapped[str] = mapped_column(String(100))
    idempotency_key: Mapped[str] = mapped_column(String(100), unique=True)
    request_hash: Mapped[str] = mapped_column(String(64))
    terminate_sessions: Mapped[bool] = mapped_column(Boolean, default=False)
    termination_state: Mapped[str] = mapped_column(String(20), default="not_requested")
    terminated_sessions: Mapped[list] = mapped_column(json_type, default=list)
    termination_error: Mapped[str | None] = mapped_column(String(500))


class InvestigationCase(Record, Base):
    __tablename__ = "investigation_cases"
    title: Mapped[str] = mapped_column(String(120))
    session_ids: Mapped[list] = mapped_column(json_type)
    note: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="new")
    revision: Mapped[int] = mapped_column(default=1)
    created_by: Mapped[str] = mapped_column(String(100))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    retention_pinned: Mapped[bool] = mapped_column(Boolean, default=False)


class Finding(Record, Base):
    __tablename__ = "findings"
    __table_args__ = (UniqueConstraint("dedupe_key"),)
    deployment_id: Mapped[str] = mapped_column(ForeignKey("deployments.id"))
    session_id: Mapped[str | None] = mapped_column(ForeignKey("sessions.id"))
    rule_id: Mapped[str] = mapped_column(String(60))
    rule_version: Mapped[int] = mapped_column(default=1)
    title: Mapped[str] = mapped_column(String(100))
    severity: Mapped[str] = mapped_column(String(20))
    explanation: Mapped[str] = mapped_column(Text)
    observation: Mapped[str] = mapped_column(String(20))
    evidence_ids: Mapped[list] = mapped_column(json_type)
    dedupe_key: Mapped[str] = mapped_column(String(200))
    observed_first_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    observed_last_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notification_state: Mapped[str] = mapped_column(String(20), default="none")


class Audit(Record, Base):
    __tablename__ = "audit_log"
    actor: Mapped[str] = mapped_column(String(100))
    action: Mapped[str] = mapped_column(String(60))
    object_id: Mapped[str] = mapped_column(String(100))
    details: Mapped[dict] = mapped_column(json_type, default=dict)


class EvidenceArtifact(Record, Base):
    __tablename__ = "evidence_artifacts"
    host_id: Mapped[str] = mapped_column(ForeignKey("hosts.id"), index=True)
    deployment_id: Mapped[str] = mapped_column(ForeignKey("deployments.id"), index=True)
    generation: Mapped[str] = mapped_column(ForeignKey("deployment_runs.id"))
    source_session_id: Mapped[str | None] = mapped_column(String(100))
    kind: Mapped[str] = mapped_column(String(20))
    sha256: Mapped[str] = mapped_column(String(64))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    received_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    state: Mapped[str] = mapped_column(String(20), default="receiving")
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    details: Mapped[dict] = mapped_column(json_type, default=dict)


class IntegrationToken(Record, Base):
    __tablename__ = "integration_tokens"
    name: Mapped[str] = mapped_column(String(100))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    deployment_id: Mapped[str | None] = mapped_column(ForeignKey("deployments.id"))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[str] = mapped_column(String(100))
    allow_response: Mapped[bool] = mapped_column(Boolean, default=False)


class StreamState(Base):
    __tablename__ = "stream_state"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    position: Mapped[int] = mapped_column(default=0)


class StreamEntry(Base):
    __tablename__ = "event_stream"
    position: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(40))
    data: Mapped[dict] = mapped_column(json_type)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

class HoneyToken(Record, Base):
    service_key: Mapped[str | None] = mapped_column(String(24))
    __tablename__ = 'honeytokens'
    profile_id: Mapped[str] = mapped_column(ForeignKey('profiles.id', ondelete='CASCADE'), index=True)
    profile_version_id: Mapped[str] = mapped_column(ForeignKey('profile_versions.id', ondelete='CASCADE'), index=True)
    name: Mapped[str] = mapped_column(String(100))
    kind: Mapped[str] = mapped_column(String(10))
    file_path: Mapped[str | None] = mapped_column(String(240))
    created_by: Mapped[str] = mapped_column(String(100))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class HoneyTokenBinding(Record, Base):
    __tablename__ = 'honeytoken_bindings'
    __table_args__ = (UniqueConstraint('token_id', 'generation'),)
    token_id: Mapped[str] = mapped_column(ForeignKey('honeytokens.id', ondelete='CASCADE'))
    deployment_id: Mapped[str] = mapped_column(ForeignKey('deployments.id'))
    generation: Mapped[str] = mapped_column(ForeignKey('deployment_runs.id'))
    public_value: Mapped[str] = mapped_column(String(48), unique=True)
    resource_path: Mapped[str] = mapped_column(String(240))


class HoneyTokenUse(Record, Base):
    __tablename__ = 'honeytoken_uses'
    __table_args__ = (UniqueConstraint('event_id', 'binding_id'),)
    event_id: Mapped[str] = mapped_column(ForeignKey('events.id', ondelete='CASCADE'))
    binding_id: Mapped[str] = mapped_column(ForeignKey('honeytoken_bindings.id', ondelete='CASCADE'))
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class DetectionPolicy(Base):
    __tablename__ = 'detection_policy'
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    revision: Mapped[int] = mapped_column(default=1)
    failed_logins: Mapped[int] = mapped_column(default=5)
    window_seconds: Mapped[int] = mapped_column(default=60)
    enabled: Mapped[bool] = mapped_column(default=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AgentCertificate(Record, Base):
    __tablename__ = 'agent_certificates'
    __table_args__ = (UniqueConstraint('host_id', 'public_key_hash'),)
    host_id: Mapped[str] = mapped_column(ForeignKey('hosts.id'), index=True)
    public_key_hash: Mapped[str] = mapped_column(String(64))
    fingerprint: Mapped[str] = mapped_column(String(64), unique=True)
    certificate_pem: Mapped[str] = mapped_column(Text)
    serial: Mapped[str] = mapped_column(String(100))
    state: Mapped[str] = mapped_column(String(20), default='pending')
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    accept_until: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
