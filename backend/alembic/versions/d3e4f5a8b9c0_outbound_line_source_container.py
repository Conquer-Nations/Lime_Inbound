"""outbound_lines: source_container_no

Revision ID: d3e4f5a8b9c0
Revises: c2d3e4f5a8b9
Create Date: 2026-05-22 23:00:00.000000

Vendors now pick which inbound container each outbound line draws from.
Stored as a free-text string (not an FK) — outbound is decoupled from
the physical Container row so amendments/wipes don't cascade.

Used to compute per-container pending totals:
    pending = inbound_qty - outbound_qty
where inbound_qty comes from container_lines.qty and outbound_qty is
the sum of order_qty across outbound_lines that pick from this
container.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd3e4f5a8b9c0'
down_revision: Union[str, Sequence[str], None] = 'c2d3e4f5a8b9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'outbound_lines',
        sa.Column('source_container_no', sa.String(length=40), nullable=True),
    )
    op.create_index(
        'ix_outbound_lines_source_container_no',
        'outbound_lines',
        ['source_container_no'],
    )


def downgrade() -> None:
    op.drop_index('ix_outbound_lines_source_container_no', table_name='outbound_lines')
    op.drop_column('outbound_lines', 'source_container_no')
