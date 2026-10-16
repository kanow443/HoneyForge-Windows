"""Encrypted observations; plaintext never persists in the centre database."""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "010"
down_revision = "009"
branch_labels = depends_on = None


def upgrade():
    op.add_column("events", sa.Column("private_capture_available", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.create_table("private_captures",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("event_id", sa.String(36), sa.ForeignKey("events.id", ondelete="CASCADE"), nullable=False, unique=True),
        sa.Column("capture_id", sa.String(36), nullable=False, unique=True),
        sa.Column("envelope", postgresql.JSONB(), nullable=False))


def downgrade():
    op.drop_table("private_captures")
    op.drop_column("events", "private_capture_available")
