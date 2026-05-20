"""whpo: bol_number

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-05-19 18:00:00.000000

Adds `bol_number` text column to whpos. Vendor enters this on the Update
Shipment screen (alongside a PDF of the BOL doc). The scan-sheet export
pulls this value into the F5 cell of TEMPLATE.xlsx.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e5f6a7b8c9d0'
down_revision: Union[str, Sequence[str], None] = 'd4e5f6a7b8c9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('whpos', sa.Column('bol_number', sa.String(80), nullable=True))


def downgrade() -> None:
    op.drop_column('whpos', 'bol_number')
