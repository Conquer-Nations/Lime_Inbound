# Conquer Nation Warehouse — Session Handoff

Last updated: 2026-05-18. Feed this to the next Claude session.

---

## 1. Project identity

**Project**: Unified warehouse-management app for **Conquer Nation Inc.**, 2651 E. 12th St., Los Angeles, CA 90023.
**Owner**: Tiana Pinto (`tvpinto@usc.edu`). USC student, Azure-for-Students subscription. **Cannot register Entra ID apps** (student tenant restriction).
**Purpose**: Single product replacing two earlier prototypes (Lime 3PL Container Verification + Conquer Nation WMS). End-to-end flow:

```
vendor registers → vendor sends WHPO → we issue DO → vendor adds driver/truck info
                                                          ↓
                                operator scans containers at dock → put-away
                                                          ↘  manager monitors
```

**Status as of this handoff**: backend + frontend + database + Azure sync all live. Brand-themed UI across every page (cyan/navy/yellow per conquernation.com palette). Vendor self-service authentication live (Excel-backed users, JWT sessions). Full update/amendment flow live with audit trail. WHPO uniqueness enforced. Atomic Postgres + Excel wipe endpoint.

**Don't conflate with**:
- `/Users/Tiana/Desktop/Container Inventory Verification system/` — old Lime 3PL prototype (single HTML + Apps Script + Google Sheets)
- `/Users/Tiana/Desktop/Conquer-Nation-WMS-Handoff/HANDOFF.md` — old Conquer Nation WMS prototype (same stack)

Those two are dead/superseded. This project is the in-house replacement, built on a real backend.

---

## 2. Tech stack

| | |
|---|---|
| Backend | Python 3.12 · FastAPI · SQLAlchemy 2.0 async · Alembic · asyncpg · Postgres 16 |
| Frontend | React 18 · Vite 5 · TypeScript · Tailwind 4 · React Router 6 |
| OCR | EasyOCR (PyTorch) server-side via `/ocr/container-photo` |
| Vendor auth | bcrypt + PyJWT, Excel-backed via Logic App (no Postgres mirror) |
| Staff auth | PIN-only via `STAFF` dict in frontend (placeholder until MS SSO) |
| Sync | One Azure Function App + one unified Logic App (Office Script dispatcher) + one legacy Logic App for InboundTable APPEND |
| Local | All running on Tiana's Mac. No paid hosting yet. |

Pyproject manages backend deps via **uv** (`uv sync`, `uv run pytest`).
Frontend deps via plain npm. Vite dev server proxies `/api/*` → `localhost:8000`.

**Backend deps of note** (in `backend/pyproject.toml`):
- `fastapi`, `uvicorn`, `sqlalchemy[asyncio]`, `alembic`, `asyncpg`, `pydantic-settings`, `httpx`
- `easyocr` + `pillow` (OCR)
- `bcrypt>=4.2.0`, `pyjwt>=2.10.0`, `email-validator>=2.2.0` (vendor auth, added 2026-05-17/18)
- `gspread`, `google-auth` (vestigial, Google Sheets prototype phase — unused now)

---

## 3. File layout

```
/Users/Tiana/Desktop/Conquer-Nation-Warehouse/
├── cn-warehouse-fn/                      Azure Function App project (Python V2)
│   ├── function_app.py                   AppendInbound HTTP trigger — writes CSV
│   ├── host.json
│   ├── local.settings.json               AzureWebJobsStorage (gitignored)
│   ├── requirements.txt
│   ├── .vscode/                          deploy settings
│   └── .funcignore
├── backend/
│   ├── app/
│   │   ├── main.py                       FastAPI entry + CORS + router mount
│   │   ├── config.py                     pydantic-settings, reads .env
│   │   ├── db.py                         SQLAlchemy async engine + Base
│   │   ├── seed.py                       Customers (incl. TQL Trading Inc.),
│   │   │                                 SKUs, Floors, 2 SOLAR lots,
│   │   │                                 seeded DO-2026-0001 / HLXU9005263
│   │   ├── seed_floor1.py                Loads the 196-cell Floor 1 grid
│   │   ├── models/__init__.py            16 tables in one file. Container has
│   │   │                                 driver_phone + carrier columns.
│   │   ├── schemas/
│   │   │   ├── operator.py
│   │   │   ├── vendor.py                 Includes WHPOUpdateRequest /
│   │   │   │                             WHPOCurrentState / WHPOChange for
│   │   │   │                             the amendment flow
│   │   │   ├── vendor_auth.py            Register/Login/Reset/Token schemas
│   │   │   └── manager.py
│   │   ├── routers/
│   │   │   ├── operator.py               /operator/* endpoints (3)
│   │   │   ├── vendor.py                 /vendor/whpo, /vendor/container/*,
│   │   │   │                             /vendor/whpo/{}/current,
│   │   │   │                             /vendor/whpo/{}/update (5)
│   │   │   ├── vendor_auth.py            /vendor/auth/* (5: register, login,
│   │   │   │                             me, customers, reset-password)
│   │   │   ├── manager.py                /manager/* endpoints (16)
│   │   │   └── ocr.py                    /ocr/container-photo
│   │   └── services/
│   │       ├── assignment.py             Sqft-based lot packing algorithm
│   │       ├── space.py                  Pure footprint calculations
│   │       ├── receiving.py              Operator lookup / scan / finish
│   │       ├── intake.py                 Vendor WHPO submission + helpers.
│   │       │                             Now REJECTS duplicate WHPOs (was
│   │       │                             idempotent-replay).
│   │       ├── manager.py                Dashboard, DO/lot/exception queries
│   │       ├── ocr.py                    EasyOCR wrapper + check-digit validator
│   │       ├── sheet_sync.py             Fan-out: Function App + Logic Apps.
│   │       │                             update_driver_for_container,
│   │       │                             delete_inbound_rows_for_whpo,
│   │       │                             clear_inbound_table all go through
│   │       │                             the unified vendors-ops Logic App.
│   │       ├── vendor_excel.py           Vendor-user CRUD via vendors-ops
│   │       │                             Logic App (list/append/update_last_login
│   │       │                             /update_password/list_inbound_rows)
│   │       └── vendor_auth_service.py    bcrypt hash/verify + JWT issue/decode
│   │                                     + FastAPI deps (current_vendor_*)
│   ├── alembic/versions/                 11 migrations (latest two:
│   │                                     a1b2c3d4e5f6 driver_phone,
│   │                                     b2c3d4e5f6a7 carrier)
│   ├── tests/                            39 tests
│   ├── pyproject.toml                    Includes bcrypt, pyjwt, email-validator
│   └── .env                              Real webhook URLs + JWT_SECRET
├── frontend/
│   ├── index.html
│   ├── package.json
│   ├── vite.config.ts                    Has /api proxy + host: true
│   ├── tsconfig.json
│   └── src/
│       ├── main.tsx
│       ├── App.tsx                       BrowserRouter + role gates +
│       │                                 VendorAuthProvider wrapper
│       ├── index.css                     @import "tailwindcss"
│       ├── api/client.ts                 Typed fetch wrapper, all endpoints.
│       │                                 Auto-attaches Bearer token from
│       │                                 VendorAuthContext to every request.
│       ├── types/api.ts                  Mirrors backend Pydantic schemas
│       ├── auth/
│       │   ├── staff.ts                  STAFF dict (ken/jerry/lisa etc.)
│       │   ├── AuthContext.tsx           Staff PIN session (in-memory)
│       │   └── VendorAuthContext.tsx     Vendor JWT session (in-memory only,
│       │                                 NO localStorage — refresh = log out)
│       ├── pages/
│       │   ├── LoginPage.tsx             Staff PIN login (brand-themed)
│       │   ├── VendorWelcomePage.tsx     /vendor — Register/Login tile chooser
│       │   ├── VendorRegisterPage.tsx    /vendor/register
│       │   ├── VendorLoginPage.tsx       /vendor/login
│       │   ├── VendorForgotPasswordPage.tsx  /vendor/forgot-password
│       │   ├── VendorIntakePage.tsx      /vendor-intake — chooser with 3 tiles
│       │   │                             (New / Driver / Update),
│       │   │                             contains UpdateShipmentForm
│       │   │                             component for the amendment flow
│       │   ├── OperatorPage.tsx          Photo OCR + scan flow (navy chrome)
│       │   ├── ManagerPage.tsx           5-tab admin (navy chrome)
│       │   ├── DODetailPage.tsx
│       │   └── LotDetailPage.tsx
│       └── components/
│           ├── CameraOcr.tsx             Backend OCR call + check-digit pill
│           ├── DashboardTab.tsx          KPI cards + activity feed (10s refresh)
│           │                             — whpo_updated entries have amber
│           │                             pencil icon
│           ├── InboundView.tsx           Vendor data table + CSV export +
│           │                             Pull from Excel + Resend driver info +
│           │                             "Last updated" chip column (amber if
│           │                             changed within 24h)
│           ├── ResolveExceptionModal.tsx
│           ├── WarehouseFloorPlan.tsx    Renders 196-cell Floor 1 grid
│           ├── VendorPortalChrome.tsx    Shared cyan-bar chrome for vendor
│           │                             pages (login/register/intake/etc.)
│           └── DataExplorer.tsx          (unwired — kept for future)
├── .gitignore
└── HANDOFF.md                            THIS FILE
```

