"""vw_master_list — auto-computed inbound + outbound mastersheet

Revision ID: d9e0f1a2b3c4
Revises: c8d9e0f1a2b3
Create Date: 2026-05-23 18:00:00.000000

Postgres view that mirrors Lime's manual `Lime-Inventory-Sep 2025.xlsx`
MASTER LIST layout — one row per inbound container reception, one row
per outbound container shipment, joined by container_no in the
application layer. View columns intentionally match the spreadsheet
header naming (with normalized snake_case keys) so the Manager Portal
page can render the same shape and Tiana can mentally compare them
side-by-side.

The view is read-only and auto-recomputed by Postgres; no maintenance.
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'd9e0f1a2b3c4'
down_revision: Union[str, Sequence[str], None] = 'c8d9e0f1a2b3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


VIEW_SQL = """
CREATE OR REPLACE VIEW vw_master_list AS

-- ── Inbound side ──────────────────────────────────────────────────────
SELECT
    'inbound'::text                       AS row_kind,
    c.id                                  AS source_id,
    c.container_no                        AS container_no,
    cu.name                               AS customer_name,
    d.do_number                           AS invoice_no,
    w.whpo_number                         AS whpo_number,
    c.carrier                             AS carrier_or_broker,
    c.driver_name                         AS driver_name,
    -- "RECEIVED DATE" — null until container is finished (scan complete)
    c.finished_at::date                   AS received_date,
    c.expected_arrival_date               AS expected_arrival_date,
    -- Unit count = sum of container_lines.qty for this container
    (SELECT COALESCE(SUM(cl.qty), 0)
       FROM container_lines cl WHERE cl.container_id = c.id)
                                          AS units,
    -- Pallet count = distinct pallet_id from lot_assignments
    (SELECT COUNT(DISTINCT la.pallet_id)
       FROM lot_assignments la WHERE la.container_id = c.id
       AND la.pallet_id IS NOT NULL)      AS pallets,
    -- Outbound columns are null on inbound rows
    NULL::text                            AS transfer_order_no,
    NULL::date                            AS ship_date,
    NULL::text                            AS ship_to,
    NULL::bigint                          AS outbound_units,
    NULL::bigint                          AS outbound_pallets,
    -- "Scanned" = has any scan landed on this container?
    EXISTS (
        SELECT 1 FROM receipts r
        WHERE r.container_id = c.id
          AND r.completed_timestamp IS NOT NULL
    )                                     AS scanned,
    c.status                              AS status
FROM containers c
LEFT JOIN dos d         ON d.id = c.do_id
LEFT JOIN whpos w       ON w.id = d.whpo_id
LEFT JOIN customers cu  ON cu.id = w.customer_id

UNION ALL

-- ── Outbound side ─────────────────────────────────────────────────────
SELECT
    'outbound'::text                      AS row_kind,
    oc.id                                 AS source_id,
    oc.container_no                       AS container_no,
    cu.name                               AS customer_name,
    NULL::text                            AS invoice_no,
    NULL::text                            AS whpo_number,
    oc.carrier                            AS carrier_or_broker,
    oc.driver_name                        AS driver_name,
    NULL::date                            AS received_date,
    NULL::date                            AS expected_arrival_date,
    NULL::bigint                          AS units,
    NULL::bigint                          AS pallets,
    oo.transfer_order_no                  AS transfer_order_no,
    oo.order_date                         AS ship_date,
    oo.ship_to_name                       AS ship_to,
    -- Outbound unit count = scans on this outbound container
    (SELECT COUNT(*) FROM outbound_scans os
       WHERE os.outbound_container_id = oc.id) AS outbound_units,
    -- Outbound pallet count: distinct (inbound) pallets the scans came from
    (SELECT COUNT(DISTINCT la.pallet_id)
       FROM outbound_scans os
       JOIN scans s ON s.id = os.inbound_scan_id
       JOIN lot_assignments la ON la.container_id = (
           SELECT container_id FROM receipts WHERE id = s.receipt_id
       )
      WHERE os.outbound_container_id = oc.id
        AND la.pallet_id IS NOT NULL)      AS outbound_pallets,
    -- "Scanned" = any outbound scans on this container?
    EXISTS (
        SELECT 1 FROM outbound_scans os
         WHERE os.outbound_container_id = oc.id
    )                                     AS scanned,
    oc.status                             AS status
FROM outbound_containers oc
LEFT JOIN outbound_orders oo ON oo.id = oc.outbound_order_id
LEFT JOIN customers cu       ON cu.id = oo.customer_id
"""


def upgrade() -> None:
    op.execute(VIEW_SQL)


def downgrade() -> None:
    op.execute("DROP VIEW IF EXISTS vw_master_list")
