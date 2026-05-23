"""accounts table + customers.account_id FK

Revision ID: b7c8d9e0f1a2
Revises: a6b7c8d9e0f1
Create Date: 2026-05-23 15:00:00.000000

Two-level hierarchy:
  Account (we bill them, e.g. TQL)
    └─ Customer (their brand whose products we warehouse, e.g. Lime)

Existing Customer rows survive untouched — account_id is nullable so
direct-bill customers (no broker / aggregator above them) still fit
the schema.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b7c8d9e0f1a2'
down_revision: Union[str, Sequence[str], None] = 'a6b7c8d9e0f1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'accounts',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('billing_email', sa.String(length=255), nullable=True),
        sa.Column('billing_address', sa.Text(), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index('ix_accounts_name', 'accounts', ['name'], unique=True)

    op.add_column(
        'customers',
        sa.Column('account_id', sa.Integer(), nullable=True),
    )
    op.create_index(
        'ix_customers_account_id',
        'customers',
        ['account_id'],
    )
    op.create_foreign_key(
        'fk_customers_account_id',
        'customers',
        'accounts',
        ['account_id'],
        ['id'],
    )


def downgrade() -> None:
    op.drop_constraint('fk_customers_account_id', 'customers', type_='foreignkey')
    op.drop_index('ix_customers_account_id', table_name='customers')
    op.drop_column('customers', 'account_id')
    op.drop_index('ix_accounts_name', table_name='accounts')
    op.drop_table('accounts')
