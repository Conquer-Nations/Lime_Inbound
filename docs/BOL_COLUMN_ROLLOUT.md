# Rolling out the new `bol_number` column

Three things change to surface BOL # in the OneDrive `InboundTable`. All
three are short — total time ≈ 5 minutes.

The Office Script doesn't need any edit — it reads columns by name, so a
new column appears for free once the spreadsheet has it.

---

## 1. Add the column to the OneDrive `CN-Warehouse-Inbound.xlsx`

1. Open the workbook in Excel for the web (OneDrive).
2. Go to the `inboundTable` sheet.
3. The `InboundTable` table currently has 19 columns ending at
   `last_updated_at`. Click into the cell immediately to the right of
   `last_updated_at` in the header row.
4. Type the header text **exactly**:

   ```
   bol_number
   ```

5. Press Enter. The table will auto-expand to include the new column at
   position 20.
6. Save (Cmd-S / Ctrl-S — Excel for the web autosaves, but commit
   anyway).

**Why `bol_number` (snake_case)?** The Office Script + backend reference
columns by this exact key. If you want a friendlier display, format the
header cell only (bold, etc.) — keep the cell *value* as `bol_number`.

---

## 2. Re-map the APPEND Logic App `cn-warehouse-onedrive-sync`

This is the Logic App that catches each inbound row from the backend and
appends it to the table. It uses positional `items('For_each')[N]` to
read fields out of the payload — so the new field at position 20 needs a
mapping for its column.

1. Open https://portal.azure.com → Logic Apps → **cn-warehouse-onedrive-sync**.
2. Click **Logic App designer**.
3. Expand the **For each** loop → expand the **Add a row into a table**
   action.
4. In the action's parameter panel, the table dropdown will now show a
   new **bol_number** column (because step 1 added it). The other 19
   columns are already mapped.
5. Click into the **bol_number** field and add the expression:

   ```
   items('For_each')[19]
   ```

   That's index `19` because zero-based — `bol_number` is the 20th item
   in the row dict the backend sends.
6. **Save** the Logic App.

Quick test: from a terminal,

```bash
curl -X POST "$ONEDRIVE_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{"rows": [["TESTBOL0000001","99999998","2026-06-01","09:00",1,"Test","SKU-X","Test Co","DO-TEST","tester","tester@x.com","2026-05-19T00:00:00Z","","","","","","","",  "BOL-TEST-001"]]}'
```

Open the spreadsheet — you should see a new row at the bottom of
`InboundTable` with `TESTBOL0000001` in column A and `BOL-TEST-001` in
the new `bol_number` column. Delete the test row when you're done.

---

## 3. Redeploy the Function App `cn-warehouse-fn`

The Function App writes the same rows to a blob CSV. Its `HEADERS` list
is positional too. The code change is already committed to this branch
(`cn-warehouse-fn/function_app.py`); you just need to push the new code
to the Azure Function.

From a terminal in the repo root:

```bash
cd cn-warehouse-fn
func azure functionapp publish cn-warehouse-fn --python
```

(If you've never run `func` from this branch, you may need `pip install
-r requirements.txt` inside that folder first.)

Verify with the same test row above — the new BOL value should appear at
the end of the line in `inbound.csv` in Blob Storage.

---

## What the backend already does (no action needed)

- `whpos.bol_number` column on Postgres (migration `e5f6a7b8c9d0` already
  runs on the next backend deploy).
- `submit_whpo` and `update_whpo` persist the typed BOL # to
  `whpos.bol_number`.
- `fetch_inbound_rows_for_do` and `_fetch_inbound` add `bol_number` at
  position 20 of every row dict, matching `HEADERS`.
- TEMPLATE.xlsx scan-sheet export reads `whpos.bol_number` into cell F5.
- Manager Inbound view shows a new BOL # column and filters search the
  field.
- The "Update Shipment" vendor form has a BOL # text input alongside
  expected arrival date.
- The "Bill of Lading (BOL)" PDF upload tile auto-appears on the Update
  Shipment screen and the View Shipment screen.

---

## Rollback (if anything breaks)

Drop the column from the InboundTable (right-click column header →
Delete) — the Office Script will harmlessly ignore the missing column on
list/update. Remove the Logic App mapping in the designer. Backend keeps
running fine with a None value for everyone.

No DB rollback needed — `whpos.bol_number` defaults to NULL and is
opt-in per WHPO.
