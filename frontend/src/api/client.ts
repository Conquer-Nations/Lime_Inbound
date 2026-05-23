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
  constructor(status: number, detail: string) {
    super(`API ${status}: ${detail}`)
    this.status = status
    this.detail = detail
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
    try {
      const body = await res.json()
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
    } catch {
      /* ignore JSON parse */
    }
    throw new ApiError(res.status, detail)
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

export interface ScanSheetOpenResponse {
  header: ScanSheetHeader
  rows: ScanSheetRow[]
}

export interface ScanRecordResponse {
  accepted: boolean
  row: ScanSheetRow | null
  duplicate_of_row_id: number | null
  error: string | null
  total_scanned: number
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

export { ApiError }
