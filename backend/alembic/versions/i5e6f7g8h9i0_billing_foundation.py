"""billing foundation: rate_card + invoices + invoice_lines + customer profile JSON

Revision ID: i5e6f7g8h9i0
Revises: h4d5e6f7g8h9
Create Date: 2026-05-26 06:00:00.000000

First chunk of the merged billing system (ported from the standalone
CN-BILLING Electron + Express app):

  rate_card        — 100+ charge codes across 11 categories
                     (Handling, Order Processing, Picking, Putaway,
                      Storage, BOL/Shipping, Accessorial, IT, MDS,
                      Labor, Drayage). Seeded on first deploy.

  invoices         — one per WHPO (inbound) OR per Transfer Order
                     (outbound). status lifecycle:
                       draft → ready → sent → paid → void
                     Snapshots subtotal / fuel / advancing / operational
                     charge / tax / total + the customer-facing and
                     service-log PDF storage paths.

  invoice_lines    — charge line items, auto + manual. Each links to a
                     rate_card code; auto-applied flag marks system-
                     generated charges (container minimum, picking,
                     etc.); override_reason captures manual rate edits.

  customers.profile_json — rich customer profile (Company, Storage,
                     Inbound, Outbound, Special Services, Drayage,
                     Agreement) stored as JSONB. UI editor lands in
                     Phase 2; column added now so seed/import data has
                     a home.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'i5e6f7g8h9i0'
down_revision: Union[str, Sequence[str], None] = 'h4d5e6f7g8h9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── rate_card ─────────────────────────────────────────────────────
    op.create_table(
        'rate_card',
        sa.Column('code', sa.String(length=20), primary_key=True),
        sa.Column('category', sa.String(length=40), nullable=False),
        sa.Column('description', sa.Text(), nullable=False),
        sa.Column('unit', sa.String(length=80), nullable=False),
        # rate is nullable for "enter manually at line time" codes
        # (drayage base, custom fees, vendor advance, etc.).
        sa.Column('rate', sa.Float(), nullable=True),
        sa.Column('taxable', sa.Boolean(), server_default=sa.text('false'), nullable=False),
        sa.Column('is_minimum', sa.Boolean(), server_default=sa.text('false'), nullable=False),
        sa.Column('is_advance', sa.Boolean(), server_default=sa.text('false'), nullable=False),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('max_per_request', sa.Float(), nullable=True),
        sa.Column('min_advance', sa.Float(), nullable=True),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index('ix_rate_card_category', 'rate_card', ['category'])

    # ── invoices ──────────────────────────────────────────────────────
    op.create_table(
        'invoices',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('invoice_number', sa.String(length=40), nullable=False, unique=True),
        sa.Column('customer_id', sa.Integer(), nullable=False),
        # One of whpo_id / outbound_order_id is non-null (mutex enforced via CHECK).
        sa.Column('whpo_id', sa.Integer(), nullable=True),
        sa.Column('outbound_order_id', sa.Integer(), nullable=True),
        sa.Column(
            'status',
            sa.String(length=20),
            server_default='draft',
            nullable=False,
        ),
        sa.Column('invoice_date', sa.Date(), nullable=False, server_default=sa.func.current_date()),
        sa.Column('due_date', sa.Date(), nullable=True),
        sa.Column('terms', sa.String(length=20), server_default='Net 30', nullable=False),
        sa.Column('subtotal', sa.Float(), server_default='0', nullable=False),
        sa.Column('fuel_surcharge', sa.Float(), server_default='0', nullable=False),
        sa.Column('advancing', sa.Float(), server_default='0', nullable=False),
        sa.Column('adjustment', sa.Float(), server_default='0', nullable=False),
        sa.Column('adjustment_note', sa.Text(), nullable=True),
        sa.Column('operational_charge', sa.Float(), server_default='0', nullable=False),
        sa.Column('operational_charge_breakdown', postgresql.JSONB(), nullable=True),
        sa.Column('tax', sa.Float(), server_default='0', nullable=False),
        sa.Column('total', sa.Float(), nullable=False),
        sa.Column('customer_pdf_storage_path', sa.String(length=500), nullable=True),
        sa.Column('service_log_pdf_storage_path', sa.String(length=500), nullable=True),
        sa.Column('generated_by', sa.String(length=255), nullable=True),
        sa.Column(
            'generated_at',
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('paid_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('payment_method', sa.String(length=40), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(['customer_id'], ['customers.id']),
        sa.ForeignKeyConstraint(['whpo_id'], ['whpos.id']),
        sa.ForeignKeyConstraint(['outbound_order_id'], ['outbound_orders.id']),
        sa.CheckConstraint(
            "(whpo_id IS NOT NULL AND outbound_order_id IS NULL) "
            "OR (whpo_id IS NULL AND outbound_order_id IS NOT NULL)",
            name='invoice_scope_xor',
        ),
    )
    op.create_index('ix_invoices_customer', 'invoices', ['customer_id'])
    op.create_index('ix_invoices_whpo', 'invoices', ['whpo_id'])
    op.create_index('ix_invoices_outbound_order', 'invoices', ['outbound_order_id'])
    op.create_index('ix_invoices_status', 'invoices', ['status'])

    # ── invoice_lines ─────────────────────────────────────────────────
    op.create_table(
        'invoice_lines',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('invoice_id', sa.Integer(), nullable=False),
        sa.Column('code', sa.String(length=20), nullable=False),
        sa.Column('category', sa.String(length=40), nullable=False),
        sa.Column('description', sa.Text(), nullable=False),
        sa.Column('unit', sa.String(length=80), nullable=False),
        sa.Column('quantity', sa.Float(), nullable=False),
        sa.Column('unit_rate', sa.Float(), nullable=False),
        sa.Column('line_total', sa.Float(), nullable=False),
        sa.Column('taxable', sa.Boolean(), server_default=sa.text('false'), nullable=False),
        sa.Column('auto_applied', sa.Boolean(), server_default=sa.text('false'), nullable=False),
        sa.Column('override_reason', sa.Text(), nullable=True),
        # Lets us trace storage / picking lines back to the container they came
        # from when the manager wants to verify.
        sa.Column('source_container_id', sa.Integer(), nullable=True),
        sa.Column('source_outbound_container_id', sa.Integer(), nullable=True),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(['invoice_id'], ['invoices.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['source_container_id'], ['containers.id']),
        sa.ForeignKeyConstraint(['source_outbound_container_id'], ['outbound_containers.id']),
    )
    op.create_index('ix_invoice_lines_invoice', 'invoice_lines', ['invoice_id'])
    op.create_index('ix_invoice_lines_category', 'invoice_lines', ['category'])

    # ── invoice number sequence ───────────────────────────────────────
    # Format: CN-YYYYMMDD-#### (global counter, doesn't reset).
    op.execute("CREATE SEQUENCE invoice_number_seq START 1000")

    # ── customers.profile_json ───────────────────────────────────────
    # Rich customer profile (7 sections from CN-BILLING).
    op.add_column(
        'customers',
        sa.Column('profile_json', postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('customers', 'profile_json')
    op.execute("DROP SEQUENCE IF EXISTS invoice_number_seq")
    op.drop_index('ix_invoice_lines_category', table_name='invoice_lines')
    op.drop_index('ix_invoice_lines_invoice', table_name='invoice_lines')
    op.drop_table('invoice_lines')
    op.drop_index('ix_invoices_status', table_name='invoices')
    op.drop_index('ix_invoices_outbound_order', table_name='invoices')
    op.drop_index('ix_invoices_whpo', table_name='invoices')
    op.drop_index('ix_invoices_customer', table_name='invoices')
    op.drop_table('invoices')
    op.drop_index('ix_rate_card_category', table_name='rate_card')
    op.drop_table('rate_card')
