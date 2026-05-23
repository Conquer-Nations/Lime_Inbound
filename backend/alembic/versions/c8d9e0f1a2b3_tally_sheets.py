"""tally_sheets table — POD-driven billing audit log

Revision ID: c8d9e0f1a2b3
Revises: b7c8d9e0f1a2
Create Date: 2026-05-23 17:00:00.000000

One row per (container_id) — UNIQUE enforces exactly one tally per
inbound container. Manager/developer uploads the POD photo at arrival;
backend OCRs origin/destination + snapshots driver / truck / carrier
from the existing Container record. Operator's scan-sheet open is
gated on this row existing; vendors read it for shipment-flow tracking.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'c8d9e0f1a2b3'
down_revision: Union[str, Sequence[str], None] = 'b7c8d9e0f1a2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'tally_sheets',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('container_id', sa.Integer(), nullable=False),
        # POD file (stored under settings.uploads_dir like ContainerDocument)
        sa.Column('pod_filename', sa.String(length=255), nullable=False),
        sa.Column('pod_content_type', sa.String(length=120), nullable=False),
        sa.Column('pod_file_size', sa.Integer(), nullable=False),
        sa.Column('pod_storage_path', sa.String(length=500), nullable=False),
        # OCR results — nullable since OCR may fail and the manager can
        # still create the tally manually (so billing isn't blocked).
        sa.Column('ocr_from_location', sa.String(length=500), nullable=True),
        sa.Column('ocr_to_location', sa.String(length=500), nullable=True),
        sa.Column('ocr_extracted_json', postgresql.JSONB(), nullable=True),
        sa.Column('ocr_engine', sa.String(length=32), nullable=True),
        # Snapshot from Container at tally time — audit-grade so later
        # edits to the container don't change historical billing rows.
        sa.Column('matched_container_no', sa.String(length=20), nullable=False),
        sa.Column('matched_driver_name', sa.String(length=200), nullable=True),
        sa.Column('matched_driver_license', sa.String(length=120), nullable=True),
        sa.Column('matched_driver_phone', sa.String(length=40), nullable=True),
        sa.Column('matched_carrier', sa.String(length=200), nullable=True),
        sa.Column('matched_truck_plate', sa.String(length=60), nullable=True),
        # Manager-entered overrides / additions not captured elsewhere.
        sa.Column('manual_seal_no', sa.String(length=120), nullable=True),
        sa.Column('manual_chassis_no', sa.String(length=120), nullable=True),
        # Receipt metadata
        sa.Column(
            'tallied_at',
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column('tallied_by', sa.String(length=255), nullable=False),
        # Billing
        sa.Column(
            'billing_status',
            sa.String(length=20),
            server_default='pending',
            nullable=False,
        ),
        sa.Column('billing_notes', sa.Text(), nullable=True),
        sa.Column(
            'updated_at',
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ['container_id'], ['containers.id'], ondelete='CASCADE'
        ),
        sa.UniqueConstraint('container_id', name='uq_tally_container'),
    )
    op.create_index(
        'ix_tally_sheets_billing_status', 'tally_sheets', ['billing_status']
    )
    op.create_index(
        'ix_tally_sheets_tallied_at', 'tally_sheets', ['tallied_at']
    )


def downgrade() -> None:
    op.drop_index('ix_tally_sheets_tallied_at', table_name='tally_sheets')
    op.drop_index('ix_tally_sheets_billing_status', table_name='tally_sheets')
    op.drop_table('tally_sheets')
