import { useEffect, useMemo, type ReactNode } from 'react'

/**
 * Reusable filter bar — used across every list view in both portals.
 *
 * Two filter dimensions:
 *   - Brand (optional, hidden when there's only one brand on file)
 *   - Date, with a 4-mode granularity selector:
 *       Year  → all rows in YYYY
 *       Month → all rows in YYYY-MM
 *       Day   → exactly YYYY-MM-DD
 *       Range → from / to date inputs
 *
 * Each mode resolves to a `(from_date, to_date)` pair sent to the
 * backend. The chosen mode + values persist in URL query params via
 * the caller (use `useFilterState` below). Page refresh + shareable
 * URLs stay consistent.
 *
 * Quick presets (Today / 7d / 30d / This month / This year / All) live
 * above the granularity selector — single click for the common cases.
 */

export type FilterMode = 'preset' | 'year' | 'month' | 'day' | 'range'

export interface FilterValue {
  brand_id: number | 'all'
  mode: FilterMode
  preset?: PresetKey
  year?: number
  month?: number   // 1-12
  day?: number     // 1-31
  from_date?: string  // ISO YYYY-MM-DD
  to_date?: string
}

export type PresetKey = 'today' | '7d' | '30d' | 'this_month' | 'this_year' | 'all'

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'this_month', label: 'This month' },
  { key: 'this_year', label: 'This year' },
  { key: 'all', label: 'All time' },
]

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

interface Brand {
  id: number
  name: string
}

export interface FilterBarProps {
  /** Customers/brands the current user can filter by. Hide the brand
   *  picker entirely by passing []. */
  brands: Brand[]
  /** Current filter state. */
  value: FilterValue
  /** Called when any field changes. Caller persists via URL params. */
  onChange: (v: FilterValue) => void
  /** Custom-rendered label above the brand picker. Defaults to "Brand". */
  brandLabel?: string
}

