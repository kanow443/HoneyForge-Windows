from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import Field, field_validator, model_validator

from honeyforge.domain.profiles import ProfileConfig, StrictModel


class Login(StrictModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=200)


class CreateProfile(StrictModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=500)
    config: ProfileConfig

    @field_validator("config", mode="before")
    @classmethod
    def legacy_defaults(cls, value):
        return {"schema_version": 1, **value} if isinstance(value, dict) else value


class PublishVersion(StrictModel):
    config: ProfileConfig

    @field_validator("config", mode="before")
    @classmethod
    def legacy_defaults(cls, value):
        return {"schema_version": 1, **value} if isinstance(value, dict) else value


class UpdateProfile(StrictModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=500)


class Deploy(StrictModel):
    name: str = Field(min_length=1, max_length=100)
    host_id: UUID
    profile_version_id: UUID
    port: int = Field(ge=1024, le=65535)


class Redeploy(StrictModel):
    profile_version_id: UUID | None = None


class DeployGroup(StrictModel):
    name: str = Field(min_length=1, max_length=100)
    host_id: UUID
    profile_version_id: UUID
    ports: dict[str, int] = Field(default_factory=dict, max_length=8)

    @field_validator("ports")
    @classmethod
    def valid_ports(cls, ports):
        if any(not 1024 <= port <= 65535 for port in ports.values()):
            raise ValueError("Ports must be between 1024 and 65535")
        return ports


class Enroll(StrictModel):
    token: str = Field(min_length=20, max_length=200)
    name: str = Field(min_length=1, max_length=100)
    address: str = Field(min_length=1, max_length=120)
    capabilities: list[Literal["http", "cowrie", "tcp-banner"]] = Field(min_length=1, max_length=3)
    runtime_version: str = Field(default="", max_length=100)


class RuntimeObservation(StrictModel):
    deployment_id: UUID
    revision: int = Field(ge=1)
    state: Literal["running", "stopped", "error"]
    image_digest: str = Field(default="", max_length=200)
    error: str | None = Field(default=None, max_length=500)


class Heartbeat(StrictModel):
    padding: str = Field(default="", max_length=2048, pattern=r"^[0-9a-f]*$")
    capabilities: list[Literal["http", "cowrie", "tcp-banner"]] = Field(default_factory=list, max_length=3)
    runtime_version: str = Field(default="", max_length=100)
    cpu_percent: float = Field(default=0, ge=0, le=100)
    memory_percent: float = Field(default=0, ge=0, le=100)
    queued_events: int = Field(default=0, ge=0)
    dropped_events: int = Field(default=0, ge=0)
    parser_errors: int = Field(default=0, ge=0)
    network_dropped_packets: int = Field(default=0, ge=0)
    artifact_errors: int = Field(default=0, ge=0)
    artifact_dropped_packets: int = Field(default=0, ge=0)
    queued_artifacts: int = Field(default=0, ge=0)
    network_capture_state: Literal["active", "unavailable", "idle"] = "idle"
    network_policy: Literal["internal-bridge", "external-firewall", "unverified"] = "unverified"
    runtimes: list[RuntimeObservation] = Field(default_factory=list, max_length=100)


class Progress(StrictModel):
    attempt: int = Field(ge=1)
    stage: str = Field(min_length=1, max_length=100)


class JobResult(StrictModel):
    attempt: int = Field(ge=1)
    succeeded: bool
    image_digest: str = Field(default="", max_length=200)
    error: str | None = Field(default=None, max_length=500)


EVENT_TYPES = Literal["tcp.connect", "tcp.request", "tcp.disconnect", "http.request", "http.login", "ssh.connect", "ssh.login.failed", "ssh.login.success",
    "ssh.command", "ssh.output", "ssh.disconnect", "ssh.forward", "ssh.client.version", "ssh.client.kex",
    "ssh.file.download", "ssh.file.download.failed", "ssh.file.upload",
    "network.blocked", "network.connection", "network.traffic", "sensor.error"]


