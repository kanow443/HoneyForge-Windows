"""Preserve ordering from source timestamps without 32-bit overflow."""
import sqlalchemy as sa
from alembic import op

revision = "002"
down_revision = "001"
branch_labels = None
depends_on = None


def upgrade():
    op.alter_column("events", "source_seq", type_=sa.BigInteger())


def downgrade():
    op.alter_column("events", "source_seq", type_=sa.Integer())
