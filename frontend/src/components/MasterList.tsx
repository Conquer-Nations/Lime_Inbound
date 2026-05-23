import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { masterListApi } from '../api/client'
import type { MasterListRow } from '../api/client'

/**
 * Auto-computed mastersheet — mirrors `Lime-Inventory-Sep 2025.xlsx`
 * MASTER LIST layout. One row per inbound container reception, one row
 * per outbound container shipment, ordered by date (newest first).
 *
 * Container # cells link to the existing container detail page; TO #
 * cells link to the transfer-order detail page.
 *
 * Read-only — the underlying SQL view computes everything from source-of-
 * truth tables. To change layout, edit migration d9e0f1a2b3c4.
 */
export default function MasterList() {
  const [rows, setRows] = useState<MasterListRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [kindFilter, setKindFilter] = useState<'all' | 'inbound' | 'outbound'>('all')
  const [scannedFilter, setScannedFilter] = useState<'all' | 'scanned' | 'pending'>('all')
  const [customer, setCustomer] = useState('')

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

  const visible =
    rows?.filter((r) => (kindFilter === 'all' ? true : r.row_kind === kindFilter)) ?? null

  return (
    <div className="space-y-5">
      <header>
        <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#1B4676] text-[11px] font-semibold tracking-[0.14em] uppercase mb-3">
          <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
          Master List
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#1B4676]">
          Inbound + Outbound — auto
        </h1>
        <p className="mt-1.5 text-sm text-slate-600 max-w-2xl">
          One row per inbound container reception, one row per outbound
          container shipment. Auto-computed from receivings, scans and
          shipments — the manual Lime-Inventory spreadsheet equivalent.
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
              {visible?.length ?? '…'} of {total} rows
            </h2>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="text"
              placeholder="Filter by brand (exact)…"
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              className="border border-slate-300 rounded-md px-2.5 py-1 text-xs w-40"
            />
            <PillGroup
              value={kindFilter}
              onChange={(v) => setKindFilter(v)}
              options={[
                { value: 'all', label: 'All' },
                { value: 'inbound', label: 'Inbound' },
                { value: 'outbound', label: 'Outbound' },
              ]}
            />
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
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">Kind</th>
                <th className="text-left px-3 py-2">Container</th>
                <th className="text-left px-3 py-2">Brand</th>
                <th className="text-left px-3 py-2">WHPO / TO</th>
                <th className="text-left px-3 py-2">Carrier / Driver</th>
                <th className="text-left px-3 py-2">Date</th>
                <th className="text-right px-3 py-2">Units</th>
                <th className="text-right px-3 py-2">Pallets</th>
                <th className="text-left px-3 py-2">Ship to</th>
                <th className="text-left px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {visible?.length === 0 && (
                <tr>
                  <td colSpan={10} className="text-center px-3 py-8 text-sm text-slate-400">
                    No rows match these filters.
                  </td>
                </tr>
              )}
              {visible?.map((r, i) => (
                <Row key={`${r.row_kind}-${r.source_id}-${i}`} r={r} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-[11px] text-slate-400">
        Tip: the underlying view is read-only. To add columns, edit the
        Alembic view migration <code>d9e0f1a2b3c4</code>.
      </p>
    </div>
  )
}


function Row({ r }: { r: MasterListRow }) {
  const isInbound = r.row_kind === 'inbound'
  const date = r.received_date ?? r.ship_date
  const units = (isInbound ? r.units : r.outbound_units) ?? 0
  const pallets = (isInbound ? r.pallets : r.outbound_pallets) ?? 0
  const whpoOrTo = isInbound ? r.whpo_number : r.transfer_order_no
  return (
    <tr className="border-t border-slate-100 hover:bg-[#0093D0]/5">
      <td className="px-3 py-2">
        <span
          className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
            isInbound
              ? 'bg-emerald-100 text-emerald-800'
              : 'bg-indigo-100 text-indigo-800'
          }`}
        >
          {r.row_kind}
        </span>
      </td>
      <td className="px-3 py-2 font-mono">
        {isInbound ? (
          <Link
            to={`/manager/containers/${encodeURIComponent(r.container_no)}`}
            className="text-[#1B4676] hover:text-[#0093D0] hover:underline font-semibold"
          >
            {r.container_no}
          </Link>
        ) : (
          <span className="text-slate-700">{r.container_no}</span>
        )}
      </td>
      <td className="px-3 py-2 text-slate-700">
        {r.customer_name || <span className="text-slate-300">—</span>}
      </td>
      <td className="px-3 py-2 font-mono text-xs">
        {whpoOrTo ? (
          isInbound ? (
            <span className="text-slate-700">{whpoOrTo}</span>
          ) : (
            <Link
              to={`/manager/outbound-orders/${encodeURIComponent(whpoOrTo)}`}
              className="text-[#1B4676] hover:text-[#0093D0] hover:underline"
            >
              {whpoOrTo}
            </Link>
          )
        ) : (
          <span className="text-slate-300">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-slate-700">
        {r.carrier_or_broker || <span className="text-slate-300">—</span>}
        {r.driver_name && (
          <div className="text-[10px] text-slate-400">{r.driver_name}</div>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-slate-600 whitespace-nowrap">
        {date ?? <span className="text-slate-300">—</span>}
      </td>
      <td className="px-3 py-2 text-right font-mono text-sm tabular-nums">
        {units || <span className="text-slate-300">—</span>}
      </td>
      <td className="px-3 py-2 text-right font-mono text-sm tabular-nums">
        {pallets || <span className="text-slate-300">—</span>}
      </td>
      <td className="px-3 py-2 text-xs text-slate-700 max-w-[180px] truncate">
        {!isInbound && r.ship_to ? r.ship_to : <span className="text-slate-300">—</span>}
      </td>
      <td className="px-3 py-2">
        <span
          className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
            r.scanned
              ? 'bg-emerald-100 text-emerald-700'
              : 'bg-amber-100 text-amber-700'
          }`}
        >
          {r.scanned ? 'scanned' : 'pending'}
        </span>
        {r.status && (
          <div className="text-[10px] text-slate-400 mt-0.5">{r.status}</div>
        )}
      </td>
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
