"""outbound: orders, lines, line_serials, containers, scans

Revision ID: a1b2c3d4e5f7
Revises: f1a2b3c4d5e6
Create Date: 2026-05-21 16:00:00.000000

Phase 2 — outbound shipment flow. Five new tables, all additive — no
changes to inbound tables. Inventory at any point in time is computed
as `scans` (inbound) minus `outbound_scans`, joined on serial_number /
inbound_scan_id.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB  # noqa: F401  (kept for parity)


revision: str = 'a1b2c3d4e5f7'
down_revision: Union[str, Sequence[str], None] = 'f1a2b3c4d5e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'outbound_orders',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('transfer_order_no', sa.String(80), nullable=False, unique=True),
        sa.Column('customer_id', sa.Integer(), sa.ForeignKey('customers.id'), nullable=False),
        sa.Column('order_date', sa.Date(), nullable=True),
        sa.Column('priority', sa.String(32), nullable=False, server_default='normal'),
        sa.Column('memo', sa.Text(), nullable=True),
        sa.Column('ship_from_name', sa.String(120), nullable=True),
        sa.Column('ship_from_address', sa.Text(), nullable=True),
        sa.Column('ship_to_name', sa.String(255), nullable=True),
        sa.Column('ship_to_address', sa.Text(), nullable=True),
        sa.Column('status', sa.String(32), nullable=False, server_default='open'),
        sa.Column(
            'submitted_at',
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text('now()'),
        ),
        sa.Column('submitted_by', sa.String(255), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
    )
    op.create_index(
        'ix_outbound_orders_customer_id', 'outbound_orders', ['customer_id']
    )
    op.create_index('ix_outbound_orders_status', 'outbound_orders', ['status'])

    op.create_table(
        'outbound_lines',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column(
            'outbound_order_id',
            sa.Integer(),
            sa.ForeignKey('outbound_orders.id'),
            nullable=False,
        ),
        sa.Column('line_no', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('sku_id', sa.Integer(), sa.ForeignKey('skus.id'), nullable=True),
        sa.Column('sku_raw', sa.String(120), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('order_qty', sa.Integer(), nullable=False),
        sa.Column('unit', sa.String(16), nullable=False, server_default='EA'),
        sa.Column('serial_specific', sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index(
        'ix_outbound_lines_order_id', 'outbound_lines', ['outbound_order_id']
    )
    op.create_index('ix_outbound_lines_sku_id', 'outbound_lines', ['sku_id'])

    op.create_table(
        'outbound_line_serials',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column(
            'outbound_line_id',
            sa.Integer(),
            sa.ForeignKey('outbound_lines.id'),
            nullable=False,
        ),
        sa.Column('serial_number', sa.String(120), nullable=False),
        sa.Column('status', sa.String(16), nullable=False, server_default='requested'),
        sa.UniqueConstraint(
            'outbound_line_id', 'serial_number', name='uq_outbound_line_serial'
        ),
    )
    op.create_index(
        'ix_outbound_line_serials_line_id',
        'outbound_line_serials',
        ['outbound_line_id'],
    )
    op.create_index(
        'ix_outbound_line_serials_serial',
        'outbound_line_serials',
        ['serial_number'],
    )

    op.create_table(
        'outbound_containers',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column(
            'outbound_order_id',
            sa.Integer(),
            sa.ForeignKey('outbound_orders.id'),
            nullable=False,
        ),
        sa.Column('container_no', sa.String(40), nullable=False, unique=True),
        sa.Column('container_type', sa.String(16), nullable=False, server_default='bic'),
        sa.Column('status', sa.String(32), nullable=False, server_default='open'),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('started_by', sa.String(80), nullable=True),
        sa.Column('sealed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('sealed_by', sa.String(80), nullable=True),
        sa.Column('driver_name', sa.String(120), nullable=True),
        sa.Column('driver_license', sa.String(60), nullable=True),
        sa.Column('driver_phone', sa.String(40), nullable=True),
        sa.Column('truck_license_plate', sa.String(20), nullable=True),
        sa.Column('insurance', sa.Text(), nullable=True),
        sa.Column('carrier', sa.String(120), nullable=True),
        sa.Column('bol_number', sa.String(80), nullable=True),
    )
    op.create_index(
        'ix_outbound_containers_order_id', 'outbound_containers', ['outbound_order_id']
    )
    op.create_index(
        'ix_outbound_containers_status', 'outbound_containers', ['status']
    )

    op.create_table(
        'outbound_scans',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column(
            'outbound_container_id',
            sa.Integer(),
            sa.ForeignKey('outbound_containers.id'),
            nullable=False,
        ),
        sa.Column(
            'outbound_line_id',
            sa.Integer(),
            sa.ForeignKey('outbound_lines.id'),
            nullable=True,
        ),
        sa.Column(
            'inbound_scan_id', sa.Integer(), sa.ForeignKey('scans.id'), nullable=True
        ),
        sa.Column('sku_id', sa.Integer(), sa.ForeignKey('skus.id'), nullable=True),
        sa.Column('serial_number', sa.String(120), nullable=False),
        sa.Column('imei', sa.String(40), nullable=True),
        sa.Column('picked_location', sa.String(120), nullable=True),
        sa.Column(
            'scanned_at',
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text('now()'),
        ),
        sa.Column('scanned_by', sa.String(80), nullable=False),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.UniqueConstraint(
            'outbound_container_id',
            'serial_number',
            name='uq_outbound_container_serial',
        ),
        sa.UniqueConstraint('inbound_scan_id', name='uq_outbound_scan_per_inbound'),
    )
    op.create_index(
        'ix_outbound_scans_container_id',
        'outbound_scans',
        ['outbound_container_id'],
    )
    op.create_index(
        'ix_outbound_scans_line_id', 'outbound_scans', ['outbound_line_id']
    )
    op.create_index(
        'ix_outbound_scans_serial', 'outbound_scans', ['serial_number']
    )


def downgrade() -> None:
    op.drop_index('ix_outbound_scans_serial', table_name='outbound_scans')
    op.drop_index('ix_outbound_scans_line_id', table_name='outbound_scans')
    op.drop_index('ix_outbound_scans_container_id', table_name='outbound_scans')
    op.drop_table('outbound_scans')
    op.drop_index('ix_outbound_containers_status', table_name='outbound_containers')
    op.drop_index('ix_outbound_containers_order_id', table_name='outbound_containers')
    op.drop_table('outbound_containers')
    op.drop_index(
        'ix_outbound_line_serials_serial', table_name='outbound_line_serials'
    )
    op.drop_index(
        'ix_outbound_line_serials_line_id', table_name='outbound_line_serials'
    )
    op.drop_table('outbound_line_serials')
    op.drop_index('ix_outbound_lines_sku_id', table_name='outbound_lines')
    op.drop_index('ix_outbound_lines_order_id', table_name='outbound_lines')
    op.drop_table('outbound_lines')
    op.drop_index('ix_outbound_orders_status', table_name='outbound_orders')
    op.drop_index('ix_outbound_orders_customer_id', table_name='outbound_orders')
    op.drop_table('outbound_orders')
