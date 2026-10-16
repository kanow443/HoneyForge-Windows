"""Keep firewall application and SSH transport termination as separate evidence."""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "004"
down_revision = "003"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("source_blocks", sa.Column("terminate_sessions", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("source_blocks", sa.Column("termination_state", sa.String(20), nullable=False, server_default="not_requested"))
    op.add_column("source_blocks", sa.Column("terminated_sessions", JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")))
    op.add_column("source_blocks", sa.Column("termination_error", sa.String(500)))
    for name in ("terminate_sessions", "termination_state", "terminated_sessions"):
        op.alter_column("source_blocks", name, server_default=None)


def downgrade():
    for name in ("termination_error", "terminated_sessions", "termination_state", "terminate_sessions"):
        op.drop_column("source_blocks", name)
