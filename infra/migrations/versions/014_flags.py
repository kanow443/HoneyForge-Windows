"""CTF challenges and analyst event flags."""
import sqlalchemy as sa
from alembic import op

revision = "014"
down_revision = "013"
branch_labels = depends_on = None


def upgrade():
    op.create_table("event_flags",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("event_id", sa.String(36), sa.ForeignKey("events.id", ondelete="CASCADE"), nullable=False),
        sa.Column("flag", sa.String(30), nullable=False),
        sa.Column("note", sa.String(500), nullable=False),
        sa.Column("created_by", sa.String(100), nullable=False),
        sa.UniqueConstraint("event_id", "flag", name="uq_event_flag"))
    op.create_index("ix_event_flags_event_id", "event_flags", ["event_id"])
    op.create_table("flag_challenges",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("binding_id", sa.String(36), sa.ForeignKey("honeytoken_bindings.id"), nullable=False, unique=True),
        sa.Column("title", sa.String(100), nullable=False),
        sa.Column("points", sa.Integer(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("created_by", sa.String(100), nullable=False))
    op.create_table("flag_solves",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("challenge_id", sa.String(36), sa.ForeignKey("flag_challenges.id"), nullable=False),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("points", sa.Integer(), nullable=False),
        sa.UniqueConstraint("challenge_id", "user_id", name="uq_flag_solve"))
    op.create_index("ix_flag_solves_challenge_id", "flag_solves", ["challenge_id"])
    op.create_index("ix_flag_solves_user_id", "flag_solves", ["user_id"])


def downgrade():
    op.drop_table("flag_solves")
    op.drop_table("flag_challenges")
    op.drop_table("event_flags")
