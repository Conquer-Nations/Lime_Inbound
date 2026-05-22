"""receipts: kind + outbound_container_id (outbound scan-sheet routing)

Revision ID: e4f5a8b9c0d1
Revises: d3e4f5a8b9c0
Create Date: 2026-05-23 10:00:00.000000

Operator UI stays the same — they hit /operator/sheet/open with a
container number and we route based on which physical table holds that
container.

  kind = 'inbound'  → Receipt.container_id points at containers.id
                      (existing flow; scans go into the scans table)
  kind = 'outbound' → Receipt.outbound_container_id points at
                      outbound_containers.id (new flow; scans go into
                      outbound_scans, each linked to an inbound Scan
                      by serial number)

The CHECK constraint guarantees exactly one of the two FKs is populated.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e4f5a8b9c0d1'
down_revision: Union[str, Sequence[str], None] = 'd3e4f5a8b9c0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'receipts',
        sa.Column(
            'kind',
            sa.String(length=16),
            nullable=False,
            server_default='inbound',
        ),
    )
    op.add_column(
        'receipts',
        sa.Column(
            'outbound_container_id',
            sa.Integer(),
            sa.ForeignKey('outbound_containers.id'),
            nullable=True,
        ),
    )
    op.create_index(
        'ix_receipts_outbound_container_id',
        'receipts',
        ['outbound_container_id'],
    )
    op.alter_column('receipts', 'container_id', nullable=True)
    op.create_check_constraint(
        'chk_receipt_kind_one_container',
        'receipts',
        "(kind = 'inbound' AND container_id IS NOT NULL AND outbound_container_id IS NULL) "
        "OR (kind = 'outbound' AND container_id IS NULL AND outbound_container_id IS NOT NULL)",
    )


def downgrade() -> None:
    op.drop_constraint('chk_receipt_kind_one_container', 'receipts', type_='check')
    op.alter_column('receipts', 'container_id', nullable=False)
    op.drop_index('ix_receipts_outbound_container_id', table_name='receipts')
    op.drop_column('receipts', 'outbound_container_id')
    op.drop_column('receipts', 'kind')
