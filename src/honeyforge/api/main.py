import asyncio
import logging
import secrets
from contextlib import asynccontextmanager
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, Header, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.sse import EventSourceResponse, ServerSentEvent
from sqlalchemy import text
from starlette.middleware.cors import CORSMiddleware

from honeyforge.application.control import ControlService
from honeyforge.application.detection import DetectionService
from honeyforge.application.evidence import EvidenceService
from honeyforge.application.flags import FlagService
from honeyforge.application.geo import GeoService
from honeyforge.application.honeytokens import HoneyTokenService
from honeyforge.application.integrations import IntegrationService
from honeyforge.application.intelligence import IntelligenceService
from honeyforge.application.investigation import InvestigationService
from honeyforge.application.private_captures import PrivateCaptureService
from honeyforge.application.retention import RetentionService
from honeyforge.application.schemas import (
    AgentCertificateView,
    AgentPolicy,
    ArtifactChunk,
    ArtifactManifest,
    ArtifactView,
    AuditView,
    CaseView,
    ChallengeState,
    ChangeUserRole,
    CreateCase,
    CreateFlagChallenge,
    CreateHoneyToken,
    CreateIntegrationToken,
    CreateProfile,
    CreateSourceBlock,
    CreateUser,
    Deploy,
    DeployGroup,
    DeploymentGroupView,
    DeploymentView,
    DetectionPolicyView,
    Enroll,
    EnrollmentView,
    EventBatch,
    EventPage,
    EventView,
    ExportRequest,
    ExportView,
    FlagChallengeView,
    FlagSolveView,
    GeoTopView,
    Heartbeat,
    HoneyTokenView,
    HostView,
    IntegrationEventPage,
    IntegrationSourceBlock,
    IntegrationTokenSecret,
    IntegrationTokenView,
    IoCExportRequest,
    IoCExportView,
    IssueCertificate,
    IssuedCertificateView,
    JobResult,
    Login,
    LoginView,
    NamedFindingView,
    OkayView,
    OverviewView,
    PinCase,
    PlaybackPage,
    PolicyAck,
    PrivateCaptureView,
    ProfileView,
    Progress,
    PublishVersion,
    QueryFilters,
    Redeploy,
    RevisionRequest,
    ScoreRow,
    SessionDetail,
    SessionReport,
    SessionView,
    SetEventFlag,
    SourceBlockView,
    StorageView,
    SubmitFlag,
    TopologyView,
    UpdateCase,
    UpdateDetectionPolicy,
    UpdateProfile,
    UserView,
    VersionView,
)
from honeyforge.application.telemetry import TelemetryService
from honeyforge.domain.authorization import authorize
from honeyforge.domain.errors import DomainError
from honeyforge.infrastructure.capture_keys import CaptureKeys
from honeyforge.infrastructure.certificates import CertificateService
from honeyforge.infrastructure.database import Database
from honeyforge.infrastructure.queries import Queries
from honeyforge.infrastructure.security import digest
from honeyforge.infrastructure.settings import Settings, settings

logger = logging.getLogger("honeyforge")


class BodyLimitMiddleware:
    def __init__(self, app, maximum=524288):
        self.app, self.maximum = app, maximum

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        messages, size = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            messages.append(message)
            size += len(message.get("body", b""))
            if size > self.maximum:
                return await JSONResponse({"error": {"code": "body_too_large", "message": "Maximum body size is 512 KiB"}}, status_code=413)(scope, receive, send)
            if not message.get("more_body", False):
                break

        async def buffered():
            if messages:
                return messages.pop(0)
            return await receive()

        return await self.app(scope, buffered, send)


