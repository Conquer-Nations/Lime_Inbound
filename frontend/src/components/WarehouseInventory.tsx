import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { inventoryReportsApi } from '../api/client'
import type {
  AgingBucket,
  ContainerAgingResponse,
  ContainerAgingRow,
  RemainingInventoryResponse,
} from '../api/client'

/**
 * Warehouse Inventory — two reports on one page:
 *   1. **Aging** (default view): every received container, ordered oldest
 *      first, with units in / out / remaining and a coloured "bucket"
 *      pill. Top tiles show counts per bucket for at-a-glance ops mgmt.
 *   2. **Remaining inventory** (drill-down from any row): per-SKU
 *      received vs shipped vs remaining, plus serial-level table showing
 *      which units are still on the floor vs which TO they shipped on.
 *
 * No charts yet — straight tabular reports. Visualisation can layer on
 * after the data shapes prove out.
 */

const BUCKET_PILL: Record<AgingBucket, { label: string; cls: string; dot: string }> = {
  active: {
    label: 'Active',
    cls: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    dot: 'bg-emerald-500',
  },
  aging: {
    label: 'Aging',
    cls: 'bg-amber-100 text-amber-800 border-amber-200',
    dot: 'bg-amber-500',
  },
  stale: {
    label: 'Stale',
    cls: 'bg-rose-100 text-rose-800 border-rose-200',
    dot: 'bg-rose-500',
  },
  fully_shipped: {
    label: 'Shipped out',
    cls: 'bg-slate-100 text-slate-600 border-slate-200',
    dot: 'bg-slate-400',
  },
}

