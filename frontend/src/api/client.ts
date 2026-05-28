import { readVendorToken } from '../auth/VendorAuthContext'
import type {
  ContainerLookupResponse,
  DODetail,
  DOListItem,
  DashboardResponse,
  ExceptionItem,
  FinishResponse,
  LotDetail,
  LotMapItem,
  ResolveExceptionRequest,
  ResolveExceptionResponse,
  ScanResponse,
  VendorWHPOSubmission,
  WHPOIntakeResponse,
} from '../types/api'

// Frontend always talks to its own origin. Vite dev server proxies /api/* to the backend.
// Avoids browser cross-origin/CORS/HSTS issues that affect Safari + localhost.
// In production, VITE_API_BASE points at the deployed App Service hostname.
export const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'
const BASE = API_BASE

/**
 * Scan-sheet feature flag — frontend-side. Mirrors the backend's
 * `SCAN_SHEETS_ENABLED` setting; both must be ON for the operator
 * scan-sheet UI and the auditor page to render. Defaults to false so
 * production stays unaffected until we flip both.
 */
export const SCAN_SHEETS_ENABLED =
  String(import.meta.env.VITE_SCAN_SHEETS_ENABLED ?? '').toLowerCase() === 'true'

/**
 * Container-plate OCR is now done **client-side** with Tesseract.js — no
 * backend service required. Always available. The legacy VITE_OCR_BASE env
 * var is kept as an escape hatch in case we later add a server-side OCR.
 */
const _ocr_base_raw = (import.meta.env.VITE_OCR_BASE as string | undefined) ?? ''
export const OCR_BASE = _ocr_base_raw.replace(/\/+$/, '')
export const OCR_AVAILABLE = true
export const OCR_ENDPOINT = OCR_BASE.length > 0
  ? `${OCR_BASE}/container-photo`
  : `${BASE}/ocr/container-photo`

class ApiError extends Error {
  status: number
  detail: string
  /** Parsed `detail` value when the server returned an object (e.g. the
   *  scan-sheet 409 with {message, tally_required, container_no}).
   *  Stringified in `detail` for backward compatibility. */
  detailObj: unknown
  constructor(status: number, detail: string, detailObj?: unknown) {
    super(`API ${status}: ${detail}`)
    this.status = status
    this.detail = detail
    this.detailObj = detailObj
  }
}

async function request<T>(
  path: string,
  init?: RequestInit & { auth?: boolean }
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init?.headers as Record<string, string>) ?? {}),
  }
  // Attach vendor JWT for routes that may accept it (default ON — backend
  // treats it as optional, so it's safe to send everywhere).
  if (init?.auth !== false) {
    const token = readVendorToken()
    if (token) headers.Authorization = `Bearer ${token}`
  }
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers,
  })
  if (!res.ok) {
    let detail = res.statusText
    let detailObj: unknown = undefined
    try {
      const body = await res.json()
      if (typeof body.detail === 'string') {
        detail = body.detail
      } else {
        detailObj = body.detail
        // Friendlier string fallback when detail is structured.
        const m = (body.detail as { message?: string } | undefined)?.message
        detail = m || JSON.stringify(body.detail)
      }
    } catch {
      /* ignore JSON parse */
    }
    throw new ApiError(res.status, detail, detailObj)
  }
  return (await res.json()) as T
}

async function requestMultipart<T>(
  path: string,
  method: 'PUT' | 'POST',
  form: FormData,
): Promise<T> {
  const headers: Record<string, string> = {}
  const token = readVendorToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, body: form, headers })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail)
  }
  return (await res.json()) as T
}

async function requestVoid(
  path: string,
  init?: RequestInit & { auth?: boolean }
): Promise<void> {
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string>) ?? {}),
  }
  if (init?.auth !== false) {
    const token = readVendorToken()
    if (token) headers.Authorization = `Bearer ${token}`
  }
  const res = await fetch(`${BASE}${path}`, { ...init, headers })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail)
  }
}

export interface ContainerDocumentItem {
  id: number
  kind: string
  label: string
  filename: string
  content_type: string
  file_size: number
  uploaded_at: string
  uploaded_by: string | null
  url: string
}

export interface DocumentKindOption {
  kind: string
  label: string
}

export interface VendorTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  user: { email: string; full_name: string; company: string }
}

