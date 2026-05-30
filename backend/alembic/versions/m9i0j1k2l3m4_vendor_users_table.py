"""vendor_users table — Postgres-backed vendor portal auth

Revision ID: m9i0j1k2l3m4
Revises: l8h9i0j1k2l3
Create Date: 2026-05-30 12:00:00.000000

Vendor portal accounts used to live ONLY in an OneDrive Excel workbook
(fronted by a Logic App running an Office Script). Every login read that
sheet through the Excel Online connector, so login was hostage to the
connector's daily call-volume quota — when it ran out, the portal locked
everyone out.

This table makes Postgres the source of truth. Auth now reads/writes here;
the Excel store is consulted only as a lazy fallback for accounts that
predate the migration, and each such account is copied into this table on
its next successful login (migrated_from_excel = true).

Columns mirror the old sheet: email | full_name | company | password_hash |
registered_at | last_login_at. Email is lowercased + unique.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'm9i0j1k2l3m4'
down_revision: Union[str, Sequence[str], None] = 'l8h9i0j1k2l3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'vendor_users',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('email', sa.String(length=255), nullable=False),
        sa.Column('full_name', sa.String(length=200), nullable=False, server_default=''),
        sa.Column('company', sa.String(length=200), nullable=False, server_default=''),
        sa.Column('password_hash', sa.String(length=255), nullable=False),
        sa.Column(
            'registered_at',
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column('last_login_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            'migrated_from_excel',
            sa.Boolean(),
            server_default=sa.false(),
            nullable=False,
        ),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index('ix_vendor_users_email', 'vendor_users', ['email'], unique=True)


def downgrade() -> None:
    op.drop_index('ix_vendor_users_email', table_name='vendor_users')
    op.drop_table('vendor_users')
