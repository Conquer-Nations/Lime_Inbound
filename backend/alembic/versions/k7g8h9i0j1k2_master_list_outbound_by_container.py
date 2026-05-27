"""vw_master_list v3: outbound aggregates by container_no (with scan fallback)

Revision ID: k7g8h9i0j1k2
Revises: j6f7g8h9i0j1
Create Date: 2026-05-27 03:30:00.000000

Previous v2 (h4d5e6f7g8h9) computed outbound aggregates exclusively via
the operator scan chain:

    container ← scans → outbound_scans → outbound_containers → outbound_orders

That works for live operations where every item is barcoded at receiving
and again at picking. But it breaks for historical data backfilled via
scripts/import_historical.py — those rows have OutboundContainers and
OutboundLines but no per-item scans, so the aggregates resolve to NULL.

v3 prefers the scan-based chain when scan data exists (more accurate —
scans tell you which physical container an item *actually* shipped from
when items got cross-loaded). Falls back to a container_no string match
through outbound_containers when scan data is absent. The fallback
covers:
  - All historical imports
  - Manually-created TOs that never went through the operator flow
  - Any future bulk-import that doesn't have scan-level granularity

Falls back per-column via COALESCE so partial coverage still works.
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'k7g8h9i0j1k2'
down_revision: Union[str, Sequence[str], None] = 'j6f7g8h9i0j1'
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
    (SELECT COALESCE(SUM(cl.qty), 0) FROM container_lines cl WHERE cl.container_id = c.id)
      * COALESCE(
          (SELECT s.sqft_per_unit FROM container_lines cl
            JOIN skus s ON s.id = cl.sku_id
           WHERE cl.container_id = c.id AND s.sqft_per_unit IS NOT NULL LIMIT 1),
          0
        )                                         AS total_sqft,

    -- ── Outbound side (cols 14-20) ──────────────────────────────────
    -- COALESCE(scan-chain, container_no-fallback) per column.
    COALESCE(
        (SELECT string_agg(DISTINCT oo.transfer_order_no, ', ' ORDER BY oo.transfer_order_no)
           FROM outbound_scans os
           JOIN scans sc              ON sc.id = os.inbound_scan_id
           JOIN outbound_containers oc ON oc.id = os.outbound_container_id
           JOIN outbound_orders oo    ON oo.id = oc.outbound_order_id
          WHERE sc.container_id = c.id),
        (SELECT string_agg(DISTINCT oo.transfer_order_no, ', ' ORDER BY oo.transfer_order_no)
           FROM outbound_containers oc
           JOIN outbound_orders oo    ON oo.id = oc.outbound_order_id
          WHERE oc.container_no = c.container_no)
    )                                             AS to_no,

    COALESCE(
        (SELECT MIN(oo.order_date)
           FROM outbound_scans os
           JOIN scans sc              ON sc.id = os.inbound_scan_id
           JOIN outbound_containers oc ON oc.id = os.outbound_container_id
           JOIN outbound_orders oo    ON oo.id = oc.outbound_order_id
          WHERE sc.container_id = c.id),
        (SELECT MIN(oo.order_date)
           FROM outbound_containers oc
           JOIN outbound_orders oo    ON oo.id = oc.outbound_order_id
          WHERE oc.container_no = c.container_no)
    )                                             AS ship_date,

    COALESCE(
        (SELECT string_agg(DISTINCT oo.ship_to_name, ', ' ORDER BY oo.ship_to_name)
           FROM outbound_scans os
           JOIN scans sc              ON sc.id = os.inbound_scan_id
           JOIN outbound_containers oc ON oc.id = os.outbound_container_id
           JOIN outbound_orders oo    ON oo.id = oc.outbound_order_id
          WHERE sc.container_id = c.id
            AND oo.ship_to_name IS NOT NULL),
        (SELECT string_agg(DISTINCT oo.ship_to_name, ', ' ORDER BY oo.ship_to_name)
           FROM outbound_containers oc
           JOIN outbound_orders oo    ON oo.id = oc.outbound_order_id
          WHERE oc.container_no = c.container_no
            AND oo.ship_to_name IS NOT NULL)
    )                                             AS ship_to,

    -- Pallets out: prefer actual scan-counted pallets, fall back to
    -- a derived count via outbound_lines.order_qty / SKU items_per_pallet.
    COALESCE(
        (SELECT COUNT(DISTINCT sc.pallet_id)
           FROM outbound_scans os
           JOIN scans sc              ON sc.id = os.inbound_scan_id
          WHERE sc.container_id = c.id
            AND sc.pallet_id IS NOT NULL),
        (SELECT CEIL(SUM(ol.order_qty)::numeric
                     / NULLIF(s.items_per_pallet, 0))::bigint
           FROM outbound_lines ol
           LEFT JOIN skus s ON s.id = ol.sku_id
          WHERE ol.source_container_no = c.container_no
          GROUP BY s.items_per_pallet
          LIMIT 1),
        0
    )                                             AS pallets_out,

    -- Units out: prefer scan count, fall back to sum(outbound_lines.order_qty)
    COALESCE(
        (SELECT COUNT(*)
           FROM outbound_scans os
           JOIN scans sc              ON sc.id = os.inbound_scan_id
          WHERE sc.container_id = c.id),
        (SELECT COALESCE(SUM(ol.order_qty), 0)
           FROM outbound_lines ol
          WHERE ol.source_container_no = c.container_no),
        0
    )                                             AS units_out,

    -- sqft_out: per-unit figure from the SKU master (same physical items)
    (SELECT s.sqft_per_unit
       FROM container_lines cl
       JOIN skus s ON s.id = cl.sku_id
      WHERE cl.container_id = c.id
        AND s.sqft_per_unit IS NOT NULL
      LIMIT 1)                                    AS sqft_out,

    -- total_sqft_out = units_out * sqft_per_unit
    COALESCE(
        (SELECT COUNT(*)
           FROM outbound_scans os
           JOIN scans sc              ON sc.id = os.inbound_scan_id
          WHERE sc.container_id = c.id),
        (SELECT COALESCE(SUM(ol.order_qty), 0)
           FROM outbound_lines ol
          WHERE ol.source_container_no = c.container_no),
        0
    )
      * COALESCE(
          (SELECT s.sqft_per_unit FROM container_lines cl
            JOIN skus s ON s.id = cl.sku_id
           WHERE cl.container_id = c.id AND s.sqft_per_unit IS NOT NULL LIMIT 1),
          0
        )                                         AS total_sqft_out,

    -- ── Status (cols 21-22) ─────────────────────────────────────────
    -- "scanned" = there's a finished receipt OR (for historical rows) an
    -- outbound shipment with a destination = items have moved through.
    (
        EXISTS (
            SELECT 1 FROM receipts r
             WHERE r.container_id = c.id
               AND r.finished_at IS NOT NULL
        )
        OR EXISTS (
            SELECT 1 FROM outbound_containers oc
              JOIN outbound_orders oo ON oo.id = oc.outbound_order_id
             WHERE oc.container_no = c.container_no
               AND oo.ship_to_name IS NOT NULL
        )
    )                                             AS scanned,
    (SELECT cl.sku_raw FROM container_lines cl
      WHERE cl.container_id = c.id LIMIT 1)       AS lpn
FROM containers c
LEFT JOIN dos d         ON d.id = c.do_id
LEFT JOIN whpos w       ON w.id = d.whpo_id
LEFT JOIN customers cu  ON cu.id = w.customer_id
"""


# Previous v2 verbatim — needed for downgrade.
V2_VIEW_SQL = """
CREATE VIEW vw_master_list AS
SELECT
    c.id                                          AS container_id,
    c.container_no                                AS container_no,
    cu.name                                       AS customer_name,
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
    (SELECT COALESCE(SUM(cl.qty), 0) FROM container_lines cl WHERE cl.container_id = c.id)
      * COALESCE(
          (SELECT s.sqft_per_unit FROM container_lines cl
            JOIN skus s ON s.id = cl.sku_id
           WHERE cl.container_id = c.id AND s.sqft_per_unit IS NOT NULL LIMIT 1),
          0
        )                                         AS total_sqft,
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


def upgrade() -> None:
    op.execute("DROP VIEW IF EXISTS vw_master_list")
    op.execute(VIEW_SQL)


def downgrade() -> None:
    op.execute("DROP VIEW IF EXISTS vw_master_list")
    op.execute(V2_VIEW_SQL)
