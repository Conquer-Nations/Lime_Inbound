# Conquer Nation Warehouse — Session Handoff

Last updated: 2026-05-22. Feed this to the next Claude session.

**⚠ File is `HANDOFF.md`** (uppercase). macOS is case-insensitive so `handoff.md` works too, but git tracks it as uppercase. Use uppercase when adding/committing.

**⚠ Repo path moved**: active project is now at `/Users/Tiana/Desktop/Conquer Nation/Lime Bikes/SOFTWARE/Conquer-Nation-Warehouse/` (note the spaces — quote it when `cd`-ing). The old `/Users/Tiana/Desktop/Conquer-Nation-Warehouse/` path no longer exists. All older sections in this file still reference the old path; mentally substitute when running commands.

**Newest work** (2026-05-18 → 2026-05-22):
1. Container documents upload (driver's license, insurance, plate photos, BOL PDFs) → OneDrive via Microsoft Graph OR local sync mirror
2. Scan-sheet operator flow (TEMPLATE.xlsx-style sheet per container with serial + IMEI + row_notes)
3. Auditor portal (read-only sheet browse + bulk Excel export, gated by JWT email allowlist)
4. WHPO BOL number field
5. Phase 1 INBOUND/OUTBOUND mode picker
6. Phase 2 outbound flow scaffolding (DB schema, backend routes, frontend cards)
7. Container OCR fixed via paid OpenRouter Gemini

Sections **28–40** at the bottom hold all the latest details — they supersede anything contradictory in §1–§27.

**Uncommitted at handoff time** (`git status` from `main`):
- `HANDOFF.md` — this doc, just rewritten
- `backend/app/services/ocr.py` — `_snap_to_bic` tightening (positions 0-3 letter-only)
- `frontend/src/pages/OutboundComponents.tsx` — `parseOutboundPaste` email-paste parser added (user/linter edit)
- `vendor-portal-redesign.html` — phone/email contact details updated to (310) 678-6768 / developer@conquernation.com (was placeholder 323-555-1234 / ops@…)

**Untracked at handoff time**:
- `.vscode/` — VS Code workspace settings (extensions.json, launch.json, settings.json, tasks.json) — added 2026-05-19
- `Input-Truck:Driver Images/` — 3 test JPEGs from 2026-05-18 for driver document OCR experiments. **Do not commit** — likely contains personal info from driver's licenses

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

---

## 28. Repo path + deployment (2026-05-22)

### Active local path
```
/Users/Tiana/Desktop/Conquer Nation/Lime Bikes/SOFTWARE/Conquer-Nation-Warehouse/
```
Note the spaces — always quote when `cd`-ing:
```bash
cd "/Users/Tiana/Desktop/Conquer Nation/Lime Bikes/SOFTWARE/Conquer-Nation-Warehouse"
```

### Deployed
- **GitHub**: `Conquer-Nations/Lime_Inbound` (main branch, auto-deploys)
- **Backend**: Azure App Service B1 (FastAPI) — env vars set in portal
- **Frontend**: Azure Static Web Apps (Vite build)
- **Database**: Azure PostgreSQL Flexible Server (replaces local Postgres for prod)

### Pending security
- PG password `Abcdeedcba12345*` was exposed in chat history during this session. **Rotate before any external sharing.**
- API keys (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `JWT_SECRET`) stored as App Service env vars only — never check into repo.

---

## 29. OCR resolution (paid OpenRouter Gemini)

Container OCR was unstable through multiple iterations. Final working setup:

### Dispatch chain in `backend/app/services/ocr.py`
```
OpenRouter (if OPENROUTER_API_KEY set)  →  Gemini direct (if GEMINI_API_KEY set)  →  RapidOCR (local ONNX, ~100MB)
```

EasyOCR is **NOT** installed in production (was removed from `requirements.txt`). Old fallback chain that masked import errors was deleted — RapidOCR import failures now surface directly.

### Active env vars
```
OPENROUTER_API_KEY=sk-or-v1-...           # paid, $5 credit = ~50,000 scans
OPENROUTER_MODEL=google/gemini-2.0-flash-001
```

**Note**: Earlier tried free OpenRouter models (`google/gemini-2.0-flash-exp:free`, `meta-llama/llama-3.2-11b-vision-instruct:free`, `qwen/qwen-2.5-vl-72b-instruct:free`) — all returned 404 (deprecated). Direct Gemini API hit 429 quota. Paid OpenRouter is the working path. Cost: ~$0.0001/scan.

### App Service startup command
Must install OS libs for opencv (RapidOCR fallback dependency):
```bash
apt-get install -y libxcb1 libgl1 libglib2.0-0 && <normal startup cmd>
```
Also pinned: `opencv-python-headless>=4.10.0`, `rapidocr-onnxruntime>=1.4.0` in `backend/requirements.txt`.

### `_snap_to_bic` fix
Was over-aggressive in fuzzy-snapping digit→letter in positions 0-3, producing false BIC candidates (e.g., `BOZI6884562`, `PUBO2168848` for an image of `JZPU8021688`).

**Current behavior**:
- Positions 0-3 must already be letters (no digit→letter snap)
- Only letter→digit snap allowed in positions 4-10
- Sort prefers (1) `check_digit_valid`, (2) `source='ocr'` over `'ocr_check_digit_corrected'`, (3) alphabetical

---

## 30. Phase 1: INBOUND/OUTBOUND mode picker (committed `918217f`)

Vendor portal landing now has 2 mode tiles instead of jumping straight to inbound. After login, vendor lands on `/vendor-intake` → sees **DirectionChooser** with two big tiles:

| Tile | onChoose | Description |
|---|---|---|
| **INBOUND** | `'choose'` | "Receive new shipment / Add driver / Update existing" (existing 3-tile flow) |
| **OUTBOUND** | `'out_choose'` | Was "Coming soon" — now navigates to the 4-tile outbound chooser |

In `frontend/src/pages/VendorIntakePage.tsx`:
```typescript
type Mode = 'direction' | 'outbound_soon' | 'choose' | 'new' | 'driver' | 'update' | 'view'
  | 'out_choose' | 'out_new' | 'out_driver' | 'out_update' | 'out_view'
```
DirectionChooser OUTBOUND tile: `onClick={() => onChoose('out_choose')}` + `accent="navy"` (removed `comingSoon` prop).

---

## 31. Phase 2: Outbound flow (in progress)

Mirrors the inbound flow but in reverse. Customer says "ship me X qty of SKU-Y" → system picks from inventory → operator scans items into outbound container.

### 31a. Customer outbound = pick + ship

- Each line has `serial_specific: bool`
  - `false` — system picks any matching unshipped serials FIFO from inventory
  - `true` — customer provides exact serials they want
- Outbound goes in BIC containers (mostly) OR smaller trucks (sometimes)
- One login per customer; manager sees all
- Separate workbook: **`Lime Outbound Data.xlsx`** (not yet created)

### 31b. Picking ticket format (from `TO21787.pdf`)

Fields populating outbound order:
```
Transfer Order #     (e.g., TO21787)
Order Date
Priority
Memo
Ship From (Name, Address)
Ship To (Name, Address)
Line items:
  Line No | SKU | Description | Order Qty | Unit | Picked Qty | Picked Location
```

Email-paste format (5 dash-separated columns):
```
TO21787 - LPN-001769 - Scooters - 3 units - Long Island City
```
Same TO# = multiple lines on one order.

### 31c. Phase 2.1 — DB schema (DONE)

Migration: `backend/alembic/versions/a1b2c3d4e5f7_outbound_tables.py`
- `revision='a1b2c3d4e5f7'`
- `down_revision='f1a2b3c4d5e6'` (scan_imei was the prior head)
- **Additive only** — no changes to inbound tables

Five new SQLAlchemy classes appended to `backend/app/models/__init__.py` (after `ActivityLog`):

| Table | Key columns | Relationships |
|---|---|---|
| `outbound_orders` | id, transfer_order_no (UNIQUE), customer_id, order_date, priority, memo, ship_from_*, ship_to_*, status (open/picking/shipped/cancelled), submitted_at, submitted_by, notes | customer, lines (cascade), containers (cascade) |
| `outbound_lines` | id, outbound_order_id, line_no, sku_id, sku_raw, description, order_qty, unit, serial_specific (bool) | order, sku, serials (cascade) |
| `outbound_line_serials` | id, outbound_line_id, serial_number, status (requested/picked/shipped/not_found). UNIQUE(line_id, serial) | line |
| `outbound_containers` | id, outbound_order_id, container_no (UNIQUE), container_type ('bic'/'truck'), status (open/loading/sealed/shipped), started_at/by, sealed_at/by, driver_*, truck_license_plate, insurance, carrier, bol_number | order, scans (cascade) |
| `outbound_scans` | id, outbound_container_id, outbound_line_id, **inbound_scan_id (FK to `scans` — UNIQUE so one inbound serial = one outbound scan)**, sku_id, serial_number, imei, picked_location, scanned_at, scanned_by, notes. UNIQUE(container_id, serial_number) | container, line, inbound_scan |

Constraints:
- `uq_outbound_line_serial` — same serial can't be requested twice on one line
- `uq_outbound_container_serial` — same serial can't be scanned twice into one container
- `uq_outbound_scan_per_inbound` — one inbound scan can only ship out once (enforces FIFO + no double-shipping)

`__all__` in models was updated to include the 5 new classes.

### 31d. Phase 2.2 — Backend (DONE)

**`backend/app/schemas/outbound.py`** — 14 Pydantic schemas. Key ones:
```python
class OutboundLineInput(BaseModel):
    line_no: int  # >=1
    sku: str
    description: str
    order_qty: int  # >=1
    unit: str = 'EA'
    serial_specific: bool = False
    serials: list[str] | None = None
    notes: str | None = None

class OutboundOrderSubmission(BaseModel):
    transfer_order_no: str
    customer: str
    order_date: date
    priority: str | None
    memo: str | None
    ship_from_name: str
    ship_from_address: str
    ship_to_name: str
    ship_to_address: str
    lines: list[OutboundLineInput]
    notes: str | None = None

class OutboundContainerAttachRequest(BaseModel):
    container_no: str
    container_type: Literal['bic', 'truck'] = 'bic'
    driver_name: str
    driver_license: str
    driver_phone: str
    truck_license_plate: str
    insurance: str
    carrier: str
    bol_number: str | None = None
```

**`backend/app/services/outbound.py`** — 3 async functions:
- `list_available_inventory_for_company(session, company_name)` — joins Scan→Container→DO→WHPO→Customer, filters where no OutboundScan references the scan_id, groups by sku_raw
- `find_inbound_scan_by_serial(session, serial, company_name)` — for serial-specific picks
- `find_inbound_scan_fifo(session, sku_raw, company_name)` — picks oldest unshipped by `Scan.scanned_at.asc()`

Inventory logic: `available_stock = inbound Scan rows (serial_number NOT NULL) - OutboundScan rows linked via inbound_scan_id`.

**`backend/app/routers/outbound.py`** — `prefix='/vendor/outbound'`, tag `'vendor-outbound'`. Endpoints:

| Method | Path | Purpose |
|---|---|---|
| POST | `/order` | Submit new outbound order (201) |
| PUT | `/order/{transfer_order_no}` | Update existing order (deletes lines, reinserts; 409 if not in `open`/`picking`) |
| GET | `/orders` | List company orders + count of lines |
| GET | `/order/{transfer_order_no}` | View detail with `picked_qty` per line from OutboundScan counts |
| POST | `/order/{transfer_order_no}/container` | Attach BIC/truck + driver info |
| GET | `/inventory` | Available stock per SKU for current vendor |

All endpoints use `current_vendor_required` dep + `_enforce_company_match(claims, customer_name)` for tenant isolation.

**`backend/app/main.py`** — added:
```python
from app.routers import outbound as outbound_router
# ...
app.include_router(outbound_router.router)
```

Verified at `/openapi.json` — 5 paths with 'outbound' in name visible.

### 31e. Phase 2.3 — Frontend (3 of 4 cards DONE; Update is placeholder)

**`frontend/src/api/client.ts`** — 6 new API methods + 14 TypeScript interfaces:
- `api.submitOutboundOrder(payload)`
- `api.updateOutboundOrder(transfer_order_no, payload)`
- `api.listMyOutboundOrders()`
- `api.viewOutboundOrder(transfer_order_no)`
- `api.attachOutboundContainer(transfer_order_no, payload)`
- `api.outboundInventory()`
- Types: `OutboundLineInput`, `OutboundOrderSubmission`, `OutboundOrderUpdateRequest`, `OutboundIntakeResponse`, `OutboundUpdateResponse`, `OutboundLineRead`, `OutboundContainerRead`, `OutboundOrderRead`, `OutboundOrderListItem`, `OutboundOrderListResponse`, `OutboundContainerAttachRequest`, `OutboundContainerAttachResponse`, `InventoryItem`, `InventoryResponse`

**`frontend/src/pages/OutboundComponents.tsx`** — 834+ lines. Exports:
- `OutboundModeChooser` — 4-card picker (Order / Driver / Amend / Review)
- `OutboundNewOrderForm` — full picking-ticket form: Order header, Ship from, Ship to, Line items (per-line `serial_specific` toggle + textarea for serials), Notes
- `OutboundDriverInfoForm` — BIC or truck plate, driver+carrier+BOL fields
- `OutboundUpdateOrderForm` — **PLACEHOLDER** (still needs implementation, see Phase 2.3b below)
- `OutboundViewOrderForm` — lookup by TO# + recent orders list with line table

**User/linter addition** (after my initial Phase 2.3 commit): `parseOutboundPaste` function around line 155. Adds:
```typescript
export interface ParsedOutboundLine {
  raw: string
  line_idx: number
  transfer_order_no: string
  sku: string
  product_type: string
  qty: number
  destination: string
  error?: string
}

export interface ParsedOutboundOrder {
  transfer_order_no: string
  destination: string
  lines: ParsedOutboundLine[]
  warning?: string
}

export function parseOutboundPaste(text: string): {
  lines: ParsedOutboundLine[]
  orders: ParsedOutboundOrder[]
}
```
Parses 5-column dash-separated format: `TO# - SKU - Product Type - Qty - Destination`. Same TO# groups into one order. Likely powers an "email paste" intake mode in `OutboundNewOrderForm` — **integration with the form is not yet verified**, preserve when refactoring.

**`frontend/src/pages/VendorIntakePage.tsx`** — modifications:
```typescript
import {
  OutboundModeChooser,
  OutboundNewOrderForm,
  OutboundDriverInfoForm,
  OutboundUpdateOrderForm,
  OutboundViewOrderForm,
} from './OutboundComponents'

// Mode union expanded with 5 'out_*' states
// Dispatch added for all 5 out_ modes, each with onBack to out_choose
// DirectionChooser OUTBOUND tile: onClick={() => onChoose('out_choose')}, accent="navy"
```

### 31f. Phase 2.3b — Pending: OutboundUpdateOrderForm

Still a placeholder. Needs:
- Lookup by TO# → calls `api.viewOutboundOrder(tno)`
- Editable form pre-filled with current state (header, ship-to, lines)
- Add/remove lines, edit qty/sku
- Submit calls `api.updateOutboundOrder(tno, payload)`
- 409 if order status is `shipped` or any container is `sealed`/`shipped`
- Structured diff + audit (mirror inbound update flow's `whpo_updated` activity log → add `outbound_order_updated` kind)

### 31g. Phase 2.4 — Pending: Operator scan-OUT + OneDrive sync

The big remaining piece. Required:

1. **Backend scan-out endpoint** — new in `app/routers/operator.py` or new `app/routers/outbound_operator.py`:
   - Operator scans serial into outbound container
   - Validate serial exists in `scans` table (`serial_number NOT NULL`)
   - Validate no existing `OutboundScan.inbound_scan_id` for that scan (not already shipped)
   - Validate serial matches an outbound line for this order
   - Create `OutboundScan` row linking inbound_scan_id ↔ outbound container/line
   - On container "seal" (operator action), flip `OutboundContainer.status='sealed'`, push to OneDrive

2. **Office Script `ScanSheetAppendOutbound`** in `Lime Outbound Data.xlsx`:
   - Same dispatcher pattern as `VendorOps` / `ScanSheetAppend`
   - Actions: `append`, `list`, `delete_to_rows`, `clear_table`
   - Columns: TO#, container_no, serial_number, sku, picked_location, scanned_at, scanned_by + outbound order header fields

3. **Logic App `cn-outbound-scans-append`**:
   - HTTP trigger → Run script on `Lime Outbound Data.xlsx`
   - New env var: `ONEDRIVE_OUTBOUND_SCAN_URL`

4. **Backend hook on container seal**:
   - In service, after sealing, call `sheet_sync.append_outbound_rows(rows)` analogous to inbound

### 31h. Phase 3 — Pending: Manager dashboard counters

Future work. Mock spec:
- Inbound count / Outbound count / Pending count tiles
- Filterable by time range (today / week / month / custom), SKU, customer
- Connect to WMS for cross-system visibility

---

## 32. Updated migration head + active env vars (2026-05-22)

### Migration head
Current head: **`a1b2c3d4e5f7_outbound_tables`** (was `f1a2b3c4d5e6_scan_imei`).

Apply:
```bash
cd "/Users/Tiana/Desktop/Conquer Nation/Lime Bikes/SOFTWARE/Conquer-Nation-Warehouse/backend"
uv run alembic upgrade head
```

### Updated `.env` keys
All previous keys still apply. **New additions:**
```bash
# OCR — paid OpenRouter (working) + Gemini direct (fallback) + RapidOCR (local final fallback)
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=google/gemini-2.0-flash-001
GEMINI_API_KEY=...                              # optional fallback

# Phase 2.4 — not yet wired
ONEDRIVE_OUTBOUND_SCAN_URL=                     # TODO: cn-outbound-scans-append Logic App
```

### `requirements.txt` additions
```
opencv-python-headless>=4.10.0
rapidocr-onnxruntime>=1.4.0
```
(EasyOCR removed.)

### App Service startup command
Prepend OS lib install:
```bash
apt-get install -y libxcb1 libgl1 libglib2.0-0 && <existing startup>
```

---

## 33. Pick-up checklist for next session

1. **Read** the user's last instruction in the new chat — they want to continue Phase 2.4 (scan-OUT + outbound OneDrive sync) OR Phase 2.3b (OutboundUpdateOrderForm full implementation).

2. **Verify the parseOutboundPaste integration** — open `frontend/src/pages/OutboundComponents.tsx` and find how `parseOutboundPaste` is wired into `OutboundNewOrderForm`. The user/linter added this between my commits; confirm UI behavior before touching.

3. **Check uncommitted work**:
   ```bash
   cd "/Users/Tiana/Desktop/Conquer Nation/Lime Bikes/SOFTWARE/Conquer-Nation-Warehouse"
   git status
   git log --oneline -10
   ```
   Last clean commit was Phase 2.3 frontend. The parseOutboundPaste additions may or may not be committed.

4. **Smoke-test outbound endpoints**:
   ```bash
   # Get JWT first via /vendor/auth/login, then:
   curl -s -X POST http://localhost:8000/vendor/outbound/order \
     -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"transfer_order_no":"TO21787","customer":"Lime Mobility","order_date":"2026-05-22","ship_from_name":"CN Vernon","ship_from_address":"...","ship_to_name":"Lime LIC","ship_to_address":"...","lines":[{"line_no":1,"sku":"LPN-001769","description":"Scooter","order_qty":3,"serial_specific":false}]}'

   curl -s http://localhost:8000/vendor/outbound/orders -H "Authorization: Bearer $TOKEN"
   curl -s http://localhost:8000/vendor/outbound/inventory -H "Authorization: Bearer $TOKEN"
   ```

5. **For Phase 2.4** (operator scan-OUT): start by mirroring `app/routers/scan_sheet.py` patterns. Key safety constraint: enforce `uq_outbound_scan_per_inbound` at the service layer so duplicate ship attempts return a clear 409 instead of a raw DB error.

---

---

## 34. Full migration chain (REVISED — supersedes §19)

§19 was correct only through `b2c3d4e5f6a7`. Here is the complete current chain, oldest → newest:

| Revision | File | Purpose |
|---|---|---|
| `e2ed3602fc4e` | `_initial_schema.py` | Base schema (16 tables) |
| `b9f24bef22fe` | `_container_packaging_fields.py` | Container packaging dims |
| `f0bf04d3f58b` | `_container_arrival_time_and_line_product_.py` | `expected_arrival_time` + `product_type` |
| `c5b4ddff7896` | `_add_grid_coords_to_lots.py` | Floor 1 grid layout |
| `979d959b2156` | `_add_sku_id_to_lot_assignments.py` | sku_id FK on lot_assignments |
| `3c6b3348c600` | `_sqft_fields_on_lot_assignments_and_.py` | planned/actual sqft |
| `de310e4a215b` | `_whpo_driver_info_fields.py` | (deprecated) WHPO-level driver |
| `7652edc5569f` | `_container_driver_info_fields.py` | Container-level driver fields |
| `a1b2c3d4e5f6` | `_container_driver_phone.py` | `driver_phone` |
| `b2c3d4e5f6a7` | `_container_carrier.py` | `carrier` |
| `c3d4e5f6a7b8` | `_container_documents.py` | **NEW table** `container_documents` (one row per (container, kind); kinds: driver_license / insurance / registration / plate_photo / dispatch_order / etc.) Unique constraint `uq_container_doc_kind` — re-upload of same kind overwrites in place. |
| `d4e5f6a7b8c9` | `_scan_serial_and_row_notes.py` | `scans.serial_number` (nullable) + `scans.row_notes` (text). Partial unique index `uq_scans_receipt_serial` where serial NOT NULL. Plain index `ix_scans_serial_number`. |
| `e5f6a7b8c9d0` | `_whpo_bol_number.py` | `whpos.bol_number` (used by TEMPLATE.xlsx F5 cell on scan-sheet export). |
| `f1a2b3c4d5e6` | `_scan_imei.py` | `scans.imei` (nullable; required only for scooter SKUs at app layer). |
| `a1b2c3d4e5f7` | `_outbound_tables.py` | **Phase 2 outbound** — 5 new tables. CURRENT HEAD. |

Apply: `cd backend && uv run alembic upgrade head`

---

## 35. Container documents (vendor file uploads)

Added 2026-05-18 (migration `c3d4e5f6a7b8`). Vendors can upload supporting docs per container:

### `container_documents` table

```
id, container_id (FK), kind, filename, content_type, file_size,
storage_path, uploaded_at, uploaded_by
UNIQUE(container_id, kind)
```

`kind` values used in practice: `driver_license`, `insurance`, `registration`, `plate_photo`, `dispatch_order`, `bol`. New kinds can be added freely.

### Storage path

Local: `{settings.uploads_dir}/<file>.{ext}` — backend filesystem holds the canonical copy. Re-upload of the same `(container, kind)` overwrites both row and file (see `backend/app/services/vendor_uploads.py`).

### OneDrive mirror — TWO paths, choose at deploy time

**Path A: Local sync** (`onedrive_local_sync.py`)
- Backend writes the file under a local OneDrive desktop sync folder
- The OneDrive desktop client on the same machine pushes to the cloud
- Tree: `{sync_root}/{Company}/{YYYY}/{MM - Month}/WHPO {whpo}/{container}/{kind}.{ext}`
- Requires OneDrive desktop client on the backend host — fine for Tiana's Mac, not for App Service

**Path B: Microsoft Graph cloud-only** (`onedrive_graph.py`) — preferred for App Service
- Backend uploads via Graph API `PUT /me/drive/root:/path:/content` (auto-creates folders)
- Requires one-time device code flow: `cd backend && python -m app.scripts.onedrive_login` → visit microsoft.com/devicelogin → paste code → sign in. Refresh token persisted to `settings.onedrive_graph_cache_path` (default `./.onedrive_token_cache.json`)
- Uses OAuth public client (no client secret needed)
- Same tree layout as Path A
- Settings: `onedrive_graph_enabled`, `onedrive_graph_client_id` (default = Microsoft's generic device-flow ID `04b07795-8ddb-461a-bbee-02f9e1bf7b46`), `onedrive_graph_tenant=common`, `onedrive_graph_root=Vendor Files`
- **Protect `.onedrive_token_cache.json` like a secret** — it contains the refresh token

**Both paths are best-effort**: errors are logged and swallowed; vendor uploads never fail because OneDrive is unreachable. Postgres + the backend-managed local file are the source of truth.

There's also `onedrive_rclone.py` and `onedrive_files.py` — older variants. `onedrive_rclone_enabled` flag exists for the rclone variant. Look at `config.py` to see which path is active in any given environment.

---

## 36. Scan-sheet operator flow

Added 2026-05-19/20. Mirrors a `TEMPLATE.xlsx` spreadsheet — operator opens one "sheet" per container, scans serials + IMEIs + row notes inline.

### Feature flag
`SCAN_SHEETS_ENABLED=true` env var must be set. When `false` (default), every scan-sheet + audit endpoint returns 503. This is the single switch to release the feature.

### DB columns added to `scans`
- `serial_number` (nullable, varchar 120) — per-receipt unique via partial index
- `row_notes` (nullable, text) — free-text per scan row
- `imei` (nullable, varchar 40) — required for scooter SKUs at app layer

### Endpoints — `backend/app/routers/scan_sheet.py` (prefix `/operator/sheet`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/open` | Open a new sheet for a container — creates a `Receipt` |
| POST | `/{receipt_id}/scan` | Append one scan row (serial + imei + row_notes) |
| POST | `/{receipt_id}/finish` | Lock the sheet, push to OneDrive Excel |
| GET | `/{receipt_id}` | Re-open existing sheet (resume) |

Legacy `/operator/*` endpoints (`lookup_container`, `record_scan`, `finish_container`) are **untouched** and still work. Operators can use either flow until full migration.

### OneDrive Excel sync — `Lime Scan Data.xlsx`

On `/finish`, backend POSTs to `settings.onedrive_scan_sheet_url` (a Logic App). The Logic App runs Office Script `ScanSheetAppend` which:
- Creates (or replaces) a worksheet named after `container_no`
- Writes header block (mirrors TEMPLATE.xlsx) + scan rows
- Cell F5 = `whpos.bol_number`

Best-effort: errors logged and swallowed.

### Frontend
Scan-sheet UI lives within `OperatorPage.tsx` (single-screen flow, bulletproof scanner focus management via `requestAnimationFrame` + DOM reads). Recent commits added:
- Debounced auto-advance on input (no Enter required from Keyence scanner)
- Catch Enter at input level (works when submit button disabled)
- Validate serial (alphanumeric) + IMEI (digits, 14-17 length)

### PWA install
`vite-plugin-pwa` configured with 192/512 + maskable icons. Operators install on iPad/Android home screen for kiosk-mode usage.

---

## 37. Auditor portal

Added with scan-sheet. Read-only view + bulk Excel export of completed scan sheets.

### Auth model
- Same JWT as vendor auth (HS256, `JWT_SECRET`)
- `current_auditor_required` dep checks JWT email against `settings.auditor_emails` allowlist (default: `["developer@conquernation.com"]`)
- 403 if email not in allowlist; 503 if `SCAN_SHEETS_ENABLED=false`

### Endpoints — `backend/app/routers/audit.py` (prefix `/audit`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/sheets?year=&month=&container_no=&whpo_number=` | List finished sheets, filterable |
| GET | `/sheets/{receipt_id}` | One sheet detail with scan rows |
| GET | `/sheets/{receipt_id}/export.xlsx` | Single container, TEMPLATE.xlsx clone |
| GET | `/sheets/export.xlsx?<filters>` | Bulk — one worksheet per container in one workbook |

Excel building lives in `backend/app/services/scan_sheet_export.py`: `build_single_container_workbook()` + `build_bulk_workbook()`. Both clone TEMPLATE.xlsx layout (header block, scan rows starting at row N, formulas preserved).

### Frontend
`frontend/src/pages/AuditPage.tsx` — auditor-facing browse + download UI. Routed at `/audit` (likely; verify in `App.tsx` if needed).

---

## 38. Newly discovered config settings (REVISED — adds to §11 `.env` keys)

Full current list from `backend/app/config.py`:

```bash
# Database
DATABASE_URL=postgresql+asyncpg://localhost/cn_warehouse
CORS_ORIGINS=["http://localhost:5173"]

# Inbound APPEND fan-out
INBOUND_WEBHOOK_URL=                  # Function App → Blob CSV
ONEDRIVE_WEBHOOK_URL=                 # InboundTable APPEND Logic App
ONEDRIVE_UPDATE_WEBHOOK_URL=          # DEAD — ignored
ONEDRIVE_VENDORS_OPS_URL=             # Unified vendor-ops dispatcher
INBOUND_WEBHOOK_SECRET=               # optional X-CN-Secret header
MS_CLIENT_SECRET=                     # (legacy, may be unused)

# Vendor JWT sessions
JWT_SECRET=                           # HS256 secret — MUST be set in prod
JWT_EXPIRY_HOURS=24

# Vendor file uploads
UPLOADS_DIR=./uploads                 # backend filesystem path
ONEDRIVE_VENDOR_FILES_URL=            # optional — alternate Logic App for vendor file ops

# OneDrive Microsoft Graph (cloud-only upload path)
ONEDRIVE_GRAPH_ENABLED=false
ONEDRIVE_GRAPH_CLIENT_ID=04b07795-8ddb-461a-bbee-02f9e1bf7b46    # MS device flow generic ID
ONEDRIVE_GRAPH_TENANT=common
ONEDRIVE_GRAPH_CACHE_PATH=./.onedrive_token_cache.json           # refresh token — secret
ONEDRIVE_GRAPH_ROOT=Vendor Files

# OneDrive rclone (alternate sync mechanism)
ONEDRIVE_RCLONE_ENABLED=false

# Scan-sheet feature flag + auditor gating
SCAN_SHEETS_ENABLED=false
AUDITOR_EMAILS=["developer@conquernation.com"]

# Scan-sheet Excel sync
ONEDRIVE_SCAN_SHEET_URL=              # Logic App for ScanSheetAppend

# OCR providers (paid OpenRouter is primary)
OCR_SERVICE_URL=                      # optional external OCR microservice
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=google/gemini-2.0-flash-001
GEMINI_API_KEY=                       # optional fallback

# Phase 2.4 — not yet wired
ONEDRIVE_OUTBOUND_SCAN_URL=           # TODO: cn-outbound-scans-append Logic App
```

---

## 39. Full backend module inventory (REVISED — supersedes §3)

§3 listed routers/services that existed pre-scan-sheet. Current actual state:

### `backend/app/routers/`
- `operator.py` — legacy scan flow (lookup + record + finish)
- `vendor.py` — WHPO submission, container driver-info, update flow
- `vendor_auth.py` — register/login/me/customers/reset-password
- `manager.py` — dashboard, DOs, lots, exceptions, inbound + wipes
- `ocr.py` — `/ocr/container-photo`
- `scan_sheet.py` — operator scan-sheet flow (TEMPLATE.xlsx style). **Gated by `SCAN_SHEETS_ENABLED`.**
- `audit.py` — read-only auditor view + bulk Excel export. **Gated by `SCAN_SHEETS_ENABLED` + `current_auditor_required`.**
- `outbound.py` — Phase 2 outbound endpoints (orders, lines, containers, inventory)

### `backend/app/services/`
- `assignment.py`, `space.py` — lot packing
- `receiving.py` — legacy scan flow service layer
- `intake.py` — vendor WHPO submission + helpers (rejects duplicate WHPOs)
- `manager.py` — dashboard + queries
- `ocr.py` — OpenRouter → Gemini → RapidOCR dispatch
- `sheet_sync.py` — Inbound fan-out to Function App + Logic Apps
- `vendor_excel.py` — vendor user CRUD via vendors-ops Logic App
- `vendor_auth_service.py` — bcrypt + JWT + FastAPI deps
- `vendor_uploads.py` — backend filesystem storage for container documents
- `onedrive_local_sync.py` — mirrors uploaded docs to local OneDrive sync folder
- `onedrive_graph.py` — Microsoft Graph cloud-only upload (preferred for App Service)
- `onedrive_rclone.py` — rclone-based variant (alternate)
- `onedrive_files.py` — older variant (likely deprecatable)
- `scan_sheet_export.py` — builds single + bulk TEMPLATE.xlsx clones for auditor
- `scan_sheet_onedrive.py` — pushes finished scan sheets to `Lime Scan Data.xlsx` via Logic App
- `outbound.py` — inventory query (Scan minus OutboundScan), serial + FIFO finders

### `backend/app/schemas/`
- `operator.py`, `vendor.py`, `vendor_auth.py`, `manager.py` (existing)
- `scan_sheet.py` — OpenSheetRequest/Response, RecordScanRequest/Response, FinishSheetResponse, ScanRow, ScanSheetHeader, AuditSheetDetail, AuditSheetListItem, AuditSheetListResponse
- `outbound.py` — 14 Pydantic schemas for outbound flow

### `frontend/src/pages/`
- `LoginPage.tsx`, `OperatorPage.tsx`, `ManagerPage.tsx`, `DODetailPage.tsx`, `LotDetailPage.tsx`
- `VendorWelcomePage.tsx`, `VendorRegisterPage.tsx`, `VendorLoginPage.tsx`, `VendorForgotPasswordPage.tsx`, `VendorIntakePage.tsx`
- `AuditPage.tsx` — **new** auditor portal
- `OutboundComponents.tsx` — **new** Phase 2 outbound cards + paste parser

### `vendor-portal-redesign.html`
Standalone HTML mockup file (~14KB) — not part of the live app. Visual design exploration for the vendor portal redesign. Phone/email in footer were just updated from placeholder values to real Conquer Nation contact info (`(310) 678-6768`, `developer@conquernation.com`). Safe to delete if the redesign is fully ported into React.

---

## 40. parseOutboundPaste detailed spec (uncommitted, in OutboundComponents.tsx)

User/linter added this between Phase 2.3 commit and handoff time. Full spec:

### Input format
Each line is dash/pipe-separated, 5 columns:
```
TO# - SKU - Product Type - Qty - Destination
```
Examples:
```
TO21787 - LPN-001769 - Scooters - 3 units - Long Island City
TO21788 - LPN-001770 - Batteries - 50 units - LA Hub
TO21787 - LPN-001771 - Helmets - 25 units - Long Island City
```
- Splits on `\s*[-—–|]\s*` (handles em-dash, en-dash, hyphen, pipe)
- Qty regex: `/([0-9]+)/` — strips "units"/"ea"/etc.
- Destination = everything past column 4, rejoined with " - " (so destinations can contain dashes)
- TO# and SKU forced UPPERCASE

### Grouping rule
Lines with the same TO# group into one `ParsedOutboundOrder`. Destination = first line's destination wins. If a subsequent line on the same TO# has a different destination, the order gets a soft warning: `"Lines on {tno} have mixed destinations (using '{dest}' for the order)."` (lines still included).

### Per-line errors (soft, not blocking)
- `< 5 columns` → `"Need 5 columns (TO# - SKU - Product Type - Qty - Destination); got N."`
- Bad qty → `"Couldn't read a quantity from '{raw}'."`

### Returned shape
```typescript
{
  lines: ParsedOutboundLine[]    // all parsed lines, including errors
  orders: ParsedOutboundOrder[]  // grouped by TO#, errors excluded
}
```

### Integration status
Function exported from `OutboundComponents.tsx` but **integration into `OutboundNewOrderForm` is not verified**. Open the file and search for `parseOutboundPaste(` to see how/whether it's wired into the form UI. Likely powers a "paste from email" toggle/textarea alongside the manual line-by-line entry.

---

## 41. Full commit log since handoff §27 (chronological, oldest → newest)

§27 stopped at 2026-05-18. Here's everything from then through handoff time:

```
9f27ef7  PWA: proper square icons (192/512 + maskable) so home-screen install shows logo
203bbc1  Scan-sheet: bulletproof scanner focus management via rAF + DOM reads
9c28d08  Scan-sheet: catch Enter at input level, not form (works when submit btn disabled)
6b4a3a0  Scan-sheet: debounced auto-advance on input (no Enter required from scanner)
39fc90e  Scan-sheet: validate serial (alphanumeric) + IMEI (digits 14-17)
c3e2c8b  Container OCR: switch to Tesseract.js client-side (free, no backend)
154d0e9  Container OCR: worker API + char whitelist + position-aware fuzzy match
4d9f449  Container OCR: Gemini 2.0 Flash backend (replaces Tesseract.js)
d66fc5d  OCR: add OpenRouter provider (matches OCR-Driver-POD repo)
b8942de  OCR: stronger prompt + larger token budget to capture full 11-char BIC
0c35586  OCR: add local RapidOCR (ONNX) provider — no external API, ~100MB
b2b1247  OCR: pin opencv-python-headless so rapidocr's cv2 import works on App Service Linux
a752795  OCR: surface RapidOCR runtime errors instead of silently falling back
8a3a413  OCR: surface full RapidOCR/cv2/onnxruntime import error in the response
e3ce105  OCR: stop hiding RapidOCR errors behind EasyOCR fallback
b7be2f5  OCR: position-aware letter↔digit fuzzy match so B in check-digit cell becomes 8
918217f  Vendor portal: INBOUND/OUTBOUND mode picker (Phase 1, UI only)
be04c79  Phase 2.1: outbound DB schema (orders, lines, line_serials, containers, scans)
a9b2219  Phase 2.2: backend outbound endpoints (orders, lines, containers, inventory)
879df07  Phase 2.3: outbound vendor portal — 4 cards (New order, Driver, Update, View)
```

Then **uncommitted** (see top of doc): HANDOFF.md rewrite + `_snap_to_bic` tightening + parseOutboundPaste + vendor-portal-redesign.html contact info.

OCR commit arc: started Tesseract.js client-side → tried Gemini direct → moved to OpenRouter (initially free models, all 404'd, then paid `google/gemini-2.0-flash-001`) → added local RapidOCR ONNX fallback → debugging libxcb/opencv ABI issues → tightening fuzzy-match heuristic to stop false BIC candidates.

---

## 42. Phase 2 user design decisions (locked in by Tiana, 2026-05-22 conversation)

These are the answers I worked from when designing Phase 2. Preserve them verbatim:

1. **Customer outbound = "ship me X qty of SKU-Y"** → system picks from inventory. Each line has `serial_specific: bool`:
   - `false` — system picks any matching unshipped serials FIFO
   - `true` — customer provides exact serials they want
2. **Outbound goes in BIC containers (mostly) OR smaller trucks (sometimes)** → `outbound_containers.container_type` enum `'bic' | 'truck'`
3. **One login per company** (not per user) — confirmed by Tiana. Manager sees all.
4. **Separate workbook** `Lime Outbound Data.xlsx` — NOT mixed into `CN-Warehouse-Inbound.xlsx`
5. **Coming-soon tile was rejected** — full Phase 2 implementation was kicked off this session.
6. **Picking ticket fields** (from `TO21787.pdf`):
   - Transfer Order #, Order Date, Priority, Memo, Ship From (name + address), Ship To (name + address)
   - Line items: Line No, SKU, Description, Order Qty, Unit, Picked Qty, Picked Location
7. **Email-paste format**: `TO# - SKU - Product Type - Qty - Destination` (5 dash-separated columns; same TO# = multiple lines on one order) — implemented as `parseOutboundPaste` in `OutboundComponents.tsx`

---

## 43. Pending work — consolidated (REVISED)

Active backlog, ordered by priority:

### Phase 2.3b — OutboundUpdateOrderForm (frontend)
- Currently a placeholder in `frontend/src/pages/OutboundComponents.tsx`
- Needs lookup by TO# → editable form → submit via `api.updateOutboundOrder(tno, payload)`
- 409 if order is `shipped` or any container is `sealed`/`shipped`
- Add `outbound_order_updated` activity_log kind mirroring `whpo_updated` (structured before/after diff)

### Phase 2.4 — Operator scan-OUT + OneDrive sync
- Backend scan-out endpoint (new in `routers/outbound_operator.py` or extend `operator.py`)
  - Validate serial exists in `scans` table
  - Validate no existing `OutboundScan.inbound_scan_id` for that scan
  - Validate serial matches an outbound line on this order
  - Create `OutboundScan` linking inbound_scan_id → outbound container/line
  - On container "seal", push to OneDrive
- New Office Script `ScanSheetAppendOutbound` in `Lime Outbound Data.xlsx`
- New Logic App `cn-outbound-scans-append`
- New env var `ONEDRIVE_OUTBOUND_SCAN_URL` (already documented in §32 + §38)

### parseOutboundPaste integration
- Verify how/whether it's wired into `OutboundNewOrderForm` (user/linter added; integration not confirmed)
- Likely needs a paste-area toggle next to the manual line entry

### Phase 3 — Manager dashboard
- Inbound / Outbound / Pending counter tiles
- Filterable by time range, SKU, customer
- Connect to WMS for cross-system visibility

### Inherited from §13
- MS 365 SSO (replace placeholder STAFF dict)
- Email-link verification for password reset
- Damage flag mid-scan
- Real-time updates via WebSocket/SSE (currently 10s polling)
- Server-side PIN hashing
- Tests for vendor auth + Update + outbound endpoints
- Production hosting decision (currently Azure App Service B1 + Static Web Apps)

### Security cleanup
- **Rotate Postgres password** (`Abcdeedcba12345*` was exposed in chat history)
- Remove DIAG `print()` statements from `app/routers/vendor.py` + `app/services/sheet_sync.py`
- Audit `.gitignore` to ensure `.onedrive_token_cache.json`, `uploads/`, `Input-Truck:Driver Images/` are excluded
- Drop `cn-warehouse-driver-update` Logic App (dead)
- Drop deprecated `WHPO.driver_*` columns (use migration)

---

## 44. Critical files reference (quick path lookup)

| What | Path (from repo root) |
|---|---|
| Backend entry | `backend/app/main.py` |
| Outbound models | `backend/app/models/__init__.py` (5 classes after `ActivityLog`) |
| Outbound migration | `backend/alembic/versions/a1b2c3d4e5f7_outbound_tables.py` |
| Outbound router | `backend/app/routers/outbound.py` |
| Outbound service | `backend/app/services/outbound.py` |
| Outbound schemas | `backend/app/schemas/outbound.py` |
| Scan-sheet router | `backend/app/routers/scan_sheet.py` |
| Auditor router | `backend/app/routers/audit.py` |
| Scan-sheet Excel export | `backend/app/services/scan_sheet_export.py` |
| Scan-sheet OneDrive push | `backend/app/services/scan_sheet_onedrive.py` |
| Container documents migration | `backend/alembic/versions/c3d4e5f6a7b8_container_documents.py` |
| Vendor uploads service | `backend/app/services/vendor_uploads.py` |
| OneDrive Graph upload | `backend/app/services/onedrive_graph.py` |
| OneDrive local sync | `backend/app/services/onedrive_local_sync.py` |
| OCR dispatch | `backend/app/services/ocr.py` (uncommitted `_snap_to_bic` fix) |
| Frontend API client | `frontend/src/api/client.ts` |
| Outbound components | `frontend/src/pages/OutboundComponents.tsx` (uncommitted `parseOutboundPaste`) |
| Vendor intake (with mode picker) | `frontend/src/pages/VendorIntakePage.tsx` |
| Auditor page | `frontend/src/pages/AuditPage.tsx` |
| Vendor portal redesign mockup | `vendor-portal-redesign.html` (standalone) |
| Picking ticket reference | `/Users/Tiana/Desktop/TO21787.pdf` (on Tiana's desktop, not in repo) |

---

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SESSION HANDOFF UPDATE — 2026-05-22 → 2026-05-27
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Everything from §45 onward is from the May 22 → May 27 sprint.
68 commits, 12 billing chunks, a vendor-portal SOP doc, an import
script, and a half-discovered Azure account migration mess.

**TL;DR for the next chat:** the live production backend is on Tiana's
PERSONAL Azure for Students account (`tvpinto@usc.edu`, RG
`cn-warehouse-prod`). A parallel `lime-inbound-backend` exists on the
work conquernation account but does not receive traffic. A full
backend migration (Option C in §46) is the next big task.

---

## 45. Recent work — chronological overview (May 22 → May 27)

68 commits in this window. Grouped by theme:

### Tally sheets (POD → billing audit log)
- POD upload + tally PDF generation via reportlab on every POD upload
- Vendor view + manager admin + remove-with-PIN flow
- OneDrive Excel sync (`Lime Tally Sheets.xlsx`) on POD upload + correction
- Operator scan-sheet open gated on tally row existing (returns 409)
- Manager DELETE container endpoint for full teardown

Commits: `e62ef9c`, `e1e499a`, `996cdf0`, `204c5b3`, `5b947f0`,
`a9c3572`, `9cea424`

### Mastersheet / master list
- View `vw_master_list` — one row per container, joined inbound + outbound
- 22-column shape matching Tiana's `Lime-Inventory-Sep 2025.xlsx`
- Manager Portal page (`MasterList.tsx`) — sortable, searchable
- OneDrive Excel mirror (`Lime Master Inventory.xlsx`) — full-replace
  pattern via Logic App + Office Script
- Manual sync-onedrive trigger endpoint

Commits: `49314fa`, `b24a864`, `c3e8c26` (revert), `58e712f`, `5645f7a`,
`56cad6d`, `a4d0c67`

### Inventory reports
- Container aging report (active / aging / stale / fully_shipped buckets)
- Per-container remaining inventory drill-down (SKU-level + serials)
- Manager Portal: WarehouseInventory.tsx

Commit: `880ecd0`

### Outbound flow extensions
- Operator auto-logout on finish
- FIFO auto-pick for outbound source containers
- Vendor BOL + Packing List PDF upload UI (per outbound order)

Commits: `801827a`, `eb26114`

### OneDrive container-folder hierarchy
- New tree: `/Vendor Files/{Account}/{Brand}/{Quarter}/{Month}/{Container}/`
- Separate Logic App for container files (different from the legacy
  WHPO-based path)
- All container documents (POD, tally PDF, BOL, driver photos, etc.)
  land in the same per-container folder

Commits: `61f82e6`, `99056dc`

### Dynamics 365 BC dual-write (Phase 1)
- Accounts → BC Customers dual-write on create/update
- BC migration plan committed

Commits: `b652c55`, `e8abaf4`, `3e176fb`

### Billing module (the big one — 12 chunks, full ERP)
See §47 for full details. Chunks 1-8 were committed before this sprint;
chunks 9-12 happened in this session. The order:

| # | Commit | What |
|---|---|---|
| 1 | `fc5193e` | Foundation: `rate_card`, `invoices`, `invoice_lines`, `customers.profile_json` |
| 2+3 | `2b581ee` | `invoice_pricing.py` + `operational_charge.py` services |
| 4 | `8843275` | PDF generation (customer + service log) via reportlab |
| 5+6 | `e1284df` | Auto-charge proposers + manager/vendor router endpoints |
| 7 | `53b6554` | Manager Invoicing UI (BillingInvoices + BillingRateCard) |
| 8 | `fc0bd57` | Vendor Invoices view (read-only) |
| **9** | **`1f8515e`** | **Vendor self-pay flow (sent → payment_submitted → paid)** |
| **10** | **`088c5c6`** | **Brand filter on manager + vendor invoice lists** |
| **11** | **`c70355a`** | **Manager Order History tab (inbound/outbound segregated)** |
| **12** | **`68a066a`** | **Rate card editor (developer-only)** |

### Vendor portal Choose Direction reorder
- Container Inventory card moved above Calendar
- Invoices tile REMOVED from this page (route `/vendor/invoices` still
  exists, just no longer linked from here)

Commit: `ef389f0`

### OpenRouter fixes (PDF picking-ticket extraction)
- Set `OPENROUTER_API_KEY` on cn-warehouse-backend App Service
- Discovered the default model `google/gemini-2.0-flash-exp:free` was
  retired by OpenRouter (returned 404 "No endpoints found")
- Swapped default to `google/gemma-4-31b-it:free` (currently free,
  vision-capable)
- Set `OPENROUTER_MODEL=google/gemma-4-31b-it:free` on App Service env
- Repo's `config.py` default updated to match

Commits: `7fcf3bf`, `bebbdce` (re-deploy after lock contention)

### CI workflow cleanup
- Dropped stale comment about "now-defunct" lime-inbound-backend
  (turned out lime-inbound is NOT defunct, see §46)

Commit: `b73fc0f`

### Historical data import script
- `backend/scripts/import_historical.py`
- Reads master-list-shaped xlsx, stages WHPOs + DOs + Containers
  + OutboundOrders + OutboundContainers
- Default dry-run + `--commit` flag for actual writes
- `--seed-onedrive-folders` flag pre-creates folder hierarchy on OneDrive
- `--report-skips` exports invalid rows as CSV

Commits: `dc9f9f0`, `2ae40e4` (seed flag), `c468277` (ssl→sslmode for psycopg2)

See §48 for full context — script is written but **NOT YET EXECUTED**
against any DB.

### Documentation deliverables (vendor user guide + flowchart)
See §50.

---

## 46. ⚠ CRITICAL — Azure account split + half-done migration

**This is the most important section in this update.** Hours of session
time went into untangling it. Don't repeat the investigation.

### The situation
There are TWO Azure accounts in play, and the project's resources are
SPLIT between them:

| Resource | Account | Tenant / Subscription | Status |
|---|---|---|---|
| Backend `cn-warehouse-backend` | **`tvpinto@usc.edu`** (personal Azure for Students) | USC Marshall School of Business / `07dc530f-ca55-4024-a4ac-5322df244439` | **LIVE PROD** — receives all traffic |
| Postgres `cn-warehouse-backend-server` | `tvpinto@usc.edu` | Same as above, RG `cn-warehouse-prod` | LIVE, private VNet (no public access) |
| Blob storage | `tvpinto@usc.edu` | Same | LIVE, holds all vendor uploads |
| Function App `cn-warehouse-fn` | `tvpinto@usc.edu` | Same | LIVE |
| Logic Apps (8+) | `tvpinto@usc.edu` | Same | LIVE |
| GH workflow `main_cn-warehouse-backend.yml` | — | — | Deploys to `cn-warehouse-backend` |
| GH variable `VITE_API_BASE` | — | — | Points at `cn-warehouse-backend...azurewebsites.net` |
| Backend `lime-inbound-backend` | **`Developer@conquernation.com`** (paid work) | conquernation / Subscription 1 `8731c186-...` | **DORMANT** — receives same code deploys but no traffic |
| Postgres `cnlimeinbound` | Same | Same, RG `lime-inbound`, **PUBLIC ACCESS ENABLED** | Empty / out-of-date schema |
| Logic Apps (6 of 8 needed) | Same | Same | LIVE but no env vars wired |
| SWA `lime-inbound-frontend` (`ambitious-forest-001ea921e`) | Same | Same | **LIVE** — serves the frontend |
| Custom domain `lime.cnwarehousing.com` | — (GoDaddy DNS) | — | Bound to the SWA above |

### How vendors reach the system today
```
Vendor browser → lime.cnwarehousing.com (GoDaddy DNS) → SWA "lime-inbound-frontend"
                                                          (conquernation tenant)
                  ↓
                SPA bundle calls hardcoded URL:
                  cn-warehouse-backend-f0gugbbvh9hhhhf2.centralus-01.azurewebsites.net
                  ↓
                cn-warehouse-backend (tvpinto's personal account)
                  ↓
                cn-warehouse-backend-server Postgres (tvpinto's account)
```

The SWA is on the work account but the SPA bundle has the personal-account
backend URL baked in via `VITE_API_BASE` at build time. The two accounts
are duct-taped together by that GitHub Actions variable.

### Why this is a problem
Tiana built originally on her personal student account. The backend never
moved when the work account became the primary account. If the student
account expires, gets disabled, or hits Azure for Students restrictions,
production breaks.

### What's confusing
- `lime-inbound-backend` IS configured with GitHub Actions auto-deploy via
  Azure Deployment Center → every push to main lands code on BOTH backends
- So lime-inbound-backend has CURRENT code, but no env vars + empty Postgres
  + no traffic → it's a warm standby that's never been activated

### How we proved which is live (definitive test)
Don't second-guess this. The bundle inspection is canonical:

```bash
BUNDLE=$(curl -sL https://lime.cnwarehousing.com/ | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
curl -sL "https://lime.cnwarehousing.com$BUNDLE" | grep -oE 'https?://[a-zA-Z0-9./_-]+' | sort -u | head -30
```

Returned (on 2026-05-26):
```
https://cn-warehouse-backend-f0gugbbvh9hhhhf2.centralus-01.azurewebsites.net
https://cn-warehouse-backend-f0gugbbvh9hhhhf2.centralus-01.azurewebsites.net/manager/invoices/
https://cn-warehouse-backend-f0gugbbvh9hhhhf2.centralus-01.azurewebsites.net/manager/tally-sheets/
```

That hostname IS in the live SPA bundle. Live SPA calls cn-warehouse.
Period. Don't accept Tiana's casual "I migrated already" — she means she
SET UP lime-inbound but never finished the cutover.

### Tiana's two USC email accounts (also confusing)
- `tvpinto@usc.edu` — has cn-warehouse-prod RG access
- `tvpinto@marshall.usc.edu` — does NOT have cn-warehouse-prod RG access
  (same person, different Microsoft account)

When re-authenticating to do migration ops on cn-warehouse, use the
`@usc.edu` variant. `az login --username tvpinto@usc.edu` pre-fills it
in the browser sign-in to avoid SSO-picking the wrong account.

### Option C migration plan (NOT EXECUTED YET)
6 phases, ~2-4 hours focused work, 15-30 min vendor downtime during
cutover. **Run this in a dedicated session, not as side-work.**

**Phase 1 — Inventory** (~30 min, read-only)
- Sign in as `tvpinto@usc.edu`, `az account set --subscription "Azure for Students"`
- List: storage accounts, function apps, Logic Apps, env vars in `cn-warehouse-prod`
- Sign in as `Developer@conquernation.com`, `az account set --subscription "Subscription 1"`
- Compare against what's already on lime-inbound side (see inventory in §46 table above)
- Identify exact gaps

**Phase 2 — Stand up missing infra in conquernation** (~1-2 hr)
- Create Storage Account in conquernation `lime-inbound` RG (vendor file
  uploads, blob CSV mirror)
- Create Function App in conquernation `lime-inbound` RG, deploy
  `cn-warehouse-fn/` code (writes inbound CSV to blob)
- Create any Logic Apps that exist on cn-warehouse but not on
  conquernation (most exist already — see §49)

**Phase 3 — Deploy code + run migrations on cnlimeinbound** (~30 min)
- Code already deploys to lime-inbound via Deployment Center, so it's
  current. Skip GH workflow changes for now.
- Set all env vars on lime-inbound-backend (port from cn-warehouse —
  see §49 for the full list)
- Run `alembic upgrade head` against cnlimeinbound. (Postgres has public
  access enabled — can run from Tiana's laptop directly.)

**Phase 4 — Migrate data** (~1-2 hr) — RISKY, take backup first
- `pg_dump` cn-warehouse Postgres (need tvpinto access, run from inside
  Azure or via App Service Console since DB is in private VNet)
- `pg_restore` into cnlimeinbound (public access — can do from laptop)
- `azcopy` blob contents from cn-warehouse storage → new conquernation
  storage account
- Verify row counts match per table

**Phase 5 — Cutover** (~30 min) — has vendor-visible downtime
- Update GH repo variable `VITE_API_BASE` →
  `https://lime-inbound-backend-hhemd4a2dff9gtdf.westus2-01.azurewebsites.net`
- Trivial commit + push to trigger SWA rebuild (~2 min build time)
- Once SWA has rebuilt: SPA starts calling lime-inbound. Test full flow.
- If broken: revert GH variable, push again. Recovery is ~5 min.

**Phase 6 — Decommission cn-warehouse** (after 1-2 weeks of monitoring)
- Stop `cn-warehouse-backend`, `cn-warehouse-fn`
- Disable Logic Apps
- After 2-4 more weeks: delete `cn-warehouse-prod` RG entirely
- Revoke `tvpinto@usc.edu` access on any remaining resources

### Why we didn't do it in this session
- Spent ~2 hours establishing which backend was actually live (had to
  rule out red herrings: deployment center logs on lime-inbound, custom
  domain bindings, SWA backend linking, etc.)
- Recommended doing it fresh in a dedicated session with proper prep:
  off-hours window for vendor downtime, both az accounts verified, pg
  tools tested, snapshot of cn-warehouse Postgres taken first

---

## 47. Billing module — comprehensive deep dive

The 12 chunks shipped over Apr-May 2026 took CN-BILLING (the standalone
Electron + Express app at `/Users/Tiana/Desktop/CN-BILLING-main.zip`)
and merged it into the unified backend.

### Architecture decision
**Manager access** = full ERP visibility (every invoice, every customer,
all line items, status transitions, PDFs).
**Vendor access** = only their own invoices, only at sent/payment_submitted/paid
status, customer PDF only (no service-log AP backup).

### Data model (3 new tables + 1 column)

#### `rate_card`
~125 charge codes across 11 categories (HANDLING, ORDER_PROC, PICKING,
PUTAWAY, STORAGE, BOL_SHIP, ACCESSORIAL, IT, MDS, LABOR, DRAYAGE).

Seeded on first deploy via `backend/app/services/rate_card_seed.py`.
Seed is idempotent — only inserts missing codes, so developer edits via
the new editor (chunk 12) survive restarts.

Columns: `code` (PK), `category`, `description`, `unit`, `rate`,
`taxable`, `is_minimum`, `is_advance`, `note`, `max_per_request`,
`min_advance`, `created_at`.

#### `invoices`
One row per WHPO (inbound) OR per Transfer Order (outbound).
Enforced via CheckConstraint `invoice_scope_xor` — exactly one of
`whpo_id` / `outbound_order_id` must be non-null.

**Status lifecycle (final, after chunk 9):**
```
draft → sent → payment_submitted → paid → void
              └ vendor self-mark    └ manager verifies receipt
```

Key snapshot fields (frozen at generation time):
- `subtotal`, `fuel_surcharge`, `advancing`, `adjustment`, `adjustment_note`
- `operational_charge`, `operational_charge_breakdown` (JSONB)
- `tax` (currently hardcoded 9.5% CA rate; Phase 2 reads from settings)
- `total`

Vendor self-pay fields (added in chunk 9):
- `vendor_payment_reference` — check #, ACH ref, etc.
- `vendor_marked_paid_at` — when vendor clicked "Mark as paid"
- `vendor_marked_paid_by` — vendor email from JWT `sub` claim

Invoice numbers come from a Postgres sequence `invoice_number_seq`,
formatted `CN-YYYYMMDD-####`.

#### `invoice_lines`
Charge line items, auto + manual. Each links to a rate_card code;
`auto_applied` flag marks system-generated charges (container minimum,
picking, etc.); `override_reason` captures manual rate edits.

#### `customers.profile_json`
JSONB column added to existing customers table. Holds the rich CN-BILLING
profile (Company, Storage, Inbound, Outbound, Special Services, Drayage,
Agreement). UI editor lands in billing Phase 2; column added now so seed
import has a home.

### Services layer

#### `app/services/invoice_pricing.py`
Port of CN-BILLING's `pricing.js`:
- `PICK_CODES`, `ADVANCE_CODES` constants
- `round2(n)` — cent rounding
- `recompute_picking_minimum(session, invoice_id)` — auto-applies $10 floor
- `invoice_totals_from_lines(lines, tax_rate, adjustment, operational_charge)` —
  returns subtotal/fuel/advancing/tax/total dict
- `compute_due_date(invoice_date, terms)` — supports Net 15/30/45/60/COD/Prepaid

#### `app/services/operational_charge.py`
Port of `operational-charge.js`. Monthly fixed fee per customer,
tier-based:

| Tier | Threshold | Monthly |
|---|---|---|
| small | ≤50 SKUs / 200 orders/mo / 5 containers/mo | $300 |
| medium | ≤200 SKUs / 1k orders/mo / 20 containers/mo | $750 |
| large | ≤500 SKUs / 5k orders/mo / 50 containers/mo | $1500 |
| enterprise | everything above | $3000 |

Plus add-ons: hazmat ($150), drayage ($100) — additive on tier base.

Each tier's components MUST sum to its monthly total (sanity-checked at
module import — raises ValueError if mismatched). Edit `TIERS` list to
change pricing.

Functions:
- `metrics_from_profile(profile)` — extracts SKUs/orders/containers/hazmat
  /drayage from `customer.profile_json`
- `pick_tier(metrics)` — first tier where all 3 caps are not exceeded
- `calculate(profile)` — full result with components + addons + monthly
  + breakdown
- `snapshot_for_invoice(profile, effective_monthly)` — frozen on the
  invoice. If `effective_monthly` differs from calculated by >$0.01,
  snapshot is a single "Custom rate per agreement" line (no leakage of
  override into customer's view)

#### `app/services/invoice_pdf.py`
Two reportlab PDF generators:
- `generate_customer_invoice_pdf(invoice, customer, lines)` — summary view,
  charges grouped by category. What vendors download.
- `generate_service_log_pdf(invoice, customer, lines)` — full line-item
  detail. AP backup, manager only.

Shared layout: black CN header band, ISSUED/DUE/TERMS row, Prepared For
/ Service Period, totals, footer with `PAYMENT_INSTRUCTIONS` +
`TERMS_FOOTER`. Hardcoded `COMPANY_NAME = "Conquer Nation Inc."`,
`COMPANY_ADDRESS = "Vernon, CA"`, `COMPANY_EMAIL = "billing@conquernation.com"`.

#### `app/services/billing_auto_charges.py`
- `propose_inbound_charges(session, whpo_id)`:
  - HND-005 ($750) per container received (`finished_at IS NOT NULL`)
  - STG-D-NH per (pallet × days held) — `(today - received_date).days, min 1`
  - PIK-001 per scan recorded on each container
- `propose_outbound_charges(session, outbound_order_id)`:
  - ORD-001 ($4.50) once per TO
  - PIK-001 per outbound scan (joined via outbound_containers since
    OutboundScan has no outbound_order_id FK directly)
  - BOL-001 ($12) per outbound container

These are Phase 1 best-effort heuristics. Phase 2 can refine (e.g.,
weight-bucket box-handling rates HND-001/2/3/4 based on actual scanned
weights).

### Router layer (`app/routers/billing.py`)

Two routers: `manager_router` (prefix `/manager`) + `vendor_router`
(prefix `/vendor`).

#### Manager endpoints (15 routes)
- `GET /manager/rate-card` — list all codes
- `POST /manager/rate-card` — **developer-only** (client-side gating)
- `PATCH /manager/rate-card/{code}` — **developer-only**, no rename
- `DELETE /manager/rate-card/{code}` — refuses if used on any invoice line
- `GET /manager/invoices` — list, supports `status`, `customer_id`, `limit`, `offset` filters
- `GET /manager/invoices/{id}` — detail with lines
- `GET /manager/invoices/{id}/pdf?type=customer|servicelog` — stream PDF
- `POST /manager/whpos/{whpo}/invoice-preview` — proposed inbound charges
- `POST /manager/whpos/{whpo}/invoice` — generate inbound invoice (409 if exists)
- `POST /manager/outbound-orders/{to}/invoice-preview` — proposed outbound
- `POST /manager/outbound-orders/{to}/invoice` — generate outbound invoice
- `POST /manager/invoices/{id}/lines` — add manual line (rate-card code + qty)
- `DELETE /manager/invoices/{id}/lines/{line_id}` — remove line
- `POST /manager/invoices/{id}/send` — flip to `sent`
- `POST /manager/invoices/{id}/paid` — flip to `paid` (terminal)
- `POST /manager/invoices/{id}/void` — flip to `void`

#### Vendor endpoints (4 routes — all JWT-required)
- `GET /vendor/invoices` — list, JWT-scoped to customer_ids + filtered to
  `(sent, payment_submitted, paid)` only (drafts/ready stay internal,
  void hidden)
- `GET /vendor/invoices/{id}` — detail (same scope)
- `POST /vendor/invoices/{id}/mark-paid` — vendor self-reports payment,
  flips `sent → payment_submitted`. Captures method, reference, notes.
  Notes append to existing manager notes (`[vendor] <text>`) so audit
  trail is preserved.
- `GET /vendor/invoices/{id}/pdf` — customer PDF only (no service log)

### Frontend

#### Manager — `frontend/src/components/`
- `BillingInvoices.tsx` (1100+ lines) — master/detail view with:
  - Left rail: list with status filter (All/Draft/Ready/Sent/Verify/Paid/Void) + brand filter + search
  - Right panel: detail with lines, status pills, action buttons
  - "Verify & mark paid" button label when status is `payment_submitted`
    (instead of generic "Mark paid")
  - Orange callout on `payment_submitted` invoices showing vendor's submission
    details (who/when/method/reference)
  - "Generate from WHPO" + "Generate from TO" buttons → preview modal → commit
  - Add Line modal with rate-card picker + override reason
- `BillingOrderHistory.tsx` (chunk 11) — paid+void invoices with
  Inbound/Outbound sub-tabs, brand filter
- `BillingRateCard.tsx` (chunk 12) — grouped by category, search, dev-only
  Edit/Delete buttons + "New code" modal (gated on `useAuth().user.role === 'developer'`)

#### Vendor — `frontend/src/pages/VendorInvoicesPage.tsx`
- Full vendor list at `/vendor/invoices`
- Stat tiles: Unpaid · Payment submitted · Paid · Total invoices
- Brand filter (dropdown, hidden when single-brand account)
- Status filter chips
- "Mark as paid" button on `sent` rows → modal with method (ACH/Wire/Check/Zelle/CC/Other)
  + reference + notes
- "Awaiting verification" indicator on `payment_submitted` rows
- "View PDF" → fetches via Bearer-auth blob, opens in new tab

#### API client — `frontend/src/api/client.ts`
`billingApi` export with full surface (~250 lines):
- `rateCard()`, `createRateCode()`, `updateRateCode()`, `deleteRateCode()`
- `listInvoices()`, `getInvoice()`
- `previewInbound()`, `generateInbound()`
- `previewOutbound()`, `generateOutbound()`
- `addLine()`, `removeLine()`
- `markSent()`, `markPaid()`, `markVoid()`
- `pdfUrl(invoice_id, type)` — for direct anchor links
- `vendorListInvoices()`, `vendorGetInvoice()`, `vendorMarkPaid()`,
  `vendorFetchPdf()` (uses Bearer header, returns Blob)

### Test data state (as of 2026-05-26)
Per the earlier session summary:
- Customers: TQL Trading Inc., Lime, Boviet Solar, Pan American Wire
- SKUs: LPN-003174, LPN-003176, LPN-003743 (Lime)
- No live invoices yet (all test data is post-wipe scratch state)

---

## 48. Historical data import — context + status

### The data
Tiana has 3 months of historical data at `/Users/Tiana/Desktop/HISTORICAL DATA.xlsx`.
Same 22-column shape as `vw_master_list` and the existing `Lime-Inventory-Sep 2025.xlsx`.

431 rows total:
- 423 importable, 8 skipped (5 invalid ISO 6346 container numbers, 3 missing commodity)
- All Lime Mobility (commodities are GLIDERS / N-E-BIKE / SCOOTERS)
- 354 unique WHPOs, 173 unique TOs
- Date range: Feb 24 → May 21, 2026
- 242 of 431 containers have shipped outbound; 189 still inbound-only

The 8 skipped rows need manual fix-up:
- `GESU64660271` (8-digit suffix, ISO 6346 needs 7)
- `DFSU71032554` (8-digit suffix)
- `TCKU71475706` (8-digit suffix)
- 2× `MIXED CONTAINER` (need re-identification from broker emails)
- 3 rows with no COMMODITY

Tiana said she'll fix these manually after the bulk import.

### The script — `backend/scripts/import_historical.py`

511 lines. Phase 1 = headers only (no SKU breakdown, no serials).

Features:
- Default mode: dry-run. Prints diff vs current DB, no writes.
- `--commit` flag: actual inserts in a single Postgres transaction
- `--seed-onedrive-folders` flag: after commit, fires one
  `_README_historical_backfill.txt` upload per container so the
  `/Account/Brand/Quarter/Month/Container/` folder hierarchy is
  pre-created. Best-effort, paced at 1/sec
- `--report-skips <path.csv>` writes invalid rows for manual fix-up
- `--customer "<name>"` defaults to "Lime Mobility"
- Idempotent — skips whpo_number / container_no / transfer_order_no
  that already exist
- Internal DO numbers use `DO-HIST-######` prefix to keep historical
  backfill rows visually distinct from live `DO-2026-####` sequence

What it inserts per row:
1. WHPO (skip if `whpo_number` exists)
2. DO (one per WHPO, auto-generated `DO-HIST-NNNNNN`)
3. Container with `do_id` link, carrier + driver_name from sheet,
   `actual_arrival_date` from RECEIVED DATE,
   `status='finished'` + `finished_at=received_date` if SCANNED=YES
4. OutboundOrder if row has TO# (priority='normal', `status='shipped'`
   if ship_date present, else 'open')
5. OutboundContainer linking BIC to TO (`type='bic'`, sealed_at = ship_date)

Does NOT touch: SKUs, container lines, outbound lines, serials, invoices,
tally sheets, operator audit data.

### Status — BLOCKED, NOT YET EXECUTED

Hit issues in this order trying to run dry-run:
1. `pandas` missing in venv → installed via `.venv/bin/python -m ensurepip`
   then `pip install pandas`
2. `psycopg2-binary` missing → installed
3. Local `.env` has `DATABASE_URL=postgresql+asyncpg://localhost/cn_warehouse`
   (local dev), not prod → override via `DATABASE_URL='<prod url>'` env var
4. Prod URL pulled via `az webapp config appsettings list`. **PROD DB
   PASSWORD WAS PASTED IN CHAT — ROTATE IT** (see §51 security cleanup)
5. asyncpg → psycopg2 URL translation needed `ssl=require` →
   `sslmode=require` (fixed in commit `c468277`)
6. Final blocker: **cn-warehouse-backend-server Postgres has public access
   DISABLED**. Can't connect from Tiana's laptop. Must run from inside
   Azure (App Service SSH on cn-warehouse-backend).

### How to actually run it (after access is sorted)
```bash
# From App Service SSH on cn-warehouse-backend, OR after migration to lime-inbound
cd /home/site/wwwroot
pip install --user pandas psycopg2-binary  # if needed
python scripts/import_historical.py "/path/to/HISTORICAL DATA.xlsx" --report-skips /tmp/skips.csv
# Eyeball the dry-run plan, then:
python scripts/import_historical.py "/path/to/HISTORICAL DATA.xlsx" --commit --seed-onedrive-folders
```

If running from laptop AFTER migration (cnlimeinbound is public):
```bash
cd /Users/Tiana/Desktop/Conquer\ Nation/Lime\ Bikes/SOFTWARE/Conquer-Nation-Warehouse/backend
PROD_URL=$(az webapp config appsettings list --name lime-inbound-backend --resource-group lime-inbound --query "[?name=='DATABASE_URL'].value" -o tsv)
DATABASE_URL="$PROD_URL" .venv/bin/python scripts/import_historical.py "/Users/Tiana/Desktop/HISTORICAL DATA.xlsx" --commit --seed-onedrive-folders
```

---

## 49. OneDrive infrastructure — full inventory

### Logic Apps in conquernation tenant (Subscription 1, RG `lime-inbound`)
All 8 enabled. Don't need to recreate during migration.

| Logic App | Purpose |
|---|---|
| `cn-inbound-append` | Appends inbound CSV rows on WHPO submit/update |
| `cn-scan-sheets-append` | Adds per-container sheet to `Lime Scan Data.xlsx` on operator finish |
| `cn-vendor-users-ops` | Vendor user CRUD against `CN-Warehouse-Inbound.xlsx`'s VendorUsers table |
| `cn-warehouse-container-files` | Container document uploads (POD, BOL, driver photos, etc.) — new Account/Brand/Quarter/Month/Container hierarchy |
| `cn-warehouse-master-sheet-sync` | Master list xlsx full-replace |
| `cn-warehouse-outbound-ops` | Vendor outbound CRUD |
| `cn-warehouse-outbound-scan-sync` | Outbound scan sheets |
| `cn-warehouse-outbound-sync` | Outbound CSV append on TO submit/update |

### Env vars currently set on lime-inbound-backend (18 keys)
```
AUDITOR_EMAILS
CORS_ORIGINS
DATABASE_URL                    # points at cnlimeinbound Postgres
GEMINI_MODEL                    # no GEMINI_API_KEY paired — needs adding if used
JWT_EXPIRY_HOURS
JWT_SECRET
ONEDRIVE_OUTBOUND_OPS_URL       # → cn-warehouse-outbound-ops
ONEDRIVE_OUTBOUND_SCAN_SHEET_URL  # → cn-warehouse-outbound-scan-sync
ONEDRIVE_OUTBOUND_WEBHOOK_URL   # → cn-warehouse-outbound-sync
ONEDRIVE_SCAN_SHEET_URL         # → cn-scan-sheets-append
ONEDRIVE_VENDORS_OPS_URL        # → cn-vendor-users-ops
ONEDRIVE_WEBHOOK_URL            # → cn-inbound-append
OPENROUTER_API_KEY              # set, value unknown — verify matches cn-warehouse
OPENROUTER_MODEL                # set, verify = google/gemma-4-31b-it:free
SCAN_SHEETS_ENABLED
SCM_DO_BUILD_DURING_DEPLOYMENT
UPLOADS_DIR
UPLOAD_MAX_BYTES
```

### Env vars MISSING from lime-inbound-backend (port from cn-warehouse-prod)
Compare lime-inbound list above against cn-warehouse-backend's env vars
(was ~30+ at last check):
- `ONEDRIVE_CONTAINER_FILES_URL` — for the new container hierarchy Logic App
  (`cn-warehouse-container-files`). The dispatch code prefers this over
  `ONEDRIVE_VENDOR_FILES_URL`. **Currently missing — newer-style container
  document uploads won't route correctly.**
- `ONEDRIVE_VENDOR_FILES_URL` + `ONEDRIVE_VENDOR_FILES_ROOT` — legacy WHPO-based
  upload path (may or may not be needed depending on whether any old code
  still calls the old service)
- `ONEDRIVE_MASTER_LIST_URL` — for `cn-warehouse-master-sheet-sync`
- `ONEDRIVE_TALLY_SHEET_URL` — for tally PDF sync
- `ONEDRIVE_SCAN_SHEET_CLEAR_URL` — wipe-transactional support
- `ONEDRIVE_OUTBOUND_SCAN_SHEET_CLEAR_URL` — same, outbound
- `BLOB_STORAGE_CONNECTION_STRING` — Azure Blob for vendor uploads
- `BLOB_CONTAINER_NAME` — default container name
- Possibly `GEMINI_API_KEY` (only `GEMINI_MODEL` is set right now)

Pull current cn-warehouse values during migration Phase 1, set them on
lime-inbound during Phase 3.

### Office Scripts (in OneDrive Excel workbooks)
Source of truth: `docs/onedrive_office_script_VendorOps.ts` (215 lines).
Actions implemented: list, append, update_last_login, update_password,
update_driver, list_inbound, delete_whpo_rows, clear_inbound_table,
ensure_bol_column, describe_inbound_table.

To update Office Scripts when the schema changes, paste the file's
contents into Excel Online → Automate → All Scripts → VendorOps. The
`docs/BOL_COLUMN_ROLLOUT.md` doc walks through one specific column-add
example end to end.

---

## 50. Documentation deliverables for vendors

In `docs/`:

| File | What |
|---|---|
| `Conquer-Nation-Vendor-Portal-User-Guide.docx` | 45 KB Word doc — 9-section walkthrough + 2 appendices, with 20 screenshot placeholders |
| `build_user_guide.py` | python-docx script — re-run after dropping screenshots into `docs/screenshots/` to embed them. Uses cover page, branded headers, callout boxes for tips/notes/warnings, status table |
| `vendor-portal-flowchart.html` | Self-contained SVG flowchart in a single HTML — opens in any browser, has Download PNG (2×) and Print to PDF buttons |
| `vendor-portal-flowchart.json` | Source elements for the Excalidraw-style flowchart (MCP-connector format) |
| `vendor-portal-flowchart.README.md` | Export instructions + edit guide |
| `render_flowchart.py` | Python → SVG/HTML converter. Re-run if the json is edited |
| `screenshots/README.md` | Capture checklist of 20 screenshots needed (filenames + descriptions) |
| `BOL_COLUMN_ROLLOUT.md` | One-off doc from earlier sprint about adding the `bol_number` column to OneDrive InboundTable |
| `onedrive_office_script_VendorOps.ts` | Canonical Office Script for VendorUsers + InboundTable operations |

### Flowchart structure
- Corporate header (CN navy band + cyan accent), "Vendor Partner Standard Operating Procedure"
- §1 AUTHENTICATION: Welcome ellipse → decision diamond ("Existing account?") → YES/NO branches → Sign in / Register → Portal Hub
- BEST PRACTICES sidebar (amber, top-right)
- NEED HELP? card (navy/cyan, top-right): `developer@conquernation.com` · `(310) 678-6768`
- §2 FUNCTIONAL MODULES: 4 lanes (INBOUND, OUTBOUND, INVENTORY, INVOICES with 4 sub-steps A→D)
- §3 INVOICE STATUS REFERENCE: 5 status pills (UNPAID, PAYMENT SUBMITTED, PAID, VOID, DRAFT-internal)
- Footer: copyright + Vernon, CA address

### User guide structure (Word doc)
1. Welcome
2. Getting Started (welcome page → register → sign in → portal hub)
3. Inbound Shipments (4 actions)
4. Outbound Transfer Orders (4 actions)
5. Container Inventory Dashboard
6. Invoices — DETAILED (where to find, KPI tiles, brand filter, PDF download,
   Mark-as-paid modal, what CN does after, status reference table)
7. Account Management
8. Troubleshooting & FAQ (6 common questions)
9. Contact & Support
- Appendix A: Glossary (WHPO, TO, BOL, brand, drayage, etc.)
- Appendix B: Screenshot checklist for the doc author

---

## 51. Outstanding / open work

### Blocking (do these first next session)
1. **Decide migration path for cn-warehouse → lime-inbound** (§46 Option C)
   - Sleep on it. Plan a maintenance window. Execute fresh.
2. **Historical data import** (§48) — blocked on Postgres access. Either:
   - Run from cn-warehouse App Service SSH (uses current prod state), OR
   - Wait for migration to lime-inbound + run from laptop against public DB
3. **Pasted secrets ROTATE NOW** — see Security cleanup below

### Phase 2 billing items (not started)
- Customer profile editor UI — 7-section form to capture
  `customer.profile_json` (Company, Storage, Inbound, Outbound, Special
  Services, Drayage, Agreement). Right now profile_json is null for
  every customer so operational charge defaults to "small" tier ($300/mo).
- Per-customer rate card overrides
- AR aging dashboard (overdue, 30/60/90+ days)
- Revenue dashboard (by customer, by month, by category)
- Storage charge daily cron (currently STG-D-NH only applies on invoice
  generation, not accruing daily)

### Phase 2 historical data items
- LPN → real SKU mapping (currently the xlsx has commodity buckets like
  "GLIDERS" + LPN code; need to map to actual SKUs like LPN-003174 ×
  114 units)
- Serial-level backfill (probably not recoverable from paper records)
- Outbound picking ticket PDFs OCR'd via the new flow
- Invoice back-fill — generate invoices retroactively for each WHPO + TO,
  mark them paid via the new vendor self-pay flow

### Frontend polish
- Add Invoices entry to vendor portal navigation (was removed from
  Choose Direction page; still accessible by typing `/vendor/invoices`
  but no link from anywhere)

### Security cleanup (URGENT)
- **Rotate cn-warehouse-backend Postgres admin password** — pasted in
  chat earlier in this session
- **Rotate OpenRouter API key** — was pasted in chat (full `sk-or-v1-...`
  key value visible in the session transcript). Generate a new one at
  <https://openrouter.ai> → Settings → Keys, delete the old one, then
  `az webapp config appsettings set --name cn-warehouse-backend
  --resource-group cn-warehouse-prod --settings OPENROUTER_API_KEY="<new>"`
- Audit other secrets that may have leaked across this session

To rotate Postgres password:
```bash
# Generate new
NEW_PW=$(openssl rand -base64 24 | tr -d '+/=' | cut -c1-24)
echo "$NEW_PW"  # copy it

# Update Postgres
az postgres flexible-server update \
  --resource-group cn-warehouse-prod \
  --name cn-warehouse-backend-server \
  --admin-password "$NEW_PW"

# Build new DATABASE_URL and set on App Service
# (admin username is in the existing DATABASE_URL — pull it via:
#   az webapp config appsettings list --name cn-warehouse-backend
#     --resource-group cn-warehouse-prod
#     --query "[?name=='DATABASE_URL'].value" -o tsv)
DB_USER="<paste current admin username from existing DATABASE_URL>"
NEW_URL="postgresql+asyncpg://${DB_USER}:${NEW_PW}@cn-warehouse-backend-server.postgres.database.azure.com:5432/cn-warehouse-backend-database?ssl=require"
az webapp config appsettings set \
  --name cn-warehouse-backend \
  --resource-group cn-warehouse-prod \
  --settings DATABASE_URL="$NEW_URL"

az webapp restart --name cn-warehouse-backend --resource-group cn-warehouse-prod
```

(Then verify with `/health/db` returning 200.)

---

## 52. Updated files reference (post-May-22)

### Added in this sprint
| Path | What |
|---|---|
| `backend/app/models/__init__.py` | Added `Account`, `RateCard`, `Invoice`, `InvoiceLine` classes + `Customer.profile_json` column. Vendor self-pay columns (`vendor_payment_reference`, `vendor_marked_paid_at`, `vendor_marked_paid_by`) on Invoice from chunk 9. |
| `backend/app/routers/billing.py` | 19 endpoints (manager + vendor) |
| `backend/app/schemas/billing.py` | Pydantic shapes for the billing API |
| `backend/app/services/rate_card_seed.py` | 125 rate codes, idempotent seed run on startup lifespan |
| `backend/app/services/invoice_pricing.py` | Port of CN-BILLING pricing.js |
| `backend/app/services/operational_charge.py` | Port of operational-charge.js |
| `backend/app/services/invoice_pdf.py` | reportlab PDF generators (customer + service log) |
| `backend/app/services/billing_auto_charges.py` | Auto-charge proposers |
| `backend/alembic/versions/i5e6f7g8h9i0_billing_foundation.py` | Foundation migration |
| `backend/alembic/versions/j6f7g8h9i0j1_invoice_vendor_payment.py` | Chunk 9 — vendor self-pay columns |
| `backend/scripts/import_historical.py` | Historical data import (Phase 1 — headers only) |
| `frontend/src/api/client.ts` | `billingApi` export with full surface (~250 lines added) |
| `frontend/src/components/BillingInvoices.tsx` | Manager invoicing master/detail UI (~1100 lines) |
| `frontend/src/components/BillingOrderHistory.tsx` | Manager Order History tab |
| `frontend/src/components/BillingRateCard.tsx` | Rate card editor (developer-only) |
| `frontend/src/pages/VendorInvoicesPage.tsx` | Vendor self-pay UI |
| `docs/vendor-portal-flowchart.html` | Self-contained flowchart |
| `docs/vendor-portal-flowchart.json` | Flowchart source |
| `docs/render_flowchart.py` | JSON → HTML/SVG converter |
| `docs/Conquer-Nation-Vendor-Portal-User-Guide.docx` | 45 KB Word doc |
| `docs/build_user_guide.py` | python-docx generator |
| `docs/screenshots/README.md` | 20-shot capture checklist |
| `docs/vendor-portal-flowchart.README.md` | Export instructions |

### Modified in this sprint
| Path | What |
|---|---|
| `backend/app/main.py` | Wired billing manager + vendor routers; lifespan seeds rate card |
| `backend/app/config.py` | Updated `openrouter_model` default from deprecated gemini-2.0-flash-exp:free → google/gemma-4-31b-it:free |
| `frontend/src/pages/VendorIntakePage.tsx` | DirectionChooser reorder (Inventory above Calendar, Invoices removed) |
| `frontend/src/pages/ManagerPage.tsx` | Added Invoicing nav category + 3 tabs (Invoices, Order History, Rate Card) |
| `.github/workflows/main_cn-warehouse-backend.yml` | Dropped stale lime-inbound comment |

### Untracked but useful
| Path | What |
|---|---|
| `docs/~$nquer-Nation-Vendor-Portal-User-Guide.docx` | Word lock file — ignore, don't commit |
| `Input-Truck:Driver Images/` | Still around from §27 — likely real driver licenses, do NOT commit |
| `.vscode/` | Workspace settings, OK to commit if desired |

---

## 53. Commit log (May 22 → May 27, chronological)

68 commits. Pasted in full so the next session can grep without git log.

Last 50:
```
c468277 Import script: translate ssl=require → sslmode=require for psycopg2
2ae40e4 Import script: add --seed-onedrive-folders flag
dc9f9f0 Scripts: historical data import (Phase 1 — headers only)
bebbdce Trigger redeploy after prior deploy lock contention
7fcf3bf OCR: swap deprecated openrouter model default
b73fc0f CI: drop now-stale comment about lime-inbound-backend
ef389f0 Vendor portal: Container Inventory above Calendar, drop Invoices tile
68a066a Billing chunk 12: rate card editor (developer role only)
c70355a Billing chunk 11: manager Order History tab (inbound/outbound segregated)
088c5c6 Billing chunk 10: brand filter on manager + vendor invoice lists
1f8515e Billing chunk 9: vendor self-pay flow (sent → payment_submitted → paid)
fc0bd57 Billing chunk 8: vendor invoices view (read-only)
53b6554 Billing chunk 7: manager Invoicing UI (invoices + rate card)
e1284df Billing chunks 5+6: auto-charge proposers + manager/vendor endpoints
8843275 Billing chunk 4: invoice PDF generation (customer + service log)
2b581ee Billing chunks 2+3: pricing + operational charge services
fc5193e Billing foundation: rate_card + invoices + invoice_lines + profile JSON
a4d0c67 Master list: manual sync-onedrive trigger endpoint
56cad6d Master List: one row per container + OneDrive Excel mirror
eb26114 Outbound: vendor BOL + Packing List upload UI
880ecd0 Inventory reports: container aging + per-container remaining stock
801827a Operator auto-logout + outbound FIFO pick + outbound BOL/packing-list upload
99056dc OneDrive: route container-folder uploads to dedicated Logic App URL
61f82e6 OneDrive: Account/Brand/Quarter/Month/Container folder hierarchy
a9c3572 Tally PDF generation — every POD upload now produces a printable sheet
f6c96cb Account Admin: Delete brand button + backend endpoint
2a2544b Trigger SWA rebuild with corrected VITE_API_BASE
3e176fb BC client: match company by name OR displayName
e8abaf4 BC migration: full-scope plan v1
b652c55 Dynamics 365 BC — Phase 1: Accounts → BC Customers dual-write
9cea424 Manager: DELETE /manager/containers/{container_no} for full teardown
5b947f0 Tally remove: show backend errors inside the re-auth modal
204c5b3 Tally sheets: remove with PIN re-auth
3c21307 POD OCR: Gemini vision extracts all fields, not just from/to
996cdf0 Tally sheets: OneDrive Excel sync on POD upload + correction
49f5883 GH Actions: actually push the app-name + secret rename to cn-warehouse-backend
91563a3 Vendor scoping: account-level logins can access any brand under them
c6d91c8 Vendor intake: brand picker derives from Account→Customers, not hardcoded TQL
8eb1a5d Vendor portal: POD / tally status block on container view
5645f7a Merge debug/mastersheet: fixed lot_assignments column bug
58e712f Mastersheet: fix view DDL (lot_assignments.pallet_id doesn't exist)
c3e8c26 Revert mastersheet backend — view + route crash prod, needs debug
b24a864 Mastersheet view: fix wrong receipts column name
49314fa Mastersheet: auto-computed inbound+outbound view + Manager Portal page
e1e499a Tally sheets frontend: Manager admin + operator 409 handler
e62ef9c Tally sheets: POD upload + scan-sheet guard + vendor tracking endpoint
```

(There are more — 68 total. Run `git log --oneline --since="2026-05-22"` for the full list.)

---

## 54. Pick-up checklist for the NEXT session

If a fresh Claude reads this file, here's what to do first:

1. **Read §46** (Azure account split) before anything else. The whole
   migration mess is documented there.
2. **Read §51** to see what's blocking.
3. **Read §48** if the user asks about importing historical data.
4. **Read §47** if the user asks about billing.
5. If user wants to do the migration: read §46 Option C, write the
   exact runbook with copy-paste commands, then execute step by step
   with checkpoints. Don't start before user confirms a maintenance
   window.
6. If user just wants to keep building: cn-warehouse-backend is fine to
   keep using for now. Push to main → both backends get the code → SPA
   keeps calling cn-warehouse. Don't try to do migration as a side task.

### State of az CLI on Tiana's Mac at handoff time
At the end of this session, az CLI was logged in as
`tvpinto@marshall.usc.edu` with subscription "Azure for Students".

**This account does NOT have access to `cn-warehouse-prod` RG.** To
read cn-warehouse resources, log in as `tvpinto@usc.edu` (no `@marshall`):
```bash
az logout
az login --username tvpinto@usc.edu
```
(`@marshall.usc.edu` and `@usc.edu` are different Microsoft accounts
despite being the same person.)

### State of venv at handoff time
`backend/.venv` was created with `uv` (no pip installed). Use:
```bash
.venv/bin/python -m ensurepip --upgrade  # bootstrap pip
.venv/bin/python -m pip install <pkg>    # install
```

Already installed in this session (just for the import script):
- `pandas`, `python-dateutil` (~10 MB)
- `psycopg2-binary` (~4 MB)
- `openpyxl` was already in `requirements.txt`

### What's in the production environment right now
- cn-warehouse-backend: latest code (last successful deploy = `bebbdce`)
- cnlimeinbound Postgres: unknown schema state — assume empty/outdated
- cn-warehouse-backend Postgres: current schema, all migrations applied,
  has test data (TQL/Lime/Boviet/Pan American brands + 3 Lime SKUs)
- Live SPA bundle: `index-ekIDozA4.js`, has cn-warehouse URL hardcoded

---

End of handoff.
