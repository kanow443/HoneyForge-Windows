import sqlalchemy as sa
from alembic import op

revision = '012'
down_revision = '011'
branch_labels = depends_on = None


def base():
    return [sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False)]


def upgrade():
    op.create_table('honeytokens', *base(),
        sa.Column('profile_id', sa.String(36), sa.ForeignKey('profiles.id', ondelete='CASCADE'), nullable=False),
        sa.Column('profile_version_id', sa.String(36), sa.ForeignKey('profile_versions.id', ondelete='CASCADE'), nullable=False),
        sa.Column('name', sa.String(100), nullable=False), sa.Column('kind', sa.String(10), nullable=False),
        sa.Column('file_path', sa.String(240)), sa.Column('created_by', sa.String(100), nullable=False),
        sa.Column('revoked_at', sa.DateTime(timezone=True)))
    op.create_index('ix_honeytokens_profile_id', 'honeytokens', ['profile_id'])
    op.create_index('ix_honeytokens_profile_version_id', 'honeytokens', ['profile_version_id'])
    op.create_table('honeytoken_bindings', *base(),
        sa.Column('token_id', sa.String(36), sa.ForeignKey('honeytokens.id', ondelete='CASCADE'), nullable=False),
        sa.Column('deployment_id', sa.String(36), sa.ForeignKey('deployments.id'), nullable=False),
        sa.Column('generation', sa.String(36), sa.ForeignKey('deployment_runs.id'), nullable=False),
        sa.Column('public_value', sa.String(48), nullable=False, unique=True),
        sa.Column('resource_path', sa.String(240), nullable=False), sa.UniqueConstraint('token_id', 'generation'))
    op.create_table('honeytoken_uses', *base(),
        sa.Column('event_id', sa.String(36), sa.ForeignKey('events.id', ondelete='CASCADE'), nullable=False),
        sa.Column('binding_id', sa.String(36), sa.ForeignKey('honeytoken_bindings.id', ondelete='CASCADE'), nullable=False),
        sa.Column('observed_at', sa.DateTime(timezone=True), nullable=False), sa.UniqueConstraint('event_id', 'binding_id'))
    op.create_table('detection_policy', sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('revision', sa.Integer(), nullable=False), sa.Column('failed_logins', sa.Integer(), nullable=False),
        sa.Column('window_seconds', sa.Integer(), nullable=False), sa.Column('enabled', sa.Boolean(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False))
    op.execute('INSERT INTO detection_policy VALUES (1,1,5,60,true,NOW())')
    op.add_column('findings', sa.Column('observed_first_at', sa.DateTime(timezone=True)))
    op.add_column('findings', sa.Column('observed_last_at', sa.DateTime(timezone=True)))
    op.add_column('findings', sa.Column('notification_state', sa.String(20), nullable=False, server_default='none'))
    op.create_index('ix_event_observation_detection', 'events', ['deployment_id', 'event_type', 'source_ip', 'observed_at'])
    op.create_table('agent_certificates', *base(),
        sa.Column('host_id', sa.String(36), sa.ForeignKey('hosts.id'), nullable=False),
        sa.Column('public_key_hash', sa.String(64), nullable=False),
        sa.Column('fingerprint', sa.String(64), nullable=False, unique=True),
        sa.Column('certificate_pem', sa.Text(), nullable=False), sa.Column('serial', sa.String(100), nullable=False),
        sa.Column('state', sa.String(20), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('accept_until', sa.DateTime(timezone=True), nullable=False),
        sa.Column('confirmed_at', sa.DateTime(timezone=True)), sa.Column('revoked_at', sa.DateTime(timezone=True)),
        sa.UniqueConstraint('host_id', 'public_key_hash'))
    op.create_index('ix_agent_certificates_host_id', 'agent_certificates', ['host_id'])


def downgrade():
    op.drop_table('agent_certificates')
    op.drop_index('ix_event_observation_detection', 'events')
    for name in ['notification_state', 'observed_last_at', 'observed_first_at']:
        op.drop_column('findings', name)
    op.drop_table('detection_policy')
    op.drop_table('honeytoken_uses')
    op.drop_table('honeytoken_bindings')
    op.drop_table('honeytokens')
