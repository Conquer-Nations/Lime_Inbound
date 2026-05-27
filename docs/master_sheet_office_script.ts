/**
 * MasterSheetSyncV2 — multi-brand master inventory sync.
 *
 * Receives a JSON-stringified payload from the cn-master-sheet Logic App.
 * For each brand in payload.brands, ensures a sheet exists in the
 * workbook and bulk-replaces its data rows.
 *
 * Payload shape (matches backend/app/services/master_sheet_sync.py):
 *
 *   {
 *     "headers": [ ...22 column names... ],
 *     "brands":  {
 *       "Lime":              [[col1, col2, ..., col22], ...],
 *       "Pan American Wire": [[col1, col2, ..., col22], ...],
 *       "Boviet Solar":      []
 *     }
 *   }
 *
 * For each brand:
 *   - Sheet name = sanitized brand (Excel disallows : \ / ? * [ ]; 31-char cap).
 *   - Table name = MasterTable_<brand>  (alphanumeric + underscore only).
 *   - If the sheet doesn't exist yet, we add it, write the header row, and
 *     create the table over it. Newly-created sheets land at the end of
 *     the tab strip; move them around manually if you care about order.
 *   - Existing tables get all data rows cleared, then the new rows
 *     bulk-appended.
 *
 * Returns JSON: { ok, brands, rows, created_sheets }
 *
 * SETUP:
 *   Excel → Automate → New Script → paste this file → Save as
 *   `MasterSheetSyncV2`. Then point the Logic App's "Run script" action
 *   at this script and wire its only parameter to triggerBody() as a
 *   JSON string (see docs/master_sheet_logic_app_setup.md).
 */
function main(workbook: ExcelScript.Workbook, payload: string): string {
  const data = JSON.parse(payload || "{}") as {
    headers?: string[];
    brands?: { [brand: string]: (string | number | boolean)[][] };
  };

  const headers: string[] = data.headers || [];
  const brands = data.brands || {};

  if (headers.length === 0) {
    return JSON.stringify({ error: "payload.headers is empty" });
  }

  let totalRows = 0;
  let totalBrands = 0;
  const createdSheets: string[] = [];
  const errors: string[] = [];

  for (const brand of Object.keys(brands)) {
    if (!brand) continue;
    const rows = brands[brand] || [];
    const sheetName = sanitizeSheetName(brand);
    const tableName = sanitizeTableName("MasterTable_" + brand);

    let sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      sheet = workbook.addWorksheet(sheetName);
      createdSheets.push(sheetName);
    }

    let table = workbook.getTable(tableName);
    if (!table) {
      // Brand-new sheet: write the header row in A1:V1, then create
      // a one-row table over it. The header text becomes the table's
      // column names automatically.
      const headerRange = sheet.getRangeByIndexes(0, 0, 1, headers.length);
      headerRange.setValues([headers]);
      table = workbook.addTable(headerRange, true);
      try {
        table.setName(tableName);
      } catch (e) {
        errors.push(`could not name table for ${brand}: ${e}`);
      }
    }

    // Clear existing data rows. Walk top-down because deleteRowsAt
    // shifts indices.
    const dataBody = table.getRangeBetweenHeaderAndTotal();
    if (dataBody) {
      const existingCount = dataBody.getRowCount();
      if (existingCount > 0) {
        table.deleteRowsAt(0, existingCount);
      }
    }

    // Bulk-append the fresh rows. addRows takes a 2D array.
    if (rows.length > 0) {
      try {
        table.addRows(-1, rows);
      } catch (e) {
        errors.push(`addRows failed for ${brand}: ${e}`);
      }
    }

    totalRows += rows.length;
    totalBrands++;
  }

  return JSON.stringify({
    ok: errors.length === 0,
    brands: totalBrands,
    rows: totalRows,
    created_sheets: createdSheets,
    errors: errors,
  });
}

function sanitizeSheetName(brand: string): string {
  // Excel rejects : \ / ? * [ ] in sheet names, and caps at 31 chars.
  let s = brand.replace(/[:\\/?*\[\]]/g, "").trim();
  if (s.length > 31) s = s.substring(0, 31);
  return s || "Brand";
}

function sanitizeTableName(name: string): string {
  // Excel table names: alphanumeric + underscore, must start with a
  // letter, max 255 chars. We replace anything non-conforming with _.
  let s = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (!/^[A-Za-z]/.test(s)) s = "T_" + s;
  if (s.length > 255) s = s.substring(0, 255);
  return s;
}
