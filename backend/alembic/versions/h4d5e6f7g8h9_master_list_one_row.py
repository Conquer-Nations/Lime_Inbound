"""vw_master_list v2: one row per inbound container

Revision ID: h4d5e6f7g8h9
Revises: g3c4d5e6f7g8
Create Date: 2026-05-26 04:00:00.000000

Replaces the previous UNION ALL view (inbound + outbound rows separate)
with the structure of Tiana's Lime-Inventory-Sep 2025.xlsx — ONE row
per inbound container with the outbound aggregates joined in. Outbound
columns are NULL until the container has been (partially) shipped out.

Columns mirror the xlsx exactly:

  Inbound (1-13):
    invoice | commodity | container_no | whpo_load_no | carrier_broker |
    driver_name | drop_container | received_date | pickup_container |
    pallets | units | sqft | total_sqft

  Outbound (14-20):
    to_no | ship_date | ship_to | pallets_out | units_out | sqft_out |
    total_sqft_out

  Status (21-22):
    scanned | lpn

Outbound aggregates are computed by joining outbound_scans →
scans.container_id back to the inbound container that physically held
each scanned unit. So the outbound qty = actual units that shipped,
not just what was planned.
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'h4d5e6f7g8h9'
down_revision: Union[str, Sequence[str], None] = 'g3c4d5e6f7g8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


VIEW_SQL = """
CREATE VIEW vw_master_list AS
SELECT
    c.id                                          AS container_id,
    c.container_no                                AS container_no,
    cu.name                                       AS customer_name,

    -- ── Inbound side (cols 1-13) ────────────────────────────────────
    d.do_number                                   AS invoice,
    (SELECT cl.product_type
       FROM container_lines cl
      WHERE cl.container_id = c.id
        AND cl.product_type IS NOT NULL
      LIMIT 1)                                    AS commodity,
    w.whpo_number                                 AS whpo_load_no,
    c.carrier                                     AS carrier_broker,
    c.driver_name                                 AS driver_name,
    c.actual_arrival_date                         AS drop_container,
    c.finished_at::date                           AS received_date,
    NULL::date                                    AS pickup_container,
    (SELECT COUNT(*) FROM pallets p
       WHERE p.container_id = c.id)               AS pallets,
    (SELECT COALESCE(SUM(cl.qty), 0)
       FROM container_lines cl
      WHERE cl.container_id = c.id)               AS units,
    (SELECT s.sqft_per_unit
       FROM container_lines cl
       JOIN skus s ON s.id = cl.sku_id
      WHERE cl.container_id = c.id
        AND s.sqft_per_unit IS NOT NULL
      LIMIT 1)                                    AS sqft,
    -- TOTAL SQ FT = units * sqft_per_unit
    (SELECT COALESCE(SUM(cl.qty), 0) FROM container_lines cl WHERE cl.container_id = c.id)
      * COALESCE(
          (SELECT s.sqft_per_unit FROM container_lines cl
            JOIN skus s ON s.id = cl.sku_id
           WHERE cl.container_id = c.id AND s.sqft_per_unit IS NOT NULL LIMIT 1),
          0
        )                                         AS total_sqft,

    -- ── Outbound side (cols 14-20) ──────────────────────────────────
    (SELECT string_agg(DISTINCT oo.transfer_order_no, ', ')
       FROM outbound_scans os
       JOIN scans s              ON s.id = os.inbound_scan_id
       JOIN outbound_containers oc ON oc.id = os.outbound_container_id
       JOIN outbound_orders oo   ON oo.id = oc.outbound_order_id
      WHERE s.container_id = c.id)                AS to_no,
    (SELECT MIN(oo.order_date)
       FROM outbound_scans os
       JOIN scans s              ON s.id = os.inbound_scan_id
       JOIN outbound_containers oc ON oc.id = os.outbound_container_id
       JOIN outbound_orders oo   ON oo.id = oc.outbound_order_id
      WHERE s.container_id = c.id)                AS ship_date,
    (SELECT string_agg(DISTINCT oo.ship_to_name, ', ')
       FROM outbound_scans os
       JOIN scans s              ON s.id = os.inbound_scan_id
       JOIN outbound_containers oc ON oc.id = os.outbound_container_id
       JOIN outbound_orders oo   ON oo.id = oc.outbound_order_id
      WHERE s.container_id = c.id
        AND oo.ship_to_name IS NOT NULL)          AS ship_to,
    (SELECT COUNT(DISTINCT s.pallet_id)
       FROM outbound_scans os
       JOIN scans s              ON s.id = os.inbound_scan_id
      WHERE s.container_id = c.id
        AND s.pallet_id IS NOT NULL)              AS pallets_out,
    (SELECT COUNT(*)
       FROM outbound_scans os
       JOIN scans s              ON s.id = os.inbound_scan_id
      WHERE s.container_id = c.id)                AS units_out,
    -- For outbound sqft we use the same per-unit figure from the
    -- source SKU (the items are the same physical thing, just moving).
    (SELECT s.sqft_per_unit
       FROM container_lines cl
       JOIN skus s ON s.id = cl.sku_id
      WHERE cl.container_id = c.id
        AND s.sqft_per_unit IS NOT NULL
      LIMIT 1)                                    AS sqft_out,
    (SELECT COUNT(*)
       FROM outbound_scans os
       JOIN scans s              ON s.id = os.inbound_scan_id
      WHERE s.container_id = c.id)
      * COALESCE(
          (SELECT s.sqft_per_unit FROM container_lines cl
            JOIN skus s ON s.id = cl.sku_id
           WHERE cl.container_id = c.id AND s.sqft_per_unit IS NOT NULL LIMIT 1),
          0
        )                                         AS total_sqft_out,

    -- ── Status (cols 21-22) ─────────────────────────────────────────
    EXISTS (
        SELECT 1 FROM receipts r
         WHERE r.container_id = c.id
           AND r.finished_at IS NOT NULL
    )                                             AS scanned,
    (SELECT cl.sku_raw FROM container_lines cl
      WHERE cl.container_id = c.id LIMIT 1)       AS lpn
