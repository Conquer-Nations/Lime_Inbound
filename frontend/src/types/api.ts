// Mirror of backend Pydantic schemas. Kept in sync manually for v1.
// TODO: codegen from OpenAPI in v2.

export interface Alert {
  kind: string
  message: string
  payload?: Record<string, unknown> | null
}

export interface LineRow {
  sku: string
  description: string | null
  qty: number
  items_per_pallet: number | null
  pallet_mode: string
  scanned: number
}

export interface AssignmentRow {
  assignment_order: number
  lot_id: number
  lot_code: string
  floor_name: string
  sku: string
  planned_pallets: number
  actual_pallets: number
  items_placed: number
  items_expected: number
  status: string
}

export interface ContainerLookupResponse {
  container_no: string
  do_number: string
  whpo_number: string
  customer_name: string
  expected_arrival_date: string | null
  container_status: string
  receipt_id: number
  lines: LineRow[]
  assignments: AssignmentRow[]
  alerts: Alert[]
  total_scanned: number
  total_expected: number
}

export interface ScanResponse {
  receipt_id: number
  accepted: boolean
  result: string
  error_reason: string | null
  current_assignment: AssignmentRow | null
  next_assignment: AssignmentRow | null
  auto_cut: boolean
  auto_finish: boolean
  total_scanned: number
  total_expected: number
}

export interface FinishResponse {
  receipt_id: number
  container_no: string
  container_status: string
  receipt_status: string
  finished_at: string
  total_scanned: number
  total_expected: number
  pallets_created: number
}

export interface DOListItem {
  do_id: number
  do_number: string
  whpo_number: string
  customer_name: string
  status: string
  expected_arrival_date: string | null
  issued_at: string
  container_count: number
  open_exceptions: number
}

export interface LotMapItem {
  lot_id: number
  lot_code: string
  floor_id: number
  floor_name: string
  type: string
  pallet_capacity: number
  pallets_used: number
  pallets_reserved: number
  pallets_free: number
  occupancy_pct: number
  blocked: boolean
  grid_row: number | null
  grid_col: number | null
}

export interface ExceptionItem {
  exception_id: number
  kind: string
  ref_type: string | null
  ref_id: number | null
  payload: Record<string, unknown> | null
  status: string
  opened_at: string
  opened_by: string | null
  resolved_at: string | null
  resolved_by: string | null
  resolution_notes: string | null
}

// ─── Vendor intake ────────────────────────────────────────────────────

export interface VendorLineItem {
  sku: string
  qty: number
  product_type?: string | null
}

export interface VendorContainerSubmission {
  container_no: string
  expected_arrival_date?: string | null
  expected_arrival_time?: string | null
  lines: VendorLineItem[]
}

export interface VendorPackaging {
  on_pallet: boolean
  pallet_length_in?: number | null
  pallet_width_in?: number | null
  item_length_in?: number | null
  item_width_in?: number | null
  item_height_in?: number | null
}

export interface VendorWHPOSubmission {
  customer: string
  whpo_number: string
  submitter_name: string
  submitter_email: string
  expected_arrival_date: string
  arrival_window?: string | null
  bol_number?: string | null
  containers: VendorContainerSubmission[]
  packaging?: VendorPackaging | null
  notes?: string | null
}

export interface ExceptionOpened {
  exception_id: number
  kind: string
  ref_type: string
  ref_id: number
  payload?: Record<string, unknown> | null
}

export interface ContainerCreated {
  container_id: number
  container_no: string
  lines_total: number
  unknown_skus: string[]
}

export interface WHPOIntakeResponse {
  whpo_id: number
  whpo_number: string
  do_id: number
  do_number: string
  do_status: string
  containers: ContainerCreated[]
  exceptions_opened: ExceptionOpened[]
  idempotent_replay: boolean
}

// ─── Manager: DO detail + lot detail + resolve ───────────────────────

export interface ContainerLineRow {
  line_id: number
  sku: string
  qty: number
  items_per_pallet: number | null
  sqft_per_unit: number | null
  sku_resolved: boolean
  computed_sqft_per_unit: number
  computed_total_sqft: number
  space_basis: string
}

export interface DOAssignmentRow {
  assignment_order: number
  lot_code: string
  floor_name: string
  sku: string
  planned_pallets: number
  actual_pallets: number
  status: string
}

export interface ContainerInDO {
  container_id: number
  container_no: string
  status: string
  expected_arrival_date: string | null
  actual_arrival_date: string | null
  total_expected: number
  total_received: number
  lines: ContainerLineRow[]
  assignments: DOAssignmentRow[]
  on_pallet: boolean | null
  pallet_length_in: number | null
  pallet_width_in: number | null
  item_length_in: number | null
  item_width_in: number | null
  item_height_in: number | null
  total_sqft_needed: number
  lots_equivalent: number
}

export interface DODetail {
  do_id: number
  do_number: string
  whpo_id: number
  whpo_number: string
  customer_name: string
  status: string
  expected_arrival_date: string | null
  issued_at: string
  containers: ContainerInDO[]
  open_exceptions: number
}

export interface PalletInLot {
  pallet_id: number
  sku: string
  container_no: string
  qty: number
  level: number
  palletized_at: string
  palletized_by: string
}

export interface LotDetail {
  lot_id: number
  lot_code: string
  floor_id: number
  floor_name: string
  type: string
  pallet_capacity: number
  sqft_capacity: number
  pallets_used: number
  pallets_reserved: number
  pallets_free: number
  blocked: boolean
  pallets: PalletInLot[]
}

export interface SKUCreatePayload {
  description?: string | null
  sqft_per_unit?: number | null
  items_per_pallet: number
  pallet_mode?: string
  stackable?: boolean
  max_stack_height?: number | null
  unit?: string
}

export interface ResolveExceptionRequest {
  sku_data?: SKUCreatePayload | null
  patch?: Partial<SKUCreatePayload> | null
  notes?: string | null
  resolved_by: string
}

export interface ResolveExceptionResponse {
  exception_id: number
  status: string
  sku_id: number | null
  do_id: number | null
  do_status: string | null
  do_status_changed: boolean
}

// ─── Receiving pipeline ───────────────────────────────────────────────

export interface PipelineContainer {
  container_id: number
  container_no: string
  customer_name: string
  whpo_number: string
  do_number: string
  expected_arrival_date: string | null
  total_expected: number
  driver_info_received: boolean
  scan_status: 'none' | 'in_progress'
}

export interface ReceivingPipelineResponse {
  awaiting_tally: PipelineContainer[]
  awaiting_scan: PipelineContainer[]
}

// ─── Dashboard ────────────────────────────────────────────────────────

export interface DashboardKPIs {
  containers_expected_today: number
  receipts_in_progress: number
  containers_finished_today: number
  open_exceptions: number
  total_pallets_stored: number
  pallets_received_today: number
  lot_occupancy_pct: number
  lots_blocked: number
  lots_total: number
}

export interface ActivityFeedItem {
  id: number
  t: string
  kind: string
  actor: string | null
  ref_type: string | null
  ref_id: number | null
  message: string | null
}

export interface TodaySummary {
  containers_received: number
  units_scanned: number
  vendor_submissions: number
  drivers_checked_in: number
  outbound_orders_placed: number
  outbound_shipments: number
  exceptions_resolved: number
}

export interface OperatorStat {
  actor: string
  scans: number
}

export interface DashboardResponse {
  today: string
  kpis: DashboardKPIs
  activity: ActivityFeedItem[]
  today_summary?: TodaySummary | null
  hourly_scans?: number[]      // length 24 (PT)
  operators_today?: OperatorStat[]
}
