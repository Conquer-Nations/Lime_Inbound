"""outbound_orders: po_number (internal Pickup Order)

Revision ID: b1c2d3e4f5a8
Revises: a1b2c3d4e5f7
Create Date: 2026-05-22 18:00:00.000000

Mirrors the WHPO → DO relationship from inbound:
  - `transfer_order_no` is the vendor's own ID (e.g. TO21787) — billing ref.
  - `po_number` is the internal Pickup Order we auto-issue per TO,
    formatted PO-YYYY-NNNN. Sequential per year.

Nullable for the duration of the backfill — the routers populate it on
every new submit. Existing pre-PO orders can be backfilled later if
needed.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b1c2d3e4f5a8'
down_revision: Union[str, Sequence[str], None] = 'a1b2c3d4e5f7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'outbound_orders',
        sa.Column('po_number', sa.String(length=20), nullable=True),
    )
    op.create_index(
        'ix_outbound_orders_po_number',
        'outbound_orders',
        ['po_number'],
        unique=True,
        postgresql_where=sa.text('po_number IS NOT NULL'),
    )


def downgrade() -> None:
    op.drop_index('ix_outbound_orders_po_number', table_name='outbound_orders')
    op.drop_column('outbound_orders', 'po_number')
