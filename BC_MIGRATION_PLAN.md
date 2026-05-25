# Migration to Microsoft Dynamics 365 Business Central

**Status:** Draft v1 — 2026-05-25
**Author:** Tiana Pinto (IT Director, Conquer Nation) with Claude
**Audience:** Conquer Nation leadership, future BC implementation partner, engineering

---

## TL;DR

The custom-built **cn-warehouse** app (Postgres + FastAPI + React) will be retired in favour of **Dynamics 365 Business Central**. BC becomes the single system of record for accounts, brands, SKUs, inbound receipts, tally sheets / billing, and outbound shipments. Users transition off the custom UIs and onto BC + Power Platform.

Approach: **strangler fig with dual-write**. Custom app keeps running for current operations; every write also mirrors to BC; once BC equivalents are live for each workflow, users cut over; once everyone is cut over, the custom app retires.

Realistic timeline: **5-9 months** end-to-end with focused effort.

---

## Why migrate

| Driver | Implication |
|---|---|
| **Single source of truth for financials** | All revenue / AR / AP / inventory accounting lives in BC, not three places |
| **Audit + compliance** | BC's audit log, posting workflows, and dimension controls are well-tested vs custom code |
| **Vendor portal + B2B** | BC has native vendor self-service + EDI; we currently maintain that ourselves |
| **Reduced bespoke maintenance** | Today: one IT director (Tiana) maintaining a custom app. BC has a partner ecosystem |
| **Power Platform integration** | Power BI dashboards, Power Apps mobile, Power Automate workflows — all bolt onto BC natively |

---

## Current state — what cn-warehouse does today

### Backend (FastAPI + Postgres)

| Module | Endpoints | Tables |
|---|---|---|
| Vendor portal | `/vendor/*` — register, login, WHPO submit/view/update, driver info, document upload, container tally view | `vendor_users` (OneDrive Excel), `whpos`, `dos`, `containers`, `container_lines`, `container_documents`, `tally_sheets` (read-only for vendor) |
| Operator scan | `/operator/*`, `/operator/sheet/*` — container lookup, sheet open, scan rows, finish | `receipts`, `scans`, `pallets`, `lot_assignments` |
| Manager portal | `/manager/*` — dashboards, DO/TO admin, accounts, customers, SKUs, exceptions, tally sheets, master list, BC reconcile | All transactional + master tables |
| Outbound | `/vendor/outbound/*`, `/operator/sheet/{id}/scan` (outbound mode) | `outbound_orders`, `outbound_lines`, `outbound_containers`, `outbound_scans` |
| Tally sheets | `/manager/tally/*` — POD upload, Gemini OCR, PIN re-auth delete, list/detail/patch | `tally_sheets`, POD files on disk |
| Master list (view) | `/manager/master-list` — auto-computed inbound+outbound mastersheet | `vw_master_list` (Postgres view) |

### Frontend (React + Vite, served by Azure Static Web Apps)

- Vendor portal (`/vendor`, `/vendor-intake`, `/vendor/login`, `/vendor/register`, `/vendor/audit`)
- Operator scan kiosk (`/operator`) — 11-key barcode input, browser-native scan event handlers, scan-sheet view
- Manager portal (`/manager`) — sidebar nav: Home / Customer / Receiving / Shipping / Warehouse / Reports

### External integrations (current)

- **OneDrive Excel** — vendor users store, scan sheets, outbound table, inbound table, tally table (planned)
- **Azure Logic Apps** — Excel append/clear, soon: tally append
- **Gemini Vision API** — POD field extraction (chassis, seal, container, driver, etc.)
- **Static Web Apps + App Service + Postgres Flexible Server** — Azure hosting stack
- **OneDrive folder hierarchy** (planned) — `Account/Brand/Quarter/Month/Container/` for POD + tally PDF + driver license

---

## Target state — what BC + Power Platform does

