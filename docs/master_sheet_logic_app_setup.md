# Master Sheet — multi-brand Excel mirror setup

After commit `40f1da8` (backend) the API sends per-brand payloads. Three
one-time steps on the Excel + Logic App side to consume them.

## 1. Update the workbook (≈ 2 min)

The workbook stays where it is — currently `Lime Master Inventory.xlsx`
on `developer@conquernation.com`'s OneDrive. Optionally rename to
`CN Master Inventory.xlsx` (the script doesn't care about the workbook
filename — only the Logic App's "File" picker).

Each brand gets its own sheet auto-created the first time it has data.
Existing `Lime` sheet/table is reused.

## 2. Paste the Office Script (≈ 2 min)

1. Open the workbook in Excel for the web.
2. Automate tab → **New Script**.
3. Delete the boilerplate, paste the contents of
   `docs/master_sheet_office_script.ts` from the repo.
4. Click the script title (top-left) and rename to **MasterSheetSyncV2**.
5. Save.

Smoke-test in the editor:
- Click **Run**.
- It'll error with "payload.headers is empty" — that's expected
  (no payload). Confirms the script parses + runs.

## 3. Update the Logic App (≈ 1 min)

The Logic App is in the `cn-warehouse` resource group, named
something like `cn-master-sheet-sync` (the URL is in `.env` as
`ONEDRIVE_MASTER_SHEET_WEBHOOK_URL`).

1. Open the Logic App → **Logic app designer**.
2. Click the **Run script** action.
3. Change the **Script** dropdown to `MasterSheetSyncV2`.
4. The action now shows a single `payload` input (type: string).
5. Wire `payload` to the trigger body as **JSON text**:
   - Click into the `payload` field.
   - Open the **Expression** picker.
   - Paste: `string(triggerBody())`
   - Click OK.
6. Save the Logic App.

If the `payload` input doesn't surface after switching scripts, the
connector is caching old metadata — pick a different script in the
dropdown, wait 2s, pick `MasterSheetSyncV2` again. (Documented gotcha in
HANDOFF.md §9e.)

## 4. Verify

From your laptop:

```bash
BASE="https://lime-inbound-backend-hhemd4a2dff9gtdf.westus2-01.azurewebsites.net"
curl -s -X POST "$BASE/manager/master-list/sync-onedrive" | python3 -m json.tool
```

Should return `{"configured": true, "pushed": true}`. Refresh the
workbook on OneDrive — you'll see:
- `Lime` sheet with ~184 rows
- `Pan American Wire` sheet (empty for now)
- `Boviet Solar` sheet (empty for now)

After each new vendor shipment submission, this same push fires
automatically (also commit `40f1da8`).

## Rollback

If anything goes sideways, revert the Logic App's script dropdown back
to whichever V1 script you had before. The backend still sends the
flat `payload.rows` for v1 compatibility, so V1 will keep working
exactly as it did.
