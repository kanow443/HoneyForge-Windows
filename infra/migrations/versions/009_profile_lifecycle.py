"""Archive profiles without altering immutable versions or history."""
import sqlalchemy as sa
from alembic import op

revision = "009"
down_revision = "008"
branch_labels = depends_on = None


def upgrade():
    op.add_column("profiles", sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))


def downgrade():
    op.drop_column("profiles", "archived_at")