```
                   ┌─────────────────────────────────┐
                   │ END USERS                       │
                   │  • Operators (handheld scan)    │
                   │  • Managers (warehouse + finance)│
                   │  • Vendors (broker self-service)│
                   └────┬─────────────┬─────────────┬┘
                        │             │             │
                        ▼             ▼             ▼
              ┌─────────────┐ ┌────────────┐ ┌───────────────┐
              │ Power Apps  │ │ BC Web     │ │ BC Vendor     │
              │ mobile scan │ │ Client     │ │ Portal + B2B  │
              │ (or BC WMS) │ │            │ │ extensions    │
              └──────┬──────┘ └─────┬──────┘ └──────┬────────┘
                     │              │               │
                     └──────────────┼───────────────┘
                                    ▼
                       ┌─────────────────────────┐
                       │ Dynamics 365 Business   │
                       │ Central (Online)        │
                       │  • Native: Customers /  │
                       │    Items / Sales / Pur. │
                       │  • Custom AL extension: │
                       │    Containers, Tally,   │
                       │    Vendor workflows     │
                       └────────────┬────────────┘
                                    │
                       ┌────────────▼──────────────┐
                       │ Power Platform support    │
                       │  • Power Automate flows   │
                       │  • Power BI dashboards    │
                       │  • Dataverse for staging  │
                       └───────────────────────────┘
```

---

## Mapping — custom app entity → BC concept

