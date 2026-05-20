import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import {
  api,
  ApiError,
  SCAN_SHEETS_ENABLED,
  type AuditSheetDetailResponse,
  type AuditSheetListItem,
} from '../api/client'
import { useVendorAuth } from '../auth/VendorAuthContext'
import Spinner from '../components/Spinner'
import VendorPortalChrome from '../components/VendorPortalChrome'

// Mirrors backend AUDITOR_EMAILS — kept in lockstep on the client so the
// nav entry doesn't render for non-auditors. Server-side check is the
// real gate.
const AUDITOR_EMAILS = ['developer@conquernation.com']

function isAuditor(email: string | null | undefined): boolean {
  if (!email) return false
  return AUDITOR_EMAILS.includes(email.trim().toLowerCase())
}

export { AUDITOR_EMAILS, isAuditor }

interface Filters {
  year: number | null
  month: number | null
  container_no: string
  whpo_number: string
}

const CURRENT_YEAR = new Date().getFullYear()
const YEAR_OPTIONS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2]
const MONTH_OPTIONS = [
  { v: 1, label: 'Jan' },
  { v: 2, label: 'Feb' },
  { v: 3, label: 'Mar' },
  { v: 4, label: 'Apr' },
  { v: 5, label: 'May' },
  { v: 6, label: 'Jun' },
  { v: 7, label: 'Jul' },
  { v: 8, label: 'Aug' },
  { v: 9, label: 'Sep' },
  { v: 10, label: 'Oct' },
  { v: 11, label: 'Nov' },
  { v: 12, label: 'Dec' },
]

export default function AuditPage() {
  const { user, isLoggedIn } = useVendorAuth()

  // Redirect if not signed in or not on the whitelist. Server returns 403
  // anyway but a UI-level redirect avoids the flash of "Audit access is
  // restricted" for normal vendors who navigate here by accident.
  if (!isLoggedIn || !user) return <Navigate to="/vendor/login" replace />
  if (!isAuditor(user.email)) return <Navigate to="/vendor-intake" replace />
  if (!SCAN_SHEETS_ENABLED) {
    return (
      <VendorPortalChrome breadcrumbCurrent="Audit">
        <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-3 text-sm text-amber-900">
            Scan-sheet audit isn't enabled on this environment yet.
          </div>
        </main>
      </VendorPortalChrome>
    )
  }

  return (
    <VendorPortalChrome breadcrumbCurrent="Audit">
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-10">
        <AuditContent />
      </main>
    </VendorPortalChrome>
  )
}