def create_app(config: Settings = settings, database: Database | None = None):
    db = database or Database(config.database_url)
    control = ControlService(db.unit_of_work, config)
    capture_keys = CaptureKeys(config.capture_key_dir)
    telemetry = TelemetryService(db.unit_of_work, capture_keys)
    captures = PrivateCaptureService(db.unit_of_work, capture_keys)
    investigation = InvestigationService(db.unit_of_work, config)
    queries = Queries(db, config)
    evidence = EvidenceService(db, config)
    flags = FlagService(db)
    retention = RetentionService(db, config, evidence)
    integrations = IntegrationService(db, investigation, config)
    honey = HoneyTokenService(db)
    detection = DetectionService(db)
    intelligence = IntelligenceService(db, queries)
    geo = GeoService(db, config)
    certificates = CertificateService(db, config)

    @asynccontextmanager
    async def lifespan(app):
        with db.engine.connect() as connection:
            connection.execute(text("SELECT position FROM stream_state WHERE id=1"))
        async def expire():
            while True:
                await asyncio.sleep(60)
                try:
                    await asyncio.to_thread(retention.sweep)
                except Exception:
                    logger.exception("Evidence expiry failed; the next bounded batch will retry")
        cleanup_task = asyncio.create_task(expire())
        try:
            yield
        finally:
            cleanup_task.cancel()
            try:
                await cleanup_task
            except asyncio.CancelledError:
                pass
            db.engine.dispose()

    app = FastAPI(title="HoneyForge Control API", version="0.1.0", lifespan=lifespan,
        description="Versioned honeypot profiles, durable remote deployment and deterministic investigation. No AI services.")
    app.state.db, app.state.control, app.state.queries = db, control, queries
    app.state.evidence = evidence
    app.state.certificates = certificates
    app.state.settings = config
    app.add_middleware(BodyLimitMiddleware)
    app.add_middleware(CORSMiddleware, allow_origins=[config.public_origin], allow_credentials=True,
        allow_methods=["GET", "POST"], allow_headers=["Content-Type", "X-CSRF-Token", "Idempotency-Key", "Last-Event-ID"])

    @app.middleware("http")
    async def response_headers(request, call_next):
        request_id = str(uuid4())
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Cache-Control"] = "no-store"
        response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
        return response

    @app.exception_handler(DomainError)
    async def domain_error(request, error):
        return JSONResponse({"error": {"code": error.code, "message": error.message}}, status_code=error.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        fields = [{"path": ".".join(map(str, item["loc"])), "message": item["msg"]} for item in error.errors()]
        return JSONResponse({"error": {"code": "validation_failed", "message": "Invalid request", "fields": fields}}, status_code=422)

    def operator(request: Request):
        principal = control.authenticate(request.cookies.get("hf_session"))
        authorize(principal["role"], request.scope["route"].name)
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            origin = request.headers.get("origin")
            if origin and origin != config.public_origin:
                raise DomainError("csrf_origin", "Origin is not allowed", 403)
            csrf = request.headers.get("x-csrf-token", "")
            if not secrets.compare_digest(digest(csrf), principal["csrf_hash"]):
                raise DomainError("csrf_failed", "CSRF token is missing or invalid", 403)
        return principal

    def management_gateway(request):
        if not config.sync_proxy_secret or not secrets.compare_digest(request.headers.get("x-asset-gateway", ""), config.sync_proxy_secret) or request.headers.get("x-asset-scheme") != "https":
            raise DomainError("invalid_management_gateway", "Verified management gateway is required", 403)

    def client_fingerprint(request):
        value = request.headers.get("x-asset-client-fingerprint", "").replace(":", "").lower()
        return value if len(value) == 64 and all(c in "0123456789abcdef" for c in value) else None

    def agent(request: Request, authorization: Annotated[str | None, Header()] = None):
        if not authorization or not authorization.startswith("Bearer "):
            raise DomainError("invalid_agent_key", "A Bearer agent key is required", 401)
        host_id = control.agent_auth(authorization[7:])
        if config.require_agent_mtls:
            management_gateway(request)
            if request.scope["route"].name != "issue_agent_certificate":
                certificates.authorize(host_id, client_fingerprint(request))
        return host_id

    Operator = Annotated[dict, Depends(operator)]
    Agent = Annotated[str, Depends(agent)]

    @app.get("/health/live", tags=["health"])
    def live():
        return {"status": "ok", "version": "0.1.0"}

    @app.get("/health/ready", tags=["health"])
    def ready():
        try:
            with db.engine.connect() as connection:
                connection.execute(text("SELECT position FROM stream_state WHERE id=1"))
        except Exception:
            return JSONResponse({"status": "unavailable"}, status_code=503)
        return {"status": "ready"}

    @app.post("/api/v1/auth/login", response_model=LoginView, tags=["operator"])
    def login(body: Login, request: Request, response: Response):
        origin = request.headers.get("origin")
        if origin and origin != config.public_origin:
            raise DomainError("csrf_origin", "Origin is not allowed", 403)
        user, token, csrf = control.login(body.username, body.password, request.client.host)
        response.set_cookie("hf_session", token, httponly=True, secure=config.cookie_secure, samesite="strict",
            max_age=config.session_hours * 3600)
        response.set_cookie("hf_csrf", csrf, httponly=False, secure=config.cookie_secure, samesite="strict",
            max_age=config.session_hours * 3600)
        return {"user": user, "csrf_token": csrf}

    @app.get("/api/v1/auth/me", response_model=UserView, tags=["operator"])
    def me(principal: Operator):
        return {"id": principal["id"], "username": principal["username"], "role": principal["role"]}

    @app.get("/api/v1/users", response_model=list[UserView], tags=["administration"])
    def users(principal: Operator):
        return control.users()

    @app.post("/api/v1/users", response_model=UserView, status_code=201, tags=["administration"])
    def create_user(body: CreateUser, principal: Operator):
        return control.create_user(principal["username"], body)

    @app.post("/api/v1/users/{user_id}/role", response_model=UserView, tags=["administration"])
    def change_user_role(user_id: UUID, body: ChangeUserRole, principal: Operator):
        return control.change_user_role(principal["username"], str(user_id), body)

    @app.get("/api/v1/integration-tokens", response_model=list[IntegrationTokenView], tags=["integrations"])
    def integration_tokens(principal: Operator):
        return integrations.list()

    @app.post("/api/v1/integration-tokens", response_model=IntegrationTokenSecret, status_code=201, tags=["integrations"])
    def create_integration_token(body: CreateIntegrationToken, principal: Operator):
        return integrations.create(principal["username"], body)

    @app.post("/api/v1/integration-tokens/{integration_id}/revoke", response_model=IntegrationTokenView, tags=["integrations"])
    def revoke_integration_token(integration_id: UUID, principal: Operator):
        return integrations.revoke(principal["username"], str(integration_id))

    @app.get("/integration/v1/events", response_model=IntegrationEventPage, tags=["integrations"])
    def integration_events(authorization: Annotated[str | None, Header()] = None,
            after: int = Query(default=0, ge=0), limit: int = Query(default=100, ge=1, le=500)):
        if not authorization or not authorization.startswith("Bearer "):
            raise DomainError("invalid_integration_key", "A read-only integration credential is required", 401)
        return integrations.events(authorization[7:], after, limit)

    @app.post("/integration/v1/source-blocks", response_model=SourceBlockView, status_code=202, tags=["integrations"])
    def integration_block(body: IntegrationSourceBlock, authorization: Annotated[str | None, Header()] = None,
            idempotency_key: Annotated[str, Header(min_length=8, max_length=100)] = ""):
        if not authorization or not authorization.startswith("Bearer "):
            raise DomainError("invalid_integration_key", "An integration credential is required", 401)
        if not idempotency_key:
            raise DomainError("idempotency_required", "Idempotency-Key is required")
        return integrations.respond(authorization[7:], body, idempotency_key)

    @app.get("/integration/v1/source-blocks/{policy_id}", response_model=SourceBlockView, tags=["integrations"])
    def integration_policy(policy_id: UUID, authorization: Annotated[str | None, Header()] = None):
        if not authorization or not authorization.startswith("Bearer "):
            raise DomainError("invalid_integration_key", "An integration credential is required", 401)
        return integrations.policy(authorization[7:], str(policy_id))

    @app.post("/api/v1/auth/logout", response_model=OkayView, tags=["operator"])
    def logout(principal: Operator, response: Response):
        control.logout(principal)
        response.delete_cookie("hf_session")
        response.delete_cookie("hf_csrf")
        return {"ok": True}

    @app.get("/api/v1/hosts", response_model=list[HostView], tags=["hosts"])
    def hosts(principal: Operator):
        return queries.hosts()

    @app.post("/api/v1/hosts/enrollment-tokens", response_model=EnrollmentView, tags=["hosts"])
    def enrollment(principal: Operator):
        return control.enrollment_token(principal["username"])

    @app.post("/api/v1/hosts/{host_id}/revoke", response_model=HostView, tags=["hosts"])
    def revoke(host_id: UUID, principal: Operator):
        return control.revoke(principal["username"], str(host_id))

    @app.get("/api/v1/profiles", response_model=list[ProfileView], tags=["profiles"])
    def profiles(principal: Operator):
        return queries.profiles()

    @app.get("/api/v1/profiles/{profile_id}", response_model=ProfileView, tags=["profiles"])
    def profile(profile_id: UUID, principal: Operator):
        return queries.profile(str(profile_id))

    @app.post("/api/v1/profiles/{profile_id}/metadata", response_model=ProfileView, tags=["profiles"])
    def update_profile(profile_id: UUID, body: UpdateProfile, principal: Operator):
        return control.update_profile(principal["username"], str(profile_id), body)

    @app.post("/api/v1/profiles/{profile_id}/archive", response_model=ProfileView, tags=["profiles"])
    def archive_profile(profile_id: UUID, principal: Operator):
        return control.archive_profile(principal["username"], str(profile_id), True)

    @app.post("/api/v1/profiles/{profile_id}/restore", response_model=ProfileView, tags=["profiles"])
    def restore_profile(profile_id: UUID, principal: Operator):
        return control.archive_profile(principal["username"], str(profile_id), False)

    @app.post("/api/v1/profiles/{profile_id}/delete", response_model=OkayView, tags=["profiles"])
    def delete_profile(profile_id: UUID, principal: Operator):
        return control.delete_profile(principal["username"], str(profile_id))

    @app.post("/api/v1/profiles", response_model=ProfileView, status_code=201, tags=["profiles"])
    def create_profile(body: CreateProfile, principal: Operator):
        return control.create_profile(principal["username"], body)

    @app.post("/api/v1/profiles/{profile_id}/versions", response_model=VersionView, status_code=201, tags=["profiles"])
    def version(profile_id: UUID, body: PublishVersion, principal: Operator):
        return control.publish(principal["username"], str(profile_id), body.config)

    @app.get("/api/v1/honeytokens", response_model=list[HoneyTokenView], tags=["honeytokens"])
    def honeytokens(principal: Operator, profile_id: UUID | None = None):
        return honey.list(str(profile_id) if profile_id else None)

    @app.post("/api/v1/honeytokens", response_model=HoneyTokenView, status_code=201, tags=["honeytokens"])
    def create_honeytoken(body: CreateHoneyToken, principal: Operator):
        return honey.create(principal["username"], body)

    @app.post("/api/v1/honeytokens/{token_id}/revoke", response_model=HoneyTokenView, tags=["honeytokens"])
    def revoke_honeytoken(token_id: UUID, principal: Operator):
        return honey.revoke(principal["username"], str(token_id))

    @app.get("/api/v1/detection-policy", response_model=DetectionPolicyView, tags=["analysis"])
    def detection_policy(principal: Operator):
        return detection.policy()

    @app.post("/api/v1/detection-policy", response_model=DetectionPolicyView, tags=["analysis"])
    def update_detection_policy(body: UpdateDetectionPolicy, principal: Operator):
        return detection.update(principal["username"], body)

    @app.post("/api/v1/ioc-exports", response_model=IoCExportView, tags=["analysis"])
    def export_ioc(body: IoCExportRequest, principal: Operator):
        return intelligence.export(principal["username"], body)

    @app.get("/api/v1/geo-sources", response_model=GeoTopView, tags=["analysis"])
    def geo_top(principal: Operator):
        return geo.top()

    @app.get("/api/v1/hosts/{host_id}/certificates", response_model=list[AgentCertificateView], tags=["hosts"])
    def agent_certificates(host_id: UUID, principal: Operator):
        return certificates.list(str(host_id))

    @app.post("/api/v1/agent-certificates/{certificate_id}/revoke", response_model=AgentCertificateView, tags=["hosts"])
    def revoke_agent_certificate(certificate_id: UUID, principal: Operator):
        return certificates.revoke(principal["username"], str(certificate_id))

    @app.post("/agent/v1/certificates/issue", response_model=IssuedCertificateView, tags=["agent"])
    def issue_agent_certificate(body: IssueCertificate, request: Request, host_id: Agent):
        management_gateway(request)
        return certificates.issue(host_id, body.csr, client_fingerprint(request))

    @app.post("/agent/v1/certificates/confirm", response_model=AgentCertificateView, tags=["agent"])
    def confirm_agent_certificate(request: Request, host_id: Agent):
        management_gateway(request)
        return certificates.confirm(host_id, client_fingerprint(request))

    @app.get("/api/v1/deployments", response_model=list[DeploymentView], tags=["deployments"])
    def deployments(principal: Operator):
        return queries.deployments()

    @app.get("/api/v1/deployments/{deployment_id}", response_model=DeploymentView, tags=["deployments"])
    def deployment(deployment_id: UUID, principal: Operator):
        return queries.deployment(str(deployment_id))

    @app.post("/api/v1/deployments", response_model=DeploymentView, status_code=202, tags=["deployments"])
    def deploy(body: Deploy, principal: Operator,
        idempotency_key: Annotated[str, Header(min_length=8, max_length=100)]):
        return control.deploy(principal["username"], body, idempotency_key)

    @app.post("/api/v1/deployments/{deployment_id}/stop", response_model=DeploymentView, status_code=202, tags=["deployments"])
    def stop(deployment_id: UUID, principal: Operator):
        return control.change_runtime(principal["username"], str(deployment_id), "stop")

    @app.post("/api/v1/deployments/{deployment_id}/redeploy", response_model=DeploymentView, status_code=202, tags=["deployments"])
    def redeploy(deployment_id: UUID, body: Redeploy, principal: Operator):
        return control.change_runtime(principal["username"], str(deployment_id), "deploy",
            str(body.profile_version_id) if body.profile_version_id else None)

    @app.get("/api/v1/deployment-groups", response_model=list[DeploymentGroupView], tags=["deployments"])
    def deployment_groups(principal: Operator):
        return control.groups()

    @app.get("/api/v1/deployment-groups/{group_id}", response_model=DeploymentGroupView, tags=["deployments"])
    def deployment_group(group_id: UUID, principal: Operator):
        return control.groups(str(group_id))

    @app.post("/api/v1/deployment-groups", response_model=DeploymentGroupView, status_code=202, tags=["deployments"])
    def deploy_group(body: DeployGroup, principal: Operator,
        idempotency_key: Annotated[str, Header(min_length=8, max_length=100)]):
        return control.deploy_group(principal["username"], body, idempotency_key)

    @app.post("/api/v1/deployment-groups/{group_id}/stop", response_model=DeploymentGroupView, status_code=202, tags=["deployments"])
    def stop_group(group_id: UUID, principal: Operator):
        return control.change_group(principal["username"], str(group_id), "stop")

    @app.post("/api/v1/deployment-groups/{group_id}/redeploy", response_model=DeploymentGroupView, status_code=202, tags=["deployments"])
    def redeploy_group(group_id: UUID, body: Redeploy, principal: Operator):
        return control.change_group(principal["username"], str(group_id), "deploy",
            str(body.profile_version_id) if body.profile_version_id else None)

    @app.get("/api/v1/events", response_model=EventPage, tags=["telemetry"])
    def events(principal: Operator, filters: Annotated[QueryFilters, Query()]):
        return queries.events(filters)

    @app.post("/api/v1/events/{event_id}/flags", response_model=EventView, tags=["investigation"])
    def set_event_flag(event_id: UUID, body: SetEventFlag, principal: Operator):
        return flags.set_event_flag(principal["username"], str(event_id), body)

    @app.get("/api/v1/flags/challenges", response_model=list[FlagChallengeView], response_model_exclude_none=True, tags=["flags"])
    def flag_challenges(principal: Operator):
        return flags.challenges(principal["id"])

    @app.get("/api/v1/flags/admin/challenges", response_model=list[FlagChallengeView], tags=["flags"])
    def admin_flag_challenges(principal: Operator):
        return flags.challenges(principal["id"], admin=True)

    @app.post("/api/v1/flags/challenges", response_model=FlagChallengeView, status_code=201, tags=["flags"])
    def create_flag_challenge(body: CreateFlagChallenge, principal: Operator):
        return flags.create_challenge(principal["username"], body)

    @app.post("/api/v1/flags/challenges/{challenge_id}/state", response_model=FlagChallengeView, tags=["flags"])
    def set_flag_challenge(challenge_id: UUID, body: ChallengeState, principal: Operator):
        return flags.set_challenge(principal["username"], str(challenge_id), body.enabled)

    @app.post("/api/v1/flags/submit", response_model=FlagSolveView, tags=["flags"])
    def submit_flag(body: SubmitFlag, principal: Operator):
        return flags.submit(principal["id"], body)

    @app.get("/api/v1/flags/scoreboard", response_model=list[ScoreRow], tags=["flags"])
    def flag_scoreboard(principal: Operator):
        return flags.scoreboard()

    @app.get("/api/v1/storage", response_model=StorageView, tags=["evidence"])
    def storage(principal: Operator):
        return retention.status()

    @app.post("/api/v1/cases/{case_id}/retention", response_model=CaseView, tags=["evidence"])
    def pin_case(case_id: UUID, body: PinCase, principal: Operator):
        return retention.pin(principal["username"], str(case_id), body)

    @app.post("/api/v1/events/{event_id}/private-capture", response_model=PrivateCaptureView, tags=["evidence"])
    def reveal_capture(principal: Operator, event_id: UUID):
        return captures.reveal(principal["username"], str(event_id))

    @app.get("/api/v1/sessions", response_model=list[SessionView], tags=["investigation"])
    def sessions(principal: Operator, deployment_id: UUID | None = None):
        return queries.sessions(str(deployment_id) if deployment_id else None)

    @app.get("/api/v1/sessions/{session_id}", response_model=SessionDetail, tags=["investigation"])
    def session(session_id: UUID, principal: Operator):
        return queries.session(str(session_id))

    @app.get("/api/v1/sessions/{session_id}/playback", response_model=PlaybackPage, tags=["investigation"])
    def playback(session_id: UUID, principal: Operator, after: int = Query(default=0, ge=0),
        limit: int = Query(default=500, ge=1, le=500)):
        return queries.playback(str(session_id), after, limit)

    @app.get("/api/v1/sessions/{session_id}/report", response_model=SessionReport, tags=["investigation"])
    def report(session_id: UUID, principal: Operator):
        return queries.report(str(session_id))

    @app.get("/api/v1/topology", response_model=TopologyView, tags=["overview"])
    def topology(principal: Operator, hours: int = Query(default=24, ge=1, le=168)):
        return queries.topology(hours)

    @app.get("/api/v1/source-blocks", response_model=list[SourceBlockView], tags=["response"])
    def blocks(principal: Operator, deployment_id: UUID | None = None):
        return queries.blocks(str(deployment_id) if deployment_id else None)

    @app.post("/api/v1/source-blocks", response_model=SourceBlockView, status_code=202, tags=["response"])
    def create_block(body: CreateSourceBlock, principal: Operator,
        idempotency_key: Annotated[str, Header(min_length=8, max_length=100)]):
        return investigation.create_block(principal["username"], body, idempotency_key)

    @app.post("/api/v1/source-blocks/{block_id}/cancel", response_model=SourceBlockView, status_code=202, tags=["response"])
    def cancel_block(block_id: UUID, body: RevisionRequest, principal: Operator):
        return investigation.cancel_block(principal["username"], str(block_id), body.revision)

    @app.get("/api/v1/cases", response_model=list[CaseView], tags=["investigation"])
    def cases(principal: Operator):
        return queries.cases()

    @app.post("/api/v1/cases", response_model=CaseView, status_code=201, tags=["investigation"])
    def create_case(body: CreateCase, principal: Operator):
        return investigation.create_case(principal["username"], body)

    @app.post("/api/v1/cases/{case_id}", response_model=CaseView, tags=["investigation"])
    def update_case(case_id: UUID, body: UpdateCase, principal: Operator):
        return investigation.update_case(principal["username"], str(case_id), body)

    @app.get("/api/v1/findings", response_model=list[NamedFindingView], tags=["investigation"])
    def findings(principal: Operator):
        return queries.findings()

    @app.get("/api/v1/overview", response_model=OverviewView, tags=["overview"])
    def overview(principal: Operator):
        return queries.overview()

    @app.get("/api/v1/audit", response_model=list[AuditView], tags=["audit"])
    def audit(principal: Operator):
        return queries.audit()

    @app.post("/api/v1/exports", response_model=ExportView, tags=["investigation"])
    def export(body: ExportRequest, principal: Operator):
        return queries.export(body, principal["username"])

    @app.get("/api/v1/artifacts", response_model=list[ArtifactView], tags=["evidence"])
    def artifacts(principal: Operator, deployment_id: UUID | None = None, session_id: UUID | None = None):
        return evidence.list(str(deployment_id) if deployment_id else None, str(session_id) if session_id else None)

    @app.get("/api/v1/artifacts/{artifact_id}/download", tags=["evidence"])
    def download_artifact(artifact_id: UUID, principal: Operator):
        path, kind, sha256 = evidence.download(str(artifact_id), principal["username"])
        return FileResponse(path, media_type="application/octet-stream", filename=f"{kind}-{artifact_id}.{'pcap' if kind == 'pcap' else 'bin'}",
            headers={"X-Content-SHA256": sha256})

    @app.get("/api/v1/stream", response_class=EventSourceResponse, tags=["telemetry"])
    async def stream(request: Request, principal: Operator,
        after: int = Query(default=0, ge=0), last_event_id: Annotated[str | None, Header()] = None):
        try:
            cursor = int(last_event_id) if last_event_id is not None else after
        except ValueError:
            raise DomainError("invalid_cursor", "Invalid stream cursor") from None
        if cursor < 0:
            raise DomainError("invalid_cursor", "Invalid stream cursor")
        ticks = 0
        while not await request.is_disconnected():
            if ticks % 20 == 0:
                try:
                    await asyncio.to_thread(control.authenticate, request.cookies.get("hf_session"))
                except DomainError:
                    yield ServerSentEvent(event="auth_expired", data={})
                    return
            batch = await asyncio.to_thread(queries.stream, cursor)
            if batch["reset"]:
                cursor = batch["watermark"]
                yield ServerSentEvent(event="reset_required", id=str(cursor), data={"watermark": cursor})
            for item in batch["items"]:
                cursor = item["position"]
                yield ServerSentEvent(event="update", id=str(cursor), data={"kind": item["kind"], **item["data"]})
            ticks += 1
            await asyncio.sleep(0.25)

    @app.post("/agent/v1/enroll", tags=["agent"])
    def enroll(body: Enroll, request: Request):
        if config.require_agent_mtls:
            management_gateway(request)
        return control.enroll(body)

    @app.post("/agent/v1/heartbeat", tags=["agent"])
    def heartbeat(body: Heartbeat, host_id: Agent):
        return control.heartbeat(host_id, body)

    @app.get("/agent/v1/runtimes", tags=["agent"])
    def desired_runtimes(host_id: Agent):
        return control.desired_runtimes(host_id)

    @app.get("/agent/v1/source-policies", response_model=list[AgentPolicy], tags=["agent"])
    def source_policies(host_id: Agent):
        return investigation.policies(host_id)

    @app.post("/agent/v1/source-policies/{policy_id}/ack", response_model=OkayView, tags=["agent"])
    def policy_ack(policy_id: UUID, body: PolicyAck, host_id: Agent):
        return investigation.acknowledge(host_id, str(policy_id), body)

    @app.post("/agent/v1/jobs/claim", tags=["agent"])
    def claim(host_id: Agent):
        return {"job": control.claim(host_id)}

    @app.post("/agent/v1/jobs/{job_id}/progress", tags=["agent"])
    def progress(job_id: UUID, body: Progress, host_id: Agent):
        return control.progress(host_id, str(job_id), body)

    @app.post("/agent/v1/jobs/{job_id}/result", tags=["agent"])
    def result(job_id: UUID, body: JobResult, host_id: Agent):
        return control.result(host_id, str(job_id), body)

    @app.post("/agent/v1/events/batch", tags=["agent"])
    def ingest(body: EventBatch, host_id: Agent):
        return telemetry.ingest(host_id, body)

    @app.post("/agent/v1/artifacts", response_model=ArtifactView, tags=["agent"])
    def artifact_manifest(body: ArtifactManifest, host_id: Agent):
        return evidence.manifest(host_id, body)

    @app.post("/agent/v1/artifacts/{artifact_id}/chunks", response_model=ArtifactView, tags=["agent"])
    def artifact_chunk(artifact_id: UUID, body: ArtifactChunk, host_id: Agent):
        return evidence.chunk(host_id, str(artifact_id), body)

    return app


app = create_app()


def run():
    import uvicorn
    uvicorn.run("honeyforge.api.main:app", host=settings.bind, port=settings.port, log_level="info")
