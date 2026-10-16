"""Atomic multi-service groups, preserving every existing deployment and version."""
import sqlalchemy as sa
from alembic import op

revision = '013'
down_revision = '012'
branch_labels = depends_on = None


def upgrade():
    op.add_column('honeytokens', sa.Column('service_key', sa.String(24)))
    op.create_table('deployment_groups',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('host_id', sa.String(36), sa.ForeignKey('hosts.id'), nullable=False),
        sa.Column('profile_version_id', sa.String(36), sa.ForeignKey('profile_versions.id'), nullable=False),
        sa.Column('idempotency_key', sa.String(100), nullable=False, unique=True),
        sa.Column('request_hash', sa.String(64), nullable=False))
    op.create_index('ix_deployment_groups_host_id', 'deployment_groups', ['host_id'])
    op.add_column('deployments', sa.Column('group_id', sa.String(36), sa.ForeignKey('deployment_groups.id')))
    op.add_column('deployments', sa.Column('service_key', sa.String(24)))
    op.create_index('ix_deployments_group_id', 'deployments', ['group_id'])
    op.create_unique_constraint('uq_deployments_group_service', 'deployments', ['group_id', 'service_key'])


def downgrade():
    op.drop_column('honeytokens', 'service_key')
    op.drop_constraint('uq_deployments_group_service', 'deployments', type_='unique')
    op.drop_index('ix_deployments_group_id', 'deployments')
    op.drop_column('deployments', 'service_key')
    op.drop_column('deployments', 'group_id')
    op.drop_table('deployment_groups')