class TelemetryEvent(StrictModel):
    event_id: str = Field(min_length=1, max_length=100)
    deployment_id: UUID
    generation: UUID
    event_type: EVENT_TYPES
    source_ip: str = Field(max_length=80)
    source_session_id: str | None = Field(default=None, max_length=100)
    source_seq: int = Field(default=0, ge=0)
    observed_at: datetime
    payload: dict[str, Any] = Field(default_factory=dict)
    provenance: Literal["tcp-sensor", "http-sensor", "cowrie", "firewall", "network-sensor", "lab-fixture"] = "http-sensor"
    private_capture: dict[str, Any] | None = None

    @field_validator("observed_at")
    @classmethod
    def timezone_required(cls, value: datetime):
        if value.tzinfo is None:
            raise ValueError("A timezone is required")
        return value


class EventBatch(StrictModel):
    events: list[TelemetryEvent] = Field(min_length=1, max_length=100)


class QueryFilters(StrictModel):
    host_id: UUID | None = None
    deployment_id: UUID | None = None
    event_type: str | None = Field(default=None, max_length=40)
    flag: Literal["suspicious", "reviewed", "false_positive", "escalated"] | None = None
    source_ip: str | None = Field(default=None, max_length=80)
    q: str | None = Field(default=None, max_length=200)
    since: datetime | None = None
    until: datetime | None = None
    limit: int = Field(default=100, ge=1, le=500)
    offset: int = Field(default=0, ge=0, le=100000)


class ExportRequest(StrictModel):
    session_id: UUID | None = None
    filters: QueryFilters = Field(default_factory=QueryFilters)


class UserView(StrictModel):
    id: str
    username: str
    role: Literal["admin", "operator", "analyst", "viewer", "participant"] = "admin"


class CreateUser(StrictModel):
    username: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_.@-]+$")
    password: str = Field(min_length=12, max_length=200)
    role: Literal["admin", "operator", "analyst", "viewer", "participant"] = "viewer"


class ChangeUserRole(StrictModel):
    role: Literal["admin", "operator", "analyst", "viewer", "participant"]


class SetEventFlag(StrictModel):
    flag: Literal["suspicious", "reviewed", "false_positive", "escalated"]
    enabled: bool = True
    note: str = Field(default="", max_length=500)


class EventFlagView(StrictModel):
    id: str
    created_at: datetime
    event_id: str
    flag: Literal["suspicious", "reviewed", "false_positive", "escalated"]
    note: str
    created_by: str


class CreateFlagChallenge(StrictModel):
    binding_id: UUID
    title: str = Field(min_length=1, max_length=100)
    points: int = Field(ge=1, le=10000)


class ChallengeState(StrictModel):
    enabled: bool


class FlagChallengeView(StrictModel):
    id: str
    created_at: datetime
    title: str
    points: int
    enabled: bool
    active: bool
    solved: bool
    binding_id: str | None = None


class SubmitFlag(StrictModel):
    challenge_id: UUID
    flag: str = Field(min_length=1, max_length=100)


class FlagSolveView(StrictModel):
    ok: bool
    points: int
    challenge_id: str


class ScoreRow(StrictModel):
    username: str
    points: int
    solves: int


class CreateIntegrationToken(StrictModel):
    name: str = Field(min_length=1, max_length=100)
    deployment_id: UUID | None = None
    expires_days: int = Field(default=30, ge=1, le=365)
    allow_response: bool = False

    @model_validator(mode="after")
    def response_scope(self):
        if self.allow_response and self.deployment_id is None:
            raise ValueError("Automated response requires one explicitly selected deployment")
        return self


class IntegrationTokenView(StrictModel):
    id: str
    created_at: datetime
    name: str
    deployment_id: str | None
    expires_at: datetime
    revoked_at: datetime | None
    last_used_at: datetime | None
    created_by: str
    allow_response: bool


class IntegrationSourceBlock(StrictModel):
    event_id: UUID
    ttl_seconds: int = Field(default=60, ge=60, le=300)
    reason: str = Field(min_length=1, max_length=400)


class IntegrationTokenSecret(StrictModel):
    token: str
    integration: IntegrationTokenView


class IntegrationEventPage(StrictModel):
    format: Literal["honeyforge-ecs-events-v1"]
    items: list[dict[str, Any]]
    next_cursor: int
    watermark: int
    has_more: bool
    reset_required: bool


class LoginView(StrictModel):
    user: UserView
    csrf_token: str


class OkayView(StrictModel):
    ok: bool


