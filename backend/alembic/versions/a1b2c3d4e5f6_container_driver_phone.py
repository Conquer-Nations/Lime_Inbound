"""container driver phone field

Revision ID: a1b2c3d4e5f6
Revises: 7652edc5569f
Create Date: 2026-05-18 12:00:00.000000

Adds a `driver_phone` column to `containers` so vendors can submit a contact
number when patching driver/truck info.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = '7652edc5569f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'containers',
        sa.Column('driver_phone', sa.String(length=40), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('containers', 'driver_phone')
