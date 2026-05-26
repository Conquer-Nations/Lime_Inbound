"""invoice: vendor self-pay flow — payment_submitted status + ref fields

Revision ID: j6f7g8h9i0j1
Revises: i5e6f7g8h9i0
Create Date: 2026-05-26 12:00:00.000000

Adds three columns on `invoices` to support the vendor-initiated payment
workflow:

  vendor_payment_reference  — string captured from the vendor (check #,
                              ACH ref, wire ref, Zelle conf). Optional.
  vendor_marked_paid_at     — when the vendor clicked "Mark as paid" in
                              the vendor portal.
  vendor_marked_paid_by     — vendor user email, for the audit trail.

Status lifecycle extends:
    draft → sent → payment_submitted → paid → void
                  └ vendor self-mark    └ manager verifies

`status` is a plain VARCHAR(20) so no enum migration is needed — just
new values flow through.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'j6f7g8h9i0j1'
down_revision: Union[str, None] = 'i5e6f7g8h9i0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'invoices',
        sa.Column('vendor_payment_reference', sa.String(120), nullable=True),
    )
    op.add_column(
        'invoices',
        sa.Column(
            'vendor_marked_paid_at', sa.DateTime(timezone=True), nullable=True
        ),
    )
    op.add_column(
        'invoices',
        sa.Column('vendor_marked_paid_by', sa.String(255), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('invoices', 'vendor_marked_paid_by')
    op.drop_column('invoices', 'vendor_marked_paid_at')
    op.drop_column('invoices', 'vendor_payment_reference')
