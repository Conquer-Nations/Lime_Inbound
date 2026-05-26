"""outbound_orders: bol + packing_list file refs

Revision ID: g3c4d5e6f7g8
Revises: f2b3c4d5e6f7
Create Date: 2026-05-26 03:00:00.000000

Vendor uploads a BOL and a packing list per outbound order. Stored on
disk via vendor_uploads, with the row carrying filename + storage path.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'g3c4d5e6f7g8'
down_revision: Union[str, Sequence[str], None] = 'f2b3c4d5e6f7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('outbound_orders', sa.Column('bol_filename', sa.String(length=255), nullable=True))
    op.add_column('outbound_orders', sa.Column('bol_storage_path', sa.String(length=500), nullable=True))
    op.add_column('outbound_orders', sa.Column('bol_content_type', sa.String(length=120), nullable=True))
    op.add_column('outbound_orders', sa.Column('packing_list_filename', sa.String(length=255), nullable=True))
    op.add_column('outbound_orders', sa.Column('packing_list_storage_path', sa.String(length=500), nullable=True))
    op.add_column('outbound_orders', sa.Column('packing_list_content_type', sa.String(length=120), nullable=True))


def downgrade() -> None:
    for c in (
        'packing_list_content_type',
        'packing_list_storage_path',
        'packing_list_filename',
        'bol_content_type',
        'bol_storage_path',
        'bol_filename',
    ):
        op.drop_column('outbound_orders', c)
