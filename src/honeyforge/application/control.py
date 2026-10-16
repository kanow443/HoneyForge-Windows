"""Transactional application commands. HTTP and runtime execution stay outside this layer."""
from datetime import timedelta

from sqlalchemy import func, or_, select

from honeyforge.application.honeytokens import HoneyTokenService
from honeyforge.application.schemas import CreateProfile, Deploy, Enroll, Heartbeat, JobResult, Progress
from honeyforge.domain.errors import DomainError
from honeyforge.domain.profiles import runtime_config
from honeyforge.infrastructure.capture_keys import CaptureKeys
from honeyforge.infrastructure.models import (
    Deployment,
    DeploymentGroup,
    DeploymentRun,
    Enrollment,
    Host,
    Job,
    LoginAttempt,
    OperatorSession,
    PortReservation,
    Profile,
    ProfileVersion,
    User,
    now,
    uid,
)
from honeyforge.infrastructure.projections import deployment_view, group_view, host_view, profile_view, record
from honeyforge.infrastructure.security import config_digest, digest, password_hasher, secret, verify_password


def required(value, label="Object"):
    if value is None:
        raise DomainError("not_found", f"{label} not found", 404)
    return value


class ControlService:
    def __init__(self, uow_factory, settings):
        self.uow_factory, self.settings = uow_factory, settings
        self.capture_keys = CaptureKeys(settings.capture_key_dir)
        self.dummy_password = password_hasher.hash(secret())

    def _active_host(self, u, host_id):
        host = required(u.repo.get(Host, host_id), "Host")
        if host.revoked_at:
            raise DomainError("invalid_agent_key", "Agent key is revoked", 401)
        return host

    def login(self, username, password, client_ip):
        invalid = False
        identity = digest(f"{client_ip}:{username}")
        with self.uow_factory() as u:
            u.lock_write()
            failures = u.session.scalar(select(func.count()).select_from(LoginAttempt).where(
                LoginAttempt.identity == identity, LoginAttempt.succeeded.is_(False),
                LoginAttempt.created_at > now() - timedelta(minutes=5)))
            if failures >= 10:
                raise DomainError("rate_limited", "Too many login attempts. Try again in five minutes.", 429)
            user = u.repo.find(User, username=username)
            valid = verify_password(user.password_hash if user else self.dummy_password, password) and user is not None
            u.repo.add(LoginAttempt(identity=identity, succeeded=valid))
            if not valid:
                invalid = True
            else:
                token, csrf = secret(), secret()
                u.repo.add(OperatorSession(user_id=user.id, token_hash=digest(token), csrf_hash=digest(csrf),
                    expires_at=now() + timedelta(hours=self.settings.session_hours)))
                u.audit(user.username, "auth.login", user.id)
                result = ({"id": user.id, "username": user.username, "role": user.role}, token, csrf)
        if invalid:
            raise DomainError("invalid_credentials", "Incorrect username or password", 401)
        return result

    def authenticate(self, token):
        with self.uow_factory() as u:
            session = u.repo.find(OperatorSession, token_hash=digest(token or ""))
            if not session or session.expires_at <= now():
                raise DomainError("unauthorized", "Please sign in", 401)
            user = required(u.repo.get(User, session.user_id), "User")
            return {"id": user.id, "username": user.username, "role": user.role, "session_id": session.id,
                "csrf_hash": session.csrf_hash}

    def users(self):
        with self.uow_factory() as u:
            return [{"id": row.id, "username": row.username, "role": row.role} for row in u.repo.list(User)]

    def create_user(self, actor, command):
        with self.uow_factory() as u:
            u.lock_write()
            if u.repo.find(User, username=command.username):
                raise DomainError("username_exists", "Username is already in use", 409)
            row = u.repo.add(User(username=command.username, password_hash=password_hasher.hash(command.password), role=command.role))
            u.audit(actor, "user.created", row.id, {"username": row.username, "role": row.role})
            return {"id": row.id, "username": row.username, "role": row.role}

    def change_user_role(self, actor, key, command):
        with self.uow_factory() as u:
            u.lock_write()
            row = required(u.repo.get(User, key), "User")
            if row.role == "admin" and command.role != "admin":
                count = u.session.scalar(select(func.count()).select_from(User).where(User.role == "admin"))
                if count <= 1:
                    raise DomainError("last_admin", "At least one administrator is required", 409)
            if row.role != command.role:
                row.role = command.role
                for session in u.session.scalars(select(OperatorSession).where(OperatorSession.user_id == key)):
                    u.session.delete(session)
                u.audit(actor, "user.role_changed", row.id, {"role": row.role, "sessions_revoked": True})
            return {"id": row.id, "username": row.username, "role": row.role}

    def logout(self, principal):
        with self.uow_factory() as u:
            u.lock_write()
            row = u.repo.get(OperatorSession, principal["session_id"])
            if row:
                u.session.delete(row)
            u.audit(principal["username"], "auth.logout", principal["id"])

    def enrollment_token(self, actor):
        token = secret()
        expires = now() + timedelta(minutes=10)
        with self.uow_factory() as u:
            u.lock_write()
            entry = u.repo.add(Enrollment(token_hash=digest(token), expires_at=expires))
            u.audit(actor, "host.enrollment_created", entry.id)
        return {"token": token, "expires_at": expires}

    def enroll(self, command: Enroll):
        key = secret()
        with self.uow_factory() as u:
            u.lock_write()
            token = u.repo.find(Enrollment, token_hash=digest(command.token))
            if not token or token.used_at or token.expires_at <= now():
                raise DomainError("invalid_enrollment", "Enrollment token is expired or already used", 401)
            token.used_at = now()
            host = u.repo.add(Host(name=command.name, address=command.address, key_hash=digest(key),
                capabilities=command.capabilities, runtime_version=command.runtime_version, last_seen=now()))
            u.audit("agent", "host.enrolled", host.id)
            u.emit("host.updated", {"id": host.id})
            return {"host_id": host.id, "key": key}

    def agent_auth(self, key):
        with self.uow_factory() as u:
            host = u.repo.find(Host, key_hash=digest(key or ""))
            if not host or host.revoked_at:
                raise DomainError("invalid_agent_key", "Agent key is invalid or revoked", 401)
            return host.id

    def revoke(self, actor, host_id):
        with self.uow_factory() as u:
            u.lock_write()
            host = required(u.repo.get(Host, host_id), "Host")
            host.revoked_at = now()
            u.audit(actor, "host.revoked", host.id)
            u.emit("host.updated", {"id": host.id})
            return host_view(host, self.settings.offline_seconds)

    def heartbeat(self, host_id, command: Heartbeat):
        with self.uow_factory() as u:
            u.lock_write()
            host = self._active_host(u, host_id)
            host.last_seen = now()
            if command.capabilities:
                host.capabilities = command.capabilities
            if command.runtime_version:
                host.runtime_version = command.runtime_version
            host.metrics = command.model_dump(mode="json", exclude={"runtimes", "padding"})
            for observation in command.runtimes:
                deployment = u.repo.get(Deployment, str(observation.deployment_id))
                if not deployment or deployment.host_id != host_id:
                    raise DomainError("foreign_deployment", "Runtime does not belong to this host", 403)
                if observation.revision != deployment.desired_revision:
                    continue
                if observation.state == "running" and deployment.desired_state == "stopped":
                    continue
                active = any(j.status in {"queued", "leased"} for j in u.repo.list(Job, deployment_id=deployment.id))
                if active:
                    # Heartbeats cannot overwrite a command while its executor is applying it.
                    continue
                if observation.state == "stopped" and deployment.desired_state == "running" and deployment.observed_state == "running":
                    deployment.desired_revision += 1
                    u.repo.add(Job(deployment_id=deployment.id, host_id=host_id, kind="deploy", revision=deployment.desired_revision))
                    deployment.observed_state = "requested"
                    u.audit(f"agent:{host_id}", "deployment.repair_requested", deployment.id,
                        {"revision": deployment.desired_revision})
                    u.emit("deployment.updated", {"id": deployment.id})
                    continue
                changed = deployment.observed_state != observation.state
                deployment.observed_state = observation.state
                deployment.observed_at = now()
                if observation.image_digest:
                    deployment.image_digest = observation.image_digest
                deployment.error = observation.error
                if changed:
                    u.emit("deployment.updated", {"id": deployment.id})
            u.emit("host.updated", {"id": host.id})
            return {"server_time": now()}

    def create_profile(self, actor, command: CreateProfile):
        with self.uow_factory() as u:
            u.lock_write()
            profile = u.repo.add(Profile(name=command.name, description=command.description,
                adapter=command.config.adapter))
            config = command.config.model_dump(mode="json")
            u.repo.add(ProfileVersion(profile_id=profile.id, number=1, config=config, config_hash=config_digest(config)))
            u.audit(actor, "profile.created", profile.id, {"adapter": profile.adapter})
            u.emit("profile.updated", {"id": profile.id})
            return profile_view(u.session, profile)

    def publish(self, actor, profile_id, config):
        with self.uow_factory() as u:
            u.lock_write()
            profile = required(u.repo.get(Profile, profile_id), "Profile")
            if profile.archived_at:
                raise DomainError("profile_archived", "Restore the profile before publishing", 409)
            if profile.adapter != config.adapter:
                raise DomainError("adapter_mismatch", "A profile cannot change its adapter")
            profile.latest_version += 1
            data = config.model_dump(mode="json")
            version = u.repo.add(ProfileVersion(profile_id=profile.id, number=profile.latest_version,
                config=data, config_hash=config_digest(data)))
            u.audit(actor, "profile.version_published", profile.id, {"version": version.number, "hash": version.config_hash})
            u.emit("profile.updated", {"id": profile.id})
            return record(version)

    def update_profile(self, actor, key, command):
        with self.uow_factory() as u:
            u.lock_write()
            row = required(u.repo.get(Profile, key), "Profile")
            row.name, row.description = command.name, command.description
            u.audit(actor, "profile.metadata_updated", key)
            u.emit("profile.updated", {"id": key})
            return profile_view(u.session, row)

    def archive_profile(self, actor, key, archived):
        with self.uow_factory() as u:
            u.lock_write()
            row = required(u.repo.get(Profile, key), "Profile")
            row.archived_at = now() if archived else None
            u.audit(actor, "profile.archived" if archived else "profile.restored", key)
            u.emit("profile.updated", {"id": key})
            return profile_view(u.session, row)

    def delete_profile(self, actor, key):
        with self.uow_factory() as u:
            u.lock_write()
            row = required(u.repo.get(Profile, key), "Profile")
            versions = select(ProfileVersion.id).where(ProfileVersion.profile_id == key)
            used = u.session.scalar(select(func.count()).select_from(DeploymentRun).where(DeploymentRun.profile_version_id.in_(versions)))
            if used or u.session.scalar(select(DeploymentGroup.id).where(DeploymentGroup.profile_version_id.in_(versions)).limit(1)):
                raise DomainError("profile_in_use", "Profile has deployment history; archive it instead", 409)
            for version in u.repo.list(ProfileVersion, profile_id=key):
                u.session.delete(version)
            u.session.flush()
            u.session.delete(row)
            u.audit(actor, "profile.deleted", key)
            u.emit("profile.updated", {"id": key})
            return {"ok": True}

    def deploy(self, actor, command: Deploy, idempotency_key):
        request_hash = config_digest(command.model_dump(mode="json"))
        with self.uow_factory() as u:
            u.lock_write()
            existing = u.repo.find(Deployment, idempotency_key=idempotency_key)
            if existing:
                if existing.request_hash != request_hash:
                    raise DomainError("idempotency_conflict", "This key was used for another request", 409)
                return deployment_view(u.session, existing, self.settings.offline_seconds)
            host = required(u.repo.get(Host, str(command.host_id)), "Host")
            if host_view(host, self.settings.offline_seconds)["status"] not in {"online", "degraded"}:
                raise DomainError("host_offline", "Host is offline or revoked", 409)
            version = required(u.repo.get(ProfileVersion, str(command.profile_version_id)), "Profile version")
            if required(u.repo.get(Profile, version.profile_id), "Profile").archived_at:
                raise DomainError("profile_archived", "Restore the profile before deploying", 409)
            adapter = version.config["adapter"]
            if adapter == "bundle":
                raise DomainError("group_required", "Use /api/v1/deployment-groups for a multi-service profile", 409)
            if adapter not in host.capabilities:
                raise DomainError("incompatible_host", "This host does not support the selected adapter", 409)
            if u.repo.find(PortReservation, host_id=host.id, port=command.port):
                raise DomainError("port_reserved", "Port is already reserved by another trap", 409)
            deployment = u.repo.add(Deployment(name=command.name, host_id=host.id, adapter=adapter,
                port=command.port, profile_version_id=version.id, idempotency_key=idempotency_key,
                request_hash=request_hash))
            u.repo.add(DeploymentRun(id=deployment.runtime_generation, deployment_id=deployment.id,
                profile_version_id=version.id))
            HoneyTokenService.bind(u, deployment, deployment.runtime_generation)
            u.repo.add(PortReservation(deployment_id=deployment.id, host_id=host.id, port=command.port))
            u.repo.add(Job(deployment_id=deployment.id, host_id=host.id, kind="deploy", revision=1))
            u.audit(actor, "deployment.requested", deployment.id, {"version_id": version.id, "port": command.port})
            u.emit("deployment.updated", {"id": deployment.id})
            return deployment_view(u.session, deployment, self.settings.offline_seconds)

    def change_runtime(self, actor, deployment_id, kind, version_id=None):
        with self.uow_factory() as u:
            u.lock_write()
            deployment = required(u.repo.get(Deployment, deployment_id), "Deployment")
            if kind == "stop" and deployment.desired_state == "stopped":
                return deployment_view(u.session, deployment, self.settings.offline_seconds)
            if deployment.group_id and kind == "deploy":
                raise DomainError("group_required", "Redeploy this service through its deployment group", 409)
            return self._change_runtime(u, actor, deployment, kind, version_id)

    def _change_runtime(self, u, actor, deployment, kind, version_id=None):
        if kind == "stop" and deployment.desired_state == "stopped":
            return deployment_view(u.session, deployment, self.settings.offline_seconds)
        host = required(u.repo.get(Host, deployment.host_id), "Host")
        if host.revoked_at:
            raise DomainError("host_revoked", "Restore control of this host before changing its runtime", 409)
        if kind == "deploy":
            version = required(u.repo.get(ProfileVersion, version_id or deployment.profile_version_id), "Version")
            if required(u.repo.get(Profile, version.profile_id), "Profile").archived_at:
                raise DomainError("profile_archived", "Restore the profile before redeploying", 409)
            if runtime_config(version.config, deployment.service_key)["adapter"] != deployment.adapter:
                raise DomainError("adapter_mismatch", "Redeployment must use the same adapter")
            if not u.repo.find(PortReservation, deployment_id=deployment.id):
                if u.repo.find(PortReservation, host_id=host.id, port=deployment.port):
                    raise DomainError("port_reserved", "Port was reserved by another trap", 409)
                u.repo.add(PortReservation(deployment_id=deployment.id, host_id=host.id, port=deployment.port))
            deployment.profile_version_id = version.id
            deployment.runtime_generation = uid()
            u.repo.add(DeploymentRun(id=deployment.runtime_generation, deployment_id=deployment.id,
                profile_version_id=version.id))
            HoneyTokenService.bind(u, deployment, deployment.runtime_generation)
        deployment.desired_revision += 1
        deployment.desired_state = "stopped" if kind == "stop" else "running"
        deployment.observed_state = "stopping" if kind == "stop" else "requested"
        deployment.error = None
        for previous in u.repo.list(Job, deployment_id=deployment.id):
            if previous.status in {"queued", "leased"}:
                previous.status = "cancelled"
        u.repo.add(Job(deployment_id=deployment.id, host_id=host.id, kind=kind,
            revision=deployment.desired_revision))
        u.audit(actor, f"deployment.{kind}_requested", deployment.id,
            {"revision": deployment.desired_revision, "version_id": deployment.profile_version_id})
        u.emit("deployment.updated", {"id": deployment.id})
        return deployment_view(u.session, deployment, self.settings.offline_seconds)
    def deploy_group(self, actor, command, idempotency_key):
        request_hash = config_digest(command.model_dump(mode="json"))
        with self.uow_factory() as u:
            u.lock_write()
            existing = u.repo.find(DeploymentGroup, idempotency_key=idempotency_key)
            if existing:
                if existing.request_hash != request_hash:
                    raise DomainError("idempotency_conflict", "This key was used for another group", 409)
                return group_view(u.session, existing, self.settings.offline_seconds)
            host = required(u.repo.get(Host, str(command.host_id)), "Host")
            if host_view(host, self.settings.offline_seconds)["status"] not in {"online", "degraded"}:
                raise DomainError("host_offline", "Host is offline or revoked", 409)
            version = required(u.repo.get(ProfileVersion, str(command.profile_version_id)), "Version")
            if required(u.repo.get(Profile, version.profile_id), "Profile").archived_at:
                raise DomainError("profile_archived", "Restore the profile before deploying", 409)
            if version.config["adapter"] != "bundle":
                raise DomainError("bundle_required", "A deployment group requires a schema v3 bundle", 409)
            services = version.config["services"]
            keys = {entry["key"] for entry in services}
            if set(command.ports) - keys:
                raise DomainError("unknown_service", "Port overrides must reference existing service keys")
            ports = [command.ports.get(entry["key"], entry["port"]) for entry in services]
            if len(set(ports)) != len(ports):
                raise DomainError("duplicate_port", "Each service requires a distinct port", 409)
            for entry, port in zip(services, ports, strict=True):
                if entry["config"]["adapter"] not in host.capabilities:
                    raise DomainError("incompatible_host", "The host must support every service", 409)
                if u.repo.find(PortReservation, host_id=host.id, port=port):
                    raise DomainError("port_reserved", f"Port {port} is already reserved", 409)
            group = u.repo.add(DeploymentGroup(name=command.name, host_id=host.id,
                profile_version_id=version.id, idempotency_key=idempotency_key, request_hash=request_hash))
            for entry, port in zip(services, ports, strict=True):
                deployment = u.repo.add(Deployment(name=f"{command.name[:74]} / {entry['key']}", host_id=host.id,
                    adapter=entry["config"]["adapter"], port=port, profile_version_id=version.id,
                    group_id=group.id, service_key=entry["key"], idempotency_key="group:" + group.id + ":" + entry["key"],
                    request_hash=request_hash))
                u.repo.add(DeploymentRun(id=deployment.runtime_generation, deployment_id=deployment.id,
                    profile_version_id=version.id))
                HoneyTokenService.bind(u, deployment, deployment.runtime_generation)
                u.repo.add(PortReservation(deployment_id=deployment.id, host_id=host.id, port=port))
                u.repo.add(Job(deployment_id=deployment.id, host_id=host.id, kind="deploy", revision=1))
                u.emit("deployment.updated", {"id": deployment.id, "group_id": group.id})
            u.audit(actor, "deployment_group.requested", group.id, {"version_id": version.id, "ports": ports})
            return group_view(u.session, group, self.settings.offline_seconds)

    def groups(self, group_id=None):
        with self.uow_factory() as u:
            if group_id:
                return group_view(u.session, required(u.repo.get(DeploymentGroup, group_id), "Group"), self.settings.offline_seconds)
            return [group_view(u.session, g, self.settings.offline_seconds) for g in u.repo.list(DeploymentGroup)]

    def change_group(self, actor, group_id, kind, version_id=None):
        with self.uow_factory() as u:
            u.lock_write()
            group = required(u.repo.get(DeploymentGroup, group_id), "Group")
            children = u.repo.list(Deployment, group_id=group.id)
            if kind == "deploy":
                version = required(u.repo.get(ProfileVersion, version_id or group.profile_version_id), "Version")
                old = required(u.repo.get(ProfileVersion, group.profile_version_id), "Version")
                if version.profile_id != old.profile_id or version.config["adapter"] != "bundle":
                    raise DomainError("profile_mismatch", "Group redeploy must use the same bundle profile", 409)
                topology = {entry["key"]: entry["config"]["adapter"] for entry in version.config["services"]}
                if topology != {d.service_key: d.adapter for d in children}:
                    raise DomainError("topology_changed", "Create a new group to change service keys or adapters", 409)
                host = required(u.repo.get(Host, group.host_id), "Host")
                if any(d.adapter not in host.capabilities for d in children):
                    raise DomainError("incompatible_host", "The host must support every service", 409)
                group.profile_version_id = version.id
            for deployment in children:
                self._change_runtime(u, actor, deployment, kind, group.profile_version_id if kind == "deploy" else None)
            u.audit(actor, f"deployment_group.{kind}_requested", group.id)
            return group_view(u.session, group, self.settings.offline_seconds)

    def desired_runtimes(self, host_id):
        with self.uow_factory() as u:
            self._active_host(u, host_id)
            return [self._spec(u, d) for d in u.repo.list(Deployment, host_id=host_id)]

    def _spec(self, u, deployment):
        version = required(u.repo.get(ProfileVersion, deployment.profile_version_id), "Version")
        return {"deployment_id": deployment.id, "revision": deployment.desired_revision,
            "generation": deployment.runtime_generation, "desired_state": deployment.desired_state,
            "observed_state": deployment.observed_state,
            "adapter": deployment.adapter, "port": deployment.port,
            "group_id": deployment.group_id, "service_key": deployment.service_key,
            "config": runtime_config(version.config, deployment.service_key),
            "capture_key": self.capture_keys.public(), "honeytokens": HoneyTokenService.runtime(u, deployment)}

    def claim(self, host_id):
        with self.uow_factory() as u:
            u.lock_write()
            self._active_host(u, host_id)
            jobs = list(u.session.scalars(select(Job).where(Job.host_id == host_id,
                or_(Job.status == "queued", (Job.status == "leased") & (Job.lease_until < now())))
                .order_by(Job.created_at).limit(20)))
            for job in jobs:
                deployment = required(u.repo.get(Deployment, job.deployment_id), "Deployment")
                if job.revision != deployment.desired_revision:
                    job.status = "cancelled"
                    continue
                if job.attempt >= 3:
                    job.status = "failed"
                    job.error = "Agent lease expired after three attempts"
                    deployment.observed_state, deployment.error = "error", job.error
                    u.emit("deployment.updated", {"id": deployment.id})
                    continue
                job.status, job.attempt = "leased", job.attempt + 1
                job.lease_until = now() + timedelta(seconds=self.settings.lease_seconds)
                deployment.observed_state = "applying" if job.kind == "deploy" else "stopping"
                u.emit("deployment.updated", {"id": deployment.id})
                return {**record(job), "spec": self._spec(u, deployment)}
            return None

    def _leased_job(self, u, host_id, job_id, attempt):
        self._active_host(u, host_id)
        job = required(u.repo.get(Job, job_id), "Job")
        if job.host_id != host_id:
            raise DomainError("foreign_job", "This job belongs to another host", 403)
        deployment = required(u.repo.get(Deployment, job.deployment_id), "Deployment")
        if job.status != "leased" or job.attempt != attempt or job.revision != deployment.desired_revision or job.lease_until < now():
            raise DomainError("stale_attempt", "This execution lease is no longer current", 409)
        return job, deployment

    def progress(self, host_id, job_id, command: Progress):
        with self.uow_factory() as u:
            u.lock_write()
            job, deployment = self._leased_job(u, host_id, job_id, command.attempt)
            job.lease_until = now() + timedelta(seconds=self.settings.lease_seconds)
            stages = list(job.stages)
            if not stages or stages[-1]["name"] != command.stage:
                stages.append({"name": command.stage, "at": now().isoformat()})
            job.stages = stages[-30:]
            u.emit("deployment.updated", {"id": deployment.id})
            return {"lease_until": job.lease_until}

    def result(self, host_id, job_id, command: JobResult):
        with self.uow_factory() as u:
            u.lock_write()
            job, deployment = self._leased_job(u, host_id, job_id, command.attempt)
            job.status = "succeeded" if command.succeeded else "failed"
            job.error = command.error if not command.succeeded else None
            deployment.observed_state = ("stopped" if job.kind == "stop" else "running") if command.succeeded else "error"
            deployment.observed_at = now()
            deployment.error = job.error
            if command.image_digest:
                deployment.image_digest = command.image_digest
            if command.succeeded and job.kind == "stop":
                reservation = u.repo.get(PortReservation, deployment.id)
                if reservation:
                    u.session.delete(reservation)
            u.audit(f"agent:{host_id}", "job.completed", job.id, {"status": job.status, "attempt": job.attempt})
            u.emit("deployment.updated", {"id": deployment.id})
            return {"accepted": True}
