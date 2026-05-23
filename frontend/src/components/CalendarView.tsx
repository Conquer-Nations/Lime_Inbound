import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { CalendarResponse, CalendarDay } from '../api/client'

/**
 * Reusable activity calendar with drilldown.
 *
 * The caller provides the data-fetch function (vendor's own activity vs.
 * manager-wide). We render days as expandable cards: header shows the
 * date + inbound/outbound counts; clicking expands the container list.
 */
export function CalendarView({
  fetcher,
  defaultDays = 14,
  showWindowSelector = false,
  emptyHint,
  drilldown = false,
}: {
  fetcher: (days: number) => Promise<CalendarResponse>
  defaultDays?: number
  showWindowSelector?: boolean
  emptyHint?: string
  /** When true, container_no on each row becomes a Link into the manager
   * ERP drilldown. Vendors pass false so the vendor portal stays a flat
   * read-only view. */
  drilldown?: boolean
}) {
  const [days, setDays] = useState(defaultDays)
  const [data, setData] = useState<CalendarResponse | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    setError(null)
    fetcher(days)
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.detail || e))
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days])

  const totalIn = data?.days.reduce((n, d) => n + d.inbound_containers.length, 0) ?? 0
  const totalOut = data?.days.reduce((n, d) => n + d.outbound_containers.length, 0) ?? 0
  const visibleDays = data?.days ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-slate-600">
          {data
            ? `${new Date(data.window_start).toLocaleDateString()} → ${new Date(
                data.window_end,
              ).toLocaleDateString()}`
            : '—'}
          {' · '}
          <span className="font-semibold text-[#0093D0]">{totalIn} inbound</span>
          {' · '}
          <span className="font-semibold text-[#1B4676]">{totalOut} outbound</span>
        </div>
        {showWindowSelector && (
          <div className="flex items-center gap-1.5">
            {[1, 7, 14, 30].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setDays(n)}
                className={`text-xs font-semibold px-3 py-1.5 rounded-md transition ${
                  days === n
                    ? 'bg-[#1B4676] text-white'
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                }`}
              >
                {n === 1 ? 'Today' : `${n} days`}
              </button>
            ))}
          </div>
        )}
      </div>

      {busy && (
        <div className="text-sm text-slate-500 italic">Loading calendar…</div>
      )}
      {error && (
        <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5">
          {error}
        </div>
      )}

      {!busy && !error && (
        <div className="space-y-3">
          {visibleDays.map((day) => (
            <DayCard key={day.date} day={day} drilldown={drilldown} />
          ))}
          {visibleDays.every(
            (d) => d.inbound_containers.length === 0 && d.outbound_containers.length === 0,
          ) && (
            <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
              {emptyHint || 'No activity in this window.'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DayCard({ day, drilldown }: { day: CalendarDay; drilldown: boolean }) {
  const [open, setOpen] = useState(false)
  const inCount = day.inbound_containers.length
  const outCount = day.outbound_containers.length
  const isEmpty = inCount === 0 && outCount === 0
  const dt = new Date(day.date + 'T00:00:00')
  const weekday = dt.toLocaleDateString(undefined, { weekday: 'short' })
  const dayMonth = dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const isToday = new Date().toISOString().slice(0, 10) === day.date

  return (
    <div
      className={`rounded-xl border bg-white overflow-hidden ${
        isToday ? 'border-[#1B4676]/60 ring-1 ring-[#1B4676]/30' : 'border-slate-200'
      } ${isEmpty ? 'opacity-60' : ''}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={isEmpty}
        className="w-full flex items-center gap-4 px-4 py-3 text-left hover:bg-slate-50 disabled:hover:bg-transparent disabled:cursor-default transition"
      >
        <div className="text-center min-w-[3.5rem]">
          <div className="text-[10.5px] uppercase tracking-wider text-slate-500 font-semibold">
            {weekday}
          </div>
          <div className="text-base font-bold text-[#1B4676]">{dayMonth}</div>
        </div>
        <div className="flex-1 flex items-center gap-3">
          <Pill count={inCount} label="inbound" color="cyan" />
          <Pill count={outCount} label="outbound" color="navy" />
          {isToday && (
            <span className="text-[10.5px] uppercase tracking-wider font-bold text-[#1B4676] bg-[#FED641] px-2 py-0.5 rounded">
              Today
            </span>
          )}
        </div>
        {!isEmpty && (
          <span
            aria-hidden
            className="text-slate-400 text-sm transition-transform"
            style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
          >
            ▸
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-slate-100 px-4 py-3 space-y-3">
          {inCount > 0 && (
            <ContainerList
              title="Inbound (arriving)"
              accent="cyan"
              rows={day.inbound_containers}
              drilldown={drilldown}
              direction="inbound"
            />
          )}
          {outCount > 0 && (
            <ContainerList
              title="Outbound (loading)"
              accent="navy"
              rows={day.outbound_containers}
              drilldown={drilldown}
              direction="outbound"
            />
          )}
        </div>
      )}
    </div>
  )
}

function Pill({
  count,
  label,
  color,
}: {
  count: number
  label: string
  color: 'cyan' | 'navy'
}) {
  const accent = color === 'cyan' ? '#0093D0' : '#1B4676'
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs"
      style={{ color: accent }}
    >
      <span
        className="inline-grid place-items-center w-6 h-6 rounded-full text-[11px] font-bold text-white"
        style={{ background: count > 0 ? accent : '#cbd5e1' }}
      >
        {count}
      </span>
      <span className="uppercase tracking-wider font-semibold text-slate-600">
        {label}
      </span>
    </span>
  )
}

function ContainerList({
  title,
  rows,
  accent,
  drilldown,
  direction,
}: {
  title: string
  rows: import('../api/client').CalendarContainerRow[]
  accent: 'cyan' | 'navy'
  drilldown: boolean
  direction: 'inbound' | 'outbound'
}) {
  const accentColor = accent === 'cyan' ? '#0093D0' : '#1B4676'
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wider font-bold text-slate-500 mb-1.5">
        {title}
      </div>
      <ul className="space-y-1.5 text-sm">
        {rows.map((r, i) => {
          const containerLabel = (
            <span className="font-mono font-bold" style={{ color: accentColor }}>
              {r.container_no}
            </span>
          )
          const refLabel = (
            <span className="text-xs text-slate-500">{r.ref_no}</span>
          )
          return (
            <li
              key={`${r.container_no}|${r.ref_no}|${i}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 rounded-md border border-slate-200 bg-slate-50/40"
            >
              {drilldown && direction === 'inbound' ? (
                <Link
                  to={`/manager/containers/${encodeURIComponent(r.container_no)}`}
                  className="hover:opacity-70 underline decoration-dotted"
                >
                  {containerLabel}
                </Link>
              ) : (
                containerLabel
              )}
              <span className="text-xs text-slate-600">{r.customer}</span>
              {drilldown && direction === 'outbound' ? (
                <Link
                  to={`/manager/outbound-orders/${encodeURIComponent(r.ref_no)}`}
                  className="hover:opacity-70 underline decoration-dotted"
                >
                  {refLabel}
                </Link>
              ) : (
                refLabel
              )}
              <span
                className="ml-auto text-[10.5px] uppercase tracking-wider font-bold px-2 py-0.5 rounded"
                style={{
                  background: `${accentColor}1A`,
                  color: accentColor,
                }}
              >
                {r.current_label}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
