import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, masterListApi } from '../api/client'
import type { CustomerRead, MasterListRow } from '../api/client'

/**
 * Master List — mirror of Tiana's Lime-Inventory-Sep 2025.xlsx.
 *
 * One row per inbound container. Cols 1-13 cover inbound (invoice,
 * commodity, container, WHPO, carrier, driver, drop/received/pickup,
 * pallets/units/sqft). Cols 14-20 cover outbound (TO, ship date,
 * ship to, pallets/units/sqft out). Cols 21-22 are status (scanned,
 * LPN). Outbound cells stay blank until an outbound has actually
 * drawn from this container.
 *
 * The OneDrive Excel mirror (Lime Master Inventory.xlsx) is kept in
 * sync by the backend on every receipt-finish / outbound-finish.
 */
export default function MasterList() {
  const [rows, setRows] = useState<MasterListRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [scannedFilter, setScannedFilter] = useState<'all' | 'scanned' | 'pending'>('all')
  const [customer, setCustomer] = useState('')
  const [brands, setBrands] = useState<CustomerRead[]>([])

  // Load the brand list once on mount so the filter dropdown is populated.
  // Brands = Customer rows (Lime, Pan American Wire, Boviet Solar, …).
  useEffect(() => {
    api
      .listManagerCustomers()
      .then((rows) => setBrands(rows.sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {
        /* fail-soft — dropdown stays at default and the user can still
           pick "All brands" or type via the URL once we ship a free-text
           fallback. Not surfacing the error inline because the master
           sheet itself still loads fine. */
      })
  }, [])

  function reload() {
    setError(null)
    masterListApi
      .list({
        customer: customer.trim() || undefined,
        scanned:
          scannedFilter === 'scanned'
            ? true
            : scannedFilter === 'pending'
            ? false
            : undefined,
        limit: 500,
      })
      .then((r) => {
        setRows(r.items)
        setTotal(r.total)
      })
      .catch((e) => setError(String(e?.detail || e)))
  }

  useEffect(reload, [scannedFilter, customer])

  return (
    <div className="space-y-5">
      <header>
        <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#1B4676] text-[11px] font-semibold tracking-[0.14em] uppercase mb-3">
          <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
          Master List
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#1B4676]">
          Inventory master sheet
        </h1>
        <p className="mt-1.5 text-sm text-slate-600 max-w-3xl">
          One row per inbound container. Columns through{' '}
          <strong>Total Sq Ft</strong> are inbound; <strong>TO No.</strong>{' '}
          onward is outbound (blank until something has shipped from the
          container). Same layout as the manual{' '}
          <em>Lime-Inventory-Sep 2025.xlsx</em>; the OneDrive workbook
          (Lime Master Inventory.xlsx) auto-mirrors this view on every
          receipt and outbound finish.
        </p>
      </header>

      {error && (
        <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-3 py-2">
          <span className="font-semibold">Error:</span> {error}
        </div>
      )}

      <section className="bg-white border border-slate-200 rounded-xl shadow-sm">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-200 flex-wrap">
          <div>
            <h2 className="text-sm font-bold text-[#1B4676]">
              {rows?.length ?? '…'} of {total} containers
            </h2>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              className="border border-slate-300 rounded-md px-2.5 py-1 text-xs w-44 bg-white text-[#1B4676] focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
              aria-label="Filter by brand"
            >
              <option value="">All brands</option>
              {brands.map((b) => (
                <option key={b.id} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
            <PillGroup
              value={scannedFilter}
              onChange={(v) => setScannedFilter(v)}
              options={[
                { value: 'all', label: 'Any' },
                { value: 'scanned', label: 'Scanned' },
                { value: 'pending', label: 'Pending' },
              ]}
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              {/* Two-row header: section bands above, column names below.
                  Matches the xlsx's visual grouping. */}
              <tr className="bg-[#1B4676] text-white">
                <th colSpan={13} className="text-left px-3 py-1.5 text-[10px] uppercase tracking-wider font-bold">
                  Inbound
                </th>
                <th colSpan={7} className="text-left px-3 py-1.5 text-[10px] uppercase tracking-wider font-bold bg-[#0093D0]">
                  Outbound
                </th>
                <th colSpan={2} className="text-left px-3 py-1.5 text-[10px] uppercase tracking-wider font-bold bg-slate-600">
                  Status
                </th>
              </tr>
              <tr className="bg-slate-50 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                <th className="text-left px-2 py-2">invoice</th>
                <th className="text-left px-2 py-2">commodity</th>
                <th className="text-left px-2 py-2">container</th>
                <th className="text-left px-2 py-2">whpo</th>
                <th className="text-left px-2 py-2">carrier</th>
                <th className="text-left px-2 py-2">driver</th>
                <th className="text-left px-2 py-2">drop</th>
                <th className="text-left px-2 py-2">received</th>
                <th className="text-left px-2 py-2">pickup</th>
                <th className="text-right px-2 py-2">pallets</th>
                <th className="text-right px-2 py-2">units</th>
                <th className="text-right px-2 py-2">sqft</th>
                <th className="text-right px-2 py-2">total sqft</th>
                <th className="text-left px-2 py-2 border-l border-[#0093D0]/20">to no</th>
                <th className="text-left px-2 py-2">ship date</th>
                <th className="text-left px-2 py-2">ship to</th>
                <th className="text-right px-2 py-2">pallets</th>
                <th className="text-right px-2 py-2">units</th>
                <th className="text-right px-2 py-2">sqft</th>
                <th className="text-right px-2 py-2">total sqft</th>
                <th className="text-left px-2 py-2 border-l border-slate-300">scanned</th>
                <th className="text-left px-2 py-2">lpn</th>
              </tr>
            </thead>
            <tbody>
              {rows?.length === 0 && (
                <tr>
                  <td colSpan={22} className="text-center px-3 py-8 text-sm text-slate-400">
                    No containers match these filters.
                  </td>
                </tr>
              )}
              {rows?.map((r) => (
                <Row key={r.container_id} r={r} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}


function Row({ r }: { r: MasterListRow }) {
  const cell = "px-2 py-2"
  const dash = <span className="text-slate-300">—</span>
  const fmtN = (v: number | null) => (v == null || v === 0 ? dash : v.toLocaleString())
  const fmtF = (v: number | null) =>
    v == null || v === 0 ? dash : Number.isInteger(v) ? v.toLocaleString() : v.toFixed(1)
  const fmtT = (v: string | null) => (v ? v : dash)

  return (
    <tr className="border-t border-slate-100 hover:bg-[#0093D0]/5">
      {/* Inbound cells */}
      <td className={`${cell} font-mono text-slate-700`}>{fmtT(r.invoice)}</td>
      <td className={`${cell} text-slate-700`}>{fmtT(r.commodity)}</td>
      <td className={`${cell} font-mono`}>
        <Link
          to={`/manager/containers/${encodeURIComponent(r.container_no)}`}
          className="text-[#1B4676] hover:text-[#0093D0] hover:underline font-semibold"
        >
          {r.container_no}
        </Link>
      </td>
      <td className={`${cell} font-mono`}>{fmtT(r.whpo_load_no)}</td>
      <td className={`${cell} text-slate-700`}>{fmtT(r.carrier_broker)}</td>
      <td className={`${cell} text-slate-700`}>{fmtT(r.driver_name)}</td>
      <td className={`${cell} text-slate-600 whitespace-nowrap`}>
        {fmtT(r.drop_container)}
      </td>
      <td className={`${cell} text-slate-600 whitespace-nowrap`}>
        {fmtT(r.received_date)}
      </td>
      <td className={`${cell} text-slate-600 whitespace-nowrap`}>
        {fmtT(r.pickup_container)}
      </td>
      <td className={`${cell} text-right font-mono tabular-nums`}>
        {fmtN(r.pallets)}
      </td>
      <td className={`${cell} text-right font-mono tabular-nums`}>
        {fmtN(r.units)}
      </td>
      <td className={`${cell} text-right font-mono tabular-nums`}>
        {fmtF(r.sqft)}
      </td>
      <td className={`${cell} text-right font-mono tabular-nums`}>
        {fmtF(r.total_sqft)}
      </td>

      {/* Outbound cells */}
      <td className={`${cell} font-mono border-l border-[#0093D0]/20`}>
        {r.to_no ? (
          // Strip commas + slashes from links since to_no may aggregate
          // multiple comma-separated TOs.
          r.to_no.split(',').map((t, i) => (
            <span key={i}>
              {i > 0 && <span className="text-slate-400">, </span>}
              <Link
                to={`/manager/outbound-orders/${encodeURIComponent(t.trim())}`}
                className="text-[#1B4676] hover:text-[#0093D0] hover:underline"
              >
                {t.trim()}
              </Link>
            </span>
          ))
        ) : (
          dash
        )}
      </td>
      <td className={`${cell} text-slate-600 whitespace-nowrap`}>{fmtT(r.ship_date)}</td>
      <td className={`${cell} text-slate-700 max-w-[160px] truncate`}>
        {fmtT(r.ship_to)}
      </td>
      <td className={`${cell} text-right font-mono tabular-nums`}>
        {fmtN(r.pallets_out)}
      </td>
      <td className={`${cell} text-right font-mono tabular-nums`}>
        {fmtN(r.units_out)}
      </td>
      <td className={`${cell} text-right font-mono tabular-nums`}>
        {fmtF(r.sqft_out)}
      </td>
      <td className={`${cell} text-right font-mono tabular-nums`}>
        {fmtF(r.total_sqft_out)}
      </td>

      {/* Status */}
      <td className={`${cell} border-l border-slate-300`}>
        <span
          className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
            r.scanned
              ? 'bg-emerald-100 text-emerald-700'
              : 'bg-amber-100 text-amber-700'
          }`}
        >
          {r.scanned ? 'scanned' : 'pending'}
        </span>
      </td>
      <td className={`${cell} font-mono text-[#1B4676]`}>{fmtT(r.lpn)}</td>
    </tr>
  )
}


function PillGroup<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div className="inline-flex bg-slate-100 rounded-full p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`text-[11px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full transition ${
            value === o.value
              ? 'bg-white text-[#1B4676] shadow-sm'
              : 'text-slate-500 hover:text-[#1B4676]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
