import { useEffect, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { API_BASE, api } from '../api/client'
import FilterBar, {
  resolveFilterDates,
  useFilterFromURL,
} from './FilterBar'

interface InboundRow {
  container_no: string
  whpo_number: string
  bol_number: string | null
  expected_arrival_date: string | null
  expected_arrival_time: string | null
  qty: number
  product_type: string | null
  sku: string
  customer: string
  do_number: string
  submitter_name: string | null
  submitter_email: string | null
  submitted_at: string | null
  driver_name: string | null
  driver_license: string | null
  driver_phone: string | null
  truck_license_plate: string | null
  insurance: string | null
  carrier: string | null
  last_updated_at: string | null
}

const COLUMNS: { key: keyof InboundRow; label: string }[] = [
  { key: 'container_no', label: 'Container' },
  { key: 'whpo_number', label: 'WHPO/Load No' },
  { key: 'bol_number', label: 'BOL #' },
  { key: 'expected_arrival_date', label: 'Date' },
  { key: 'expected_arrival_time', label: 'Time' },
  { key: 'qty', label: 'Qty' },
  { key: 'product_type', label: 'Type' },
  { key: 'sku', label: 'SKU' },
  { key: 'customer', label: 'Customer' },
  { key: 'do_number', label: 'DO #' },
  { key: 'submitter_name', label: 'Submitted by' },
  { key: 'submitted_at', label: 'Submitted at' },
  { key: 'driver_name', label: 'Driver' },
  { key: 'driver_license', label: 'Driver license' },
  { key: 'driver_phone', label: 'Driver phone' },
  { key: 'truck_license_plate', label: 'Truck plate' },
  { key: 'insurance', label: 'Insurance' },
  { key: 'carrier', label: 'Carrier' },
  { key: 'last_updated_at', label: 'Last updated' },
]

/**
 * Manager-facing view of everything the vendor has ever submitted.
 * One row per (container × SKU). Append-only — new vendor submissions
 * land here automatically. Exportable as CSV (opens in Excel + Sheets).
 */
export default function InboundView() {
  const [rows, setRows] = useState<InboundRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [updateConfigured, setUpdateConfigured] = useState(false)
  const [syncStatus, setSyncStatus] = useState<string | null>(null)
  const [syncFailed, setSyncFailed] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [brands, setBrands] = useState<{ id: number; name: string }[]>([])

  // Brand + date filter — state held in URL so refresh / share preserves
  // the view. resolveFilterDates() maps the selected mode to (from_date,
  // to_date) the backend understands.
  const [searchParams, setSearchParams] = useSearchParams()
  const [filterValue, setFilterValue] = useFilterFromURL(
    searchParams,
    setSearchParams,
  )

  function reload() {
    setError(null)
    const { from_date, to_date } = resolveFilterDates(filterValue)
    const q = new URLSearchParams()
    if (filterValue.brand_id !== 'all') q.set('customer_id', String(filterValue.brand_id))
    if (from_date) q.set('from_date', from_date)
    if (to_date) q.set('to_date', to_date)
    const qs = q.toString()
    fetch(`${API_BASE}/manager/database/inbound${qs ? `?${qs}` : ''}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text())
        return r.json()
      })
      .then(setRows)
      .catch((e) => setError(String(e)))
  }

  useEffect(() => {
    api
      .listManagerCustomers()
      .then((cs) =>
        setBrands(cs.map((c: { id: number; name: string }) => ({ id: c.id, name: c.name }))),
      )
      .catch(() => setBrands([]))
  }, [])

  // Re-fetch when filter changes (URL-driven).
  useEffect(reload, [filterValue])

  useEffect(() => {
    fetch(`${API_BASE}/manager/database/inbound/status`)
      .then((r) => r.json())
      .then((d) => setUpdateConfigured(Boolean(d.update_configured)))
      .catch(() => setUpdateConfigured(false))
  }, [])

  async function handleSync() {
    setSyncing(true)
    setSyncStatus(null)
    setSyncFailed(false)
    try {
      const r = await fetch(`${API_BASE}/manager/database/inbound/sync`, {
        method: 'POST',
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.detail ?? r.statusText)
      }
      const data = await r.json()
      const failed: string[] = data.containers_failed ?? []
      const successMsg = `Sent driver info for ${data.synced} container${
        data.synced === 1 ? '' : 's'
      } to OneDrive Excel.`
      if (failed.length > 0) {
        setSyncStatus(
          `${successMsg} ${failed.length} failed: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}`
        )
        setSyncFailed(true)
      } else {
        setSyncStatus(successMsg)
        setSyncFailed(false)
      }
      setTimeout(() => setSyncStatus(null), 6000)
    } catch (e) {
      setSyncStatus(`Resend failed: ${e}`)
      setSyncFailed(true)
    } finally {
      setSyncing(false)
    }
  }

  async function handlePullFromExcel() {
    setSyncing(true)
    setSyncStatus(null)
    setSyncFailed(false)
    try {
      const r = await fetch(`${API_BASE}/manager/database/inbound/pull-from-excel`, {
        method: 'POST',
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.detail ?? r.statusText)
      }
      const data = await r.json()
      const notFound: string[] = data.containers_not_in_db ?? []
      const lines = [
        `Read ${data.rows_in_excel} rows from Excel (${data.containers_in_excel} unique containers).`,
        `Updated driver info on ${data.containers_updated_in_db} container${data.containers_updated_in_db === 1 ? '' : 's'} in DB.`,
        `${data.containers_unchanged} unchanged.`,
      ]
      if (notFound.length > 0) {
        lines.push(
          `${notFound.length} container${notFound.length === 1 ? '' : 's'} in Excel not found in DB: ${notFound.slice(0, 3).join(', ')}${notFound.length > 3 ? '…' : ''}`
        )
      }
      setSyncStatus(lines.join(' '))
      setSyncFailed(false)
      reload()
      setTimeout(() => setSyncStatus(null), 8000)
    } catch (e) {
      setSyncStatus(`Pull failed: ${e}`)
      setSyncFailed(true)
    } finally {
      setSyncing(false)
    }
  }

  const filtered = rows?.filter((r) => {
    if (!filter) return true
    const q = filter.toLowerCase()
    return (
      r.container_no.toLowerCase().includes(q) ||
      r.whpo_number.includes(filter) ||
      (r.bol_number ?? '').toLowerCase().includes(q) ||
      r.sku.toLowerCase().includes(q) ||
      r.customer.toLowerCase().includes(q) ||
      (r.product_type ?? '').toLowerCase().includes(q) ||
      r.do_number.toLowerCase().includes(q)
    )
  })

  return (
    <div className="space-y-4">
      <FilterBar
        brands={brands}
        value={filterValue}
        onChange={setFilterValue}
      />

      {/* Header / controls */}
      <div
        className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5"
        style={{
          boxShadow:
            '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
        }}
      >
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0]">
              Inbound
            </div>
            <h2 className="text-xl font-bold text-[#1B4676] mt-0.5">
              Vendor data
            </h2>
          </div>
          <span className="text-xs text-slate-500 font-mono">
            {rows ? `${rows.length} row${rows.length === 1 ? '' : 's'}` : ''}
            {filtered && filtered.length !== rows?.length
              ? ` · ${filtered.length} matching`
              : ''}
          </span>
          <div className="flex-1" />
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <input
                type="text"
                placeholder="Filter by container / WHPO/Load No / BOL / SKU / customer…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="border border-slate-300 rounded-md pl-8 pr-3 py-1.5 text-sm w-72 text-slate-800 placeholder:text-slate-400 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
              />
              <SearchIcon className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            </div>
            <button
              type="button"
              onClick={reload}
              className="inline-flex items-center gap-1.5 text-[#1B4676] hover:text-[#0093D0] text-sm font-medium px-2 py-1.5 transition focus:outline-none focus-visible:underline"
              title="Refresh"
            >
              <RefreshIcon className="w-4 h-4" />
              <span>Refresh</span>
            </button>
            {updateConfigured && (
              <>
                <button
                  type="button"
                  onClick={handlePullFromExcel}
                  disabled={syncing}
                  className="inline-flex items-center gap-2 bg-white hover:bg-slate-50 disabled:bg-slate-50 disabled:text-slate-400 border border-[#1B4676]/30 hover:border-[#1B4676] text-[#1B4676] text-sm font-bold rounded-md px-3 py-1.5 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
                  title="Read InboundTable from OneDrive Excel and pull any manual edits to driver fields back into Postgres. Use after editing driver columns directly in Excel."
                >
                  <DownloadIcon className="w-4 h-4" />
                  <span>{syncing ? 'Pulling…' : 'Pull from Excel'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleSync}
                  disabled={syncing}
                  className="inline-flex items-center gap-2 bg-[#0093D0] hover:bg-[#00A8E8] disabled:bg-slate-200 disabled:text-slate-400 text-white text-sm font-semibold rounded-full px-4 py-1.5 transition shadow-[0_6px_18px_-4px_rgba(0,147,208,0.4)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
                  title="Re-fire the driver-info UPDATE webhook for every container that has driver info in the DB. Idempotent — updates existing rows in place, doesn't append."
                >
                  <UploadIcon className="w-4 h-4" />
                  <span>{syncing ? 'Sending…' : 'Resend driver info'}</span>
                </button>
              </>
            )}
            <a
              href={`${API_BASE}/manager/database/inbound.csv`}
              download
              className="inline-flex items-center gap-2 bg-[#1B4676] hover:bg-[#224E72] text-white text-sm font-medium rounded-md px-3 py-1.5 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
            >
              <DownloadIcon className="w-4 h-4" />
              <span>Export CSV</span>
            </a>
          </div>
        </div>
        {syncStatus && (
          <div
            className={`mt-3 text-xs rounded px-3 py-2 ${
              syncFailed
                ? 'bg-red-50 border border-red-200 text-red-800'
                : 'bg-emerald-50 border border-emerald-200 text-emerald-900'
            }`}
            role="status"
          >
            {syncStatus}
          </div>
        )}
        <p className="text-xs text-slate-500 mt-3">
          One row per container × SKU submitted by a vendor. Persists in Postgres —
          closing the browser or restarting the backend doesn't lose anything; every
          new submission appends new rows.{' '}
          {updateConfigured ? (
            <>
              New submissions auto-append to the OneDrive Excel file; driver-info
              PATCHes update existing rows in place. <strong>Resend driver info</strong>{' '}
              re-fires the UPDATE webhook for every container that has driver fields
              set in the DB — use when a row in Excel is still showing blank driver
              columns.
            </>
          ) : (
            <>
              OneDrive Excel sync is not yet configured — set{' '}
              <code className="bg-slate-100 text-[#1B4676] px-1 py-0.5 rounded font-mono text-[11px]">
                ONEDRIVE_UPDATE_WEBHOOK_URL
              </code>{' '}
              in backend <code className="bg-slate-100 text-[#1B4676] px-1 py-0.5 rounded font-mono text-[11px]">.env</code>.
            </>
          )}
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5 flex items-start gap-2"
        >
          <span className="font-semibold">Error:</span>
          <span>{error}</span>
        </div>
      )}

      {!rows ? (
        <div className="bg-white rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-500 flex items-center gap-2">
          <span
            className="inline-block w-2 h-2 rounded-full bg-[#0093D0] animate-pulse"
            aria-hidden
          />
          <span>Loading…</span>
        </div>
      ) : filtered && filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-slate-400 italic">
          {filter ? 'No rows match the filter.' : 'No vendor submissions yet.'}
        </div>
      ) : (
        <div
          className="bg-white rounded-xl border border-slate-200 overflow-x-auto"
          style={{
            boxShadow:
              '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
          }}
        >
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase text-slate-500 sticky top-0 z-10">
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    className="text-left px-3 py-2.5 font-bold tracking-wider whitespace-nowrap border-b border-slate-200"
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered!.map((row, i) => {
                const recentlyUpdated = isRecent(row.last_updated_at, 24)
                return (
                  <tr
                    key={i}
                    className={`hover:bg-[#0093D0]/5 transition ${
                      recentlyUpdated ? 'bg-amber-50/40' : ''
                    }`}
                  >
                    {COLUMNS.map((c) => (
                      <td
                        key={c.key}
                        className="px-3 py-1.5 align-top whitespace-nowrap font-mono text-slate-700"
                      >
                        {c.key === 'last_updated_at'
                          ? formatLastUpdatedCell(row.last_updated_at)
                          : c.key === 'container_no' && row.container_no
                          ? (
                            <Link
                              to={`/manager/containers/${encodeURIComponent(row.container_no)}`}
                              className="text-[#1B4676] hover:text-[#0093D0] font-bold underline decoration-dotted"
                            >
                              {row.container_no}
                            </Link>
                          )
                          : formatCell(row[c.key])}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function formatCell(v: string | number | null): React.ReactNode {
  if (v === null || v === undefined || v === '')
    return <span className="text-slate-300 italic">—</span>
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    try {
      return new Date(s).toLocaleString()
    } catch {
      return s
    }
  }
  if (/^\d{2}:\d{2}:\d{2}$/.test(s)) return s.slice(0, 5)
  return s
}

function isRecent(iso: string | null, withinHours: number): boolean {
  if (!iso) return false
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return false
  return Date.now() - t < withinHours * 3600 * 1000
}

function formatLastUpdatedCell(iso: string | null): React.ReactNode {
  if (!iso) return <span className="text-slate-300 italic">—</span>
  const t = new Date(iso).getTime()
  const ageMs = Date.now() - t
  const ageHours = Math.floor(ageMs / 3600 / 1000)
  if (ageHours < 24) {
    const label =
      ageHours < 1
        ? `${Math.max(1, Math.floor(ageMs / 60 / 1000))}m ago`
        : `${ageHours}h ago`
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 text-[10.5px] uppercase tracking-[0.12em] font-bold">
        <span
          className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"
          aria-hidden
        />
        Updated {label}
      </span>
    )
  }
  return <span className="text-slate-500">{new Date(iso).toLocaleString()}</span>
}

// ─── Icons ─────────────────────────────────────────────────────────────

function Icon({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Icon>
  )
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M3 21v-5h5" />
    </Icon>
  )
}

function UploadIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" x2="12" y1="3" y2="15" />
    </Icon>
  )
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
    </Icon>
  )
}
