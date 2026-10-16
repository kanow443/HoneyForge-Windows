"""Explicit, deployment-scoped automated response permission."""
import sqlalchemy as sa
from alembic import op

revision = "008"
down_revision = "007"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("integration_tokens", sa.Column("allow_response", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.alter_column("integration_tokens", "allow_response", server_default=None)


def downgrade():
    op.drop_column("integration_tokens", "allow_response")
