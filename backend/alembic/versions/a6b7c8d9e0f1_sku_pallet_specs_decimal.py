"""skus: items_per_pallet → Float, add pallet_sqft

Revision ID: a6b7c8d9e0f1
Revises: f5a8b9c0d1e2
Create Date: 2026-05-23 14:00:00.000000

Two changes to the SKU master so per-SKU pallet specs drive the
receiving space calculator:

1. items_per_pallet: Integer → Double Precision. Vendors give us
   conversion ratios like 1.9655 gliders / pallet — integer can't hold
   that.

2. New pallet_sqft column. When set, the calculator rounds qty up to
   whole pallets and multiplies by pallet_sqft — that's the actual
   warehouse-floor math (you can't put half a pallet down).

DEFAULT_LOT_SQFT (computed value, not a column) is also being changed
in app/services/space.py from 1610 (23×70) to 391 (17×23) to match the
Vernon facility.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a6b7c8d9e0f1'
down_revision: Union[str, Sequence[str], None] = 'f5a8b9c0d1e2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. items_per_pallet INTEGER → DOUBLE PRECISION (preserves data)
    op.alter_column(
        'skus',
        'items_per_pallet',
        existing_type=sa.Integer(),
        type_=sa.Float(),
        existing_nullable=True,
        postgresql_using='items_per_pallet::double precision',
    )
    # 2. new pallet_sqft column
    op.add_column(
        'skus',
        sa.Column('pallet_sqft', sa.Float(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('skus', 'pallet_sqft')
    op.alter_column(
        'skus',
        'items_per_pallet',
        existing_type=sa.Float(),
        type_=sa.Integer(),
        existing_nullable=True,
        postgresql_using='items_per_pallet::integer',
    )
