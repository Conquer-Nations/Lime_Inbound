"""outbound_containers: scheduled_arrival_at

Revision ID: c2d3e4f5a8b9
Revises: b1c2d3e4f5a8
Create Date: 2026-05-22 22:00:00.000000

Outbound doesn't use BIC container numbers — vendors ship via trucks
and tell us when the driver will arrive at our dock. This adds a
nullable timestamp column to capture that scheduled arrival, populated
from the driver info sheet OCR or manual entry on the Driver & truck
info form.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c2d3e4f5a8b9'
down_revision: Union[str, Sequence[str], None] = 'b1c2d3e4f5a8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'outbound_containers',
        sa.Column(
            'scheduled_arrival_at',
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column('outbound_containers', 'scheduled_arrival_at')