export const api = {
  // Operator
  lookupContainer: (container_no: string, operator: string) =>
    request<ContainerLookupResponse>('/operator/container/lookup', {
      method: 'POST',
      body: JSON.stringify({ container_no, operator }),
    }),

  scan: (receipt_id: number, item_barcode: string, operator: string) =>
    request<ScanResponse>('/operator/scan', {
      method: 'POST',
      body: JSON.stringify({ receipt_id, item_barcode, operator }),
    }),

  finishContainer: (receipt_id: number, operator: string) =>
    request<FinishResponse>('/operator/container/finish', {
      method: 'POST',
      body: JSON.stringify({ receipt_id, operator }),
    }),

  // Vendor
  submitWHPO: (payload: VendorWHPOSubmission) =>
    request<WHPOIntakeResponse>('/vendor/whpo', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Update existing WHPO — current state + apply
  getWHPOCurrent: (whpo_number: string) =>
    request<{
      whpo_number: string
      do_number: string
      customer_name: string
      expected_arrival_date: string | null
      bol_number: string | null
      any_locked: boolean
      containers: {
        container_no: string
        expected_arrival_date: string | null
        expected_arrival_time: string | null
        status: string
        is_locked: boolean
        has_driver_info: boolean
        driver_name: string | null
        driver_license: string | null
        driver_phone: string | null
        truck_license_plate: string | null
        insurance: string | null
        carrier: string | null
        lines: { sku: string; qty: number; product_type: string | null }[]
      }[]
    }>(`/vendor/whpo/${whpo_number}/current`),

  updateWHPO: (
    whpo_number: string,
    payload: {
      expected_arrival_date: string | null
      bol_number?: string | null
      containers: {
        original_container_no: string
        container_no: string
        expected_arrival_date: string | null
        expected_arrival_time: string | null
        carrier?: string | null
        driver_name?: string | null
        driver_license?: string | null
        driver_phone?: string | null
        truck_license_plate?: string | null
        insurance?: string | null
        lines: { sku: string; qty: number; product_type: string | null }[]
      }[]
    },
  ) =>
    request<{
      whpo_number: string
      do_number: string
      summary: string
      excel_resynced: boolean
      changes: {
        scope: string
        container_no: string | null
        field: string
        before: string | null
        after: string | null
        sku: string | null
      }[]
    }>(`/vendor/whpo/${whpo_number}/update`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  listWHPOContainers: (whpo_number: string) =>
    request<{
      whpo_number: string
      do_number: string
      customer_name: string
      containers: { container_no: string; has_driver_info: boolean; driver_name: string | null }[]
    }>(`/vendor/whpo/${whpo_number}/containers`),

  submitContainerDriverInfo: (
    container_no: string,
    payload: {
      carrier: string
      driver_name: string
      driver_license: string
      driver_phone: string
      truck_license_plate: string
      insurance: string
    },
  ) =>
    request<{
      container_no: string
      whpo_number: string
      do_number: string
      rows_affected: number
    }>(`/vendor/container/${container_no}/driver-info`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  // Manager
  getDashboard: () => request<DashboardResponse>('/manager/dashboard'),

  listDOs: (status?: string) =>
    request<DOListItem[]>(`/manager/dos${status ? `?status=${status}` : ''}`),

  getDODetail: (do_id: number) => request<DODetail>(`/manager/dos/${do_id}`),

  listLots: () => request<LotMapItem[]>('/manager/lots'),

  getLotDetail: (lot_id: number) => request<LotDetail>(`/manager/lots/${lot_id}`),

  listExceptions: () => request<ExceptionItem[]>('/manager/exceptions'),

  resolveException: (exception_id: number, payload: ResolveExceptionRequest) =>
    request<ResolveExceptionResponse>(`/manager/exceptions/${exception_id}/resolve`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Data explorer
  listDatabaseTables: () =>
    request<{ name: string; rows: number }[]>('/manager/database/tables'),

  getTableRows: (table: string, limit = 200) =>
    request<Record<string, unknown>[]>(`/manager/database/rows/${table}?limit=${limit}`),

  // Vendor self-service auth
  vendorRegister: (payload: {
    email: string
    password: string
    full_name: string
    company: string
  }) =>
    request<VendorTokenResponse>('/vendor/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
      auth: false,
    }),

  vendorLogin: (payload: { email: string; password: string }) =>
    request<VendorTokenResponse>('/vendor/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
      auth: false,
    }),

  vendorMe: () =>
    request<{ email: string; full_name: string; company: string }>(
      '/vendor/auth/me'
    ),

  listVendorCustomers: () =>
    request<string[]>('/vendor/auth/customers', { auth: false }),

  /** Brands the logged-in vendor can submit shipments for. Returns one
   *  name (no picker needed) for direct-brand logins, or many (Submitting-
   *  on-behalf-of picker) for Account-level logins like TQL. Backend
   *  resolves the company string → Account → Customers under that
   *  Account, or → single Customer, or → [company] fallback. */
  myBrands: () => request<string[]>('/vendor/auth/my-brands'),

  vendorResetPassword: (payload: { email: string; new_password: string }) =>
    request<VendorTokenResponse>('/vendor/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify(payload),
      auth: false,
    }),

  // Container documents (driver/truck photos: licence plates, insurance, etc.)
  listDocumentKinds: () =>
    request<{ kinds: DocumentKindOption[] }>('/vendor/document-kinds', {
      auth: false,
    }),

  listContainerDocuments: (container_no: string) =>
    request<{ container_no: string; documents: ContainerDocumentItem[] }>(
      `/vendor/container/${container_no}/documents`,
    ),

  uploadContainerDocument: (container_no: string, kind: string, file: File) => {
    const fd = new FormData()
    fd.append('file', file, file.name)
    return requestMultipart<ContainerDocumentItem>(
      `/vendor/container/${container_no}/documents/${kind}`,
      'PUT',
      fd,
    )
  },

  deleteContainerDocument: (container_no: string, kind: string) =>
    requestVoid(`/vendor/container/${container_no}/documents/${kind}`, {
      method: 'DELETE',
    }),

  fetchContainerDocumentBlob: async (
    container_no: string,
    kind: string,
  ): Promise<Blob> => {
    const headers: Record<string, string> = {}
    const token = readVendorToken()
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(
      `${BASE}/vendor/container/${container_no}/documents/${kind}/file`,
      { headers },
    )
    if (!res.ok) {
      let detail = res.statusText
      try {
        const body = await res.json()
        detail =
          typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, detail)
    }
    return res.blob()
  },

  // ─── Scan-sheet (Day-1 feature, gated by backend SCAN_SHEETS_ENABLED) ──
  openScanSheet: (container_no: string, operator: string) =>
    request<ScanSheetOpenResponse>(
      `/operator/sheet/open?operator=${encodeURIComponent(operator)}`,
      { method: 'POST', body: JSON.stringify({ container_no }) },
    ),

  recordScanRow: (
    receipt_id: number,
    operator: string,
    payload: {
      serial_number: string
      sku?: string | null
      imei?: string | null
      notes?: string | null
    },
  ) =>
    request<ScanRecordResponse>(
      `/operator/sheet/${receipt_id}/scan?operator=${encodeURIComponent(operator)}`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),

  finishScanSheet: (receipt_id: number, operator: string) =>
    request<ScanFinishResponse>(
      `/operator/sheet/${receipt_id}/finish?operator=${encodeURIComponent(operator)}`,
      { method: 'POST' },
    ),

  viewScanSheet: (receipt_id: number) =>
    request<ScanSheetOpenResponse>(`/operator/sheet/${receipt_id}`),

  // ─── Auditor (email-whitelisted) ────────────────────────────────────
  listAuditSheets: (params: {
    year?: number | null
    month?: number | null
    container_no?: string | null
    whpo_number?: string | null
  }) => {
    const q = new URLSearchParams()
    if (params.year != null) q.set('year', String(params.year))
    if (params.month != null) q.set('month', String(params.month))
    if (params.container_no) q.set('container_no', params.container_no)
    if (params.whpo_number) q.set('whpo_number', params.whpo_number)
    return request<AuditSheetListResponse>(
      `/audit/sheets${q.toString() ? '?' + q.toString() : ''}`,
    )
  },

  getAuditSheet: (receipt_id: number) =>
    request<AuditSheetDetailResponse>(`/audit/sheets/${receipt_id}`),

  /** Download a single container as TEMPLATE.xlsx clone. Returns Blob.
   *  Uses the standard JWT — auditor whitelist enforced server-side. */
  downloadAuditSheetXlsx: async (receipt_id: number): Promise<Blob> => {
    const headers: Record<string, string> = {}
    const token = readVendorToken()
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(
      `${BASE}/audit/sheets/${receipt_id}/export.xlsx`,
      { headers },
    )
    if (!res.ok) throw new ApiError(res.status, res.statusText)
    return res.blob()
  },

  downloadAuditBulkXlsx: async (params: {
    year?: number | null
    month?: number | null
    container_no?: string | null
    whpo_number?: string | null
  }): Promise<Blob> => {
    const q = new URLSearchParams()
    if (params.year != null) q.set('year', String(params.year))
    if (params.month != null) q.set('month', String(params.month))
    if (params.container_no) q.set('container_no', params.container_no)
    if (params.whpo_number) q.set('whpo_number', params.whpo_number)
    const headers: Record<string, string> = {}
    const token = readVendorToken()
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(
      `${BASE}/audit/sheets/export.xlsx${q.toString() ? '?' + q.toString() : ''}`,
      { headers },
    )
    if (!res.ok) throw new ApiError(res.status, res.statusText)
    return res.blob()
  },

  // ─── Outbound (Phase 2) ────────────────────────────────────────────
  submitOutboundOrder: (payload: OutboundOrderSubmission) =>
    request<OutboundIntakeResponse>('/vendor/outbound/order', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateOutboundOrder: (
    transfer_order_no: string,
    payload: OutboundOrderUpdateRequest,
  ) =>
    request<OutboundUpdateResponse>(
      `/vendor/outbound/order/${encodeURIComponent(transfer_order_no)}`,
      { method: 'PUT', body: JSON.stringify(payload) },
    ),

  listMyOutboundOrders: () =>
    request<OutboundOrderListResponse>('/vendor/outbound/orders'),

  viewOutboundOrder: (transfer_order_no: string) =>
    request<OutboundOrderRead>(
      `/vendor/outbound/order/${encodeURIComponent(transfer_order_no)}`,
    ),

  attachOutboundContainer: (
    transfer_order_no: string,
    payload: OutboundContainerAttachRequest,
  ) =>
    request<OutboundContainerAttachResponse>(
      `/vendor/outbound/order/${encodeURIComponent(transfer_order_no)}/container`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),

  /** Upload a BOL or Packing List against an outbound order. `kind` is
   *  one of 'bol' | 'packing_list'. Replaces any prior file of that
   *  kind. Returns a small ack {transfer_order_no, kind, filename,
   *  content_type, size}. */
  uploadOutboundDocument: (
    transfer_order_no: string,
    kind: 'bol' | 'packing_list',
    file: File,
  ) => {
    const form = new FormData()
    form.append('file', file)
    return requestMultipart<{
      transfer_order_no: string
      kind: string
      filename: string
      content_type: string
      size: number
    }>(
      `/vendor/outbound/order/${encodeURIComponent(transfer_order_no)}/document/${kind}`,
      'POST',
      form,
    )
  },

  outboundInventory: () =>
    request<InventoryResponse>('/vendor/outbound/inventory'),

  outboundContainerInventory: () =>
    request<ContainerInventoryResponse>('/vendor/outbound/container-inventory'),

  whpoStatus: (whpoNumber: string) =>
    request<WHPOStatusResponse>(
      `/vendor/whpo/${encodeURIComponent(whpoNumber)}/status`,
    ),

  outboundOrderStatus: (tno: string) =>
    request<OutboundOrderStatusResponse>(
      `/vendor/outbound/order/${encodeURIComponent(tno)}/status`,
    ),

  vendorCalendar: (days = 14) =>
    request<CalendarResponse>(`/vendor/calendar?days=${days}`),

  managerCalendar: (days = 14) =>
    request<CalendarResponse>(`/manager/calendar?days=${days}`),

  extractPickingTicket: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return requestMultipart<PickingTicketExtraction>(
      '/ocr/picking-ticket',
      'POST',
      fd,
    )
  },

  extractDriverDocs: (files: File[]) => {
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    return requestMultipart<DriverDocsExtraction>(
      '/ocr/driver-docs',
      'POST',
      fd,
    )
  },

  // ─── Account hierarchy admin ───────────────────────────────────────
  listAccounts: () => request<AccountRead[]>('/manager/accounts'),

  createAccount: (payload: AccountCreate) =>
    request<AccountRead>('/manager/accounts', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateAccount: (id: number, payload: AccountUpdate) =>
    request<AccountRead>(`/manager/accounts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteAccount: (id: number) =>
    requestVoid(`/manager/accounts/${id}`, { method: 'DELETE' }),

  // ─── SKU master admin ──────────────────────────────────────────────
  listManagerCustomers: (account_id?: number) => {
    const qs = account_id != null ? `?account_id=${account_id}` : ''
    return request<CustomerRead[]>(`/manager/customers${qs}`)
  },

  createCustomer: (payload: { name: string; account_id?: number | null; contact_email?: string | null }) =>
    request<CustomerRead>('/manager/customers', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateCustomer: (
    id: number,
    payload: { name?: string; account_id?: number | null; contact_email?: string | null },
  ) =>
    request<CustomerRead>(`/manager/customers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteCustomer: (id: number) =>
    requestVoid(`/manager/customers/${id}`, { method: 'DELETE' }),

  listSkus: (params?: { customer_id?: number; q?: string }) => {
    const qs = new URLSearchParams()
    if (params?.customer_id != null) qs.set('customer_id', String(params.customer_id))
    if (params?.q) qs.set('q', params.q)
    return request<SKURead[]>(
      `/manager/skus${qs.toString() ? '?' + qs.toString() : ''}`,
    )
  },

  createSku: (payload: SKUAdminCreate) =>
    request<SKURead>('/manager/skus', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateSku: (id: number, payload: SKUAdminUpdate) =>
    request<SKURead>(`/manager/skus/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteSku: (id: number) =>
    requestVoid(`/manager/skus/${id}`, { method: 'DELETE' }),

  // ─── Manager ERP drilldowns ────────────────────────────────────────
  getContainerDetail: (container_no: string) =>
    request<ContainerErpDetail>(
      `/manager/containers/${encodeURIComponent(container_no)}`,
    ),

  listAllOutboundOrders: () =>
    request<OutboundOrderListRow[]>('/manager/outbound-orders'),

  getOutboundOrderDetail: (transfer_order_no: string) =>
    request<OutboundOrderErpDetail>(
      `/manager/outbound-orders/${encodeURIComponent(transfer_order_no)}`,
    ),

  // Destructive — cascade-deletes the TO, all child rows, the Excel
  // outbound row, and refreshes the per-brand Master Inventory. Server
  // returns 409 if an invoice references this TO (void invoice first).
  deleteOutboundOrder: (transfer_order_no: string) =>
    request<{
      ok: boolean
      transfer_order_no: string
      cascade: {
        scans: number
        line_serials: number
        lines: number
        containers: number
      }
      excel_outbound_rows_deleted: number
    }>(
      `/manager/outbound-orders/${encodeURIComponent(transfer_order_no)}`,
      { method: 'DELETE' },
    ),
}

// ─── Driver-docs OCR extraction ───────────────────────────────────────

export interface DriverDocsExtraction {
  container_no: string | null
  container_type: 'bic' | 'truck' | null
  driver_name: string | null
  driver_license: string | null
  driver_phone: string | null
  truck_license_plate: string | null
  carrier: string | null
  insurance: string | null
  bol_number: string | null
  scheduled_arrival_at: string | null // ISO 8601 datetime
}

// ─── Picking-ticket extraction ────────────────────────────────────────

export interface PickingTicketExtractedLine {
  sku: string
  description: string | null
  order_qty: number
  unit: string | null
}

export interface PickingTicketExtraction {
  transfer_order_no: string | null
  order_date: string | null
  priority: string | null
  memo: string | null
  ship_from_name: string | null
  ship_from_address: string | null
  ship_to_name: string | null
  ship_to_address: string | null
  lines: PickingTicketExtractedLine[]
}

// ─── Scan-sheet types (mirror backend Pydantic schemas) ───────────────

export interface ScanSheetHeader {
  receipt_id: number
  container_no: string
  whpo_number: string
  do_number: string
  customer_name: string
  bol_number: string | null
  received_date: string         // ISO date
  start_timestamp: string       // ISO datetime
  completed_timestamp: string | null
  location: string
  is_completed: boolean
  requires_imei: boolean
  uses_box_numbers?: boolean
  // 'inbound' (default) or 'outbound'. Drives the operator UI's
  // per-LPN progress panel — outbound shows it, inbound hides it.
  kind?: 'inbound' | 'outbound'
}

export interface ScanSheetRow {
  id: number
  container_no: string
  sku: string | null
  qty: number
  serial_number: string | null
  imei: string | null
  box_number: number | null
  scanned_by: string
  notes: string | null
  scanned_at: string
}

export interface OutboundLineProgress {
  line_id: number
  line_no: number
  sku_raw: string
  description: string | null
  order_qty: number
  scanned_qty: number
  source_container_no: string | null
}

export interface ScanSheetOpenResponse {
  header: ScanSheetHeader
  rows: ScanSheetRow[]
  // Outbound only — backend leaves null for inbound receipts.
  outbound_progress?: OutboundLineProgress[] | null
}

export interface ScanRecordResponse {
  accepted: boolean
  row: ScanSheetRow | null
  duplicate_of_row_id: number | null
  error: string | null
  total_scanned: number
  // Refreshed per-LPN counts on every accepted scan so the progress
  // panel auto-advances. Null on rejected scans and on inbound.
  outbound_progress?: OutboundLineProgress[] | null
}

export interface ScanFinishResponse {
  receipt_id: number
  container_no: string
  total_scanned: number
  finished_at: string
  download_url: string
}

export interface AuditSheetListItem {
  receipt_id: number
  container_no: string
  whpo_number: string
  customer_name: string
  received_date: string
  scan_count: number
  status: string
  finished_at: string | null
}

export interface AuditSheetListResponse {
  sheets: AuditSheetListItem[]
  total: number
}

export interface AuditSheetDetailResponse {
  header: ScanSheetHeader
  rows: ScanSheetRow[]
}

// ─── Outbound types (mirror backend schemas/outbound.py) ──────────────

export interface OutboundLineInput {
  line_no: number
  sku: string
  description?: string | null
  order_qty: number
  unit?: string
  serial_specific: boolean
  serials?: string[] | null
  source_container_no?: string | null
  notes?: string | null
}

export interface OutboundOrderSubmission {
  transfer_order_no: string
  customer: string
  order_date?: string | null
  priority?: string
  memo?: string | null
  ship_from_name?: string | null
  ship_from_address?: string | null
  ship_to_name?: string | null
  ship_to_address?: string | null
  lines: OutboundLineInput[]
  notes?: string | null
}

export interface OutboundOrderUpdateRequest {
  customer: string
  order_date?: string | null
  priority?: string
  memo?: string | null
  ship_from_name?: string | null
  ship_from_address?: string | null
  ship_to_name?: string | null
  ship_to_address?: string | null
  lines: OutboundLineInput[]
  notes?: string | null
}

export interface OutboundIntakeResponse {
  order_id: number
  transfer_order_no: string
  po_number: string | null
  status: string
  submitted_at: string
}

export interface OutboundUpdateResponse {
  order_id: number
  transfer_order_no: string
  po_number: string | null
  status: string
}

export interface OutboundLineRead {
  id: number
  line_no: number
  sku: string
  description: string | null
  order_qty: number
  picked_qty: number
  unit: string
  serial_specific: boolean
  serials_requested: string[]
  source_container_no: string | null
}

export interface ContainerInventoryItem {
  container_no: string
  sku: string
  description: string | null
  inbound_qty: number
  outbound_qty: number
  pending_qty: number
  received_date: string | null
  allocated_to: string[]
}

export interface ContainerInventoryResponse {
  containers: ContainerInventoryItem[]
  total_inbound: number
  total_outbound: number
  total_pending: number
}

// ─── Status timelines ─────────────────────────────────────────────────

export interface StatusEvent {
  stage: string
  label: string
  at: string | null
}

export interface ContainerStatusTimeline {
  container_no: string
  current_stage: string
  timeline: StatusEvent[]
}

export interface WHPOStatusResponse {
  whpo_number: string
  do_number: string
  customer_name: string
  order_placed_at: string
  containers: ContainerStatusTimeline[]
}

export interface OutboundOrderStatusResponse {
  transfer_order_no: string
  po_number: string | null
  customer_name: string
  order_placed_at: string
  containers: ContainerStatusTimeline[]
}

// ─── Calendar ──────────────────────────────────────────────────────────

export interface CalendarContainerRow {
  container_no: string
  ref_no: string
  customer: string
  current_stage: string
  current_label: string
}

export interface CalendarDay {
  date: string
  inbound_containers: CalendarContainerRow[]
  outbound_containers: CalendarContainerRow[]
}

export interface CalendarResponse {
  window_start: string
  window_end: string
  days: CalendarDay[]
}

export interface OutboundContainerRead {
  id: number
  container_no: string
  container_type: string
  status: string
  driver_name: string | null
  driver_license: string | null
  driver_phone: string | null
  truck_license_plate: string | null
  carrier: string | null
  insurance: string | null
  bol_number: string | null
  scheduled_arrival_at: string | null
  started_at: string | null
  sealed_at: string | null
}

export interface OutboundOrderRead {
  id: number
  transfer_order_no: string
  po_number: string | null
  customer_name: string
  order_date: string | null
  priority: string
  memo: string | null
  ship_from_name: string | null
  ship_from_address: string | null
  ship_to_name: string | null
  ship_to_address: string | null
  status: string
  submitted_at: string
  submitted_by: string | null
  notes: string | null
  lines: OutboundLineRead[]
  containers: OutboundContainerRead[]
  has_bol?: boolean
  bol_filename?: string | null
  has_packing_list?: boolean
  packing_list_filename?: string | null
}

export interface OutboundOrderListItem {
  id: number
  transfer_order_no: string
  po_number: string | null
  customer_name: string
  order_date: string | null
  priority: string
  status: string
  line_count: number
  submitted_at: string
}

export interface OutboundOrderListResponse {
  orders: OutboundOrderListItem[]
}

export interface OutboundContainerAttachRequest {
  container_no?: string | null
  container_type?: 'bic' | 'truck'
  driver_name?: string | null
  driver_license?: string | null
  driver_phone?: string | null
  truck_license_plate?: string | null
  insurance?: string | null
  carrier?: string | null
  bol_number?: string | null
  scheduled_arrival_at?: string | null
}

export interface OutboundContainerAttachResponse {
  container_id: number
  container_no: string
  status: string
}

export interface InventoryItem {
  sku: string
  available_qty: number
}

export interface InventoryResponse {
  items: InventoryItem[]
}

// ─── Account hierarchy types ──────────────────────────────────────────

export interface AccountRead {
  id: number
  name: string
  billing_email: string | null
  billing_address: string | null
  notes: string | null
  customer_count: number
  created_at: string
}

export interface AccountCreate {
  name: string
  billing_email?: string | null
  billing_address?: string | null
  notes?: string | null
}

export interface AccountUpdate {
  name?: string
  billing_email?: string | null
  billing_address?: string | null
  notes?: string | null
}

// ─── SKU admin types (mirror schemas/manager.py SKU* models) ──────────

export interface CustomerRead {
  id: number
  name: string
  account_id?: number | null
  account_name?: string | null
  contact_email?: string | null
}

export interface SKURead {
  id: number
  customer_id: number
  customer_name: string
  sku: string
  description: string | null
  product_type: string | null
  sqft_per_unit: number | null
  items_per_pallet: number | null
  pallet_sqft: number | null
  pallet_mode: string
  stackable: boolean
  max_stack_height: number | null
  unit: string
  source: string | null
  created_at: string
  updated_at: string
}

export interface SKUAdminCreate {
  customer_id: number
  sku: string
  description?: string | null
  product_type?: string | null
  sqft_per_unit?: number | null
  items_per_pallet?: number | null
  pallet_sqft?: number | null
  pallet_mode?: string
  stackable?: boolean
  max_stack_height?: number | null
  unit?: string
}

export interface SKUAdminUpdate {
  sku?: string
  /** Move this SKU to a different Brand. Server returns 409 if the SKU is
   *  already referenced by container lines / lot assignments. */
  customer_id?: number
  description?: string | null
  product_type?: string | null
  sqft_per_unit?: number | null
  items_per_pallet?: number | null
  pallet_sqft?: number | null
  pallet_mode?: string
  stackable?: boolean
  max_stack_height?: number | null
  unit?: string
}

export interface SkuCalculatorResult {
  pallets: number
  total_sqft: number
  lots: number
  lots_needed: number
  lot_sqft_used: number
}

// ─── Manager ERP types (mirror schemas/manager_erp.py) ────────────────

export interface ErpStageEvent {
  stage: string
  label: string
  at: string | null
}

export interface ContainerErpDocument {
  kind: string
  label: string
  filename: string
  content_type: string
  file_size: number
  uploaded_at: string
  uploaded_by: string | null
  url: string
}

export interface ContainerErpLine {
  line_id: number
  sku: string
  sku_raw: string
  qty: number
  product_type: string | null
  sku_resolved: boolean
  description: string | null
}

export interface ContainerErpLotAssignment {
  assignment_order: number
  lot_code: string
  floor_name: string
  sku: string
  planned_pallets: number
  actual_pallets: number
  status: string
}

export interface ContainerErpScanRow {
  id: number
  serial_number: string | null
  imei: string | null
  sku: string | null
  box_number: number | null
  scanned_by: string
  scanned_at: string
  notes: string | null
  result: string | null
}

export interface ContainerErpOutboundLink {
  outbound_order_id: number
  transfer_order_no: string
  po_number: string | null
  customer_name: string
  order_status: string
  line_id: number
  line_no: number
  sku: string
  order_qty: number
  picked_qty: number
  order_date: string | null
}

export interface ContainerErpException {
  exception_id: number
  kind: string
  status: string
  opened_at: string
  opened_by: string | null
  resolved_at: string | null
  resolved_by: string | null
  payload: Record<string, unknown> | null
}

export interface ContainerErpActivity {
  id: number
  t: string
  actor: string | null
  kind: string
  message: string | null
}

export interface ContainerErpDetail {
  container_id: number
  container_no: string
  status: string
  customer_name: string
  whpo_id: number
  whpo_number: string
  do_id: number
  do_number: string
  bol_number: string | null

  expected_arrival_date: string | null
  expected_arrival_time: string | null
  actual_arrival_date: string | null
  actual_arrival_time: string | null
  started_at: string | null
  finished_at: string | null
  started_by: string | null
  finished_by: string | null

  driver_name: string | null
  driver_license: string | null
  driver_phone: string | null
  truck_license_plate: string | null
  carrier: string | null
  insurance: string | null
  driver_info_received_at: string | null

  on_pallet: boolean | null
  pallet_length_in: number | null
  pallet_width_in: number | null
  item_length_in: number | null
  item_width_in: number | null
  item_height_in: number | null
  total_sqft_needed: number
  lots_equivalent: number

  total_expected_qty: number
  total_received_qty: number
  lines: ContainerErpLine[]
  lot_assignments: ContainerErpLotAssignment[]

  receipt_id: number | null
  receipt_status: string | null
  total_scanned: number
  last_scan_at: string | null
  recent_scans: ContainerErpScanRow[]

  documents: ContainerErpDocument[]
  outbound_links: ContainerErpOutboundLink[]
  exceptions: ContainerErpException[]
  open_exceptions: number
  activity: ContainerErpActivity[]

  timeline: ErpStageEvent[]
  current_stage: string
}

export interface OutboundOrderListRow {
  order_id: number
  transfer_order_no: string
  po_number: string | null
  customer_name: string
  status: string
  order_date: string | null
  priority: string
  submitted_at: string | null
  line_count: number
  truck_count: number
  picked_qty: number
}

export interface OutboundOrderErpLine {
  line_id: number
  line_no: number
  sku: string
  description: string | null
  order_qty: number
  picked_qty: number
  unit: string
  serial_specific: boolean
  serials_requested: string[]
  source_container_no: string | null
}

export interface OutboundOrderErpContainer {
  container_id: number
  container_no: string
  container_type: string
  status: string
  driver_name: string | null
  driver_license: string | null
  driver_phone: string | null
  truck_license_plate: string | null
  carrier: string | null
  bol_number: string | null
  scheduled_arrival_at: string | null
  started_at: string | null
  sealed_at: string | null
  total_scanned: number
  receipt_id: number | null
  receipt_status: string | null
}

export interface OutboundOrderErpDetail {
  order_id: number
  transfer_order_no: string
  po_number: string | null
  customer_name: string
  status: string
  order_date: string | null
  priority: string
  memo: string | null
  ship_from_name: string | null
  ship_from_address: string | null
  ship_to_name: string | null
  ship_to_address: string | null
  submitted_at: string
  submitted_by: string | null
  notes: string | null
  lines: OutboundOrderErpLine[]
  total_order_qty: number
  total_picked_qty: number
  containers: OutboundOrderErpContainer[]
  linked_inbound_containers: string[]
  timeline: ErpStageEvent[]
  current_stage: string
  activity: ContainerErpActivity[]
}

// ─── Warehouse inventory reports (aging + remaining inventory) ──────────

export type AgingBucket = 'active' | 'aging' | 'stale' | 'fully_shipped'

export interface ContainerAgingRow {
  container_no: string
  brand: string | null
  invoice_no: string | null
  whpo_number: string | null
  received_date: string | null
  days_since_received: number | null
  units_in: number
  units_out: number
  units_remaining: number
  aging_bucket: AgingBucket
  fully_shipped: boolean
}

export interface ContainerAgingResponse {
  items: ContainerAgingRow[]
  total: number
  counts: Record<AgingBucket, number>
}

export interface RemainingInventorySkuRow {
  sku_raw: string
  qty_received: number
  qty_scanned_in: number
  qty_shipped_out: number
  qty_remaining: number
}

export interface RemainingSerialRow {
  serial_number: string
  sku_raw: string | null
  scanned_at: string
  status: 'in_warehouse' | 'shipped'
  shipped_to: string | null
  shipped_at: string | null
}

export interface RemainingInventoryResponse {
  container_no: string
  brand: string | null
  received_date: string | null
  days_since_received: number | null
  per_sku: RemainingInventorySkuRow[]
  serials: RemainingSerialRow[]
}

export const inventoryReportsApi = {
  aging: (params: { bucket?: AgingBucket; brand?: string; limit?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.bucket) q.set('bucket', params.bucket)
    if (params.brand) q.set('brand', params.brand)
    if (params.limit) q.set('limit', String(params.limit))
    const qs = q.toString()
    return request<ContainerAgingResponse>(`/manager/inventory/aging${qs ? `?${qs}` : ''}`)
  },
  remaining: (container_no: string) =>
    request<RemainingInventoryResponse>(
      `/manager/inventory/container/${encodeURIComponent(container_no)}/remaining`,
    ),
}

// ─── Master list (auto-computed inbound + outbound) ──────────────────────

/** Mirrors `vw_master_list` (v2 — one row per inbound container).
 *  Outbound fields are null until shipment activity touches the
 *  container. Column order matches Tiana's Lime-Inventory-Sep 2025.xlsx. */
export interface MasterListRow {
  container_id: number
  container_no: string
  customer_name: string | null

  // Inbound (cols 1-13 in the xlsx)
  // `invoice` is the BILLING invoice number (CN-YYYYMMDD-####),
  // populated once Manager > Invoicing issues an invoice. Don't
  // confuse with `do_number` — that's the warehouse Delivery Order ID.
  invoice: string | null
  do_number: string | null
  commodity: string | null
  whpo_load_no: string | null
  carrier_broker: string | null
  driver_name: string | null
  drop_container: string | null
  received_date: string | null
  pickup_container: string | null
  pallets: number
  units: number
  sqft: number | null
  total_sqft: number | null

  // Outbound (cols 14-20)
  to_no: string | null
  ship_date: string | null
  ship_to: string | null
  pallets_out: number | null
  units_out: number | null
  sqft_out: number | null
  total_sqft_out: number | null

  // Status (cols 21-22)
  scanned: boolean
  lpn: string | null
}

export interface MasterListResponse {
  items: MasterListRow[]
  total: number
}

export const masterListApi = {
  list: (params: {
    customer?: string
    since?: string
    until?: string
    scanned?: boolean
    limit?: number
    offset?: number
  } = {}): Promise<MasterListResponse> => {
    const q = new URLSearchParams()
    if (params.customer) q.set('customer', params.customer)
    if (params.since) q.set('since', params.since)
    if (params.until) q.set('until', params.until)
    if (params.scanned !== undefined) q.set('scanned', String(params.scanned))
    if (params.limit != null) q.set('limit', String(params.limit))
    if (params.offset != null) q.set('offset', String(params.offset))
    const qs = q.toString()
    return request<MasterListResponse>(`/manager/master-list${qs ? `?${qs}` : ''}`)
  },
}

// Vendor-facing variant. Backend filters rows to brands the JWT can
// access — direct-brand login sees one brand; account-level login (e.g.
// TQL Trading Inc.) sees every brand under that account.
export const vendorMasterListApi = {
  list: (params: {
    customer?: string
    since?: string
    until?: string
    scanned?: boolean
    limit?: number
    offset?: number
  } = {}): Promise<MasterListResponse> => {
    const q = new URLSearchParams()
    if (params.customer) q.set('customer', params.customer)
    if (params.since) q.set('since', params.since)
    if (params.until) q.set('until', params.until)
    if (params.scanned !== undefined) q.set('scanned', String(params.scanned))
    if (params.limit != null) q.set('limit', String(params.limit))
    if (params.offset != null) q.set('offset', String(params.offset))
    const qs = q.toString()
    return request<MasterListResponse>(`/vendor/master-list${qs ? `?${qs}` : ''}`)
  },
  brands: (): Promise<string[]> => request<string[]>('/vendor/master-list/brands'),
}

// ─── Tally sheets (POD-driven billing audit) ─────────────────────────────

export interface TallySheetRead {
  id: number
  container_id: number
  container_no: string
  pod_filename: string
  pod_content_type: string
  pod_file_size: number
  has_pdf?: boolean
  ocr_from_location: string | null
  ocr_to_location: string | null
  ocr_engine: string | null
  matched_driver_name: string | null
  matched_driver_license: string | null
  matched_driver_phone: string | null
  matched_carrier: string | null
  matched_truck_plate: string | null
  manual_seal_no: string | null
  manual_chassis_no: string | null
  tallied_at: string
  tallied_by: string
  billing_status: 'pending' | 'billed' | 'disputed' | 'waived'
  billing_notes: string | null
  updated_at: string
}

export interface TallySheetList {
  items: TallySheetRead[]
  total: number
}

export interface TallySheetUpdate {
  ocr_from_location?: string | null
  ocr_to_location?: string | null
  manual_seal_no?: string | null
  manual_chassis_no?: string | null
  billing_status?: 'pending' | 'billed' | 'disputed' | 'waived'
  billing_notes?: string | null
}

export interface VendorTallyView {
  container_no: string
  tallied: boolean
  tallied_at?: string | null
  ocr_from_location?: string | null
  ocr_to_location?: string | null
  matched_carrier?: string | null
  matched_truck_plate?: string | null
}

// Tally API surface — manager endpoints + a vendor read.
export const tallyApi = {
  /** Manager uploads the physical POD photo and creates the tally row. */
  uploadPod: async (
    container_no: string,
    file: File,
    tallied_by: string,
    extras?: { manual_seal_no?: string; manual_chassis_no?: string }
  ): Promise<TallySheetRead> => {
    const form = new FormData()
    form.append('file', file)
    form.append('tallied_by', tallied_by)
    if (extras?.manual_seal_no) form.append('manual_seal_no', extras.manual_seal_no)
    if (extras?.manual_chassis_no) form.append('manual_chassis_no', extras.manual_chassis_no)
    return requestMultipart<TallySheetRead>(
      `/manager/tally/${encodeURIComponent(container_no)}/pod`,
      'POST',
      form
    )
  },

  list: (params: {
    billing_status?: 'pending' | 'billed' | 'disputed' | 'waived'
    since?: string
    until?: string
    limit?: number
    offset?: number
  } = {}): Promise<TallySheetList> => {
    const q = new URLSearchParams()
    if (params.billing_status) q.set('billing_status', params.billing_status)
    if (params.since) q.set('since', params.since)
    if (params.until) q.set('until', params.until)
    if (params.limit != null) q.set('limit', String(params.limit))
    if (params.offset != null) q.set('offset', String(params.offset))
    const qs = q.toString()
    return request<TallySheetList>(`/manager/tally-sheets${qs ? `?${qs}` : ''}`)
  },

  get: (id: number) => request<TallySheetRead>(`/manager/tally-sheets/${id}`),

  update: (id: number, patch: TallySheetUpdate) =>
    request<TallySheetRead>(`/manager/tally-sheets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  /** Hard-delete a tally row (DB row + POD file + OneDrive Excel mirror).
   *  Frontend must PIN-re-auth before calling this — there's no server-
   *  side auth gate (manager portal trusts the SPA's login state). */
  remove: (id: number, deletedBy: string) =>
    requestVoid(
      `/manager/tally-sheets/${id}?deleted_by=${encodeURIComponent(deletedBy)}`,
      { method: 'DELETE' }
    ),

  /** Absolute URL of the generated tally-sheet PDF. Browser opens it
   *  inline (or downloads, depending on browser settings). The endpoint
   *  regenerates the PDF on the fly when the cached file is missing. */
  pdfUrl: (id: number): string =>
    `${(import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'}/manager/tally-sheets/${id}/pdf`,

  /** Vendor-scoped read — only their containers; no billing fields. */
  vendorView: (container_no: string) =>
    request<VendorTallyView>(`/vendor/container/${encodeURIComponent(container_no)}/tally`),
}

// ─── Billing (invoices + rate card) ───────────────────────────────────────

// Lifecycle:
//   draft → sent → payment_submitted → paid → void
//                   └ vendor self-mark    └ manager verifies receipt
export type InvoiceStatus =
  | 'draft'
  | 'ready'
  | 'sent'
  | 'payment_submitted'
  | 'paid'
  | 'void'

export interface InvoiceLineRead {
  id: number
  code: string
  category: string
  description: string
  unit: string
  quantity: number
  unit_rate: number
  line_total: number
  taxable: boolean
  auto_applied: boolean
  override_reason: string | null
  source_container_id: number | null
  source_outbound_container_id: number | null
}

export interface InvoiceListItem {
  id: number
  invoice_number: string
  status: InvoiceStatus
  customer_id: number
  customer_name: string | null
  whpo_number: string | null
  transfer_order_no: string | null
  invoice_date: string
  due_date: string | null
  total: number
  generated_at: string
  sent_at: string | null
  paid_at: string | null
  vendor_marked_paid_at: string | null
}

export interface OperationalChargeItem {
  label: string
  monthly: number
}

export interface OperationalChargeBreakdown {
  tier_label: string
  items: OperationalChargeItem[]
  total: number
}

export interface InvoiceRead {
  id: number
  invoice_number: string
  status: InvoiceStatus
  customer_id: number
  customer_name: string | null
  whpo_id: number | null
  whpo_number: string | null
  outbound_order_id: number | null
  transfer_order_no: string | null
  invoice_date: string
  due_date: string | null
  terms: string
  subtotal: number
  fuel_surcharge: number
  advancing: number
  adjustment: number
  adjustment_note: string | null
  operational_charge: number
  operational_charge_breakdown: OperationalChargeBreakdown | null
  tax: number
  total: number
  notes: string | null
  generated_at: string
  sent_at: string | null
  paid_at: string | null
  payment_method: string | null
  vendor_payment_reference: string | null
  vendor_marked_paid_at: string | null
  vendor_marked_paid_by: string | null
  lines: InvoiceLineRead[]
}

export interface InvoicePreview {
  scope: 'inbound' | 'outbound'
  customer_id: number
  customer_name: string | null
  whpo_number: string | null
  transfer_order_no: string | null
  proposed_lines: InvoiceLineRead[]
  operational_charge: number
  operational_charge_breakdown: OperationalChargeBreakdown | null
  subtotal: number
  fuel_surcharge: number
  advancing: number
  tax: number
  total: number
}

export interface RateCardRow {
  code: string
  category: string
  description: string
  unit: string
  rate: number | null
  taxable: boolean
  is_minimum: boolean
  is_advance: boolean
  note: string | null
  max_per_request: number | null
  min_advance: number | null
}

export interface RateCardCreate {
  code: string
  category: string
  description: string
  unit: string
  rate?: number | null
  taxable?: boolean
  is_minimum?: boolean
  is_advance?: boolean
  note?: string | null
  max_per_request?: number | null
  min_advance?: number | null
}

export interface RateCardUpdate {
  category?: string
  description?: string
  unit?: string
  rate?: number | null
  taxable?: boolean
  is_minimum?: boolean
  is_advance?: boolean
  note?: string | null
  max_per_request?: number | null
  min_advance?: number | null
}

export const billingApi = {
  // Rate card (manager — listing; developer — also create/update/delete)
  rateCard: () => request<RateCardRow[]>('/manager/rate-card'),

  createRateCode: (payload: RateCardCreate) =>
    request<RateCardRow>('/manager/rate-card', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateRateCode: (code: string, payload: RateCardUpdate) =>
    request<RateCardRow>(`/manager/rate-card/${encodeURIComponent(code)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteRateCode: (code: string) =>
    requestVoid(`/manager/rate-card/${encodeURIComponent(code)}`, {
      method: 'DELETE',
    }),

  // Invoices list (manager)
  listInvoices: (params: {
    status?: InvoiceStatus
    customer_id?: number
    limit?: number
    offset?: number
  } = {}) => {
    const q = new URLSearchParams()
    if (params.status) q.set('status', params.status)
    if (params.customer_id != null) q.set('customer_id', String(params.customer_id))
    if (params.limit != null) q.set('limit', String(params.limit))
    if (params.offset != null) q.set('offset', String(params.offset))
    const qs = q.toString()
    return request<InvoiceListItem[]>(`/manager/invoices${qs ? `?${qs}` : ''}`)
  },

  // Invoice detail (manager)
  getInvoice: (id: number) => request<InvoiceRead>(`/manager/invoices/${id}`),

  // Preview proposed inbound charges for a WHPO
  previewInbound: (whpo_number: string) =>
    request<InvoicePreview>(
      `/manager/whpos/${encodeURIComponent(whpo_number)}/invoice-preview`,
      { method: 'POST' },
    ),

  // Generate (commit) inbound invoice for a WHPO
  generateInbound: (whpo_number: string) =>
    request<InvoiceRead>(
      `/manager/whpos/${encodeURIComponent(whpo_number)}/invoice`,
      { method: 'POST' },
    ),

  // Preview proposed outbound charges for a TO
  previewOutbound: (transfer_order_no: string) =>
    request<InvoicePreview>(
      `/manager/outbound-orders/${encodeURIComponent(transfer_order_no)}/invoice-preview`,
      { method: 'POST' },
    ),

  // Generate (commit) outbound invoice for a TO
  generateOutbound: (transfer_order_no: string) =>
    request<InvoiceRead>(
      `/manager/outbound-orders/${encodeURIComponent(transfer_order_no)}/invoice`,
      { method: 'POST' },
    ),

  // Add a manual line to a draft/ready invoice
  addLine: (
    invoice_id: number,
    payload: {
      code: string
      quantity: number
      unit_rate_override?: number | null
      override_reason?: string | null
    },
  ) =>
    request<InvoiceRead>(`/manager/invoices/${invoice_id}/lines`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Remove a line from a draft/ready invoice
  removeLine: (invoice_id: number, line_id: number) =>
    request<InvoiceRead>(`/manager/invoices/${invoice_id}/lines/${line_id}`, {
      method: 'DELETE',
    }),

  markSent: (
    invoice_id: number,
    payload?: { payment_method?: string | null; notes?: string | null },
  ) =>
    request<InvoiceRead>(`/manager/invoices/${invoice_id}/send`, {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    }),

  markPaid: (
    invoice_id: number,
    payload?: { payment_method?: string | null; notes?: string | null },
  ) =>
    request<InvoiceRead>(`/manager/invoices/${invoice_id}/paid`, {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    }),

  markVoid: (invoice_id: number, payload?: { notes?: string | null }) =>
    request<InvoiceRead>(`/manager/invoices/${invoice_id}/void`, {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    }),

  /** Absolute URL of the invoice PDF (customer-facing by default).
   *  Opens inline in the browser. Service-log variant is for the
   *  manager AP backup; not exposed to vendors. */
  pdfUrl: (invoice_id: number, type: 'customer' | 'servicelog' = 'customer'): string =>
    `${(import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'}/manager/invoices/${invoice_id}/pdf?type=${type}`,

  // Vendor surface — scoped server-side via JWT
  vendorListInvoices: () => request<InvoiceListItem[]>('/vendor/invoices'),

  vendorGetInvoice: (invoice_id: number) =>
    request<InvoiceRead>(`/vendor/invoices/${invoice_id}`),

  /** Vendor self-reports payment. Status flips `sent` →
   *  `payment_submitted`; manager must verify before it becomes `paid`. */
  vendorMarkPaid: (
    invoice_id: number,
    payload: {
      payment_method?: string | null
      payment_reference?: string | null
      notes?: string | null
    },
  ) =>
    request<InvoiceRead>(`/vendor/invoices/${invoice_id}/mark-paid`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /** Vendor PDF URL — only works for sent/paid invoices in their scope.
   *  Browser uses the Bearer token in headers? No — vendor PDFs require
   *  the Authorization header, so vendors can't use a direct URL. Use
   *  fetchVendorPdfBlob() instead to download via fetch + blob. */
  vendorFetchPdf: async (invoice_id: number): Promise<Blob> => {
    const token = readVendorToken()
    const headers: Record<string, string> = {}
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(`${BASE}/vendor/invoices/${invoice_id}/pdf`, { headers })
    if (!res.ok) {
      let detail = res.statusText
      try {
        const body = await res.json()
        detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
      } catch { /* ignore */ }
      throw new ApiError(res.status, detail)
    }
    return await res.blob()
  },
}

export { ApiError }