function AuditContent() {
  const [filters, setFilters] = useState<Filters>({
    year: null,
    month: null,
    container_no: '',
    whpo_number: '',
  })
  const [sheets, setSheets] = useState<AuditSheetListItem[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<AuditSheetDetailResponse | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [downloading, setDownloading] = useState<number | null>(null)
  const [bulkDownloading, setBulkDownloading] = useState(false)

  const apiParams = useMemo(
    () => ({
      year: filters.year,
      month: filters.month,
      container_no: filters.container_no.trim() || null,
      whpo_number: filters.whpo_number.trim() || null,
    }),
    [filters],
  )

  async function loadSheets() {
    setError(null)
    setLoading(true)
    try {
      const res = await api.listAuditSheets(apiParams)
      setSheets(res.sheets)
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e))
      setSheets([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadSheets()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function applyFilters() {
    loadSheets()
  }

  function clearFilters() {
    setFilters({ year: null, month: null, container_no: '', whpo_number: '' })
    setTimeout(loadSheets, 0)
  }

  async function viewSheet(receiptId: number) {
    setDetailBusy(true)
    setError(null)
    try {
      const d = await api.getAuditSheet(receiptId)
      setDetail(d)
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setDetailBusy(false)
    }
  }

  async function downloadOne(receiptId: number, containerNo: string) {
    setDownloading(receiptId)
    try {
      const blob = await api.downloadAuditSheetXlsx(receiptId)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${containerNo}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setDownloading(null)
    }
  }

  async function downloadBulk() {
    setBulkDownloading(true)
    try {
      const blob = await api.downloadAuditBulkXlsx(apiParams)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const stamp = [
        filters.year,
        filters.month != null ? String(filters.month).padStart(2, '0') : null,
        filters.container_no,
        filters.whpo_number,
      ]
        .filter(Boolean)
        .join('-')
      a.download = `scan_sheets_${stamp || 'all'}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setBulkDownloading(false)
    }
  }

  return (
    <div className="space-y-5">
      {/* Title */}
      <div>
        <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#1B4676] text-[11px] font-semibold tracking-[0.14em] uppercase mb-3">
          <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
          Audit
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#1B4676]">
          SCAN SHEETS
        </h1>
        <p className="mt-2 text-sm text-slate-600 max-w-2xl">
          Search receipts by year, month, container, or WHPO/Load No. Download
          any sheet as Excel, or grab a workbook of every matching sheet.
        </p>
      </div>

      {/* Filter strip */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
          <SelectField
            label="Year"
            value={filters.year}
            onChange={(v) => setFilters((f) => ({ ...f, year: v }))}
            options={[
              { v: null, label: 'Any' },
              ...YEAR_OPTIONS.map((y) => ({ v: y, label: String(y) })),
            ]}
          />
          <SelectField
            label="Month"
            value={filters.month}
            onChange={(v) => setFilters((f) => ({ ...f, month: v }))}
            options={[
              { v: null, label: 'Any' },
              ...MONTH_OPTIONS.map((m) => ({ v: m.v, label: m.label })),
            ]}
          />
          <TextFilter
            label="Container #"
            value={filters.container_no}
            onChange={(v) => setFilters((f) => ({ ...f, container_no: v }))}
            placeholder="HPCU4492096"
            mono
          />
          <TextFilter
            label="WHPO/Load No"
            value={filters.whpo_number}
            onChange={(v) => setFilters((f) => ({ ...f, whpo_number: v }))}
            placeholder="36648912"
            mono
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={applyFilters}
              className="inline-flex items-center gap-2 bg-[#0093D0] hover:bg-[#00A8E8] text-white font-bold rounded-full px-4 py-2 text-sm transition shadow-[0_4px_14px_-2px_rgba(0,147,208,0.5)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0]"
            >
              <span>Apply</span>
            </button>
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-full px-4 py-2 text-sm transition"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between gap-4 text-xs">
          <div className="text-slate-500">
            {loading
              ? 'Loading…'
              : sheets
              ? `${sheets.length} result${sheets.length === 1 ? '' : 's'}`
              : ''}
          </div>
          <button
            type="button"
            onClick={downloadBulk}
            disabled={
              bulkDownloading || !sheets || sheets.length === 0 || loading
            }
            className={`inline-flex items-center gap-2 bg-[#1B4676] hover:bg-[#224E72] text-white font-bold rounded-full px-4 py-2 text-xs transition shadow-[0_4px_14px_-2px_rgba(27,70,118,0.45)] ${
              bulkDownloading
                ? 'opacity-90 cursor-wait'
                : 'disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed disabled:shadow-none'
            }`}
          >
            {bulkDownloading ? (
              <>
                <Spinner size={12} className="text-white" />
                <span>Building workbook…</span>
              </>
            ) : (
              <span>Download all ({sheets?.length ?? 0}) as one workbook</span>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5"
        >
          {error}
        </div>
      )}

      {/* Results table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[#0B1828] text-white text-[10.5px] uppercase tracking-wider">
            <tr>
              <th className="text-left px-4 py-2 font-semibold">Container</th>
              <th className="text-left px-4 py-2 font-semibold">WHPO/Load No</th>
              <th className="text-left px-4 py-2 font-semibold">Customer</th>
              <th className="text-left px-4 py-2 font-semibold">Received</th>
              <th className="text-right px-4 py-2 font-semibold">Scans</th>
              <th className="text-left px-4 py-2 font-semibold">Status</th>
              <th className="text-right px-4 py-2 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                  <span className="inline-flex items-center gap-2">
                    <Spinner size={14} className="text-[#0093D0]" />
                    <span>Loading sheets…</span>
                  </span>
                </td>
              </tr>
            ) : !sheets || sheets.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-slate-400">
                  No sheets match these filters.
                </td>
              </tr>
            ) : (
              sheets.map((s, i) => (
                <tr
                  key={s.receipt_id}
                  className={`border-t border-slate-100 ${
                    i % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'
                  }`}
                >
                  <td className="px-4 py-2 font-mono font-bold text-[#1B4676]">
                    {s.container_no}
                  </td>
                  <td className="px-4 py-2 font-mono text-slate-700">
                    {s.whpo_number}
                  </td>
                  <td className="px-4 py-2 text-slate-700">{s.customer_name}</td>
                  <td className="px-4 py-2 text-slate-600">{s.received_date}</td>
                  <td className="px-4 py-2 text-right font-mono text-[#1B4676]">
                    {s.scan_count}
                  </td>
                  <td className="px-4 py-2">
                    <StatusPill status={s.status} />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => viewSheet(s.receipt_id)}
                        className="inline-flex items-center gap-1 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold px-3 py-1 text-xs transition"
                      >
                        View
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadOne(s.receipt_id, s.container_no)}
                        disabled={downloading === s.receipt_id}
                        className={`inline-flex items-center gap-1 rounded-full bg-[#0093D0] hover:bg-[#00A8E8] text-white font-bold px-3 py-1 text-xs transition ${
                          downloading === s.receipt_id
                            ? 'opacity-90 cursor-wait'
                            : ''
                        }`}
                      >
                        {downloading === s.receipt_id ? (
                          <Spinner size={10} className="text-white" />
                        ) : (
                          <span>Excel</span>
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Footer link back to portal */}
      <div className="text-xs text-slate-500">
        <Link
          to="/vendor-intake"
          className="text-[#0093D0] hover:underline font-medium"
        >
          ← Back to vendor portal
        </Link>
      </div>

      {/* Detail modal */}
      {detail && (
        <DetailModal
          detail={detail}
          onClose={() => setDetail(null)}
          loading={detailBusy}
        />
      )}
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const color =
    status === 'completed'
      ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
      : 'bg-amber-50 text-amber-800 border-amber-200'
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10.5px] uppercase tracking-[0.12em] font-bold ${color}`}
    >
      {status === 'completed' ? 'Locked' : 'In progress'}
    </span>
  )
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: number | null
  onChange: (v: number | null) => void
  options: { v: number | null; label: string }[]
}) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wider font-semibold text-slate-500 mb-1">
        {label}
      </label>
      <select
        value={value == null ? '' : String(value)}
        onChange={(e) =>
          onChange(e.target.value === '' ? null : parseInt(e.target.value, 10))
        }
        className="w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.label} value={o.v == null ? '' : String(o.v)}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

function TextFilter({
  label,
  value,
  onChange,
  placeholder,
  mono = false,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
}) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wider font-semibold text-slate-500 mb-1">
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className={`w-full border border-slate-300 rounded-md px-3 py-1.5 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none ${
          mono ? 'font-mono' : ''
        }`}
      />
    </div>
  )
}

