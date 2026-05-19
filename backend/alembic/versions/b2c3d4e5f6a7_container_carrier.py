"""container carrier field

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-05-18 13:00:00.000000

Adds a `carrier` column to `containers` so vendors can submit the distributor
/ transport company name (e.g., "2Fast Transportation") alongside driver info.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b2c3d4e5f6a7'
down_revision: Union[str, Sequence[str], None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'containers',
        sa.Column('carrier', sa.String(length=120), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('containers', 'carrier')
