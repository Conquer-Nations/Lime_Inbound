/**
 * Office Script: VendorOps
 *
 * Lives inside CN-Warehouse-Inbound.xlsx (Automate tab → All Scripts →
 * VendorOps). The cn-warehouse-vendors-ops Logic App calls this via the
 * Excel Online connector with one of the supported `action` values.
 *
 * If you're updating an existing script: just replace the entire body
 * with this content and Save. The only addition vs. the previous version
 * is the `ensure_bol_column` action — everything else is byte-identical.
 *
 * After saving, run the column-creation action ONCE from your terminal:
 *
 *   curl -X POST "$ONEDRIVE_VENDORS_OPS_URL" \
 *     -H "Content-Type: application/json" \
 *     -d '{"action":"ensure_bol_column"}'
 *
 * Response is JSON. Either:
 *   {"ok": true, "message": "bol_number column added", ...}      (first run)
 *   {"ok": true, "message": "bol_number already exists", ...}    (subsequent)
 *
 * Idempotent — safe to call any number of times. No backend deploy
 * needed; the script invocation surface is the Logic App URL the backend
 * already has.
 *
 * If your manual edit earlier accidentally landed a bol_number column on
 * the VendorUsers table, delete it by right-clicking that column header
 * in Excel and choosing "Delete > Table Columns". VendorUsers should
 * stay at 6 columns: email | full_name | company | password_hash |
 * registered_at | last_login_at.
 */