---

## 4. Data model

### 4a. Postgres tables (16)

```
customers       (id, name, contact_email, notes, created_at)
                — auto-created when a new vendor registers under a new company.
                Seeded: Lime Mobility, Boviet Solar, Pan American Wire MFG,
                National Plastic, TQL Trading Inc.

skus            (id, customer_id, sku, description, sqft_per_unit, items_per_pallet,
                 pallet_mode {logical|physical}, stackable, max_stack_height, unit,
                 source {seed|manager_resolve})
                — `source` is used by wipe-transactional to preserve seeded SKUs
                while clearing exception-resolved ones.

floors          (id, name, layout {GRID|R}, notes)
lots            (id, floor_id, lot_code, type {rack|bulk}, sqft_capacity=1610,
                 pallet_capacity=60, max_stack_levels=2, blocked, grid_row, grid_col)

whpos           (id, whpo_number {8 digits, UNIQUE — billing constraint},
                 customer_id, received_at, raw_payload jsonb, notes,
                 [deprecated driver_* fields])

dos             (id, do_number {DO-YYYY-NNNN, sequential}, whpo_id {1:1},
                 status {pending_master_data|ready|...},
                 expected_arrival_date, issued_at, issued_by)

containers      (id, container_no {ISO 6346, unique}, do_id,
                 expected_arrival_date, expected_arrival_time,
                 actual_arrival_date, actual_arrival_time,
                 status {expected|receiving|received},
                 on_pallet, pallet_length_in, pallet_width_in,
                 item_length_in, item_width_in, item_height_in,
                 driver_name, driver_license, driver_phone,
                 truck_license_plate, insurance, carrier,
                 driver_info_received_at)
                — driver_phone added 2026-05-18 (migration a1b2c3d4e5f6)
                — carrier added 2026-05-18 (migration b2c3d4e5f6a7)

container_lines (id, container_id, sku_id {nullable=unknown}, sku_raw,
                 qty, line_index, product_type)
lot_assignments (id, container_id, sku_id, lot_id, assignment_order,
                 planned_sqft, actual_sqft, planned_pallets, actual_pallets, status)
receipts        (id, container_id, status, started_*, finished_*)
pallets         (id, receipt_id, container_id, sku_id, lot_id,
                 qty, level, sqft, pallet_mode_at_receipt, palletized_at/by)
scans           (id, receipt_id, pallet_id, container_id, sku_id,
                 item_barcode, scanned_at/by, result, error_reason)
exceptions      (id, kind, ref_type, ref_id, payload jsonb,
                 status {open|resolved}, opened_*, resolved_*, resolution_notes)
activity_log    (id, t, actor, kind, ref_type, ref_id, message, payload jsonb)
                — kinds emitted: whpo_submitted, whpo_updated (NEW),
                  driver_info_submitted, container_started, container_finished,
                  exception_opened, exception_resolved
                — whpo_updated payload = {"changes": [WHPOChange...]}
                  for the dashboard activity feed + audit trail.
```

### 4b. Excel sheets (in `CN-Warehouse-Inbound.xlsx` on `tvpinto@usc.edu`'s OneDrive)

**Sheet `inboundTable` — table named `InboundTable` (19 columns)**

Append-only per (container × SKU line). Updates done by delete-and-re-append at the WHPO level.

```
container_no | whpo_number | expected_arrival_date | expected_arrival_time
qty | product_type | sku | customer | do_number
submitter_name | submitter_email | submitted_at
driver_name | driver_license | driver_phone
truck_license_plate | insurance | carrier
last_updated_at                                            ← NEW (col S, index 18)
```

`last_updated_at` is populated only when a WHPO is **updated** (not on initial submission — blank for first-time rows).

**Sheet `VendorUsers` — table named `VendorUsers` (6 columns)**

Vendor user accounts. **Excel is the source of truth for these** (no Postgres mirror). Read on every login.

```
email | full_name | company | password_hash | registered_at | last_login_at
```

`password_hash` is bcrypt. Stored in Excel because Tiana wanted full visibility of vendor accounts in the workbook.

### Critical relationships

- WHPO (vendor billing ref, 8 digits, **UNIQUE**) → DO (1:1) → Container (1+ per DO) → ContainerLine (SKU + qty)
- Driver info lives on Container (carrier, driver_name, driver_license, driver_phone, truck_license_plate, insurance) — one set per container regardless of SKU count
- 196 grid lots on Floor 1 (A–P × 1–18 irregular) + 2 SOLAR bulk lots on Floor 3 + 0 lots on Floor 2

---

## 5. Business rules / domain knowledge

- **WHPO number**: exactly 8 digits. Vendor's billing reference. **UNIQUE** — duplicate submissions now rejected with HTTP 409 + clear error pointing at the Update flow (was previously idempotent-replay, changed 2026-05-18).
- **DO number**: `DO-{year}-{4 digit seq}`. Sequential per year. 1:1 with WHPO. Sequence gaps are OK after wipes.
- **Container number**: ISO 6346 (4 letters + 7 digits). The 11th digit is a check digit; OCR auto-corrects.
- **Lots**: 23 × 70 ft = **1,610 sqft each**, ~60 pallet capacity (16 sqft per pallet with aisle allowance).
- **Pallet mode**: per-SKU master data. `logical` = items accumulate into pallets at scan time; `physical` = pre-palletized.
- **Driver info is per-container**, never per-WHPO. A 2-container WHPO can have different drivers.
- **Carrier** = the transport/distributor company (e.g., "2Fast Transportation"). Distinct from the vendor (TQL Trading Inc.).
- **Lot assignment**: sqft-based. Packed largest-free-first, alphabetical tiebreak. Without packaging fields (we removed the vendor-facing packaging form 2026-05-18), assignment falls back to SKU master data.
- **Operator UX rule**: zero decisions. System picks lots, auto-cuts at capacity, auto-finishes at manifest qty.
- **Update flow lock**: vendor cannot amend a WHPO if **any** of its containers is in `receiving` or `received` status. Manager bypass: use the standalone Driver/Truck Info flow (which has no lock).

---

## 6. User-facing surfaces — THREE distinct portals in one React app

The frontend is a single Vite/React app at **`http://localhost:5173`**.

### A. Vendor portal (public — `/vendor` is the default landing)

URL structure:

| Path | What it is |
|---|---|
| `/vendor` | **Welcome page** — two tiles: "Register" (new account) / "Sign in" (returning) |
| `/vendor/register` | Registration form (free-text company, name, email, password) |
| `/vendor/login` | Sign-in |
| `/vendor/forgot-password` | Self-service password reset |
| `/vendor-intake` | Intake chooser (3 tiles) — gated: unauthenticated → redirect to `/vendor` |

**Session**: JWT in **React state + module-level cache only**. No localStorage. **Any browser refresh logs the vendor out** (intentional per security requirement).

**Sign-out**: every sign-out button (chrome + in-form badge) redirects to `/vendor` welcome page.

**Vendor intake chooser** (3 tiles at `/vendor-intake` after login):
1. **New Shipment** — paste shipment lines in the natural email format. WHPO# uniqueness enforced.
2. **Driver & Truck Info** — attach carrier + driver + plate + insurance to a container by WHPO# + container picker.
3. **Update Existing Shipment** — amendment flow (new). See section 8.

### B. Operator portal (PIN login required)

URL: after `/login` as an operator → `/operator`.

