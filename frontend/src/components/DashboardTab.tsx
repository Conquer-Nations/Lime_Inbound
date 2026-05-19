import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { DashboardResponse } from '../types/api'

const REFRESH_MS = 10_000

export type DashboardTarget =
  | { tab: 'dos' }
  | { tab: 'lots' }
  | { tab: 'exceptions' }
  | { tab: 'data'; table?: string }

/**
 * Manager landing dashboard. KPI tiles, activity feed, quick-action tiles.
 * Auto-refreshes every 10s so operator scans land live.
 */
export default function DashboardTab({
  onNavigate,
}: {
  onNavigate: (target: DashboardTarget) => void
}) {
  const [data, setData] = useState<DashboardResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  useEffect(() => {
    let alive = true
    function load() {
      api
        .getDashboard()
        .then((d) => {
          if (alive) {
            setData(d)
            setLastUpdated(new Date())
            setError(null)
          }
        })
        .catch((e) => alive && setError(String(e)))
    }
    load()
    const id = setInterval(load, REFRESH_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  if (error) {
    return (
      <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5 flex items-start gap-2">
        <span className="font-semibold">Error:</span>
        <span>{error}</span>
      </div>
    )
  }
  if (!data)
    return (
      <div className="bg-white rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-500 flex items-center gap-2">
        <span
          className="inline-block w-2 h-2 rounded-full bg-[#0093D0] animate-pulse"
          aria-hidden
        />
        <span>Loading dashboard…</span>
      </div>
    )

  const k = data.kpis

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <div className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-[#0093D0]">
            Operations
          </div>
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#1B4676] mt-0.5">
            {data.today}
          </h2>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          {lastUpdated && (
            <span>Updated {lastUpdated.toLocaleTimeString()}</span>
          )}
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse"
              aria-hidden
            />
            <span>auto-refresh 10s</span>
          </span>
        </div>
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi
          label="Expected today"
          value={k.containers_expected_today}
          unit="containers"
          accent="blue"
          onClick={() => onNavigate({ tab: 'data', table: 'containers' })}
        />
        <Kpi
          label="Receiving now"
          value={k.receipts_in_progress}
          unit="in progress"
          accent={k.receipts_in_progress > 0 ? 'amber' : 'slate'}
          onClick={() => onNavigate({ tab: 'data', table: 'receipts' })}
        />
        <Kpi
          label="Finished today"
          value={k.containers_finished_today}
          unit="containers"
          accent="green"
          onClick={() => onNavigate({ tab: 'data', table: 'containers' })}
        />
        <Kpi
          label="Open exceptions"
          value={k.open_exceptions}
          unit="need review"
          accent={k.open_exceptions > 0 ? 'red' : 'slate'}
          onClick={() => onNavigate({ tab: 'exceptions' })}
        />
        <Kpi
          label="Pallets on floor"
          value={k.total_pallets_stored}
          unit={`+${k.pallets_received_today} today`}
          accent="slate"
          onClick={() => onNavigate({ tab: 'data', table: 'pallets' })}
        />
        <Kpi
          label="Lot occupancy"
          value={`${k.lot_occupancy_pct}%`}
          unit={`${k.lots_total - k.lots_blocked} active · ${k.lots_blocked} blocked`}
          accent={
            k.lot_occupancy_pct >= 85
              ? 'red'
              : k.lot_occupancy_pct >= 60
              ? 'amber'
              : 'green'
          }
          onClick={() => onNavigate({ tab: 'lots' })}
        />
      </div>

      {/* Activity feed + quick actions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div
          className="lg:col-span-2 bg-white rounded-xl border border-slate-200 overflow-hidden"
          style={{
            boxShadow:
              '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
          }}
        >
          <header className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-baseline justify-between">
            <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#0093D0]">
              Recent activity
            </h3>
            <span className="text-xs text-slate-500 font-mono">
              {data.activity.length} events
            </span>
          </header>
          {data.activity.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400 italic">
              No activity yet.
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.activity.map((a) => {
                const href =
                  a.ref_type === 'do' && a.ref_id != null
                    ? `/manager/dos/${a.ref_id}`
                    : null
                const exceptionDrill = a.ref_type === 'exception'

                const content = (
                  <div className="flex items-start gap-3">
                    <ActivityIcon kind={a.kind} />
                    <div className="flex-1 text-sm">
                      <div className="text-slate-800">
                        {a.message ?? <em className="text-slate-400">{a.kind}</em>}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {a.actor && <>by {a.actor} · </>}
                        {new Date(a.t).toLocaleString()}
                      </div>
                    </div>
                    {(href || exceptionDrill) && (
                      <span className="text-slate-300 self-center pr-1" aria-hidden>
                        <ChevronRightIcon className="w-4 h-4" />
                      </span>
                    )}
                  </div>
                )

                if (href) {
                  return (
                    <li key={a.id}>
                      <Link
                        to={href}
                        className="block px-4 py-3 hover:bg-[#0093D0]/5 transition"
                      >
                        {content}
                      </Link>
                    </li>
                  )
                }
                if (exceptionDrill) {
                  return (
                    <li key={a.id}>
                      <button
                        type="button"
                        onClick={() => onNavigate({ tab: 'exceptions' })}
                        className="w-full text-left px-4 py-3 hover:bg-[#0093D0]/5 transition"
                      >
                        {content}
                      </button>
                    </li>
                  )
                }
                return (
                  <li key={a.id} className="px-4 py-3">
                    {content}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div
          className="bg-white rounded-xl border border-slate-200 p-4"
          style={{
            boxShadow:
              '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
          }}
        >
          <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#0093D0] mb-3">
            Quick actions
          </h3>
          <div className="space-y-2">
            <QuickAction
              icon={<PackageIcon className="w-5 h-5" />}
              label="Delivery Orders"
              sub="Browse + drill into DOs"
              onClick={() => onNavigate({ tab: 'dos' })}
            />
            <QuickAction
              icon={<MapIcon className="w-5 h-5" />}
              label="Warehouse Map"
              sub="Floor-by-floor lot occupancy"
              onClick={() => onNavigate({ tab: 'lots' })}
            />
            <QuickAction
              icon={<AlertTriangleIcon className="w-5 h-5" />}
              label="Exceptions"
              sub={
                k.open_exceptions > 0
                  ? `${k.open_exceptions} need review`
                  : 'all clear'
              }
              onClick={() => onNavigate({ tab: 'exceptions' })}
              accent={k.open_exceptions > 0 ? 'red' : 'slate'}
            />
            <QuickAction
              icon={<DatabaseIcon className="w-5 h-5" />}
              label="Inbound data"
              sub="Vendor table + CSV export"
              onClick={() => onNavigate({ tab: 'data' })}
            />
            <Link
              to="/vendor-intake"
              target="_blank"
              rel="noopener noreferrer"
              className="block bg-slate-50 hover:bg-[#0093D0]/5 rounded-lg px-3 py-2.5 border border-slate-200 hover:border-[#0093D0]/30 transition group"
            >
              <div className="flex items-center gap-3">
                <span
                  className="w-9 h-9 rounded-md bg-[#0093D0]/10 text-[#0093D0] flex items-center justify-center"
                  aria-hidden
                >
                  <ExternalLinkIcon className="w-5 h-5" />
                </span>
                <div className="flex-1">
                  <div className="text-sm font-semibold text-[#1B4676]">
                    Open Vendor Form
                  </div>
                  <div className="text-xs text-slate-500">Public submission link</div>
                </div>
              </div>
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Sub-components ────────────────────────────────────────────────────

type Accent = 'blue' | 'green' | 'amber' | 'red' | 'slate'

function Kpi({
  label,
  value,
  unit,
  accent = 'slate',
  onClick,
}: {
  label: string
  value: string | number
  unit?: string
  accent?: Accent
  onClick?: () => void
}) {
  const valueColor = {
    blue: 'text-[#0093D0]',
    green: 'text-emerald-700',
    amber: 'text-amber-700',
    red: 'text-red-700',
    slate: 'text-[#1B4676]',
  }[accent]
  const dotColor = {
    blue: 'bg-[#0093D0]',
    green: 'bg-emerald-500',
    amber: 'bg-amber-500',
    red: 'bg-red-500',
    slate: 'bg-slate-300',
  }[accent]
  const interactive = onClick !== undefined
  const baseClasses =
    'bg-white rounded-xl border border-slate-200 p-3.5 text-left w-full transition'
  const interactiveClasses = interactive
    ? 'hover:border-[#0093D0]/40 hover:shadow-md cursor-pointer group'
    : ''
  const inner = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="text-[10px] uppercase text-slate-500 font-bold tracking-[0.15em] flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} aria-hidden />
          <span>{label}</span>
        </div>
        {interactive && (
          <ArrowUpRightIcon className="w-3.5 h-3.5 text-slate-300 group-hover:text-[#0093D0] transition" />
        )}
      </div>
      <div className={`text-2xl font-bold mt-1.5 tabular-nums ${valueColor}`}>
        {value}
      </div>
      {unit && <div className="text-xs text-slate-500 mt-0.5">{unit}</div>}
    </>
  )

  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={`${baseClasses} ${interactiveClasses}`}
      style={{ boxShadow: '0 1px 2px 0 rgba(15,23,42,0.04)' }}
    >
      {inner}
    </button>
  ) : (
    <div
      className={baseClasses}
      style={{ boxShadow: '0 1px 2px 0 rgba(15,23,42,0.04)' }}
    >
      {inner}
    </div>
  )
}

function QuickAction({
  icon,
  label,
  sub,
  onClick,
  accent = 'slate',
}: {
  icon: ReactNode
  label: string
  sub: string
  onClick: () => void
  accent?: 'slate' | 'red'
}) {
  const colors =
    accent === 'red'
      ? {
          bg: 'bg-red-50 hover:bg-red-100',
          border: 'border-red-200 hover:border-red-300',
          iconBg: 'bg-red-100 text-red-600',
          label: 'text-red-900',
        }
      : {
          bg: 'bg-slate-50 hover:bg-[#0093D0]/5',
          border: 'border-slate-200 hover:border-[#0093D0]/30',
          iconBg: 'bg-[#0093D0]/10 text-[#0093D0]',
          label: 'text-[#1B4676]',
        }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left rounded-lg px-3 py-2.5 border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2 ${colors.bg} ${colors.border}`}
    >
      <div className="flex items-center gap-3">
        <span
          className={`w-9 h-9 rounded-md flex items-center justify-center ${colors.iconBg}`}
          aria-hidden
        >
          {icon}
        </span>
        <div className="flex-1">
          <div className={`text-sm font-semibold ${colors.label}`}>{label}</div>
          <div className="text-xs text-slate-500">{sub}</div>
        </div>
      </div>
    </button>
  )
}

function ActivityIcon({ kind }: { kind: string }) {
  const config: Record<
    string,
    { icon: ReactNode; bg: string; fg: string }
  > = {
    container_started: {
      icon: <PackageIcon className="w-3.5 h-3.5" />,
      bg: 'bg-[#0093D0]/10',
      fg: 'text-[#0093D0]',
    },
    container_finished: {
      icon: <CheckIcon className="w-3.5 h-3.5" />,
      bg: 'bg-emerald-100',
      fg: 'text-emerald-700',
    },
    whpo_submitted: {
      icon: <InboxArrowDownIcon className="w-3.5 h-3.5" />,
      bg: 'bg-slate-100',
      fg: 'text-slate-600',
    },
    whpo_updated: {
      icon: <EditIcon className="w-3.5 h-3.5" />,
      bg: 'bg-amber-100',
      fg: 'text-amber-700',
    },
    driver_info_submitted: {
      icon: <TruckIcon className="w-3.5 h-3.5" />,
      bg: 'bg-[#0093D0]/10',
      fg: 'text-[#0093D0]',
    },
    exception_resolved: {
      icon: <CheckIcon className="w-3.5 h-3.5" />,
      bg: 'bg-emerald-100',
      fg: 'text-emerald-700',
    },
    exception_opened: {
      icon: <AlertTriangleIcon className="w-3.5 h-3.5" />,
      bg: 'bg-amber-100',
      fg: 'text-amber-700',
    },
  }
  const { icon, bg, fg } = config[kind] ?? {
    icon: <DotIcon className="w-3.5 h-3.5" />,
    bg: 'bg-slate-100',
    fg: 'text-slate-500',
  }
  return (
    <span
      className={`flex-none inline-flex items-center justify-center w-7 h-7 rounded-full ${bg} ${fg}`}
      aria-hidden
    >
      {icon}
    </span>
  )
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

function CheckIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <polyline points="20 6 9 17 4 12" />
    </Icon>
  )
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="m9 18 6-6-6-6" />
    </Icon>
  )
}

function PackageIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="m7.5 4.27 9 5.15" />
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="M3.3 7 12 12l8.7-5" />
      <path d="M12 22V12" />
    </Icon>
  )
}

function MapIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21" />
      <line x1="9" x2="9" y1="3" y2="18" />
      <line x1="15" x2="15" y1="6" y2="21" />
    </Icon>
  )
}

function AlertTriangleIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Icon>
  )
}

function DatabaseIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5V19A9 3 0 0 0 21 19V5" />
      <path d="M3 12A9 3 0 0 0 21 12" />
    </Icon>
  )
}

function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </Icon>
  )
}

function InboxArrowDownIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <polyline points="22 13 16 13 14 16 10 16 8 13 2 13" />
      <path d="M5.45 5.11 2 13v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-7.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </Icon>
  )
}

function TruckIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
      <path d="M15 18H9" />
      <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
      <circle cx="17" cy="18" r="2" />
      <circle cx="7" cy="18" r="2" />
    </Icon>
  )
}

function ArrowUpRightIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M7 7h10v10" />
      <path d="M7 17 17 7" />
    </Icon>
  )
}

function DotIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="1" />
    </Icon>
  )
}

function EditIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </Icon>
  )
}
