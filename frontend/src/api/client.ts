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
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'

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
}

export { ApiError }
