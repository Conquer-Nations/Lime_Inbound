"""tally_sheets: add tally_pdf_storage_path column

Revision ID: f2b3c4d5e6f7
Revises: e1a2b3c4d5e6
Create Date: 2026-05-26 02:00:00.000000

Stores the relative path of the auto-generated tally-sheet PDF, written
to disk every time a POD is uploaded (or the row is corrected via
PATCH). Nullable — older rows have no PDF until regenerated.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f2b3c4d5e6f7'
down_revision: Union[str, Sequence[str], None] = 'e1a2b3c4d5e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'tally_sheets',
        sa.Column('tally_pdf_storage_path', sa.String(length=500), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('tally_sheets', 'tally_pdf_storage_path')