class EnrollmentView(StrictModel):
    token: str
    expires_at: datetime


class VersionView(StrictModel):
    id: str
    created_at: datetime
    profile_id: str
    number: int
    config: ProfileConfig
    config_hash: str


class ProfileView(StrictModel):
    id: str
    created_at: datetime
    name: str
    description: str
    archived_at: datetime | None = None
    adapter: str
    latest_version: int
    interaction_level: str
    versions: list[VersionView]


class HostView(StrictModel):
    id: str
    created_at: datetime
    name: str
    address: str
    last_seen: datetime | None
    revoked_at: datetime | None
    capabilities: list[str]
    metrics: dict
    runtime_version: str
    status: str


class DeploymentView(StrictModel):
    id: str
    created_at: datetime
    name: str
    host_id: str
    host_name: str
    endpoint: str
    profile_version_id: str
    group_id: str | None = None
    service_key: str | None = None
    profile_name: str
    version_number: int
    adapter: str
    interaction_level: str
    port: int
    desired_state: str
    desired_revision: int
    observed_state: str
    observed_at: datetime | None
    state: str
    runtime_generation: str
    image_digest: str
    error: str | None
    event_count: int
    jobs: list[dict]


class DeploymentGroupView(StrictModel):
    id: str
    created_at: datetime
    name: str
    host_id: str
    profile_version_id: str
    state: str
    services: list[DeploymentView]


class EventView(StrictModel):
    id: str
    created_at: datetime
    event_id: str
    host_id: str
    deployment_id: str
    deployment_name: str
    profile_version_id: str
    session_id: str | None
    generation: str
    event_type: str
    source_ip: str
    source_seq: int
    observed_at: datetime
    payload: dict
    provenance: str
    ingest_position: int
    private_capture_available: bool = False
    flags: list[EventFlagView] = Field(default_factory=list)


class PrivateCaptureView(StrictModel):
    event_id: str
    capture_id: str
    content: dict[str, Any]


class EventPage(StrictModel):
    items: list[EventView]
    total: int
    watermark: int


class FindingView(StrictModel):
    observed_first_at: datetime | None = None
    observed_last_at: datetime | None = None
    notification_state: Literal["none", "current", "historical"] = "none"
    id: str
    created_at: datetime
    deployment_id: str
    session_id: str | None
    rule_id: str
    rule_version: int
    title: str
    severity: str
    explanation: str
    observation: str
    evidence_ids: list[str]
    dedupe_key: str


class NamedFindingView(FindingView):
    deployment_name: str


class SessionView(StrictModel):
    id: str
    created_at: datetime
    deployment_id: str
    generation: str
    profile_version_id: str
    source_id: str
    source_ip: str
    protocol: str
    started_at: datetime
    ended_at: datetime | None
    deployment_name: str
    event_count: int


class SessionDetail(SessionView):
    profile_version: VersionView
    events: list[EventView]
    findings: list[FindingView]
    truncated: bool


class AuditView(StrictModel):
    id: str
    created_at: datetime
    actor: str
    action: str
    object_id: str
    details: dict[str, Any]


class HistogramBucket(StrictModel):
    at: datetime
    count: int


class OverviewView(StrictModel):
    running_traps: int
    total_traps: int
    online_hosts: int
    total_hosts: int
    events_24h: int
    unique_sources: int
    findings_24h: int
    queued_events: int
    dropped_events: int
    histogram: list[HistogramBucket]
    hosts: list[HostView]
    deployments: list[DeploymentView]
    server_time: datetime


class ExportView(StrictModel):
    format: str
    exported_at: datetime
    retention_days: int
    filters: ExportRequest
    total: int
    truncated: bool
    events: list[EventView]
    sha256: str


class PlaybackPage(StrictModel):
    items: list[EventView]
    total: int
    next_cursor: int
    watermark: int
    has_more: bool


class TopologySource(StrictModel):
    source_ip: str
    event_count: int
    last_seen: datetime


class TopologyLink(TopologySource):
    deployment_id: str
    severity: Literal["none", "low", "medium", "high"]
    session_id: str | None


class TopologyView(StrictModel):
    hosts: list[HostView]
    deployments: list[DeploymentView]
    sources: list[TopologySource]
    links: list[TopologyLink]
    sessions: list[SessionView]
    watermark: int
    since: datetime
    until: datetime
    truncated: bool


