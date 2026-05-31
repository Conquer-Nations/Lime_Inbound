"""scans.container_line_id — per-LPN attribution for mixed-container scan sheets

Revision ID: n0j1k2l3m4n5
Revises: m9i0j1k2l3m4
Create Date: 2026-05-30 19:00:00.000000

A "mixed container" is one Container with several ContainerLine rows (one per
LPN, each with its own vendor quantity). The inbound scan sheet historically
stamped every scanned row with the FIRST line's SKU and had no per-LPN
progress, so operators worked around it by treating each LPN as its own sheet.

This column links each inbound Scan to the ContainerLine (LPN) it belongs to —
the inbound analog of OutboundScan.outbound_line_id. With it, a mixed container
is scanned in ONE sheet: the operator picks the active LPN, scans fill that
line until its quantity is met, then the sheet advances to the next LPN.

Nullable + no backfill: existing scans (and any non-sheet scans) keep
container_line_id = NULL and render via the legacy first-line fallback.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'n0j1k2l3m4n5'
down_revision: Union[str, Sequence[str], None] = 'm9i0j1k2l3m4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'scans',
        sa.Column('container_line_id', sa.Integer(), nullable=True),
    )
    op.create_index(
        'ix_scans_container_line_id', 'scans', ['container_line_id']
    )
    op.create_foreign_key(
        'fk_scans_container_line_id',
        'scans',
        'container_lines',
        ['container_line_id'],
        ['id'],
    )


def downgrade() -> None:
    op.drop_constraint('fk_scans_container_line_id', 'scans', type_='foreignkey')
    op.drop_index('ix_scans_container_line_id', table_name='scans')
    op.drop_column('scans', 'container_line_id')