Single-screen scan flow at the dock. Chrome: **navy** top bar (vs. vendor portal's cyan — signals "internal tool"). Camera/photo capture, OCR check, scan input, finish button. Big touch targets for handheld use.

### C. Manager portal (PIN login required)

URL: after `/login` as manager/developer → `/manager`. Chrome: **navy** top bar with white tabs nav + yellow underline on active tab.

5 tabs:

| Tab | Path | Purpose |
|---|---|---|
| **Dashboard** | `/manager` (default) | KPI tiles + activity feed (10s auto-refresh). `whpo_updated` events show with amber pencil icon — distinct from new submissions. |
| **Delivery Orders** | `/manager` (DOs tab) | DO list, drill into `/manager/dos/:id` |
| **Warehouse Map** | `/manager` (Lots tab) | 196-cell Floor 1 grid + bulk lots + click → `/manager/lots/:id` |
| **Exceptions** | `/manager` (Exceptions tab) | Open exceptions, Resolve button → modal |
| **Inbound** | `/manager` (Inbound tab) | 19-col vendor data view + CSV export + **Pull from Excel** + **Resend driver info** + "Last updated" amber chip on rows changed within 24h |

### Frontend route table

| Path | Auth | Component |
|---|---|---|
| `/` | redirects by role | `<Home>` |
| `/login` | public | `LoginPage` (staff PIN) |
| `/vendor` | public | `VendorWelcomePage` |
| `/vendor/register` | public | `VendorRegisterPage` |
| `/vendor/login` | public | `VendorLoginPage` |
| `/vendor/forgot-password` | public | `VendorForgotPasswordPage` |
| `/vendor-intake` | public (redirects to `/vendor` if not logged in for the auth-required flows) | `VendorIntakePage` |
| `/operator` | operator role | `OperatorPage` |
| `/manager` | manager/developer role | `ManagerPage` |
| `/manager/dos/:do_id` | manager/developer role | `DODetailPage` |
| `/manager/lots/:lot_id` | manager/developer role | `LotDetailPage` |
| `*` | any | falls back to `/` |

### Test PINs (placeholder STAFF dict in `src/auth/staff.ts`)
```
ken      / 0000   developer  → /manager
jerry    / 1111   manager    → /manager
erica    / 2222   manager    → /manager
sonia    / 3333   manager    → /manager
lisa     / 1234   operator   → /operator
andrew   / 1234   operator   → /operator
karen    / 1234   operator   → /operator
giovanni / 1234   operator   → /operator
mike     / 1234   operator   → /operator
deon     / 1234   operator   → /operator
```

---

## 7. Vendor authentication system

Excel is the source of truth for vendor user records. Backend stores nothing in Postgres for vendor users (just for their associated customers).

### 7a. Endpoints (5)

| Method | Path | Purpose |
|---|---|---|
| POST | `/vendor/auth/register` | Create new account. Auto-creates Postgres customer if company is new. Returns JWT + user info. 409 on duplicate email. |
| POST | `/vendor/auth/login` | Bcrypt verify against Excel. Updates `last_login_at`. Returns JWT. 401 on wrong creds. |
| GET | `/vendor/auth/me` | Decode JWT from `Authorization: Bearer …`, return claims. |
| GET | `/vendor/auth/customers` | Public — returns customer names list. |
| POST | `/vendor/auth/reset-password` | Email + new password → overwrites bcrypt hash in Excel + returns JWT. 404 if email not found. **No email verification step** — flagged limitation. |

### 7b. JWT details

- HS256, secret in `JWT_SECRET` env var (24h expiry)
- Claims: `sub` (email), `name`, `company`, `iat`, `exp`
- Issued by `vendor_auth_service.create_access_token`
- Backend deps: `vendor_auth_service.current_vendor_optional` and `current_vendor_required`

### 7c. Frontend session model

`VendorAuthContext` (in `src/auth/VendorAuthContext.tsx`):
- React state holds the JWT + user (email, full_name, company)
- A module-level `_currentToken` variable mirrors state so `readVendorToken()` works from non-React contexts (the API client)
- **No localStorage / sessionStorage** — refresh wipes everything
- API client (`src/api/client.ts`) auto-attaches `Authorization: Bearer <token>` to every request via `readVendorToken()`

### 7d. Excel storage: `VendorUsers` table

6 columns: `email | full_name | company | password_hash | registered_at | last_login_at`.

All reads/writes routed through the **`cn-warehouse-vendors-ops`** Logic App which runs the `VendorOps` Office Script (see section 9).

---

## 8. Update / amendment flow

Lets vendors fix last-minute changes to a submitted shipment.

### 8a. UX

Vendor → `/vendor-intake` → **Update existing shipment** tile → 2-stage flow:

1. **Lookup**: enter 8-digit WHPO# → calls `GET /vendor/whpo/{whpo}/current`
2. **Edit**: form pre-filled with current state. Editable fields per container:
   - **Container #** (changeable — last-minute swaps)
   - **Arrival date / time**
   - **Carrier, driver name, driver license, driver phone, truck plate, insurance** — pre-filled with current values; clear a field to wipe it
   - **SKU lines** — add/remove rows, edit sku/qty/product_type
3. **Submit**: response shows structured change list (`field: before → after`) + Excel-resync status

If any container in the WHPO is in `receiving` or `received` status, the form shows a red **"Receiving in progress"** banner, the submit button is disabled, and the backend returns HTTP 409 if attempted anyway.

### 8b. Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/vendor/whpo/{whpo_number}/current` | Returns `WHPOCurrentState`: DO #, customer, expected_arrival_date, per-container lock status, driver fields, lines. |
| PUT | `/vendor/whpo/{whpo_number}/update` | Apply changes. Computes per-field diff. Writes activity_log `whpo_updated` entry with structured `payload.changes` array. Triggers `delete_inbound_rows_for_whpo` + `append_rows` to re-sync InboundTable. Returns change list + summary + `excel_resynced` bool. |

### 8c. Audit trail

Every update writes a single `ActivityLog` row:
- `kind = "whpo_updated"`
- `actor = "vendor"`
- `ref_type = "do"`, `ref_id = do.id`
- `message` = human-readable summary like *"WHPO 12345678 updated by vendor — 1 WHPO field, 3 container fields, 3 SKU line changes."*
- `payload = {"changes": [WHPOChange, ...]}` — list of structured before/after diffs scoped to `whpo` / `container` / `line`

Manager dashboard activity feed picks up `whpo_updated` events and shows them with an amber pencil icon. The Inbound view also shows an **"Updated Xh ago"** amber chip on rows for WHPOs updated within 24h, and tints the row faint amber.

### 8d. Excel sync model

The amendment flow uses **delete + re-append** rather than per-cell updates:
1. Backend calls `sheet_sync.delete_inbound_rows_for_whpo(whpo_number)` — Office Script action `delete_whpo_rows` removes every row matching that WHPO from InboundTable
2. Backend re-fetches current Postgres state via `fetch_inbound_rows_for_do(do_id)`
3. Backend calls `sheet_sync.append_rows(rows)` — fires both the Function App (CSV blob) and the InboundTable APPEND Logic App

This is more invasive than the original per-row UPDATE pattern but cleanly handles structural changes (added/removed lines, changed container_no) where in-place updates would be brittle.

---

## 9. Azure integrations

**Tenant**: University of Southern California (USC)
**Subscription**: Azure for Students (`tvpinto@usc.edu`)
**Resource group**: `cn-warehouse` (Central US)

### 9a. Three resources

| Resource | Workflow GUID | Purpose | Status |
|---|---|---|---|
| Function App `cn-warehouse-fn` + storage `cnwarehouse9c4e` | n/a | Writes inbound CSV to blob storage as audit log | Active |
| Logic App `cn-warehouse-onedrive-sync` | `825b6c67…46eaf7` | APPEND new rows to InboundTable | Active |
| Logic App `cn-warehouse-vendors-ops` | `1a771eab1424d8099dc47e10459751b` (prod-22) | Unified Office Script dispatcher — handles ALL VendorUsers ops + InboundTable update/delete/list | Active |
| Logic App `cn-warehouse-driver-update` | `218c10d9…f53f` | (Was: driver-info UPDATE) | **DEAD — unused** |

### 9b. Logic App `cn-warehouse-vendors-ops` — the unified dispatcher

URL in `.env` as `ONEDRIVE_VENDORS_OPS_URL` (region: prod-22.centralus).

Schema:
- HTTP trigger receives `{action: string, payload?: string}` — payload is a JSON-encoded string of action-specific args
- Action: Excel Online (Business) → **Run script** → `VendorOps` script with parameters `action` + `payload` wired from `triggerBody()`
- Response: status 200, body = `@body('Run_script')?['result']`

Supported actions (handled by `VendorOps` Office Script — full source in 9e):
- `list` — return all VendorUsers rows
- `append` — add a row to VendorUsers
- `update_last_login` — set last_login_at by email
- `update_password` — set password_hash by email
- `update_driver` — set driver fields on InboundTable rows matching container_no (also handles `carrier`)
- `list_inbound` — return all InboundTable rows (used by Pull from Excel)
- `delete_whpo_rows` — delete all InboundTable rows matching a whpo_number
- `clear_inbound_table` — delete every row from InboundTable (preserves headers)

### 9c. Logic App `cn-warehouse-onedrive-sync` — InboundTable APPEND

URL in `.env` as `ONEDRIVE_WEBHOOK_URL`. HTTP trigger → "For each row" → "Add a row into a table" mapped to all 19 InboundTable columns (`items('For_each')[0..18]`).

**If you add a column to InboundTable, you MUST update this Logic App's row mapping** (designer → re-pick Table dropdown → map new column to its index).

### 9d. Function App `cn-warehouse-fn` — Blob CSV (audit log)

Writes inbound rows as CSV to Blob Storage `cnwarehouse9c4e/inbound/inbound.csv`. HEADERS in `function_app.py` is the canonical 19-column list — keep in sync with `sheet_sync.HEADERS` and the InboundTable.

Deploy from VS Code: open `cn-warehouse-fn/` folder → right-click Function App in Azure sidebar → Deploy to Function App.

**Skippable for development** — Postgres + Excel are the working stores; the CSV is just a forensic audit.

### 9e. Office Script `VendorOps` (source of truth)

Lives inside `CN-Warehouse-Inbound.xlsx` (Automate tab → All Scripts → VendorOps). The Logic App calls it via the Excel Online connector.

**Canonical version** (paste this if it gets corrupted):

```typescript
function main(
  workbook: ExcelScript.Workbook,
  action: string,
  payload?: string
): string {
  const VU_COLS = ["email", "full_name", "company", "password_hash", "registered_at", "last_login_at"];

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

  return JSON.stringify({ error: "unknown action: " + action });
}
```

**Critical**: this script has 8 actions. If you regenerate the Logic App, the Run Script action must wire `action` + `payload` from the trigger (via dynamic content). The Office Scripts connector caches metadata; if the script's `main()` signature doesn't surface parameters in the designer, **simplify the return type to `: string`** (complex inline return types confuse the connector — discovered 2026-05-18) and rename to a fresh script name to force re-detection.

### 9f. Excel column order (must match across Function App HEADERS + sheet_sync HEADERS + InboundTable + Logic App APPEND mapping)

```
0  container_no
1  whpo_number
2  expected_arrival_date
3  expected_arrival_time
4  qty
5  product_type
6  sku
7  customer
8  do_number
9  submitter_name
10 submitter_email
11 submitted_at
12 driver_name
13 driver_license
14 driver_phone
15 truck_license_plate
16 insurance
17 carrier
18 last_updated_at
```

### 9g. Auth model

- Both Logic Apps' Excel connector signs in as `tvpinto@usc.edu` (delegated)
- The OneDrive Excel file lives in this account's OneDrive (not Tiana's personal Microsoft)
- Function App uses `AzureWebJobsStorage` → writes to `cnwarehouse9c4e`
- Backend has no Microsoft creds itself; everything goes through webhook URLs