class CreateSourceBlock(StrictModel):
    deployment_id: UUID
    source_ip: str = Field(min_length=1, max_length=45)
    ttl_seconds: int = Field(default=60, ge=60, le=3600)
    reason: str = Field(min_length=1, max_length=500)
    terminate_sessions: bool = True

    @field_validator("source_ip")
    @classmethod
    def ipv4_source(cls, value):
        from ipaddress import IPv4Address
        address = IPv4Address(value)
        if address.is_loopback or address.is_multicast or address.is_unspecified or address.is_link_local or str(address) == "255.255.255.255":
            raise ValueError("A unicast IPv4 source is required")
        return str(address)

    @field_validator("reason")
    @classmethod
    def nonempty_reason(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("A reason is required")
        return value


class RevisionRequest(StrictModel):
    revision: int = Field(ge=1)


class SourceBlockView(StrictModel):
    id: str
    created_at: datetime
    deployment_id: str
    host_id: str
    generation: str
    source_ip: str
    reason: str
    expires_at: datetime
    desired_state: Literal["blocked", "released"]
    revision: int
    observed_revision: int
    observed_state: Literal["pending", "applied", "released", "error"]
    observed_at: datetime | None
    error: str | None
    created_by: str
    state: Literal["pending", "applied", "cancelled", "expired", "error", "unknown", "superseded"]
    deployment_name: str
    terminate_sessions: bool
    termination_state: Literal["pending", "completed", "unsupported", "error", "not_requested"]
    terminated_sessions: list[str]
    termination_error: str | None


class AgentPolicy(StrictModel):
    id: UUID
    deployment_id: UUID
    generation: UUID
    source_ip: str
    expires_at: datetime
    revision: int = Field(ge=1)
    desired_state: Literal["blocked", "released"]
    terminate_sessions: bool = False


class PolicyAck(StrictModel):
    revision: int = Field(ge=1)
    state: Literal["applied", "released", "error"]
    error: str | None = Field(default=None, max_length=500)
    termination_state: Literal["pending", "completed", "unsupported", "error", "not_requested"] = "pending"
    terminated_sessions: list[str] = Field(default_factory=list, max_length=1000)
    termination_error: str | None = Field(default=None, max_length=500)

    @field_validator("terminated_sessions")
    @classmethod
    def transport_ids(cls, value):
        import re
        if any(not re.fullmatch(r"[0-9a-f]{12}", item) for item in value):
            raise ValueError("Expected Cowrie transport identifiers")
        return list(dict.fromkeys(value))


class ArtifactManifest(StrictModel):
    id: UUID
    deployment_id: UUID
    generation: UUID
    source_session_id: str | None = Field(default=None, max_length=100)
    kind: Literal["pcap", "file", "terminal"]
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    size_bytes: int = Field(ge=1, le=16 * 1024 * 1024)
    started_at: datetime
    ended_at: datetime
    details: dict[str, Any] = Field(default_factory=dict)

    @field_validator("started_at", "ended_at")
    @classmethod
    def timezone_required(cls, value):
        if value.tzinfo is None:
            raise ValueError("A timezone is required")
        return value


class ArtifactChunk(StrictModel):
    offset: int = Field(ge=0)
    data_base64: str = Field(min_length=4, max_length=349528)


class ArtifactView(ArtifactManifest):
    id: str
    deployment_id: str
    generation: str
    host_id: str
    created_at: datetime
    received_bytes: int
    state: Literal["receiving", "available", "purging", "expired"]
    expires_at: datetime


class CreateCase(StrictModel):
    title: str = Field(min_length=1, max_length=120)
    session_ids: list[UUID] = Field(min_length=1, max_length=20)
    note: str = Field(default="", max_length=4000)

    @field_validator("title")
    @classmethod
    def nonempty_title(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("A title is required")
        return value


class UpdateCase(RevisionRequest):
    status: Literal["new", "investigating", "closed"]
    note: str = Field(default="", max_length=4000)


class PinCase(RevisionRequest):
    pinned: bool


class StorageView(StrictModel):
    event_retention_days: int
    audit_retention_days: int
    reserved_bytes: int
    quota_bytes: int
    collection_available: bool
    pinned_cases: int


class CaseView(StrictModel):
    id: str
    created_at: datetime
    title: str
    session_ids: list[str]
    note: str
    status: Literal["new", "investigating", "closed"]
    revision: int
    created_by: str
    updated_at: datetime
    retention_pinned: bool = False


class ReportCollection(StrictModel):
    host_status: str
    metrics: dict
    watermark: int


class SessionReport(StrictModel):
    format: Literal["honeyforge-session-report-v1"]
    generated_at: datetime
    session: SessionView
    profile_version: VersionView
    deployment: DeploymentView
    events: list[EventView]
    findings: list[FindingView]
    source_blocks: list[SourceBlockView]
    audit: list[AuditView]
    total: int
    truncated: bool
    collection: ReportCollection
    limitations: list[str]
    sha256: str


class CreateHoneyToken(StrictModel):
    profile_version_id: UUID
    service_key: str | None = Field(default=None, pattern=r"^[a-z][a-z0-9-]{0,23}$")
    name: str = Field(min_length=1, max_length=100)
    kind: Literal['url', 'file']
    file_path: str | None = Field(default=None, max_length=240)

    @model_validator(mode='after')
    def valid_placement(self):
        from honeyforge.domain.profiles import DecoyFile
        if self.kind == 'file':
            if not self.file_path:
                raise ValueError('A file token requires a path')
            self.file_path = DecoyFile(path=self.file_path, content='').path
        elif self.file_path is not None:
            raise ValueError('URL token path is generated per runtime')
        return self


class HoneyTokenBindingView(StrictModel):
    id: str
    created_at: datetime
    token_id: str
    deployment_id: str
    generation: str
    public_value: str
    resource_path: str
    current_runtime: bool
    use_count: int
    last_used_at: datetime | None


class HoneyTokenView(StrictModel):
    service_key: str | None = None
    id: str
    created_at: datetime
    profile_id: str
    profile_version_id: str
    name: str
    kind: Literal['url', 'file']
    file_path: str | None
    created_by: str
    revoked_at: datetime | None
    bindings: list[HoneyTokenBindingView]
    application: str


class DetectionPolicyView(StrictModel):
    id: int
    revision: int
    failed_logins: int
    window_seconds: int
    enabled: bool
    updated_at: datetime | None


class UpdateDetectionPolicy(RevisionRequest):
    failed_logins: int = Field(ge=2, le=100)
    window_seconds: int = Field(ge=10, le=3600)
    enabled: bool


class IoCExportRequest(ExportRequest):
    format: Literal['csv', 'stix'] = 'stix'


class IoCExportView(StrictModel):
    format: Literal['csv', 'stix']
    content: str
    media_type: str
    filename: str
    event_count: int
    total: int
    truncated: bool
    interpretation: str


class GeoDatabaseView(StrictModel):
    age_days: int | None = None
    stale: bool | None = None
    provider: str | None = None
    attribution_url: str | None = None
    status: Literal['available', 'unavailable']
    reason: str | None
    built_at: str | None
    database_type: str | None
    size_bytes: int | None = None


class GeoSourceView(StrictModel):
    source_ip: str
    status: Literal['available', 'unavailable']
    reason: str | None
    event_count: int
    country: str | None = None
    city: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    accuracy_radius_km: int | None = None
    asn: int | None = None
    organization: str | None = None


class GeoTopView(StrictModel):
    city_database: GeoDatabaseView
    asn_database: GeoDatabaseView
    since: datetime
    time_basis: Literal['observed_at']
    sources: list[GeoSourceView]
    interpretation: str


class IssueCertificate(StrictModel):
    csr: str = Field(min_length=200, max_length=8192)


class AgentCertificateView(StrictModel):
    id: str
    created_at: datetime
    host_id: str
    public_key_hash: str
    fingerprint: str
    certificate_pem: str
    serial: str
    state: Literal['pending', 'active', 'overlap', 'revoked']
    expires_at: datetime
    accept_until: datetime
    confirmed_at: datetime | None
    revoked_at: datetime | None


class IssuedCertificateView(AgentCertificateView):
    authority_pem: str
    overlap_seconds: int
    confirmation_required: bool