export default function FilterBar({
  brands,
  value,
  onChange,
  brandLabel = 'Brand',
}: FilterBarProps) {
  const year = value.year ?? new Date().getFullYear()
  const month = value.month ?? new Date().getMonth() + 1
  const day = value.day ?? new Date().getDate()

  function patch(p: Partial<FilterValue>) {
    onChange({ ...value, ...p })
  }

  function pickPreset(k: PresetKey) {
    patch({ mode: 'preset', preset: k })
  }

  // For Year/Month/Day mode dropdowns — generate a sane range.
  const years = useMemo(() => {
    const now = new Date().getFullYear()
    const arr: number[] = []
    for (let y = now; y >= now - 5; y--) arr.push(y)
    return arr
  }, [])

  const daysInMonth = useMemo(() => {
    return new Date(year, month, 0).getDate()
  }, [year, month])

  return (
    <div
      className="bg-white rounded-xl border border-slate-200 px-4 py-3 mb-4"
      style={{
        boxShadow:
          '0 1px 2px 0 rgba(15,23,42,0.04), 0 4px 12px -6px rgba(15,23,42,0.08)',
      }}
    >
      <div className="flex flex-wrap items-end gap-4">
        {/* Brand picker — hidden if no brands or only one to pick. */}
        {brands.length > 1 && (
          <div className="flex flex-col gap-1">
            <label className="text-[10.5px] uppercase tracking-[0.16em] font-bold text-slate-500">
              {brandLabel}
            </label>
            <select
              value={value.brand_id}
              onChange={(e) =>
                patch({
                  brand_id:
                    e.target.value === 'all' ? 'all' : Number(e.target.value),
                })
              }
              className="border border-slate-300 rounded-md px-3 py-1.5 text-sm font-semibold text-[#1B4676] bg-white focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition min-w-[160px]"
              aria-label="Filter by brand"
            >
              <option value="all">All brands</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Quick presets — single click for the common date ranges. */}
        <div className="flex flex-col gap-1">
          <label className="text-[10.5px] uppercase tracking-[0.16em] font-bold text-slate-500">
            Quick range
          </label>
          <div className="flex items-center gap-1 flex-wrap">
            {PRESETS.map((p) => {
              const active = value.mode === 'preset' && value.preset === p.key
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => pickPreset(p.key)}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-bold transition border ${
                    active
                      ? 'bg-[#0093D0] text-white border-[#0093D0]'
                      : 'bg-white text-[#1B4676] border-slate-300 hover:border-[#1B4676]/40 hover:bg-slate-50'
                  }`}
                >
                  {p.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Granular mode tabs — Year / Month / Day / Range. */}
        <div className="flex flex-col gap-1">
          <label className="text-[10.5px] uppercase tracking-[0.16em] font-bold text-slate-500">
            Or pick exact
          </label>
          <div className="inline-flex rounded-md border border-slate-300 overflow-hidden text-sm font-semibold">
            {(['year', 'month', 'day', 'range'] as FilterMode[]).map((m) => {
              const active = value.mode === m
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() =>
                    patch({
                      mode: m,
                      preset: undefined,
                      year: value.year ?? year,
                      month: value.month ?? month,
                      day: value.day ?? day,
                    })
                  }
                  className={`px-3 py-1.5 transition capitalize ${
                    active
                      ? 'bg-[#1B4676] text-white'
                      : 'bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {m}
                </button>
              )
            })}
          </div>
        </div>

        {/* Mode-specific inputs. */}
        {(value.mode === 'year' || value.mode === 'month' || value.mode === 'day') && (
          <SubField label="Year">
            <select
              value={year}
              onChange={(e) => patch({ year: Number(e.target.value) })}
              className="border border-slate-300 rounded-md px-2 py-1.5 text-sm bg-white focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </SubField>
        )}

        {(value.mode === 'month' || value.mode === 'day') && (
          <SubField label="Month">
            <select
              value={month}
              onChange={(e) => patch({ month: Number(e.target.value) })}
              className="border border-slate-300 rounded-md px-2 py-1.5 text-sm bg-white focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
          </SubField>
        )}

        {value.mode === 'day' && (
          <SubField label="Day">
            <select
              value={day}
              onChange={(e) => patch({ day: Number(e.target.value) })}
              className="border border-slate-300 rounded-md px-2 py-1.5 text-sm bg-white focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
            >
              {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </SubField>
        )}

        {value.mode === 'range' && (
          <>
            <SubField label="From">
              <input
                type="date"
                value={value.from_date ?? ''}
                onChange={(e) => patch({ from_date: e.target.value || undefined })}
                className="border border-slate-300 rounded-md px-2 py-1.5 text-sm bg-white focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
              />
            </SubField>
            <SubField label="To">
              <input
                type="date"
                value={value.to_date ?? ''}
                onChange={(e) => patch({ to_date: e.target.value || undefined })}
                className="border border-slate-300 rounded-md px-2 py-1.5 text-sm bg-white focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
              />
            </SubField>
          </>
        )}

        {/* Active-filter summary chip + clear button on the right. */}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-slate-500">
            {summarize(value)}
          </span>
          {filterIsActive(value) && (
            <button
              type="button"
              onClick={() =>
                onChange({
                  brand_id: 'all',
                  mode: 'preset',
                  preset: '30d',
                })
              }
              className="text-[11px] font-semibold text-[#0093D0] hover:text-[#1B4676] underline decoration-dotted"
            >
              Clear
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function SubField({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10.5px] uppercase tracking-[0.16em] font-bold text-slate-500">
        {label}
      </label>
      {children}
    </div>
  )
}

/** Resolve filter state to the (from_date, to_date) pair the API
 * expects. Brand is passed separately. Returns undefined for either end
 * when "All time" or open-ended range. */
export function resolveFilterDates(v: FilterValue): {
  from_date?: string
  to_date?: string
} {
  const today = new Date()
  const iso = (d: Date) => d.toISOString().slice(0, 10)

  if (v.mode === 'preset') {
    switch (v.preset) {
      case 'today':
        return { from_date: iso(today), to_date: iso(today) }
      case '7d': {
        const from = new Date(today)
        from.setDate(today.getDate() - 6)
        return { from_date: iso(from), to_date: iso(today) }
      }
      case '30d': {
        const from = new Date(today)
        from.setDate(today.getDate() - 29)
        return { from_date: iso(from), to_date: iso(today) }
      }
      case 'this_month': {
        const from = new Date(today.getFullYear(), today.getMonth(), 1)
        return { from_date: iso(from), to_date: iso(today) }
      }
      case 'this_year': {
        const from = new Date(today.getFullYear(), 0, 1)
        return { from_date: iso(from), to_date: iso(today) }
      }
      case 'all':
      default:
        return {}
    }
  }
  if (v.mode === 'year' && v.year) {
    return {
      from_date: `${v.year}-01-01`,
      to_date: `${v.year}-12-31`,
    }
  }
  if (v.mode === 'month' && v.year && v.month) {
    const last = new Date(v.year, v.month, 0).getDate()
    const mm = String(v.month).padStart(2, '0')
    return {
      from_date: `${v.year}-${mm}-01`,
      to_date: `${v.year}-${mm}-${String(last).padStart(2, '0')}`,
    }
  }
  if (v.mode === 'day' && v.year && v.month && v.day) {
    const mm = String(v.month).padStart(2, '0')
    const dd = String(v.day).padStart(2, '0')
    const iso2 = `${v.year}-${mm}-${dd}`
    return { from_date: iso2, to_date: iso2 }
  }
  if (v.mode === 'range') {
    return {
      from_date: v.from_date || undefined,
      to_date: v.to_date || undefined,
    }
  }
  return {}
}

function filterIsActive(v: FilterValue): boolean {
  if (v.brand_id !== 'all') return true
  if (v.mode === 'preset' && v.preset === '30d') return false
  return true
}

function summarize(v: FilterValue): string {
  const parts: string[] = []
  if (v.brand_id !== 'all') parts.push('brand')
  if (v.mode === 'preset' && v.preset) {
    const p = PRESETS.find((x) => x.key === v.preset)
    if (p) parts.push(p.label.toLowerCase())
  }
  if (v.mode === 'year' && v.year) parts.push(`${v.year}`)
  if (v.mode === 'month' && v.year && v.month) {
    parts.push(`${MONTHS[v.month - 1]} ${v.year}`)
  }
  if (v.mode === 'day' && v.year && v.month && v.day) {
    parts.push(`${v.year}-${String(v.month).padStart(2, '0')}-${String(v.day).padStart(2, '0')}`)
  }
  if (v.mode === 'range') {
    if (v.from_date || v.to_date) {
      parts.push(`${v.from_date ?? '∞'} → ${v.to_date ?? '∞'}`)
    }
  }
  if (parts.length === 0) return 'Default: last 30 days'
  return parts.join(' · ')
}

/** Default filter state — last 30 days, all brands. */
export function defaultFilterValue(): FilterValue {
  return {
    brand_id: 'all',
    mode: 'preset',
    preset: '30d',
  }
}

/** Parse + serialize FilterValue to/from URL query string so the
 * page state survives refresh and is shareable. Plug into
 * useSearchParams: `const [params, setParams] = useSearchParams();
 * const value = parseFilterFromParams(params); ...`
 */
export function parseFilterFromParams(p: URLSearchParams): FilterValue {
  const v: FilterValue = defaultFilterValue()
  const brand = p.get('brand_id')
  if (brand) v.brand_id = brand === 'all' ? 'all' : Number(brand) || 'all'
  const mode = p.get('mode') as FilterMode | null
  if (mode) v.mode = mode
  const preset = p.get('preset') as PresetKey | null
  if (preset) v.preset = preset
  const yr = p.get('year')
  const mo = p.get('month')
  const dy = p.get('day')
  if (yr) v.year = Number(yr)
  if (mo) v.month = Number(mo)
  if (dy) v.day = Number(dy)
  const fd = p.get('from_date')
  const td = p.get('to_date')
  if (fd) v.from_date = fd
  if (td) v.to_date = td
  return v
}

export function serializeFilterToParams(v: FilterValue): URLSearchParams {
  const p = new URLSearchParams()
  if (v.brand_id !== 'all') p.set('brand_id', String(v.brand_id))
  if (v.mode !== 'preset' || v.preset !== '30d') {
    p.set('mode', v.mode)
    if (v.preset) p.set('preset', v.preset)
    if (v.year) p.set('year', String(v.year))
    if (v.month) p.set('month', String(v.month))
    if (v.day) p.set('day', String(v.day))
    if (v.from_date) p.set('from_date', v.from_date)
    if (v.to_date) p.set('to_date', v.to_date)
  }
  return p
}

/** Convenience hook: keep FilterValue state in sync with URL params.
 * Returns [value, setValue]. */
export function useFilterFromURL(
  params: URLSearchParams,
  setParams: (next: URLSearchParams, opts?: { replace?: boolean }) => void,
): [FilterValue, (v: FilterValue) => void] {
  const value = useMemo(() => parseFilterFromParams(params), [params])
  useEffect(() => {
    // No-op — included so caller can react via deps if needed.
  }, [params])
  const setValue = (v: FilterValue) => {
    setParams(serializeFilterToParams(v), { replace: true })
  }
  return [value, setValue]
}
