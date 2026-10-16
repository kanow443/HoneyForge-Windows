"""Read-only integration credentials, independent of agents and operator cookies."""
import sqlalchemy as sa
from alembic import op

revision = "007"
down_revision = "006"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("integration_tokens",
        sa.Column("id", sa.String(36), primary_key=True), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("name", sa.String(100), nullable=False), sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("deployment_id", sa.String(36), sa.ForeignKey("deployments.id")),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False), sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("last_used_at", sa.DateTime(timezone=True)), sa.Column("created_by", sa.String(100), nullable=False))


def downgrade():
    op.drop_table("integration_tokens")
