import { useEffect, useMemo, useState } from 'react'
import { billingApi } from '../api/client'
import type { RateCardRow } from '../api/client'

/**
 * Manager-only browse of the rate card. Read-only in Phase 1 — managers
 * see what codes / categories / unit rates exist so they can reference
 * them when adding manual lines to invoices. Phase 2: inline editor +
 * per-customer overrides.
 */

const CATEGORY_LABEL: Record<string, string> = {
  HANDLING: 'Handling',
  ORDER_PROC: 'Order processing',
  PICKING: 'Picking',
  PUTAWAY: 'Putaway',
  STORAGE: 'Storage',
  BOL_SHIP: 'BOL / Shipping',
  ACCESSORIAL: 'Accessorial',
  IT: 'IT & systems',
  MDS: 'Material handling',
  LABOR: 'Labor',
  DRAYAGE: 'Drayage',
}

function formatRate(r: RateCardRow): string {
  if (r.rate == null) return '—'
  return `$${r.rate.toFixed(2)}`
}

export default function BillingRateCard() {
  const [rows, setRows] = useState<RateCardRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState<string | 'all'>('all')

  useEffect(() => {
    billingApi
      .rateCard()
      .then(setRows)
      .catch((e) => setError(String(e?.detail || e)))
  }, [])

  const grouped = useMemo(() => {
    const data = rows ?? []
    const out = new Map<string, RateCardRow[]>()
    for (const r of data) {
      const list = out.get(r.category) ?? []
      list.push(r)
      out.set(r.category, list)
    }
    return out
  }, [rows])

  const categories = useMemo(() => Array.from(grouped.keys()), [grouped])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const cat = activeCategory
    const data: [string, RateCardRow[]][] = []
    for (const [c, list] of grouped.entries()) {
      if (cat !== 'all' && c !== cat) continue
      const filteredList = q
        ? list.filter(
            (r) =>
              r.code.toLowerCase().includes(q) ||
              r.description.toLowerCase().includes(q) ||
              (r.note ?? '').toLowerCase().includes(q),
          )
        : list
      if (filteredList.length) data.push([c, filteredList])
    }
    return data
  }, [grouped, search, activeCategory])

  return (
    <div className="space-y-5">
      <header>
        <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#1B4676] text-[11px] font-semibold tracking-[0.14em] uppercase mb-3">
          <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
          Rate Card
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#1B4676]">
          Master rate card
        </h1>
        <p className="mt-1.5 text-sm text-slate-600 max-w-2xl">
          The full list of billable activities + unit rates that drive
          invoice line items. Use these codes when adding manual lines on
          an invoice. Read-only in this view.
        </p>
      </header>

      {error && (
        <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-3 py-2">
          <span className="font-semibold">Error:</span> {error}
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search code or description…"
          className="w-64 max-w-full border border-slate-200 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-[#0093D0]"
        />
        <div className="flex items-center gap-1 flex-wrap">
          <button
            type="button"
            onClick={() => setActiveCategory('all')}
            className={`text-[11px] uppercase tracking-wider font-semibold px-2.5 py-1 rounded-full border transition ${
              activeCategory === 'all'
                ? 'bg-[#1B4676] text-white border-[#1B4676]'
                : 'bg-white text-slate-700 border-slate-200 hover:border-[#0093D0]'
            }`}
          >
            All
          </button>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setActiveCategory(c)}
              className={`text-[11px] uppercase tracking-wider font-semibold px-2.5 py-1 rounded-full border transition ${
                activeCategory === c
                  ? 'bg-[#1B4676] text-white border-[#1B4676]'
                  : 'bg-white text-slate-700 border-slate-200 hover:border-[#0093D0]'
              }`}
            >
              {CATEGORY_LABEL[c] ?? c}
            </button>
          ))}
        </div>
      </div>

      {rows === null && (
        <div className="bg-white border border-slate-200 rounded-md px-3 py-2.5 text-sm text-slate-500">
          Loading rate card…
        </div>
      )}

      {rows !== null && filtered.length === 0 && (
        <div className="bg-white border border-slate-200 rounded-md p-6 text-center text-slate-500 text-sm">
          No rate codes match those filters.
        </div>
      )}

      {filtered.map(([category, list]) => (
        <div
          key={category}
          className="bg-white rounded-xl border border-slate-200 overflow-hidden"
          style={{
            boxShadow:
              '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
          }}
        >
          <div className="bg-slate-50 border-b border-slate-200 px-4 py-2.5 flex items-baseline justify-between">
            <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#0093D0]">
              {CATEGORY_LABEL[category] ?? category}
            </h3>
            <span className="text-[11px] text-slate-400 uppercase tracking-wider">
              {list.length} codes
            </span>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-white text-[10.5px] uppercase text-slate-500 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-2 font-semibold tracking-wider">Code</th>
                <th className="text-left px-4 py-2 font-semibold tracking-wider">Description</th>
                <th className="text-left px-4 py-2 font-semibold tracking-wider">Unit</th>
                <th className="text-right px-4 py-2 font-semibold tracking-wider">Rate</th>
                <th className="text-left px-4 py-2 font-semibold tracking-wider">Flags</th>
                <th className="text-left px-4 py-2 font-semibold tracking-wider">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((r) => (
                <tr key={r.code} className="hover:bg-[#0093D0]/5 transition">
                  <td className="px-4 py-2 font-mono font-bold text-[#1B4676]">
                    {r.code}
                  </td>
                  <td className="px-4 py-2 text-slate-700">{r.description}</td>
                  <td className="px-4 py-2 text-slate-500">{r.unit}</td>
                  <td className="px-4 py-2 text-right text-slate-700 font-mono">
                    {formatRate(r)}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1 flex-wrap">
                      {r.taxable && (
                        <span className="bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider">
                          Tax
                        </span>
                      )}
                      {r.is_minimum && (
                        <span className="bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider">
                          Min
                        </span>
                      )}
                      {r.is_advance && (
                        <span className="bg-[#0093D0]/15 text-[#1B4676] px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider">
                          Adv
                        </span>
                      )}
                      {!r.taxable && !r.is_minimum && !r.is_advance && (
                        <span className="text-slate-300">—</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-slate-500 text-xs max-w-xs">
                    {r.note ?? <span className="text-slate-300">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}
