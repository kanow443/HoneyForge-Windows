"""Resumable uploads with independent server verification and bounded disk use."""
import base64
import binascii
import hashlib
import json
import os
from datetime import timedelta
from pathlib import Path

from sqlalchemy import func, select

from honeyforge.application.control import required
from honeyforge.domain.errors import DomainError
from honeyforge.infrastructure.models import Deployment, DeploymentRun, EvidenceArtifact, Session, now
from honeyforge.infrastructure.projections import record
from honeyforge.infrastructure.security import sanitize


class EvidenceService:
    def __init__(self, database, config):
        self.database, self.config = database, config
        self.root = Path(config.artifact_dir).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)

    def path(self, key, partial=False):
        from uuid import UUID
        return self.root / (str(UUID(key)) + (".part" if partial else ".blob"))

    def write_chunk(self, path, offset, content):
        with path.open("r+b" if path.exists() else "w+b") as file:
            os.fchmod(file.fileno(), 0o600)
            if os.fstat(file.fileno()).st_size < offset:
                raise DomainError("artifact_unavailable", "Stored upload is incomplete", 409)
            file.truncate(offset)
            file.seek(offset)
            file.write(content)
            file.flush()
            os.fsync(file.fileno())

    def manifest(self, host_id, command):
        if command.ended_at < command.started_at or len(json.dumps(command.details).encode()) > 16384:
            raise DomainError("invalid_artifact", "Invalid artifact interval or metadata")
        with self.database.unit_of_work() as u:
            u.lock_write()
            deployment = required(u.repo.get(Deployment, str(command.deployment_id)), "Deployment")
            run = required(u.repo.get(DeploymentRun, str(command.generation)), "Generation")
            if deployment.host_id != host_id or run.deployment_id != deployment.id:
                raise DomainError("foreign_artifact", "Artifact scope belongs to another sensor", 403)
            row = u.repo.get(EvidenceArtifact, str(command.id))
            fields = command.model_dump(mode="json")
            fields["details"] = sanitize(fields["details"])
            if row:
                if row.host_id != host_id:
                    raise DomainError("foreign_artifact", "Artifact belongs to another sensor", 403)
                existing = record(row)
                for name in fields:
                    value = existing[name]
                    if hasattr(value, "isoformat"):
                        value = value.isoformat()
                    if name in {"started_at", "ended_at"}:
                        # JSON may use Z or +00:00; compare parsed timestamps.
                        value = existing[name]
                        if value != getattr(command, name):
                            raise DomainError("artifact_conflict", "Artifact manifest cannot change", 409)
                    elif value != fields[name]:
                        raise DomainError("artifact_conflict", "Artifact manifest cannot change", 409)
                return record(row)
            reserved = u.session.scalar(select(func.coalesce(func.sum(EvidenceArtifact.size_bytes), 0)).where(EvidenceArtifact.state != "expired"))
            if reserved + command.size_bytes > self.config.artifact_quota_bytes:
                raise DomainError("artifact_quota", "Evidence storage budget is exhausted", 409)
            row = u.repo.add(EvidenceArtifact(**command.model_dump(exclude={"id", "details", "deployment_id", "generation"}), id=str(command.id),
                deployment_id=str(command.deployment_id), generation=str(command.generation), host_id=host_id,
                details=fields["details"], expires_at=now() + timedelta(days=self.config.event_retention_days)))
            u.emit("artifact.changed", {"id": row.id, "deployment_id": row.deployment_id})
            return record(row)

    def chunk(self, host_id, key, command):
        try:
            content = base64.b64decode(command.data_base64, validate=True)
        except (ValueError, binascii.Error):
            raise DomainError("invalid_chunk", "Expected base64 chunk") from None
        if not content or len(content) > 262144:
            raise DomainError("invalid_chunk", "Chunk size must be between 1 and 256 KiB")
        with self.database.unit_of_work() as u:
            u.lock_write()
            row = required(u.repo.get(EvidenceArtifact, key, lock=True), "Artifact")
            if row.host_id != host_id:
                raise DomainError("foreign_artifact", "Artifact belongs to another sensor", 403)
            if row.state in {"expired", "purging"}:
                raise DomainError("artifact_expired", "Artifact has expired", 410)
            if command.offset + len(content) > row.size_bytes or command.offset > row.received_bytes:
                raise DomainError("chunk_offset", "Chunk is outside the expected upload range", 409)
            partial, complete = self.path(key, True), self.path(key)
            # A previous transaction may have moved the verified file before its SQL commit.
            recovered = not partial.exists() and complete.exists()
            path = complete if row.state == "available" or recovered else partial
            if command.offset < row.received_bytes or recovered or row.state == "available":
                if command.offset + len(content) > row.received_bytes and not recovered:
                    raise DomainError("chunk_overlap", "Retry must match a fully acknowledged chunk", 409)
                with path.open("rb") as file:
                    file.seek(command.offset)
                    if file.read(len(content)) != content:
                        raise DomainError("chunk_conflict", "Chunk retry contains different bytes", 409)
            else:
                try:
                    self.write_chunk(path, row.received_bytes, content)
                except OSError:
                    raise DomainError("artifact_storage_unavailable", "Evidence storage cannot accept new bytes; existing verified evidence is preserved", 503) from None
                row.received_bytes += len(content)
            if row.received_bytes == row.size_bytes or recovered:
                with path.open("rb") as file:
                    actual = hashlib.file_digest(file, "sha256").hexdigest()
                if path.stat().st_size != row.size_bytes or actual != row.sha256:
                    # Transaction rollback preserves the previously acknowledged offset.
                    raise DomainError("artifact_hash", "Artifact size or SHA-256 does not match", 409)
                if row.state != "available":
                    if path != complete:
                        path.replace(complete)
                    directory = os.open(self.root, os.O_RDONLY)
                    try:
                        os.fsync(directory)
                    finally:
                        os.close(directory)
                    row.received_bytes, row.state = row.size_bytes, "available"
                    u.audit("agent:" + host_id, "artifact.verified", key, {"sha256": actual, "size_bytes": row.size_bytes, "kind": row.kind})
                    u.emit("artifact.changed", {"id": key, "deployment_id": row.deployment_id})
            return record(row)

    def list(self, deployment_id=None, session_id=None):
        with self.database.sessions() as s:
            query = select(EvidenceArtifact).order_by(EvidenceArtifact.created_at.desc()).limit(200)
            if deployment_id:
                query = query.where(EvidenceArtifact.deployment_id == deployment_id)
            if session_id:
                session = required(s.get(Session, session_id), "Session")
                query = query.where(EvidenceArtifact.deployment_id == session.deployment_id,
                    EvidenceArtifact.generation == session.generation,
                    (EvidenceArtifact.source_session_id == session.source_id) | (
                        EvidenceArtifact.source_session_id.is_(None) & (EvidenceArtifact.started_at <= (session.ended_at or now()))
                        & (EvidenceArtifact.ended_at >= session.started_at)))
            return [record(row) for row in s.scalars(query)]

    def download(self, key, actor):
        with self.database.unit_of_work() as u:
            u.lock_write()
            row = required(u.repo.get(EvidenceArtifact, key), "Artifact")
            if row.state != "available" or not self.path(key).is_file():
                raise DomainError("artifact_unavailable", "Artifact bytes are not available", 409)
            u.audit(actor, "artifact.downloaded", key, {"sha256": row.sha256, "kind": row.kind})
            return self.path(key), row.kind, row.sha256
