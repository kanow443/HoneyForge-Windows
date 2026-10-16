"""Durable playback cursors, source policies and investigation cases."""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "003"
down_revision = "002"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("events", sa.Column("ingest_position", sa.BigInteger(), nullable=True))
    op.execute("""UPDATE events e SET ingest_position=s.position FROM event_stream s
        WHERE s.kind='event.created' AND s.data->>'id'=e.id""")
    # Preserve orphaned legacy data without assigning a cursor beyond the stream watermark.
    op.execute("""WITH missing AS (SELECT id, (SELECT position FROM stream_state WHERE id=1)
        + row_number() OVER (ORDER BY created_at,id) AS position FROM events WHERE ingest_position IS NULL)
        UPDATE events e SET ingest_position=m.position FROM missing m WHERE e.id=m.id""")
    op.execute("""INSERT INTO event_stream(position,kind,data,created_at)
        SELECT ingest_position,'event.created',jsonb_build_object('id',id,'deployment_id',deployment_id,'session_id',session_id,'event_type',event_type),created_at
        FROM events WHERE ingest_position > (SELECT position FROM stream_state WHERE id=1)""")
    op.execute("UPDATE stream_state SET position=GREATEST(position, COALESCE((SELECT max(ingest_position) FROM events),0)) WHERE id=1")
    op.alter_column("events", "ingest_position", nullable=False)
    op.create_unique_constraint("uq_events_ingest_position", "events", ["ingest_position"])
    op.create_table("source_blocks",
        sa.Column("id", sa.String(36), primary_key=True), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deployment_id", sa.String(36), sa.ForeignKey("deployments.id"), nullable=False),
        sa.Column("host_id", sa.String(36), sa.ForeignKey("hosts.id"), nullable=False),
        sa.Column("generation", sa.String(36), nullable=False), sa.Column("source_ip", sa.String(45), nullable=False),
        sa.Column("reason", sa.String(500), nullable=False), sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("desired_state", sa.String(20), nullable=False), sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("observed_revision", sa.Integer(), nullable=False), sa.Column("observed_state", sa.String(20), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True)), sa.Column("error", sa.String(500)),
        sa.Column("created_by", sa.String(100), nullable=False), sa.Column("idempotency_key", sa.String(100), nullable=False, unique=True),
        sa.Column("request_hash", sa.String(64), nullable=False))
    op.create_index("ix_source_blocks_deployment_id", "source_blocks", ["deployment_id"])
    op.create_index("ix_source_blocks_host_id", "source_blocks", ["host_id"])
    op.create_table("investigation_cases",
        sa.Column("id", sa.String(36), primary_key=True), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("title", sa.String(120), nullable=False), sa.Column("session_ids", JSONB(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False), sa.Column("status", sa.String(20), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False), sa.Column("created_by", sa.String(100), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False))


def downgrade():
    op.drop_table("investigation_cases")
    op.drop_table("source_blocks")
    op.drop_constraint("uq_events_ingest_position", "events", type_="unique")
    op.drop_column("events", "ingest_position")
