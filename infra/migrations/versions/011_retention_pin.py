import sqlalchemy as sa
from alembic import op

revision = "011"
down_revision = "010"
branch_labels = depends_on = None


def upgrade():
    op.add_column("investigation_cases", sa.Column("retention_pinned", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade():
    op.drop_column("investigation_cases", "retention_pinned")