function main(
  workbook: ExcelScript.Workbook,
  action: string,
  payload?: string
): string {
  const VU_COLS = ["email", "full_name", "company", "password_hash", "registered_at", "last_login_at"];

  // ─── VendorUsers actions ───────────────────────────────────────────
  if (action === "list" || action === "append" || action === "update_last_login" || action === "update_password") {
    const table = workbook.getTable("VendorUsers");
    if (!table) return JSON.stringify({ error: "Table 'VendorUsers' not found" });
    const range = table.getRangeBetweenHeaderAndTotal();

    if (action === "list") {
      const users: { [k: string]: string }[] = [];
      if (range) {
        const values = range.getValues();
        for (const row of values) {
          if (row.every(c => c === "" || c === null)) continue;
          const u: { [k: string]: string } = {};
          VU_COLS.forEach((col, i) => { u[col] = row[i] == null ? "" : String(row[i]); });
          users.push(u);
        }
      }
      return JSON.stringify({ users });
    }

    if (action === "append" && payload) {
      const data = JSON.parse(payload) as { [k: string]: string };
      table.addRow(-1, VU_COLS.map(c => data[c] || ""));
      return JSON.stringify({ appended: 1 });
    }

    if ((action === "update_last_login" || action === "update_password") && payload) {
      if (!range) return JSON.stringify({ updated: 0 });
      const data = JSON.parse(payload) as { [k: string]: string };
      const emailCol = VU_COLS.indexOf("email");
      const targetCol = action === "update_last_login"
        ? VU_COLS.indexOf("last_login_at")
        : VU_COLS.indexOf("password_hash");
      const field = action === "update_last_login" ? "last_login_at" : "password_hash";
      const values = range.getValues();
      let updated = 0;
      for (let i = 0; i < values.length; i++) {
        if (String(values[i][emailCol]).toLowerCase() === String(data.email).toLowerCase()) {
          range.getCell(i, targetCol).setValue(data[field]);
          updated++;
        }
      }
      return JSON.stringify({ updated });
    }
  }

  // ─── InboundTable: driver-info update ──────────────────────────────
  if (action === "update_driver" && payload) {
    const d = JSON.parse(payload) as { [k: string]: string };
    const table = workbook.getTable("InboundTable");
    if (!table) return JSON.stringify({ error: "Table 'InboundTable' not found", updated: 0 });
    const headers = table.getHeaderRowRange().getValues()[0].map(h => String(h));
    const cIdx = headers.indexOf("container_no");
    const fields = ["driver_name", "driver_license", "driver_phone", "truck_license_plate", "insurance", "carrier"];
    const idxs = fields.map(f => headers.indexOf(f));
    if (cIdx < 0 || idxs.some(i => i < 0)) {
      return JSON.stringify({ error: "InboundTable missing required driver columns", updated: 0 });
    }
    const range = table.getRangeBetweenHeaderAndTotal();
    if (!range) return JSON.stringify({ updated: 0 });
    const values = range.getValues();
    const target = String(d.container_no).trim().toUpperCase();
    let updated = 0;
    for (let i = 0; i < values.length; i++) {
      if (String(values[i][cIdx]).trim().toUpperCase() === target) {
        fields.forEach((f, k) => range.getCell(i, idxs[k]).setValue(d[f] || ""));
        updated++;
      }
    }
    return JSON.stringify({ updated, matched_container: updated > 0 ? target : null });
  }

  // ─── InboundTable: full list (used by Pull from Excel) ─────────────
  if (action === "list_inbound") {
    const table = workbook.getTable("InboundTable");
    if (!table) return JSON.stringify({ error: "Table 'InboundTable' not found", rows: [] });
    const headers = table.getHeaderRowRange().getValues()[0].map(h => String(h));
    const range = table.getRangeBetweenHeaderAndTotal();
    const rows: { [k: string]: string }[] = [];
    if (range) {
      const values = range.getValues();
      for (const row of values) {
        if (row.every(c => c === "" || c === null)) continue;
        const obj: { [k: string]: string } = {};
        headers.forEach((h, i) => { obj[h] = row[i] == null ? "" : String(row[i]); });
        rows.push(obj);
      }
    }
    return JSON.stringify({ rows });
  }

  // ─── InboundTable: delete every row matching a WHPO ────────────────
  if (action === "delete_whpo_rows" && payload) {
    const d = JSON.parse(payload) as { whpo_number: string };
    const table = workbook.getTable("InboundTable");
    if (!table) return JSON.stringify({ error: "Table 'InboundTable' not found", deleted: 0 });
    const headers = table.getHeaderRowRange().getValues()[0].map(h => String(h));
    const wIdx = headers.indexOf("whpo_number");
    if (wIdx < 0) return JSON.stringify({ error: "whpo_number column not found", deleted: 0 });
    const range = table.getRangeBetweenHeaderAndTotal();
    if (!range) return JSON.stringify({ deleted: 0 });
    const values = range.getValues();
    const target = String(d.whpo_number).trim();
    let deleted = 0;
    for (let i = values.length - 1; i >= 0; i--) {
      if (String(values[i][wIdx]).trim() === target) {
        table.deleteRowsAt(i, 1);
        deleted++;
      }
    }
    return JSON.stringify({ deleted });
  }

  // ─── InboundTable: clear all rows (preserves headers) ──────────────
  if (action === "clear_inbound_table") {
    const table = workbook.getTable("InboundTable");
    if (!table) return JSON.stringify({ error: "Table 'InboundTable' not found", deleted: 0 });
    const range = table.getRangeBetweenHeaderAndTotal();
    if (!range) return JSON.stringify({ deleted: 0 });
    const rowCount = range.getRowCount();
    for (let i = rowCount - 1; i >= 0; i--) {
      table.deleteRowsAt(i, 1);
    }
    return JSON.stringify({ deleted: rowCount });
  }

  // ─── NEW: add bol_number column to InboundTable if missing ─────────
  // Run once after deploying the scan-sheets feature. Idempotent — if
  // bol_number already exists, returns ok without touching the sheet.
  //
  // Quirk: passing `undefined` for the `values` arg to addColumn() makes
  // Office Scripts throw "Malformed input to a URL function" — we use
  // the no-arg overload and rename via setName() instead.
  if (action === "ensure_bol_column") {
    const table = workbook.getTable("InboundTable");
    if (!table) return JSON.stringify({ error: "Table 'InboundTable' not found" });
    const headers = table.getHeaderRowRange().getValues()[0].map(h => String(h));
    if (headers.indexOf("bol_number") >= 0) {
      return JSON.stringify({
        ok: true,
        message: "bol_number already exists",
        existing_column_count: headers.length,
        columns: headers,
      });
    }
    // No-arg addColumn() appends a blank column at the end of the table.
    // Then setName() writes the header text. This is the only signature
    // Office Scripts accepts cleanly for this case.
    const newCol = table.addColumn();
    newCol.setName("bol_number");
    const after = table.getHeaderRowRange().getValues()[0].map(h => String(h));
    return JSON.stringify({
      ok: true,
      message: "bol_number column added",
      new_column_count: after.length,
      columns: after,
    });
  }

  // ─── Diagnostic: list InboundTable's current header columns ────────
  // Returns the current column names — useful for confirming the
  // table's state before/after running ensure_bol_column.
  if (action === "describe_inbound_table") {
    const table = workbook.getTable("InboundTable");
    if (!table) return JSON.stringify({ error: "Table 'InboundTable' not found" });
    const headers = table.getHeaderRowRange().getValues()[0].map(h => String(h));
    return JSON.stringify({
      ok: true,
      column_count: headers.length,
      columns: headers,
    });
  }

  return JSON.stringify({ error: "unknown action: " + action });
}
