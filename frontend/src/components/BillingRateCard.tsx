import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { billingApi } from '../api/client'
import type {
  RateCardCreate,
  RateCardRow,
  RateCardUpdate,
} from '../api/client'

/**
 * Master rate card browser.
 *
 * Managers (role: 'manager') see it READ-ONLY — they can search, filter
 * by category, and reference codes when adding manual invoice lines.
 *
 * Developers (role: 'developer') see the same view PLUS inline edit
 * controls per row + a "New code" button. Edits hit the same backend
 * the rest of the ERP uses, so changes propagate instantly to every
 * manager session.
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

// Stable list for the category dropdown when creating/editing.
const KNOWN_CATEGORIES = Object.keys(CATEGORY_LABEL)

function formatRate(r: RateCardRow): string {
  if (r.rate == null) return '—'
  return `$${r.rate.toFixed(2)}`
}

export default function BillingRateCard() {
  const { user } = useAuth()
  const canEdit = user?.role === 'developer'

  const [rows, setRows] = useState<RateCardRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState<string | 'all'>('all')
  const [editing, setEditing] = useState<RateCardRow | null>(null)
  const [creating, setCreating] = useState(false)

  function reload() {
    setError(null)
    billingApi
      .rateCard()
      .then(setRows)
      .catch((e) => setError(String(e?.detail || e)))
  }

  useEffect(reload, [])

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 3500)
  }

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

  async function deleteRow(r: RateCardRow) {
    if (
      !confirm(
        `Delete rate code ${r.code}? This refuses if it's been used on any invoice line.`,
      )
    )
      return
    try {
      await billingApi.deleteRateCode(r.code)
      showToast(`Deleted ${r.code}`)
      reload()
    } catch (e) {
      const err = e as { detail?: string } | string
      setError(typeof err === 'object' && err.detail ? err.detail : String(err))
    }
  }

  return (
    <div className="space-y-5">
      <header>
        <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#1B4676] text-[11px] font-semibold tracking-[0.14em] uppercase mb-3">
          <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
          Rate Card
          {canEdit && (
            <span className="ml-1 bg-amber-100 text-amber-800 border border-amber-200 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider">
              Dev edit
            </span>
          )}
        </div>
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#1B4676]">
              Master rate card
            </h1>
            <p className="mt-1.5 text-sm text-slate-600 max-w-2xl">
              The full list of billable activities + unit rates that drive
              invoice line items. Use these codes when adding manual lines
              on an invoice. {canEdit
                ? 'Edit any row inline — changes apply to future charges, not historical invoices.'
                : 'Edits are restricted to developer access; ask Ken if a rate needs updating.'}
            </p>
          </div>
          {canEdit && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 bg-[#0093D0] hover:bg-[#00A8E8] text-white text-sm font-semibold px-3.5 py-2 rounded-md transition"
            >
              <PlusIcon className="w-4 h-4" />
              New code
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-3 py-2 flex items-start gap-2">
          <span className="font-semibold">Error:</span>
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-rose-700/60 hover:text-rose-700"
          >
            ×
          </button>
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
                {canEdit && <th />}
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
                  {canEdit && (
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => setEditing(r)}
                        className="text-xs font-semibold text-[#0093D0] hover:text-[#1B4676] mr-3"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteRow(r)}
                        className="text-xs font-semibold text-rose-600 hover:text-rose-800"
                        title="Delete (refuses if used on any invoice)"
                      >
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {editing && canEdit && (
        <RateCodeModal
          mode="edit"
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            showToast(`Updated ${editing.code}`)
            reload()
          }}
          onError={(msg) => setError(msg)}
        />
      )}

      {creating && canEdit && (
        <RateCodeModal
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={(row) => {
            setCreating(false)
            showToast(`Created ${row.code}`)
            reload()
          }}
          onError={(msg) => setError(msg)}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 bg-emerald-700 text-white px-4 py-2.5 rounded-md shadow-lg z-50 flex items-center gap-2">
          <CheckIcon className="w-4 h-4" />
          <span className="text-sm">{toast}</span>
        </div>
      )}
    </div>
  )
}

// ─── Edit / create modal ───────────────────────────────────────────────

function RateCodeModal({
  mode,
  existing,
  onClose,
  onSaved,
  onError,
}: {
  mode: 'create' | 'edit'
  existing?: RateCardRow
  onClose: () => void
  onSaved: (row: RateCardRow) => void
  onError: (msg: string) => void
}) {
  const [code, setCode] = useState(existing?.code ?? '')
  const [category, setCategory] = useState(existing?.category ?? KNOWN_CATEGORIES[0])
  const [description, setDescription] = useState(existing?.description ?? '')
  const [unit, setUnit] = useState(existing?.unit ?? 'each')
  const [rate, setRate] = useState(
    existing?.rate != null ? String(existing.rate) : '',
  )
  const [taxable, setTaxable] = useState(existing?.taxable ?? false)
  const [isMinimum, setIsMinimum] = useState(existing?.is_minimum ?? false)
  const [isAdvance, setIsAdvance] = useState(existing?.is_advance ?? false)
  const [note, setNote] = useState(existing?.note ?? '')
  const [maxPerRequest, setMaxPerRequest] = useState(
    existing?.max_per_request != null ? String(existing.max_per_request) : '',
  )
  const [minAdvance, setMinAdvance] = useState(
    existing?.min_advance != null ? String(existing.min_advance) : '',
  )
  const [busy, setBusy] = useState(false)

  function parseNum(s: string): number | null {
    if (s.trim() === '') return null
    const n = parseFloat(s)
    return Number.isFinite(n) ? n : null
  }

  async function submit() {
    setBusy(true)
    try {
      if (mode === 'create') {
        if (!code.trim() || !category.trim() || !description.trim() || !unit.trim()) {
          onError('Code, Category, Description, and Unit are required')
          setBusy(false)
          return
        }
        const payload: RateCardCreate = {
          code: code.trim().toUpperCase(),
          category: category.trim().toUpperCase(),
          description: description.trim(),
          unit: unit.trim(),
          rate: parseNum(rate),
          taxable,
          is_minimum: isMinimum,
          is_advance: isAdvance,
          note: note.trim() || null,
          max_per_request: parseNum(maxPerRequest),
          min_advance: parseNum(minAdvance),
        }
        const row = await billingApi.createRateCode(payload)
        onSaved(row)
      } else {
        const payload: RateCardUpdate = {
          category: category.trim().toUpperCase(),
          description: description.trim(),
          unit: unit.trim(),
          rate: parseNum(rate),
          taxable,
          is_minimum: isMinimum,
          is_advance: isAdvance,
          note: note.trim() || null,
          max_per_request: parseNum(maxPerRequest),
          min_advance: parseNum(minAdvance),
        }
        const row = await billingApi.updateRateCode(existing!.code, payload)
        onSaved(row)
      }
    } catch (e) {
      const err = e as { detail?: string } | string
      onError(typeof err === 'object' && err.detail ? err.detail : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-lg font-bold text-[#1B4676]">
            {mode === 'create' ? 'New rate code' : `Edit ${existing?.code}`}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-700 text-xl leading-none"
          >
            ×
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">
                Code{mode === 'edit' && ' (cannot be renamed)'}
              </span>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                disabled={mode === 'edit'}
                placeholder="e.g. HND-099"
                className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#0093D0] disabled:bg-slate-100 disabled:text-slate-500"
              />
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">
                Category
              </span>
              <input
                list="rate-card-categories"
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value.toUpperCase())}
                className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#0093D0]"
              />
              <datalist id="rate-card-categories">
                {KNOWN_CATEGORIES.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
          </div>
          <label className="block">
            <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">
              Description
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="What this charge covers — shown on the customer invoice"
              className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#0093D0]"
            />
          </label>
          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">
                Unit
              </span>
              <input
                type="text"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="e.g. each, pallet/day, hour"
                className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#0093D0]"
              />
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">
                Rate ($)
              </span>
              <input
                type="number"
                step="any"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="(blank → entered at line)"
                className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#0093D0]"
              />
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">
                Max per request
              </span>
              <input
                type="number"
                step="any"
                value={maxPerRequest}
                onChange={(e) => setMaxPerRequest(e.target.value)}
                placeholder="(optional cap)"
                className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#0093D0]"
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">
                Min advance
              </span>
              <input
                type="number"
                step="any"
                value={minAdvance}
                onChange={(e) => setMinAdvance(e.target.value)}
                placeholder="(advancing floor)"
                className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#0093D0]"
              />
            </label>
            <div className="flex items-end gap-4 pb-1">
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={taxable}
                  onChange={(e) => setTaxable(e.target.checked)}
                  className="w-4 h-4"
                />
                <span>Taxable</span>
              </label>
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={isMinimum}
                  onChange={(e) => setIsMinimum(e.target.checked)}
                  className="w-4 h-4"
                />
                <span>Minimum</span>
              </label>
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={isAdvance}
                  onChange={(e) => setIsAdvance(e.target.checked)}
                  className="w-4 h-4"
                />
                <span>Advance</span>
              </label>
            </div>
          </div>
          <label className="block">
            <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">
              Note
            </span>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Internal note (shown to managers in the picker)"
              className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#0093D0]"
            />
          </label>
        </div>
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-slate-700 hover:bg-slate-100 px-3 py-1.5 rounded"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="text-sm bg-[#0093D0] hover:bg-[#00A8E8] text-white font-semibold px-4 py-1.5 rounded disabled:opacity-50"
          >
            {busy ? 'Saving…' : mode === 'create' ? 'Create code' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
