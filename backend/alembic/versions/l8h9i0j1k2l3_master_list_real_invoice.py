"""vw_master_list v4: `invoice` column = real invoice number; add `do_number`

Revision ID: l8h9i0j1k2l3
Revises: k7g8h9i0j1k2
Create Date: 2026-05-28 01:00:00.000000

Previous view (v3) aliased `d.do_number AS invoice` — labeling the
warehouse Delivery Order ID as if it were the billing invoice number.
That's a misnomer Tiana caught on 2026-05-28: the DO number
(`DO-YYYY-####` or historical `DO-HIST-######`) is the warehouse's
internal receiving identifier, while the actual invoice number
(`CN-YYYYMMDD-####`) is generated only when a manager issues an
invoice against the WHPO (inbound) or against the Transfer Order
(outbound).

v4 fixes the semantics:
  - `invoice` column = the latest non-void invoice_number that
    references this row's WHPO, OR (when none exists yet) the
    latest non-void invoice_number for any outbound TO that draws
    from this container. NULL if neither has been issued yet.
  - `do_number` column = the actual Delivery Order ID, separated out
    so manager ops can still cross-reference it for receiving.

Outbound invoices are linked via OutboundLine.source_container_no
(which matches Container.container_no), then up through outbound_lines
→ outbound_orders → invoices. We pick the most recent generated_at
among inbound + any matching outbound invoices to keep the column
single-valued.
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'l8h9i0j1k2l3'
down_revision: Union[str, Sequence[str], None] = 'k7g8h9i0j1k2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


VIEW_SQL = """
CREATE VIEW vw_master_list AS
SELECT
    c.id                                          AS container_id,
    c.container_no                                AS container_no,
    cu.name                                       AS customer_name,

    -- ── Inbound side ────────────────────────────────────────────────
    -- `invoice` is now the REAL billing invoice number, not the DO #.
    -- Picks the most recent non-void invoice tied to either this
    -- container's WHPO (inbound invoice) OR any outbound TO that
    -- references this container_no (outbound invoice). NULL if
    -- neither side has been billed yet.
    (
        SELECT i.invoice_number
          FROM invoices i
         WHERE i.status != 'void'
           AND (
               i.whpo_id = w.id
               OR i.outbound_order_id IN (
                   SELECT ol.outbound_order_id
                     FROM outbound_lines ol
                    WHERE ol.source_container_no = c.container_no
               )
           )
         ORDER BY i.generated_at DESC
         LIMIT 1
    )                                             AS invoice,
    -- DO # surfaced as its own column. Frontend + Excel render both.
    d.do_number                                   AS do_number,
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

    -- ── Outbound side ───────────────────────────────────────────────
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

    (SELECT s.sqft_per_unit
       FROM container_lines cl
       JOIN skus s ON s.id = cl.sku_id
      WHERE cl.container_id = c.id
        AND s.sqft_per_unit IS NOT NULL
      LIMIT 1)                                    AS sqft_out,

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

    -- ── Status ──────────────────────────────────────────────────────
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


# v3 verbatim — for downgrade.
V3_VIEW_SQL = """
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
    (SELECT s.sqft_per_unit
       FROM container_lines cl
       JOIN skus s ON s.id = cl.sku_id
      WHERE cl.container_id = c.id
        AND s.sqft_per_unit IS NOT NULL
      LIMIT 1)                                    AS sqft_out,
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


def upgrade() -> None:
    op.execute("DROP VIEW IF EXISTS vw_master_list")
    op.execute(VIEW_SQL)


def downgrade() -> None:
    op.execute("DROP VIEW IF EXISTS vw_master_list")
    op.execute(V3_VIEW_SQL)
