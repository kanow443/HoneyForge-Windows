"""Durable binary evidence manifests, separate from event JSON."""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "005"
down_revision = "004"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("evidence_artifacts",
        sa.Column("id", sa.String(36), primary_key=True), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("host_id", sa.String(36), sa.ForeignKey("hosts.id"), nullable=False),
        sa.Column("deployment_id", sa.String(36), sa.ForeignKey("deployments.id"), nullable=False),
        sa.Column("generation", sa.String(36), sa.ForeignKey("deployment_runs.id"), nullable=False),
        sa.Column("source_session_id", sa.String(100)), sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False), sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("received_bytes", sa.BigInteger(), nullable=False), sa.Column("state", sa.String(20), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False), sa.Column("ended_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False), sa.Column("details", JSONB(), nullable=False))
    op.create_index("ix_evidence_artifacts_host_id", "evidence_artifacts", ["host_id"])
    op.create_index("ix_evidence_artifacts_deployment_id", "evidence_artifacts", ["deployment_id"])


def downgrade():
    op.drop_table("evidence_artifacts")