---

## 10. Backend API endpoints (full list)

### Vendor (public + JWT-optional)
| Method | Path | Purpose |
|---|---|---|
| POST | `/vendor/whpo` | New shipment intake (multiple containers + lines). **Rejects duplicate WHPO# with 409.** |
| GET | `/vendor/whpo/{whpo_number}/containers` | List containers for the driver-info flow |
| PATCH | `/vendor/container/{container_no}/driver-info` | Update driver/truck on one container (includes carrier, driver_phone) |
| GET | `/vendor/whpo/{whpo_number}/current` | Full current state of a WHPO for the Update flow |
| PUT | `/vendor/whpo/{whpo_number}/update` | Apply diff-based update; writes whpo_updated activity log; resyncs Excel |

### Vendor auth (public + JWT)
| Method | Path | Purpose |
|---|---|---|
| POST | `/vendor/auth/register` | Excel-backed registration + Postgres customer auto-create + JWT |
| POST | `/vendor/auth/login` | Bcrypt verify, JWT issue |
| GET | `/vendor/auth/me` | Decode bearer JWT, return claims |
| GET | `/vendor/auth/customers` | Public — customer names from Postgres |
| POST | `/vendor/auth/reset-password` | Overwrite bcrypt hash in Excel by email; auto-login |

### Operator
| Method | Path | Purpose |
|---|---|---|
| POST | `/operator/container/lookup` | OCR-verified container → DO match + lot plan + receipt |
| POST | `/operator/scan` | Single barcode event |
| POST | `/operator/container/finish` | Close container |

### Manager
| Method | Path | Purpose |
|---|---|---|
| GET | `/manager/dashboard` | KPI tiles + activity feed |
| GET | `/manager/dos` | DO list |
| GET | `/manager/dos/{id}` | DO drill-down |
| GET | `/manager/lots` | Warehouse map data |
| GET | `/manager/lots/{id}` | Lot detail |
| GET | `/manager/exceptions` | Open exceptions |
| POST | `/manager/exceptions/{id}/resolve` | Resolve unknown-SKU exception (creates/updates SKU master) |
| GET | `/manager/database/tables` | Generic table list (row counts) |
| GET | `/manager/database/rows/{table}` | Generic table rows |
| GET | `/manager/database/inbound` | Flat vendor data view (19 fields per row, incl. last_updated_at) |
| GET | `/manager/database/inbound.csv` | CSV export |
| GET | `/manager/database/inbound/status` | "is the sync configured?" |
| POST | `/manager/database/inbound/sync` | Re-fire driver-info UPDATE webhook (Resend driver info button) |
| POST | `/manager/database/inbound/pull-from-excel` | Read InboundTable from Excel and pull manual driver-field edits back into Postgres |
| POST | `/manager/database/inbound/full-resync` | Wipe InboundTable in Excel and re-append every Postgres row (one-time for schema migrations) |
| POST | `/manager/database/wipe-transactional` | Atomic destructive wipe: clears InboundTable + TRUNCATEs Postgres transactional tables. Preserves master data + VendorUsers. |

### OCR
| Method | Path | Purpose |
|---|---|---|
| POST | `/ocr/container-photo` | Upload photo → EasyOCR + BIC regex + check-digit-correction |

---

## 11. Running services

### Postgres
```bash
brew services start postgresql@16
```
DB name: `cn_warehouse`. User: `Tiana` (macOS user). No password locally.

### Backend (FastAPI, port 8000)
```bash
cd /Users/Tiana/Desktop/Conquer-Nation-Warehouse/backend
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```
Log file (when run in background): `/tmp/backend.log`.
**DIAG `print()` statements** still in `app/routers/vendor.py` and `app/services/sheet_sync.py` for webhook tracing — useful for debugging, remove before production deploy.

### Frontend (Vite, port 5173)
```bash
cd /Users/Tiana/Desktop/Conquer-Nation-Warehouse/frontend
npm run dev
```
Open `http://localhost:5173`. Vite has `host: true` and proxies `/api → http://localhost:8000`.

### Tests
```bash
cd backend
uv run pytest tests/                 # 39 passing
```

### Seed
```bash
cd backend
uv run python -m app.seed            # idempotent — creates 5 customers incl. TQL Trading Inc.
uv run python -m app.seed_floor1     # loads 196 Floor 1 cells
```

### Migrations
```bash
cd backend
uv run alembic upgrade head          # latest = b2c3d4e5f6a7 (container carrier field)
```

11 migrations total. Latest two from 2026-05-18:
- `a1b2c3d4e5f6_container_driver_phone.py` — adds `containers.driver_phone`
- `b2c3d4e5f6a7_container_carrier.py` — adds `containers.carrier`

### Drop + reseed from scratch
```bash
dropdb cn_warehouse && createdb cn_warehouse && \
  cd backend && uv run alembic upgrade head && \
  uv run python -m app.seed && uv run python -m app.seed_floor1
```

### `.env` keys
```bash
DATABASE_URL=postgresql+asyncpg://localhost/cn_warehouse

# Inbound APPEND fan-out
INBOUND_WEBHOOK_URL=...        # Function App AppendInbound (blob CSV)
ONEDRIVE_WEBHOOK_URL=...       # cn-warehouse-onedrive-sync (InboundTable APPEND)

# Unified vendors-ops Logic App — handles ALL VendorUsers + InboundTable mutations
ONEDRIVE_VENDORS_OPS_URL=https://prod-22.centralus.logic.azure.com:443/workflows/1a771eab.../triggers/.../invoke?...&sig=...

# Dead — kept for backwards-compat, backend ignores it
ONEDRIVE_UPDATE_WEBHOOK_URL=...

# Vendor session JWTs (HS256). Generate with:
#   python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
JWT_SECRET=...
JWT_EXPIRY_HOURS=24
```

---

## 12. Features built (what works end-to-end)

### Vendor portal
- ✅ Welcome page (Register / Sign in tiles) at `/vendor` — default landing
- ✅ Self-service registration with free-text company → auto-creates Postgres customer
- ✅ Login with email + password (bcrypt-verified against Excel)
- ✅ Forgot-password reset (no email verification — flagged as limitation)
- ✅ Friendly 409 on duplicate email registration with "Sign in instead" CTA
- ✅ Session in memory only — refresh = logout (security requirement)
- ✅ JWT auto-attached to API calls; auth-aware "Submitting as" badge in New Shipment form
- ✅ Sign-out from anywhere → `/vendor` welcome page
- ✅ Three intake tiles: New Shipment / Driver & Truck / Update existing
- ✅ Vendor inbound paste parser, multi-WHPO submission with duplicate-rejection (was idempotent-replay)
- ✅ Driver-info flow with carrier + driver_phone fields (auto-fill name/email from JWT)
- ✅ **Update existing shipment** — full editor for container/lines/driver-info per WHPO, locked containers blocked, structured diff + audit, Excel resync
- ✅ Brand-themed UI throughout (cyan top bar + yellow accent + navy headings/footer per conquernation.com)

### Operator portal
- ✅ Brand-themed (navy top bar)
- ✅ Photo OCR → ISO 6346 check-digit correction → DO lookup
- ✅ Scan flow: pallet auto-fill, auto-cut at capacity, auto-finish at manifest qty