function DetailModal({
  detail,
  onClose,
  loading,
}: {
  detail: AuditSheetDetailResponse
  onClose: () => void
  loading: boolean
}) {
  const h = detail.header
  return (
    <div
      className="fixed inset-0 z-40 bg-slate-900/60 flex items-center justify-center px-4 py-8 overflow-y-auto"
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-4xl w-full">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0]">
              Scan sheet
            </div>
            <h2 className="text-xl font-bold font-mono text-[#1B4676]">
              {h.container_no}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold px-3 py-1 text-sm transition"
          >
            Close
          </button>
        </div>
        <div className="px-5 py-4">
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <Field k="Received" v={h.received_date} />
            <Field k="3PL Location" v={h.location} />
            <Field k="WHPO/Load No" v={h.whpo_number} mono />
            <Field k="BOL / Tracking" v={h.bol_number ?? '—'} mono />
            <Field k="Customer" v={h.customer_name} />
            <Field k="DO #" v={h.do_number} mono />
            <Field k="Start" v={new Date(h.start_timestamp).toLocaleString()} />
            <Field
              k="Finish"
              v={
                h.completed_timestamp
                  ? new Date(h.completed_timestamp).toLocaleString()
                  : '—'
              }
            />
          </dl>
        </div>
        <div className="overflow-hidden border-t border-slate-200 max-h-[60vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-[#0B1828] text-white text-[10.5px] uppercase tracking-wider sticky top-0">
              <tr>
                <th className="text-left px-4 py-2 font-semibold">#</th>
                <th className="text-left px-4 py-2 font-semibold">Serial</th>
                <th className="text-left px-4 py-2 font-semibold">SKU</th>
                <th className="text-right px-4 py-2 font-semibold">Qty</th>
                <th className="text-left px-4 py-2 font-semibold">Scanned by</th>
                <th className="text-left px-4 py-2 font-semibold">Time</th>
                <th className="text-left px-4 py-2 font-semibold">Notes</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    <Spinner size={14} className="text-[#0093D0]" />
                  </td>
                </tr>
              ) : detail.rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                    No scans recorded.
                  </td>
                </tr>
              ) : (
                detail.rows.map((r, i) => (
                  <tr
                    key={r.id}
                    className={`border-t border-slate-100 ${
                      i % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'
                    }`}
                  >
                    <td className="px-4 py-2 text-slate-400 font-mono">{i + 1}</td>
                    <td className="px-4 py-2 font-mono font-bold text-[#1B4676]">
                      {r.serial_number}
                    </td>
                    <td className="px-4 py-2 font-mono text-slate-600">
                      {r.sku ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-right font-mono">{r.qty}</td>
                    <td className="px-4 py-2 text-slate-700">{r.scanned_by}</td>
                    <td className="px-4 py-2 text-slate-500 text-xs">
                      {new Date(r.scanned_at).toLocaleTimeString()}
                    </td>
                    <td className="px-4 py-2 text-slate-600">{r.notes ?? ''}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function Field({
  k,
  v,
  mono = false,
}: {
  k: string
  v: string
  mono?: boolean
}) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider font-semibold text-slate-500">
        {k}
      </dt>
      <dd
        className={`mt-0.5 text-sm text-slate-800 ${mono ? 'font-mono' : ''}`}
      >
        {v}
      </dd>
    </div>
  )
}