| cn-warehouse entity | BC equivalent | Native or custom AL? |
|---|---|---|
| `Account` (TQL) | **Customer** with billing group | Native |
| `Customer` / Brand (Lime, Boviet) | **Customer** with parent Account link via Dimension | Native (use Dimensions for parent rollup) |
| `SKU` | **Item** (with item attributes for pallet specs, sqft) | Native + small AL for sqft fields |
| `Pallet specs` | **Item Attribute** + **Item Unit of Measure** | Native |
| `WHPO` (vendor's PO) | **Purchase Order** (header) | Native |
| `DO` (internal delivery order) | **Warehouse Receipt** + **Posted Whse. Receipt** | Native |
| `Container` (BIC / truck) | NEW **Container** table extension (cross-links to Purchase Receipt / Sales Shipment) | **Custom AL** |
| `Container_Document` (license, BOL, etc.) | **Document Attachment** on Purchase Order / Container | Native + small AL |
| `Container_Line` (SKU × qty per container) | Purchase Order line **+** Container line link | Native + AL |
| `Receipt` (scan sheet) | **Posted Warehouse Receipt** | Native |
| `Scan` (item barcode) | **Item Tracking Line** (lot/serial) | Native |
| `Lot` / `LotAssignment` | **Lot Number** / **Bin** | Native |
| `Tally_Sheet` (POD + billing audit) | NEW **Tally Sheet** table extension + **Sales Invoice** generation | **Custom AL** |
| `Outbound_Order` / Transfer Order | **Sales Order** (or **Transfer Order** for internal moves) | Native |
| `Outbound_Container` | NEW Outbound Container extension | **Custom AL** |
| `Outbound_Scan` | **Item Tracking Line** on Sales Shipment | Native |
| `Exception` | **BC Notification** / custom exception table | Custom AL |
| `Activity_Log` | **Change Log** (native) | Native |
| Master List view | **Power BI** report on top of BC data | Native (no code) |
| OneDrive folder hierarchy (POD, license, etc.) | **SharePoint Document Set** linked from BC | Native + Power Automate flow |
| OneDrive Excel mirrors | Replaced by Power BI / BC native reports | n/a — retire |

**The novel parts that need real AL development:**
1. **Container** as a first-class entity (BC doesn't ship a container model out of the box for 3PL receiving)
2. **Tally Sheet** as a custom POD-driven audit row that drives invoice generation
3. **Gemini OCR pipeline** — Azure Function called from BC codeunit to extract POD fields
4. **Vendor self-service forms** beyond what BC Vendor Portal offers natively

Everything else is configuration + light customization.

---

## Phased plan

### Phase 0 — Foundation (in progress)

**Goal:** prove the auth + dual-write pattern with the lowest-risk data
**Deliverables:**
- ✅ BC OAuth client (`app/services/bc_client.py`) — commit b652c55
- ✅ Account → BC Customer dual-write
- ✅ Manual reconcile endpoint (`POST /manager/bc/reconcile-accounts`)
- ⏳ Tiana: Register Azure AD app + grant BC permissions
- ⏳ Tiana: Set 5 env vars in App Service
- ⏳ Backfill existing accounts via reconcile

**Effort:** ~1 week including BC permission setup
**Risk:** low

### Phase 1 — Master data sync

**Goal:** BC has the complete master data picture
**Deliverables:**
- SKU → BC Item dual-write (extend bc_client.py)
- Customer (brand) → BC Customer dual-write
- Item Attributes for sqft / pallet specs
- Dimension setup for Account → Brand rollup
- Reconcile endpoints for each entity

**Effort:** 2-3 weeks
**Dependencies:** Phase 0 working
**Risk:** low

### Phase 2 — Transactional sync (one-way: Postgres → BC)

**Goal:** every receipt and shipment flows to BC as a posted document
**Deliverables:**
- Receipt (container sealed) → BC Posted Purchase Receipt
- Lot assignments → BC Lot/Bin
- Outbound container sealed → BC Posted Sales Shipment
- Custom Container table extension in BC (AL) — the foundational extension object
- Sync hooks on receipt finish + outbound seal

**Effort:** 6-10 weeks
**Dependencies:** Phase 1 (BC has SKUs as Items)
**Risk:** medium (data model mismatch on first iteration; expect re-work)

### Phase 3 — Billing migration

**Goal:** tally sheets generate BC sales invoices for the account
**Deliverables:**
- Tally Sheet table extension in BC (AL)
- Sync: cn-warehouse `tally_sheets` row → BC Tally Sheet record
- Codeunit: on tally `billing_status='billed'` → create BC Sales Invoice draft
- Manager workflow in BC for invoice review + post
- POD file attachment via SharePoint integration

**Effort:** 4-6 weeks
**Dependencies:** Phase 2 (receipts exist in BC to link)
**Risk:** medium

### Phase 4 — Vendor cutover

**Goal:** vendors stop using cn-warehouse, start using BC Vendor Portal
**Deliverables:**
- BC Vendor Portal customizations (AL pages for WHPO submit, driver info, doc upload)
- B2B Excel template for bulk WHPO submission (Lime-style)
- Vendor user migration (Excel `Vendor Users` → BC Contact + Web User)
- Sunset cn-warehouse vendor portal pages

**Effort:** 8-12 weeks
**Dependencies:** Phase 2 + 3
**Risk:** high (user training, support load)

### Phase 5 — Operator cutover

**Goal:** operators stop using cn-warehouse scan kiosk, use BC Mobile (or Power Apps)
**Deliverables:** depends on scan flow choice (see Open Decisions)
- If **BC Warehouse Mgmt**: configure WMS module, train operators on BC Mobile
- If **Power Apps**: build Power Apps mobile app, connect to BC via Dataverse / BC connector
- Either way: barcode + POD photo flows replicated
- Sunset cn-warehouse operator pages

**Effort:** 12-16 weeks
**Dependencies:** Phase 2 (BC knows about containers)
**Risk:** high (operator UX + training + handheld hardware compatibility)

### Phase 6 — Manager cutover + retire custom app

**Goal:** managers use BC + Power BI exclusively; custom app shuts down
**Deliverables:**
- Power BI dashboards replicating cn-warehouse dashboards + master list
- Manager training on BC pages (accounts, customers, items, receipts, invoices, exceptions)
- One-time data migration sweep (verify nothing lost)
- DNS cutover: `lime.cnwarehousing.com` either retires or redirects to BC vendor portal
- Decommission: Static Web App, App Service, Postgres Flexible Server, Logic Apps

**Effort:** 4-6 weeks
**Dependencies:** all prior phases
**Risk:** medium (mostly procedural)

### Total

**Calendar time:** 9-15 months with single-engineer focused effort. Faster with a BC partner doing config + WMS setup in parallel with custom AL.

---

## Open decisions (need Tiana / leadership input)

1. **Operator scan UX** — Power Apps mobile vs BC Warehouse Mgmt module vs hybrid. Affects Phase 5 scope by ±4 weeks.
2. **BC partner engagement** — full migration with one IT director is doable but slow. A BC partner doing WMS config + Vendor Portal customization in parallel cuts ~3 months off.
3. **Cutover style** — big-bang (all users on BC on date X) vs phased (vendor first, operators next, managers last). Phased is lower-risk; big-bang is faster.
4. **OneDrive Excel + Logic Apps** — keep through Phase 4 as audit trail, or retire as soon as BC equivalents are live?
5. **Tally PDF generation** — keep server-side PDF (current chip) or use BC's report-as-PDF? BC's is more native; current chip is closer to ready.
6. **Vendor authentication** — keep email + password (current) or switch to Azure AD B2B / Entra External Identities? B2B is more enterprise but onerous for one-off vendors.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| BC data model doesn't fit the 3PL container concept cleanly | High | Medium | Spike early in Phase 2 with a real container scenario; budget for one re-model |
| Operator handheld UX regression on BC Mobile vs custom kiosk | Medium | High | Field-test with one operator for 1 week before Phase 5 cutover |
| Vendor adoption — brokers used to current portal resist BC portal | Medium | High | Keep cn-warehouse vendor portal alive in parallel during Phase 4; cut over per vendor not per date |
| Gemini OCR integration breaks when called from BC vs FastAPI | Low | Low | Wrap as Azure Function with REST API; called identically from either side |
| Custom AL extension breaks during BC version upgrades | Medium | Low | Standard AppSource validation + extension versioning; test in sandbox before prod upgrades |
| Existing Postgres data fails to map cleanly into BC | Low | Medium | Phase 2 dual-write surfaces mismatches early; data migration is incremental not big-bang |
| Cost — BC license fees + Power Apps + AL development | High | Medium | License math early; per-user costs are predictable, but Premium-tier features for WMS are pricey |

---

## What we keep / what we retire

### Keep (or evolve)

- **Gemini OCR for POD extraction** — works well, will live in an Azure Function called from BC
- **OneDrive Document Storage** — moves to SharePoint Document Sets linked from BC
- **PIN-based operator auth** — model lives on in Power Apps or BC mobile sign-in
- **Account → Brand hierarchy** — implemented as BC Dimensions
- **Tally sheet concept** — becomes a custom AL table; the workflow is identical

### Retire

- React vendor portal pages → BC Vendor Portal
- React manager portal pages → BC Web Client
- React operator scan kiosk → Power Apps OR BC Mobile
- FastAPI backend → BC AL extension + Power Automate
- Postgres → BC database (Azure SQL backed)
- Static Web Apps + App Service + Logic Apps → BC + Power Platform
- Custom OneDrive Excel sync layer → Power BI on top of BC

---

## Next 30 days

| Owner | Task |
|---|---|
| **Tiana** | Register Azure AD app + grant BC permissions (Phase 0 step) |
| **Tiana** | Set 5 BC env vars in App Service + restart |
| **Tiana** | Run `POST /manager/bc/reconcile-accounts` — verify accounts appear in BC sandbox |
| **Tiana** | Decide: engage a BC partner or solo? Decision affects Phase 4-6 timeline |
| **Engineering** | Phase 1 sync: SKUs → Items (2-3 weeks) |
| **Engineering** | Spike the Container AL extension in sandbox to validate data model fit |
| **Tiana** | Get pricing on BC Premium tier (WMS) + Power Apps Per User licensing |

---

## Reference

- Today's commit (Phase 0 foundation): `b652c55` — Accounts → BC Customers dual-write
- Existing cn-warehouse codebase: `/Users/Tiana/Desktop/Conquer Nation/Lime Bikes/SOFTWARE/Conquer-Nation-Warehouse/`
- BC sandbox: TBD (Tiana to fill in tenant URL)
- BC API docs: https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-reference/v2.0/
- AL development guide: https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-dev-overview
