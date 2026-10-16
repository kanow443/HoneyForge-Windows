"""Explicit operator roles; preserve existing administrator access."""
import sqlalchemy as sa
from alembic import op

revision = "006"
down_revision = "005"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("users", sa.Column("role", sa.String(20), nullable=False, server_default="admin"))
    op.alter_column("users", "role", server_default=None)


def downgrade():
    op.drop_column("users", "role")
