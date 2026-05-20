"""scan: add serial_number + row_notes for sheet-style scan capture

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-05-19 17:00:00.000000

Adds two columns to `scans` so the operator scan-sheet flow can persist
serial numbers (per-receipt unique) and free-text notes. Both nullable
so every existing scan row stays valid.

A partial unique index on (receipt_id, serial_number) where serial is
NOT NULL gives us the template's "no duplicate serial per container"
guarantee at the DB level. Old scans (serial_number NULL) are ignored.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd4e5f6a7b8c9'
down_revision: Union[str, Sequence[str], None] = 'c3d4e5f6a7b8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'scans',
        sa.Column('serial_number', sa.String(120), nullable=True),
    )
    op.add_column(
        'scans',
        sa.Column('row_notes', sa.Text(), nullable=True),
    )
    # Partial unique index — only enforced when serial_number is set.
    # Existing rows (serial_number IS NULL) are unaffected.
    op.create_index(
        'uq_scans_receipt_serial',
        'scans',
        ['receipt_id', 'serial_number'],
        unique=True,
        postgresql_where=sa.text('serial_number IS NOT NULL'),
    )
    # Plain index on serial for cross-receipt lookups in audit queries.
    op.create_index(
        'ix_scans_serial_number',
        'scans',
        ['serial_number'],
        postgresql_where=sa.text('serial_number IS NOT NULL'),
    )


def downgrade() -> None:
    op.drop_index('ix_scans_serial_number', table_name='scans')
    op.drop_index('uq_scans_receipt_serial', table_name='scans')
    op.drop_column('scans', 'row_notes')
    op.drop_column('scans', 'serial_number')