FROM containers c
LEFT JOIN dos d         ON d.id = c.do_id
LEFT JOIN whpos w       ON w.id = d.whpo_id
LEFT JOIN customers cu  ON cu.id = w.customer_id
"""


PREV_VIEW_SQL = """
CREATE VIEW vw_master_list AS
SELECT
    'inbound'::text                       AS row_kind,
    c.id                                  AS source_id,
    c.container_no                        AS container_no,
    cu.name                               AS customer_name,
    d.do_number                           AS invoice_no,
    w.whpo_number                         AS whpo_number,
    c.carrier                             AS carrier_or_broker,
    c.driver_name                         AS driver_name,
    c.finished_at::date                   AS received_date,
    c.expected_arrival_date               AS expected_arrival_date,
    (SELECT COALESCE(SUM(cl.qty), 0)
       FROM container_lines cl WHERE cl.container_id = c.id)
                                          AS units,
    (SELECT COUNT(*) FROM pallets p
       WHERE p.container_id = c.id)       AS pallets,
    NULL::text                            AS transfer_order_no,
    NULL::date                            AS ship_date,
    NULL::text                            AS ship_to,
    NULL::bigint                          AS outbound_units,
    NULL::bigint                          AS outbound_pallets,
    EXISTS (
        SELECT 1 FROM receipts r
        WHERE r.container_id = c.id
          AND r.finished_at IS NOT NULL
    )                                     AS scanned,
    c.status                              AS status
FROM containers c
LEFT JOIN dos d         ON d.id = c.do_id
LEFT JOIN whpos w       ON w.id = d.whpo_id
LEFT JOIN customers cu  ON cu.id = w.customer_id

UNION ALL

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
    (SELECT COUNT(*) FROM outbound_scans os
       WHERE os.outbound_container_id = oc.id) AS outbound_units,
    (SELECT COUNT(DISTINCT s.pallet_id)
       FROM outbound_scans os
       JOIN scans s ON s.id = os.inbound_scan_id
      WHERE os.outbound_container_id = oc.id
        AND s.pallet_id IS NOT NULL)       AS outbound_pallets,
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
    op.execute("DROP VIEW IF EXISTS vw_master_list")
    op.execute(VIEW_SQL)


def downgrade() -> None:
    op.execute("DROP VIEW IF EXISTS vw_master_list")
    op.execute(PREV_VIEW_SQL)