### Manager portal
- ✅ Brand-themed (navy top bar + yellow active-tab underline)
- ✅ Dashboard with KPI tiles + activity feed (10s refresh) including `whpo_updated` events with amber pencil icon
- ✅ DO list/detail, Warehouse Map (196-cell grid), Exceptions queue with resolve modal
- ✅ Inbound view (19 columns) + CSV export
- ✅ **Pull from Excel** — read InboundTable and apply manual driver-field edits back to Postgres
- ✅ **Resend driver info** — re-fire UPDATE webhook for all containers with driver info
- ✅ **Last updated** column with amber chip + row tint for WHPOs amended within 24h
- ✅ Full-resync endpoint (wipe + re-append all)
- ✅ Wipe-transactional endpoint (atomic Postgres + Excel wipe)

### Azure / sync
- ✅ Unified `cn-warehouse-vendors-ops` Logic App handling 8 actions via Office Script dispatcher
- ✅ `cn-warehouse-onedrive-sync` for InboundTable APPEND
- ✅ Function App writing audit CSV to blob

---

## 13. Pending / known limitations

| Status | Item |
|---|---|
| Pending | MS 365 SSO (currently PIN-only via STAFF dict) |
| Pending | **Email-link verification for password reset** — currently anyone who knows a vendor's email can reset their password. Acceptable for small internal portal; flag before going public. |
| Pending | Damage flag mid-scan (Lime 3PL prototype had it; deferred per Ken's earlier scope) |
| Pending | Outbound / pick-pack-ship flow (deferred to v2 explicitly) |
| Pending | Real-time updates to manager hub via WebSocket / SSE (we use 10s polling) |
| Pending | Replace placeholder STAFF dict with real Conquer Nation staff list |
| Pending | Server-side PIN hashing (currently plaintext in frontend dict) |
| Pending | Tests for vendor auth + Update flow endpoints |
| Pending | Frontend partial-batch handling on duplicate-WHPO 409 — when submitting multiple WHPOs in one paste, the failing one stops the loop and the user sees only the first 409 (earlier WHPOs in the batch may have already posted). |
| Pending | Production hosting — pick Fly.io / Render / Azure Container Apps for backend + CDN for frontend. Then swap `localhost:5173` references in vendor-portal URLs. |
| Known | `tesseract.js` still in frontend `package.json` but no longer imported (OCR moved server-side). Can `npm uninstall`. |
| Known | Function App's CSV is append-only — driver-info updates flow only to InboundTable Excel (via Office Script), not to the audit CSV. The CSV is a raw audit log; if needed in sync, refactor the function to update by container_no. |
| Known | Old `WHPO.driver_*` columns still exist (deprecated, reads come from `Container.driver_*`). Migration to drop the WHPO fields is safe to schedule. |
| Known | `cn-warehouse-driver-update` Logic App is dead/unused. Backend ignores `ONEDRIVE_UPDATE_WEBHOOK_URL`. Delete from Azure when convenient. |
| Known | **DIAG `print()` statements** still in `app/routers/vendor.py` and `app/services/sheet_sync.py` from this session's debugging. Useful for tracing webhook firings — remove before any production deploy. |
| Known | **Safari + localhost quirk** — Safari sometimes resolves `localhost` to IPv6 (`::1`) which IPv4-only listeners refuse. Backend started with `--host 0.0.0.0`, frontend Vite has `host: true`, and frontend API base is `/api` (Vite proxy) — these three together avoid the issue. Don't change them. |
| Known | **MSAL.js** referenced in staff login's disabled "Sign in with Microsoft" button but no actual MSAL config exists. Placeholder for future SSO. |
| Known | Excel `list_inbound` returns raw cell values, so dates appear as Excel serials (e.g., `46206` = 2026-07-03) and times as fractions (`0.604166…` = 14:30). Only affects scripts pulling from Excel. The viewable Excel sheet shows formatted dates normally. Backend pull-from-excel only touches driver string fields, unaffected. |
| Known | The Office Scripts connector in this tenant has trouble parsing scripts with complex inline return types. Use `: string` + `JSON.stringify` everywhere. If parameters don't surface in the Logic App designer, rename the script to force fresh metadata. |
| Known | Vendor sign-in does NOT persist across page refreshes — by design (Tiana's requirement). Internal SPA navigation preserves the session. |
| Known | Logic App ID changes when the workflow is rebuilt (a save can reissue the GUID). If the URL stops working, check Azure portal for the current trigger URL and update `ONEDRIVE_VENDORS_OPS_URL`. |
| Known | New Logic Apps designer's Code view is often **read-only** in this tenant. Mutations to action body must go through the visual designer, not direct JSON editing. |

---

## 14. User context (Tiana)

- Builds for **Conquer Nation Inc.** (parent company of two of her sibling projects).
- Has Azure-for-Students subscription. **Cannot create Entra ID app registrations** in her USC tenant — this is why we used Azure Logic Apps + Function App (resource-scoped) instead of MS Graph direct.
- Prefers **VS Code integrated terminal** over plain Terminal.
- Prefers **terse responses, command-line style**. Less narration, more action.
- Wants **forward momentum** — dismisses optional questions when she can. Make reasonable defaults and proceed.
- Frequently shows error screenshots — diagnose immediately and propose the smallest fix.
- Trusts Claude to architect when she says "do it" or "yes go".
- **Doesn't want existing working things touched** when making new changes — "don't modify any existing connections (apart from what is necessary)."

---

## 15. Communication style hints for the next session

- One paragraph per concept, line-breaks instead of bullet walls.
- Show diffs and code blocks; do less explaining.
- Pick reasonable defaults when she says "you decide" or "do it".
- Don't ask 4 clarifying questions in a row. Ask 1, proceed, course-correct.
- Don't apologize for past sessions' decisions; just fix and move on.
- Don't mention the TodoWrite reminder system or system reminders.
- Confirm she's seeing what you describe before declaring success.
- For Logic App / Office Script issues, the new designer's Code view is often **read-only** in her tenant — fixes need to go through the visual designer, not direct JSON editing.

---

## 16. How to pick up tomorrow

If the next session starts cold, prove the system still works in this order:

```bash
# 1. Postgres
psql cn_warehouse -c 'SELECT count(*) FROM customers;'              # should be 5 (Lime/Boviet/PA Wire/National Plastic/TQL)
psql cn_warehouse -c 'SELECT count(*) FROM whpos;'                  # whatever state we left it

# 2. Backend
cd /Users/Tiana/Desktop/Conquer-Nation-Warehouse/backend
uv run pytest tests/                                                # 39 passing
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload &

# 3. Frontend
cd ../frontend
npm run dev                                                         # localhost:5173

# 4. Smoke test the vendor auth chain
URL=$(grep ONEDRIVE_VENDORS_OPS_URL backend/.env | cut -d= -f2- | tr -d '"')
curl -s -X POST "$URL" -H 'Content-Type: application/json' -d '{"action":"list"}'
# → should return {"users": [...]} with at least tpinto@conquernation.com and pdave@conquernation.com

# 5. Smoke test the public endpoints
curl -s http://localhost:8000/vendor/auth/customers
# → ["Boviet Solar","Lime Mobility","National Plastic","Pan American Wire MFG","TQL Trading Inc."]

# 6. Smoke test a duplicate-WHPO rejection
curl -s -X POST http://localhost:8000/vendor/whpo \
  -H 'Content-Type: application/json' \
  -d '{"customer":"TQL Trading Inc.","whpo_number":"<existing-WHPO>",...}'
# → 409 with "WHPO X is already on file..."
```

Verify visually:
- Open `http://localhost:5173/vendor` — welcome page with two tiles
- Open `http://localhost:5173/login` → sign in as ken/0000 → `/manager` → Inbound tab shows whatever's in Postgres + InboundTable
- Open `CN-Warehouse-Inbound.xlsx` on OneDrive — InboundTable + VendorUsers sheets both populated correctly

If anything's broken, the most common gotchas are listed in section 13.

---

## 17. Onboarding a new vendor (procedure)

1. Send them the URL `http://localhost:5173/vendor/register` (or eventually the deployed equivalent).
2. They self-register with **free-text company** input — Postgres customer is auto-created on registration.
3. They land on `/vendor-intake` after register. Three tiles: New Shipment / Driver & Truck / Update.
4. For new shipments: paste in `CONTAINER WHPO DATE TIME QTY TYPE SKU` format.
5. For driver info: enter WHPO# → pick container → fill 6 fields (carrier + driver_name + driver_license + driver_phone + truck_license_plate + insurance).
6. For amendments: enter WHPO# → edit any field → submit. Blocked if any container is already being received.

**You don't need to manually add the customer to Postgres anymore** — the register flow handles it.

---

## 18. Brand palette (for any UI work)

Sourced from `conquernation.com/index.css`:

- Cyan **`#0093D0`** — vendor portal top bar, primary chrome accents, focus rings, iconography
- Deep navy **`#1B4676`** / **`#224E72`** — operator + manager top bars, all H1/H2 headings, body emphasis, footer
- Signal yellow **`#FED641`** / **`#E6C200`** hover — primary CTA buttons throughout
- Slate-50 white background, slate-200 borders, slate-600/700 body text

Each portal uses a different top-bar color to disambiguate:
- **Vendor**: cyan top bar (public-facing, welcoming)
- **Operator + Manager**: navy top bar (internal tool, authoritative)

All three share the yellow accent strip below the top bar and yellow CTA buttons.

---

## 19. Migration history (chronological)

All 11 migrations in `backend/alembic/versions/`, oldest → newest:

| Revision | File | Purpose |
|---|---|---|
| `e2ed3602fc4e` | `_initial_schema.py` | Base schema — customers, skus, floors, lots, whpos, dos, containers, container_lines, lot_assignments, receipts, pallets, scans, exceptions, activity_log |
| `b9f24bef22fe` | `_container_packaging_fields.py` | `containers.on_pallet`, `pallet_length_in/width_in`, `item_length_in/width_in/height_in` |
| `f0bf04d3f58b` | `_container_arrival_time_and_line_product_.py` | `containers.expected_arrival_time` + `container_lines.product_type` |
| `c5b4ddff7896` | `_add_grid_coords_to_lots.py` | `lots.grid_row` + `lots.grid_col` for the 196-cell Floor 1 layout |
| `979d959b2156` | `_add_sku_id_to_lot_assignments.py` | `lot_assignments.sku_id` FK |
| `3c6b3348c600` | `_sqft_fields_on_lot_assignments_and_.py` | `lot_assignments.planned_sqft` + `actual_sqft` |
| `de310e4a215b` | `_whpo_driver_info_fields.py` | (deprecated) `whpos.driver_*` columns — superseded by container-level fields |
| `7652edc5569f` | `_container_driver_info_fields.py` | `containers.driver_name`, `driver_license`, `truck_license_plate`, `insurance`, `driver_info_received_at` |
| `a1b2c3d4e5f6` | `_container_driver_phone.py` | `containers.driver_phone` — **added 2026-05-18** |
| `b2c3d4e5f6a7` | `_container_carrier.py` | `containers.carrier` — **added 2026-05-18, current head** |

Apply latest: `cd backend && uv run alembic upgrade head`

---

## 20. Manual setup checklist (Excel + Azure)

If you need to rebuild any Azure side after a corruption / accidental deletion / new tenant:

### A. Excel workbook setup

1. In OneDrive (`tvpinto@usc.edu`), create `CN-Warehouse-Inbound.xlsx`
2. Add sheet `inboundTable` (any tab name — table name is what matters)
3. In `A1:S1`, paste tab-separated headers in this exact order:
   ```
   container_no	whpo_number	expected_arrival_date	expected_arrival_time	qty	product_type	sku	customer	do_number	submitter_name	submitter_email	submitted_at	driver_name	driver_license	driver_phone	truck_license_plate	insurance	carrier	last_updated_at
   ```
4. Select `A1:S1` → **Insert → Table** → check "My table has headers" → OK
5. **Table Design** → **Table Name** → set to exactly `InboundTable` → Enter
6. Add a second sheet, name it `VendorUsers` or similar
7. In `A1:F1` paste:
   ```
   email	full_name	company	password_hash	registered_at	last_login_at
   ```
8. Select `A1:F1` → **Insert → Table** → check headers → OK
9. **Table Name** → set to exactly `VendorUsers`
10. Save the workbook

### B. Office Script setup

1. In Excel, **Automate** tab → **New Script** → name it `VendorOps`
2. Paste the canonical body from section 9e
3. Save

### C. Logic App `cn-warehouse-vendors-ops` (the unified one)

1. Azure portal → Resource group `cn-warehouse` → **+ Add** → **Logic App (Consumption)** → name `cn-warehouse-vendors-ops`, Central US, Consumption plan
2. **Blank Logic App** in designer
3. **Trigger** = "When an HTTP request is received". Request body JSON schema:
   ```json
   {"type":"object","properties":{"action":{"type":"string"},"payload":{"type":"string"}}}
   ```
4. **Action** = Excel Online (Business) → Run script
   - Location: OneDrive for Business · Library: OneDrive · File: `/CN-Warehouse-Inbound.xlsx`
   - Script: `VendorOps`
   - **`action`** input → dynamic content **`action`** (from trigger)
   - **`payload`** input → dynamic content **`payload`** (from trigger)
5. **Action** = Response — Status: `200`, Body: `@body('Run_script')?['result']`
6. **Save** → copy the trigger HTTP POST URL → paste into backend `.env` as `ONEDRIVE_VENDORS_OPS_URL`

### D. Logic App `cn-warehouse-onedrive-sync` (the InboundTable APPEND)

1. Create another Logic App named `cn-warehouse-onedrive-sync`
2. Trigger: HTTP request with schema:
   ```json
   {"type":"object","properties":{"rows":{"type":"array","items":{"type":"array"}}}}
   ```
3. **For each** → loop over `rows`
4. Inside loop: **Add a row into a table** → File `CN-Warehouse-Inbound.xlsx`, Table `InboundTable`. Map all 19 columns:
   - container_no = `items('For_each')[0]`
   - whpo_number = `items('For_each')[1]`
   - ... (see section 9f for the full index list)
   - last_updated_at = `items('For_each')[18]`
5. **Save** → copy trigger URL → paste into `.env` as `ONEDRIVE_WEBHOOK_URL`

### E. Function App `cn-warehouse-fn`

Already exists; rarely needs touching. If redeploying:
1. Open `cn-warehouse-fn/` in VS Code → right-click resource in Azure sidebar → **Deploy to Function App** → confirm overwrite
2. Make sure `function_app.py` `HEADERS` list matches the 19-column order in section 9f

### F. `.env` reference

```bash
DATABASE_URL=postgresql+asyncpg://localhost/cn_warehouse
CORS_ORIGINS=["http://localhost:5173"]

INBOUND_WEBHOOK_URL=<Function App AppendInbound trigger URL>
ONEDRIVE_WEBHOOK_URL=<cn-warehouse-onedrive-sync trigger URL>
ONEDRIVE_VENDORS_OPS_URL=<cn-warehouse-vendors-ops trigger URL>
ONEDRIVE_UPDATE_WEBHOOK_URL=<DEAD — kept for backwards compat, ignored>

JWT_SECRET=<64-char URL-safe random — generate with python3 -c 'import secrets; print(secrets.token_urlsafe(48))'>
JWT_EXPIRY_HOURS=24
```

---

## 21. Debugging playbook (from this session's incidents)

### "unknown action: undefined" from Office Script

**Cause**: Logic App's Run Script action isn't passing `action`/`payload` parameters to the script.

**Fix sequence**:
1. Open the Logic App → designer → click the Run Script action
2. Check Parameters section — the `action` and `payload` inputs must show below the Script dropdown
3. If they DON'T show: the Office Scripts connector can't read the script's parameter signature. Causes:
   - The script's `main()` signature uses complex inline return types (e.g., `: { users?: [], appended?: number, … }`). **Fix**: simplify to `: string` and `JSON.stringify` everything.
   - The connector cached the old script metadata. **Fix**: pick a different script from the dropdown, wait 2s, pick the correct one back. Or rename the script to force fresh detection (e.g., `VendorOps` → `VendorOpsV2`).
4. If they DO show: wire them to `triggerBody()?['action']` and `triggerBody()?['payload']` via the dynamic content picker (don't type the expression by hand — pick from the popup)
5. Save the Logic App, probe again

### Logic App returns 401 `WorkflowNotFound`

**Cause**: the workflow GUID changed (Logic App was rebuilt) and the URL in `.env` points at the old GUID.

**Fix**: Azure portal → search the Logic App → designer → click trigger → copy current HTTP POST URL → paste into `.env`, restart backend.

### Excel `InsertDeleteConflict`

**Cause**: there's data immediately outside the InboundTable's current bounds, so Excel can't expand the table to add a row.

**Fix**:
1. Click any cell in InboundTable
2. Press `Cmd + End` (or use the Name Box: type `A1000`, Enter) to see where data ends
3. Select all rows below the table → right-click → **Delete → Entire Rows**
4. Select all columns right of `last_updated_at` → right-click → **Delete → Entire Columns**
5. Retry the operation. If still 409: Table Design → **Resize Table** → reset to current bounds

### Driver-info update succeeds but Excel doesn't reflect

**Likely cause**: the dead `cn-warehouse-driver-update` Logic App is still being called via stale `ONEDRIVE_UPDATE_WEBHOOK_URL`. The backend should now route ALL driver updates through `cn-warehouse-vendors-ops` (action=`update_driver`). Check `app/services/sheet_sync.py:update_driver_for_container` — it should POST to `settings.onedrive_vendors_ops_url`, NOT the dead URL.

### Office Script `getWorksheet("X")` fails after sheet rename

**Cause**: scripts that look up worksheets by name are sheet-rename-brittle.

**Fix**: use `workbook.getTable("InboundTable")` and `getRangeBetweenHeaderAndTotal()` instead — table names are stable across sheet renames. All current scripts in `VendorOps` already use this pattern.

### New Logic Apps designer Code view is read-only

**Symptom**: Code view shows raw JSON but edits don't persist on save.

**Workaround**: do all edits through the visual designer. Or use the older designer (banner "A new Logic Apps experience is available for preview!" — click X to dismiss and stay on the older one).

### Vendor sign-in returns 502 "Excel ops script error: unknown action: undefined"

Same as "unknown action: undefined" above — the Logic App isn't passing trigger fields to the script.

### Excel cells show as serial numbers (e.g., `46206`, `0.604166…`)

**Cause**: Excel stores dates/times as numeric serials internally. The `list_inbound` action returns raw cell values.

**Not a bug for users viewing the sheet** — Excel renders them as dates because the column format is set to Date. Only `list_inbound` script callers see the raw serials. Backend's `pull_inbound_from_excel` only reads string driver fields, so unaffected. If you ever need to read dates back, convert from Excel serial: `epoch_days = serial - 25569; ms = epoch_days * 86400 * 1000`.

### Vendor session disappears on refresh

**By design.** `VendorAuthContext` doesn't persist to localStorage — every refresh resets state. SPA navigation within the app preserves the session. If you want vendor sessions to persist across refreshes, revert the localStorage logic in `frontend/src/auth/VendorAuthContext.tsx`.

---

## 22. Activity log glossary

The `activity_log` table is the canonical audit trail. Schema reminder:

```
id (PK)
t (timestamptz)         — when it happened
actor (str)             — who did it: "vendor", "<email>", staff ID (ken/jerry/lisa/…)
kind (str)              — event type, one of the values below
ref_type (str)          — "do" | "container" | "exception"
ref_id (int)            — FK into the relevant table
message (str)           — human-readable summary, shown in the dashboard feed
payload (jsonb)         — structured event details
```

### Kinds emitted

| kind | actor | ref_type | message format | payload shape |
|---|---|---|---|---|
| `whpo_submitted` | submitter_email | `do` | `WHPO {N} submitted → DO-{Y}-{N} ({status})` | `{whpo_number, container_count, line_count}` |
| `whpo_updated` | `vendor` | `do` | `WHPO {N} updated by vendor — X WHPO field, Y container fields, Z SKU line changes.` | `{changes: [WHPOChange...]}` — see schema below |
| `driver_info_submitted` | `vendor` | `container` | `Driver info submitted for container {C}: {driver_name} (license {L}, truck {P})` | `{container_no, whpo_number, do_number}` |
| `container_started` | operator ID | `container` | `Operator {N} started receiving container {C}` | `{receipt_id}` |
| `container_finished` | operator ID | `container` | `Operator {N} closed container {C} — {N} items in {N} pallets` | `{pallets_created, total_scanned}` |
| `exception_opened` | system | `exception` | `Exception opened: {kind} — {sku_raw}` | `{kind, sku_raw, customer, do_number}` |
| `exception_resolved` | resolver email | `exception` | `Exception #{N} resolved — created SKU {sku}` | `{exception_id, sku_id, sku_data}` |

### `WHPOChange` payload shape (inside `whpo_updated`)

```json
{
  "scope": "whpo" | "container" | "line",
  "container_no": "TQLU…" or null,  // present for container + line scopes
  "field": "container_no" | "expected_arrival_date" | "expected_arrival_time"
         | "driver_name" | "driver_license" | "driver_phone"
         | "truck_license_plate" | "insurance" | "carrier"
         | "qty" | "product_type" | "added" | "removed",
  "before": "<value>" or null,
  "after": "<value>" or null,
  "sku": "TQL-…" or null  // present for line scope
}
```

The manager dashboard's activity feed (`DashboardTab`) maps each `kind` to an icon + color in the `ActivityIcon` component:
- `whpo_submitted` → slate inbox icon
- `whpo_updated` → **amber pencil icon** (visually distinct from new submissions)
- `driver_info_submitted` → cyan truck icon
- `container_started` → cyan package icon
- `container_finished` / `exception_resolved` → emerald check icon
- `exception_opened` → amber triangle icon

---

## 23. Common operations recipes

### Smoke test the full chain (cold start)

```bash
# 1. Backend health
curl -s http://localhost:8000/health

# 2. Vendor auth Excel chain
URL=$(grep ONEDRIVE_VENDORS_OPS_URL backend/.env | cut -d= -f2- | tr -d '"')
curl -s -X POST "$URL" -H 'Content-Type: application/json' -d '{"action":"list"}'

# 3. Public customers endpoint
curl -s http://localhost:8000/vendor/auth/customers

# 4. Register a smoke test user
curl -s -X POST http://localhost:8000/vendor/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"smoketest@example.com","password":"smoke-pass-12345","full_name":"Smoke Tester","company":"TQL Trading Inc."}'

# 5. Submit a fresh WHPO (use the JWT from step 4 OR send vendor info in body)
curl -s -X POST http://localhost:8000/vendor/whpo \
  -H 'Content-Type: application/json' \
  -d '{"customer":"TQL Trading Inc.","whpo_number":"77001111","submitter_name":"Smoke","submitter_email":"smoke@example.com","expected_arrival_date":"2026-07-01","containers":[{"container_no":"TESU1234567","expected_arrival_date":"2026-07-01","expected_arrival_time":"09:00:00","lines":[{"sku":"TEST-A","qty":10}]}]}'

# 6. Try to resubmit the same WHPO — should 409
curl -s -X POST http://localhost:8000/vendor/whpo -H 'Content-Type: application/json' \
  -d '{"customer":"TQL Trading Inc.","whpo_number":"77001111", ...same as above...}'

# 7. Update the shipment
curl -s -X PUT http://localhost:8000/vendor/whpo/77001111/update -H 'Content-Type: application/json' \
  -d '{"containers":[{"original_container_no":"TESU1234567","container_no":"TESU9999999","carrier":"Smoke Carrier","driver_name":"Smoke Driver","driver_license":"X","driver_phone":"X","truck_license_plate":"X","insurance":"X","lines":[{"sku":"TEST-A","qty":15}]}]}'
```

### Atomic wipe (Postgres + Excel)

```bash
curl -s -X POST http://localhost:8000/manager/database/wipe-transactional
```

Preserves: customers, seeded SKUs, floors, lots, VendorUsers Excel sheet.
Clears: whpos, dos, containers, container_lines, lot_assignments, receipts, pallets, scans, exceptions, activity_log, InboundTable Excel sheet, non-seeded SKUs.

### Backfill Excel after schema change

```bash
curl -s -X POST http://localhost:8000/manager/database/inbound/full-resync
```

Wipes InboundTable and re-appends every Postgres row using the current 19-column schema. Use after adding/removing columns.

### Pull manual Excel edits back into Postgres

```bash
curl -s -X POST http://localhost:8000/manager/database/inbound/pull-from-excel
```

Reads InboundTable, dedupes by container_no, updates driver fields (carrier + driver_*) in Postgres. Does NOT touch shipment data (qty, dates, lines).

### Resend driver info webhook for all containers

```bash
curl -s -X POST http://localhost:8000/manager/database/inbound/sync
```

Iterates every Postgres container with `driver_name` populated and re-fires the UPDATE webhook for each. Use when the original UPDATE failed and Excel rows are showing blank driver columns.

### List all vendor users in Excel

```bash
URL=$(grep ONEDRIVE_VENDORS_OPS_URL backend/.env | cut -d= -f2- | tr -d '"')
curl -s -X POST "$URL" -H 'Content-Type: application/json' -d '{"action":"list"}' | python3 -m json.tool
```

### Delete a specific Excel row by WHPO

```bash
URL=$(grep ONEDRIVE_VENDORS_OPS_URL backend/.env | cut -d= -f2- | tr -d '"')
curl -s -X POST "$URL" -H 'Content-Type: application/json' \
  -d '{"action":"delete_whpo_rows","payload":"{\"whpo_number\":\"77001111\"}"}'
```

### Useful psql one-liners

```bash
# Latest 10 activity events
psql cn_warehouse -c "SELECT t, actor, kind, left(message, 60) FROM activity_log ORDER BY t DESC LIMIT 10;"

# WHPO + DO + container summary
psql cn_warehouse -c "SELECT w.whpo_number, c.name, d.do_number, d.status, count(co.id) AS containers FROM whpos w JOIN customers c ON c.id=w.customer_id JOIN dos d ON d.whpo_id=w.id LEFT JOIN containers co ON co.do_id=d.id GROUP BY w.whpo_number, c.name, d.do_number, d.status ORDER BY w.whpo_number;"

# All driver info for a WHPO
psql cn_warehouse -c "SELECT container_no, carrier, driver_name, driver_phone, truck_license_plate FROM containers c JOIN dos d ON d.id=c.do_id JOIN whpos w ON w.id=d.whpo_id WHERE w.whpo_number='77001111';"

# Open exceptions
psql cn_warehouse -c "SELECT exception_id, kind, ref_type, ref_id, payload->>'sku_raw' AS sku FROM exceptions WHERE status='open' ORDER BY opened_at DESC;"

# Customer list
psql cn_warehouse -c "SELECT id, name, contact_email FROM customers ORDER BY id;"
```

---

## 24. Frontend chrome inventory

The frontend has three distinct chrome variants, each appropriate for its surface:

| Chrome variant | Top bar color | Used by | Location |
|---|---|---|---|
| **VendorPortalChrome** | Cyan `#0093D0` | All public vendor pages: Welcome, Register, Login, Forgot Password, Intake (chooser + 3 forms), Update Shipment, Success panels | Shared component at `frontend/src/components/VendorPortalChrome.tsx` |
| **OpsChrome** (inline) | Navy `#1B4676` | OperatorPage (single-page scan flow) | Defined inline in `frontend/src/pages/OperatorPage.tsx` |
| **ManagerChrome** (inline) | Navy `#1B4676` | ManagerPage (5 tabs) + DODetailPage + LotDetailPage | Defined inline in `frontend/src/pages/ManagerPage.tsx`; DetailChrome is a separate inline variant for the two detail pages |

**Rationale**: cyan for public vendor surfaces (matches conquernation.com's navbar — welcoming, brand-facing). Navy for internal staff tools (commanding, authoritative, visually distinct from vendor portal so dock/manager staff don't confuse them).

Common elements across all variants:
- White "CN" logo mark on the left + brand wordmark "CONQUER NATION" + role eyebrow ("Vendor Portal" / "Dock Operations" / "Manager Console")
- Yellow `#FED641` 1px accent strip below the top bar
- "Systems operational" green dot indicator (top bar right side)
- Sign-out button on the right (when applicable)
- Navy `#1B4676` footer with copyright + address + conquernation.com link

**Per-page additions**:
- VendorPortalChrome: when logged in, shows user pill (avatar circle + name + company) + Sign out. When logged out, shows "Sign in" / "Register" CTAs.
- OpsChrome: shows phase indicator pill (yellow dot + "Container intake" / "Scanning XXX" / "Container closed") so dock staff always see where they are in the flow.
- ManagerChrome: includes a sub-nav row with the 5 tab buttons. Active tab has a 3px yellow underline + bold navy text. Hover transitions to navy.

**Sign-out behavior**:
- Vendor sign-out → redirects to `/vendor` (welcome page)
- Staff sign-out → redirects to `/login`

Implemented via React Router's `useNavigate({replace: true})` so the post-sign-out state doesn't end up in browser history (back button doesn't restore a stale logged-in view).

**Icon strategy**: every icon throughout the app is an inline SVG (lucide-style, 24x24, `stroke="currentColor"`). No icon libraries. Each file that uses icons defines its own helpers (`PackagePlusIcon`, `TruckIcon`, `CheckIcon`, etc.) at the bottom — accept duplication for isolated, no-dependency components. If you ever want to DRY this up, extract to `frontend/src/components/icons.tsx`.

---

## 25. Brand design system (Tailwind 4 patterns)

The project uses Tailwind 4 (`@import "tailwindcss"` in `index.css`) with **no custom config** — brand colors are used as arbitrary values throughout, e.g. `bg-[#0093D0]`, `text-[#1B4676]`, `border-[#FED641]`.

### Brand palette (from `conquernation.com/index.css`, last scraped 2026-05-16)

- `#0093D0` — CN cyan (navbar/chrome on conquernation.com)
- `#1B4676` — CN deep navy (headings, hover-fill on rows)
- `#224E72` — CN navy gradient stop
- `#2F4B70` — CN section heading navy
- `#FED641` — CN signal yellow (their "Quote" CTA button)
- `#E6C200` — yellow hover state
- `#45627E` — navbar link hover text color
- `#FCD34D` — navbar-link hover background (used sparingly)

### Common Tailwind patterns

- **Section labels**: `text-[11px] font-bold uppercase tracking-[0.18em] text-[#0093D0]`
- **Headings**: `text-3xl sm:text-4xl font-bold tracking-tight text-[#1B4676]`
- **Field labels**: `text-xs font-semibold text-[#1B4676] mb-1.5`
- **Field focus rings**: `focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition`
- **Primary CTA button**: `bg-[#FED641] hover:bg-[#E6C200] text-[#1B4676] font-bold rounded-md py-3.5 disabled:bg-slate-100 disabled:text-slate-400`
- **Card shadow**: `style={{ boxShadow: '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)' }}`
- **Eyebrow chip** (small all-caps label): `inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#1B4676] text-[11px] font-semibold tracking-[0.14em] uppercase`
- **Required marker**: `<span className="text-[#E6C200]">*</span>` (yellow asterisk, not red)
- **Background ambient grid** (welcome page): faint 56px slate grid with radial mask, plus a top-down cyan wash

### Status palette (semantic colors)

- ✅ Success / completed: `emerald-50/600/700` (e.g., container_finished, exception_resolved)
- ⚠ Warning / pending: `amber-50/300/700` (e.g., open exceptions, recently updated rows, "ready to overwrite" hints)
- ❌ Error / blocked: `red-50/300/700` (e.g., InsertDeleteConflict, locked containers in update flow)
- ◾ Neutral / informational: `slate-100/500/700`

Status pills consistently use `text-[10.5px] uppercase tracking-[0.12em] font-bold` + `px-2 py-0.5 rounded` + matching bg/text colors.

---

## 26. Source-of-truth matrix

When information lives in multiple places, this tells you which one wins:

| Data | Source of truth | Mirrored to | Sync trigger |
|---|---|---|---|
| Customer master | Postgres `customers` | n/a | Auto-created on first vendor registration with a new company name |
| SKU master | Postgres `skus` | n/a | Seeded + manager-resolved via exception modal |
| Vendor user accounts | **Excel `VendorUsers` sheet** | n/a | Read on every login via Logic App |
| Shipment data (WHPO/DO/Container/Lines) | Postgres | Excel `InboundTable` (per container × SKU line) | APPEND fires on submit; DELETE + APPEND fires on update |
| Driver/truck info per container | Postgres `containers.driver_*` + `carrier` | Excel `InboundTable` driver columns | UPDATE webhook fires on PATCH driver-info; manual Resend driver info button replays |
| Lot assignments | Postgres `lot_assignments` | n/a | Computed by `assignment.py` at submission time |
| Scan/receipt history | Postgres `scans`, `pallets`, `receipts` | n/a | Written by operator flow |
| Audit/activity log | Postgres `activity_log` | n/a (manager dashboard reads it live) | Written by every state-changing operation |
| Inbound CSV (audit only) | Excel `InboundTable` AND Blob Storage `cnwarehouse9c4e/inbound/inbound.csv` | n/a — both are mirrors of Postgres | Function App writes on APPEND; never updates |

**Mental model**: Postgres is canonical for **transactional** data. Excel is canonical for **vendor user accounts only** (because Tiana wanted visibility). Everything else flows Postgres → Excel; nothing flows Excel → Postgres except manual driver-field edits via the Pull from Excel button.

---

## 27. Recent session log (2026-05-16 → 2026-05-18)

Chronological highlights of what was built in this 3-day stretch:

**2026-05-16 (Day 1)**:
- Brand-themed UI redesign across all surfaces (vendor portal chooser, new shipment form, driver/truck form, operator portal, manager portal + all 5 tabs, login page, DO/Lot detail pages, modals)
- Scraped conquernation.com for brand palette
- Built shared `VendorPortalChrome` component
- New cyan/navy/yellow design system

**2026-05-17 (Day 2)**:
- Vendor self-service authentication system (Excel-backed users, JWT, bcrypt)
- Welcome page at `/vendor` as default landing
- Register / Login / Forgot Password pages
- Auto-customer creation on register
- 409 friendly duplicate handling
- Driver phone column added to backend + Excel
- Pull from Excel feature for driver-field edits

**2026-05-18 (Day 3 — today)**:
- Carrier (transport company) field added to backend + Excel + driver forms
- Update / amendment flow with structured diff + audit trail
- "Last updated" column in Inbound view with amber chip
- Postgres triggers considered but rejected; built explicit `wipe-transactional` endpoint instead
- WHPO uniqueness enforced (rejected duplicates with 409, was idempotent-replay)
- Removed packaging section from new-shipment form
- Free-text company on register (was dropdown)
- Sign-out redirects to `/vendor` welcome page
- Vendor session in memory only (no localStorage — refresh = logout)
- Full-resync endpoint for Excel schema migrations
- Atomic Postgres + Excel wipe endpoint
- Unified Office Script (8 actions: list, append, update_last_login, update_password, update_driver, list_inbound, delete_whpo_rows, clear_inbound_table)
- Logic App rebuilt twice during debugging; current workflow GUID is `1a771eab…751b`
- Office Script connector parameter-detection issue debugged (return-type complexity)
- `cn-warehouse-driver-update` Logic App deprecated; everything routes through `cn-warehouse-vendors-ops`

---

End of handoff.
