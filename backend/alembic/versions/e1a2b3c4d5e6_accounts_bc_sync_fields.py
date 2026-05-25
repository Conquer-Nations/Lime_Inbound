"""accounts: bc_customer_no, bc_synced_at, bc_sync_error for BC integration

Revision ID: e1a2b3c4d5e6
Revises: d9e0f1a2b3c4
Create Date: 2026-05-25 20:00:00.000000

First slice of the Dynamics 365 Business Central integration.

Adds three nullable columns to `accounts` so the dual-write to BC can
record sync state per-row without changing existing rows:

  bc_customer_no  — BC Customer.No. assigned by BC on first upsert.
                    Stable across edits; lookup key for subsequent
                    PATCHes.
  bc_synced_at    — timestamp of last successful BC write.
  bc_sync_error   — last error string if the BC call failed; cleared
                    on next success. Manager-portal Accounts table
                    surfaces this so a sync failure isn't silent.

Until BC_CLIENT_ID etc. are set, the bc_client service no-ops and
these columns stay null. Safe to deploy without BC credentials.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e1a2b3c4d5e6'
down_revision: Union[str, Sequence[str], None] = 'd9e0f1a2b3c4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'accounts',
        sa.Column('bc_customer_no', sa.String(length=40), nullable=True),
    )
    op.add_column(
        'accounts',
        sa.Column('bc_synced_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        'accounts',
        sa.Column('bc_sync_error', sa.Text(), nullable=True),
    )
    op.create_index(
        'ix_accounts_bc_customer_no',
        'accounts',
        ['bc_customer_no'],
    )


def downgrade() -> None:
    op.drop_index('ix_accounts_bc_customer_no', table_name='accounts')
    op.drop_column('accounts', 'bc_sync_error')
    op.drop_column('accounts', 'bc_synced_at')
    op.drop_column('accounts', 'bc_customer_no')
