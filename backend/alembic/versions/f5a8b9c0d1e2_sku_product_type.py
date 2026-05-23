"""skus: product_type column

Revision ID: f5a8b9c0d1e2
Revises: e4f5a8b9c0d1
Create Date: 2026-05-23 12:00:00.000000

Add a canonical product_type column to the SKU master so the scan-sheet
IMEI / box-number logic can derive category from the master row when the
vendor leaves line.product_type blank. Free-text (the manager UI offers
common picks: Scooters, eBikes, Gliders, Batteries, Helmets, Solar
Panels, Other — but new values are allowed).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f5a8b9c0d1e2'
down_revision: Union[str, Sequence[str], None] = 'e4f5a8b9c0d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'skus',
        sa.Column('product_type', sa.String(length=120), nullable=True),
    )
    op.create_index('ix_skus_product_type', 'skus', ['product_type'])


def downgrade() -> None:
    op.drop_index('ix_skus_product_type', table_name='skus')
    op.drop_column('skus', 'product_type')