export default function WarehouseInventory() {
  const [data, setData] = useState<ContainerAgingResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | AgingBucket>('all')
  const [brandFilter, setBrandFilter] = useState('')
  const [selected, setSelected] = useState<ContainerAgingRow | null>(null)

  function reload() {
    setError(null)
    inventoryReportsApi
      .aging({
        bucket: filter === 'all' ? undefined : filter,
        brand: brandFilter.trim() || undefined,
        limit: 500,
      })
      .then(setData)
      .catch((e) => setError(String(e?.detail || e)))
  }

  useEffect(reload, [filter, brandFilter])

  const counts = data?.counts ?? { active: 0, aging: 0, stale: 0, fully_shipped: 0 }

  return (
    <div className="space-y-5">
      <header>
        <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#1B4676] text-[11px] font-semibold tracking-[0.14em] uppercase mb-3">
          <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
          Warehouse Inventory
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#1B4676]">
          Received container inventory
          <span className="block text-base font-medium text-slate-500 mt-1">
            Aging tracked from operator scan-finish
          </span>
        </h1>
        <p className="mt-3 text-sm text-slate-600 max-w-2xl">
          Every container that has been physically scanned in at the dock,
          ordered oldest first. Click a row to drill into its per-SKU and
          per-serial remaining inventory. Aging buckets: 0–29 days{' '}
          <em>active</em> · 30–59 <em>aging</em> · 60+ <em>stale</em>.
        </p>
        <div className="mt-3 rounded-md border border-[#0093D0]/25 bg-[#0093D0]/5 px-3 py-2 text-xs text-slate-700 max-w-2xl">
          <span className="font-bold text-[#1B4676]">Not seeing a container?</span>{' '}
          This view shows only containers an operator has finished scanning.
          Submitted shipments still expected at the dock live in{' '}
          <Link to="/manager" className="text-[#0093D0] hover:text-[#1B4676] underline decoration-dotted font-semibold">
            Delivery Orders
          </Link>
          {' '}— they'll appear here once received and finished.
        </div>
      </header>

      {error && (
        <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-3 py-2">
          <span className="font-semibold">Error:</span> {error}
        </div>
      )}

      {/* Aging-bucket tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(['active', 'aging', 'stale', 'fully_shipped'] as AgingBucket[]).map((b) => (
          <button
            key={b}
            type="button"
            onClick={() => setFilter(filter === b ? 'all' : b)}
            className={`text-left border rounded-xl px-4 py-3 transition ${
              filter === b
                ? 'border-[#0093D0] bg-[#0093D0]/10'
                : 'border-slate-200 bg-white hover:border-[#0093D0]/50 hover:bg-[#0093D0]/5'
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <span
                className={`w-2 h-2 rounded-full ${BUCKET_PILL[b].dot}`}
                aria-hidden
              />
              <span className="text-[11px] uppercase tracking-wider font-semibold text-slate-500">
                {BUCKET_PILL[b].label}
              </span>
            </div>
            <div className="text-2xl font-bold tabular-nums text-[#1B4676]">
              {counts[b] ?? 0}
            </div>
          </button>
        ))}
      </div>

      <section className="bg-white border border-slate-200 rounded-xl shadow-sm">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-200 flex-wrap">
          <div>
            <h2 className="text-sm font-bold text-[#1B4676]">
              Containers {filter !== 'all' && `· ${BUCKET_PILL[filter].label}`}
            </h2>
            <p className="text-xs text-slate-500">
              {data?.items.length ?? '…'} rows
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="text"
              placeholder="Filter by brand…"
              value={brandFilter}
              onChange={(e) => setBrandFilter(e.target.value)}
              className="border border-slate-300 rounded-md px-2.5 py-1 text-xs w-44"
            />
            {filter !== 'all' && (
              <button
                type="button"
                onClick={() => setFilter('all')}
                className="text-xs font-semibold text-[#1B4676] hover:text-[#0093D0]"
              >
                Clear bucket filter
              </button>
            )}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">Container</th>
                <th className="text-left px-3 py-2">Brand</th>
                <th className="text-left px-3 py-2">WHPO</th>
                <th className="text-left px-3 py-2">Received</th>
                <th className="text-right px-3 py-2">Days</th>
                <th className="text-right px-3 py-2">In</th>
                <th className="text-right px-3 py-2">Out</th>
                <th className="text-right px-3 py-2">Remaining</th>
                <th className="text-left px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center px-3 py-8 text-sm text-slate-400">
                    No containers match these filters.
                  </td>
                </tr>
              )}
              {data?.items.map((r) => {
                const pill = BUCKET_PILL[r.aging_bucket]
                return (
                  <tr
                    key={r.container_no}
                    onClick={() => setSelected(r)}
                    className={`border-t border-slate-100 cursor-pointer hover:bg-[#0093D0]/5 transition ${
                      selected?.container_no === r.container_no ? 'bg-[#0093D0]/10' : ''
                    }`}
                  >
                    <td className="px-3 py-2 font-mono font-semibold text-[#1B4676]">
                      {r.container_no}
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      {r.brand || <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-600">
                      {r.whpo_number || <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600 whitespace-nowrap">
                      {r.received_date ?? <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-700">
                      {r.days_since_received ?? <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-700">
                      {r.units_in || <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-700">
                      {r.units_out || <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold text-[#1B4676]">
                      {r.units_remaining}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${pill.cls}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${pill.dot}`} aria-hidden />
                        {pill.label}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {selected && (
        <RemainingDrilldown
          containerNo={selected.container_no}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}


function RemainingDrilldown({
  containerNo,
  onClose,
}: {
  containerNo: string
  onClose: () => void
}) {
  const [data, setData] = useState<RemainingInventoryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'in_warehouse' | 'shipped'>('in_warehouse')

  useEffect(() => {
    setData(null)
    setError(null)
    inventoryReportsApi
      .remaining(containerNo)
      .then(setData)
      .catch((e) => setError(String(e?.detail || e)))
  }, [containerNo])

  const visible = useMemo(
    () =>
      data?.serials.filter((s) => (filter === 'all' ? true : s.status === filter)) ?? [],
    [data, filter],
  )

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-slate-900/40 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="bg-white w-full max-w-2xl h-full overflow-y-auto shadow-2xl">
        <header className="px-5 py-4 border-b border-slate-200 sticky top-0 bg-white z-10">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-[0.18em] font-bold text-[#0093D0]">
                Remaining inventory
              </div>
              <h3 className="font-mono font-bold text-[#1B4676] text-lg mt-0.5">
                {containerNo}
              </h3>
              {data && (
                <p className="text-[11px] text-slate-500">
                  {data.brand ?? 'unknown brand'} · received {data.received_date ?? '?'}
                  {data.days_since_received != null && ` · ${data.days_since_received} days ago`}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 text-2xl leading-none px-1"
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </header>

        <div className="p-5 space-y-5">
          {error && (
            <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-3 py-2">
              {error}
            </div>
          )}

          {/* Per-SKU rollup */}
          {data && (
            <section>
              <h4 className="text-[11px] uppercase tracking-wider font-bold text-slate-500 mb-2">
                Per-SKU breakdown
              </h4>
              <div className="overflow-x-auto border border-slate-200 rounded-md">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-[10.5px] uppercase tracking-wider text-slate-500 font-semibold">
                    <tr>
                      <th className="text-left px-3 py-2">SKU</th>
                      <th className="text-right px-3 py-2">Received</th>
                      <th className="text-right px-3 py-2">Scanned in</th>
                      <th className="text-right px-3 py-2">Shipped</th>
                      <th className="text-right px-3 py-2">Remaining</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.per_sku.length === 0 && (
                      <tr>
                        <td colSpan={5} className="text-center px-3 py-6 text-slate-400 text-xs">
                          No SKU lines on this container.
                        </td>
                      </tr>
                    )}
                    {data.per_sku.map((s) => (
                      <tr key={s.sku_raw} className="border-t border-slate-100">
                        <td className="px-3 py-2 font-mono text-[#1B4676]">{s.sku_raw}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">
                          {s.qty_received}
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-700">
                          {s.qty_scanned_in}
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-700">
                          {s.qty_shipped_out}
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold text-[#1B4676]">
                          {s.qty_remaining}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Serial-level */}
          {data && (
            <section>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-[11px] uppercase tracking-wider font-bold text-slate-500">
                  Serials ({data.serials.length})
                </h4>
                <div className="inline-flex bg-slate-100 rounded-full p-0.5">
                  {(['in_warehouse', 'shipped', 'all'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setFilter(f)}
                      className={`text-[10.5px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full transition ${
                        filter === f
                          ? 'bg-white text-[#1B4676] shadow-sm'
                          : 'text-slate-500 hover:text-[#1B4676]'
                      }`}
                    >
                      {f === 'in_warehouse' ? 'On floor' : f === 'shipped' ? 'Shipped' : 'All'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="overflow-x-auto border border-slate-200 rounded-md">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-[10.5px] uppercase tracking-wider text-slate-500 font-semibold">
                    <tr>
                      <th className="text-left px-3 py-2">Serial</th>
                      <th className="text-left px-3 py-2">SKU</th>
                      <th className="text-left px-3 py-2">Scanned in</th>
                      <th className="text-left px-3 py-2">Status</th>
                      <th className="text-left px-3 py-2">Shipped on</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.length === 0 && (
                      <tr>
                        <td colSpan={5} className="text-center px-3 py-6 text-slate-400 text-xs">
                          {data.serials.length === 0
                            ? 'No serial-bearing scans recorded.'
                            : 'No serials match this filter.'}
                        </td>
                      </tr>
                    )}
                    {visible.map((s) => (
                      <tr key={s.serial_number + s.scanned_at} className="border-t border-slate-100">
                        <td className="px-3 py-2 font-mono text-xs text-[#1B4676]">
                          {s.serial_number}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-slate-600">
                          {s.sku_raw ?? '—'}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-500">
                          {new Date(s.scanned_at).toLocaleDateString()}
                        </td>
                        <td className="px-3 py-2">
                          {s.status === 'in_warehouse' ? (
                            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                              On floor
                            </span>
                          ) : (
                            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                              Shipped
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-600">
                          {s.shipped_to ? (
                            <span className="font-mono">{s.shipped_to}</span>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                          {s.shipped_at && (
                            <span className="text-slate-400">
                              {' · '}
                              {new Date(s.shipped_at).toLocaleDateString()}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
