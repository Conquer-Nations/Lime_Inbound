"""scan: add imei column for scooter IMEI capture

Revision ID: f1a2b3c4d5e6
Revises: e5f6a7b8c9d0
Create Date: 2026-05-21 10:00:00.000000

Adds a nullable `imei` column to `scans`. Required for scooter SKUs at
the application layer; not enforced at the DB level so non-scooter
products can leave it null.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f1a2b3c4d5e6'
down_revision: Union[str, Sequence[str], None] = 'e5f6a7b8c9d0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'scans',
        sa.Column('imei', sa.String(40), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('scans', 'imei')
