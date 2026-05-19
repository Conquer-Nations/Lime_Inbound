import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { api } from '../api/client'
import DashboardTab from '../components/DashboardTab'
import InboundView from '../components/InboundView'
import ResolveExceptionModal from '../components/ResolveExceptionModal'
import WarehouseFloorPlan from '../components/WarehouseFloorPlan'
import type { DOListItem, ExceptionItem, LotMapItem } from '../types/api'
import BrandMark from '../components/BrandMark'

type Tab = 'dashboard' | 'dos' | 'lots' | 'exceptions' | 'inbound'

const TABS: { key: Tab; label: string }[] = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'dos', label: 'Delivery Orders' },
  { key: 'lots', label: 'Warehouse Map' },
  { key: 'exceptions', label: 'Exceptions' },
  { key: 'inbound', label: 'Inbound' },
]

export default function ManagerPage() {
  const { user } = useAuth()
  const [tab, setTab] = useState<Tab>('dashboard')
  const [dos, setDos] = useState<DOListItem[] | null>(null)
  const [lots, setLots] = useState<LotMapItem[] | null>(null)
  const [exceptions, setExceptions] = useState<ExceptionItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  function refresh(t: Tab = tab) {
    setError(null)
    if (t === 'dos') api.listDOs().then(setDos).catch((e) => setError(String(e)))
    if (t === 'lots') api.listLots().then(setLots).catch((e) => setError(String(e)))
    if (t === 'exceptions')
      api.listExceptions().then(setExceptions).catch((e) => setError(String(e)))
  }

  useEffect(() => {
    if (tab === 'dos' && dos === null) refresh('dos')
    else if (tab === 'lots' && lots === null) refresh('lots')
    else if (tab === 'exceptions' && exceptions === null) refresh('exceptions')
  }, [tab, dos, lots, exceptions])

  return (
    <ManagerChrome activeTab={tab} onTabChange={setTab}>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        {error && (
          <div
            role="alert"
            className="mb-5 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5 flex items-start gap-2"
          >
            <span className="font-semibold">Error:</span>
            <span>{error}</span>
          </div>
        )}

        {tab === 'dashboard' && (
          <DashboardTab
            onNavigate={(target) => {
              // 'data' was the old data explorer — fold into inbound for any back-link.
              setTab(target.tab === 'data' ? 'inbound' : target.tab)
            }}
          />
        )}
        {tab === 'dos' && <DOsTab data={dos} />}
        {tab === 'lots' && <LotsTab data={lots} />}
        {tab === 'inbound' && <InboundView />}
        {tab === 'exceptions' && (
          <ExceptionsTab
            data={exceptions}
            resolvedBy={user?.id ?? 'manager'}
            onResolved={() => {
              setExceptions(null)
              setDos(null)
              refresh('exceptions')
            }}
          />
        )}
      </main>
    </ManagerChrome>
  )
}

// ─── Chrome ────────────────────────────────────────────────────────────

function ManagerChrome({
  activeTab,
  onTabChange,
  children,
}: {
  activeTab: Tab
  onTabChange: (t: Tab) => void
  children: ReactNode
}) {
  const { user, signOut } = useAuth()
  const initial = user?.name?.[0]?.toUpperCase() ?? '?'

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 antialiased">
      <header
        className="text-white"
        style={{
          background:
            'linear-gradient(180deg, #0B1828 0%, #14233A 100%)',
        }}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BrandMark className="h-12 text-white" />
            <div className="leading-tight">
              <div className="text-base font-extrabold tracking-[0.16em]">
                CONQUER NATION
              </div>
              <div className="text-[10px] uppercase tracking-[0.28em] text-[#0093D0]">
                Manager Console
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 sm:gap-4">
            <div className="hidden md:flex items-center gap-2 text-sm text-white/90">
              <span
                className="w-8 h-8 rounded-full bg-white/10 ring-1 ring-white/20 flex items-center justify-center text-xs font-bold uppercase"
                aria-hidden
              >
                {initial}
              </span>
              <div className="leading-tight">
                <div className="text-sm">{user?.name}</div>
                <div className="text-[10.5px] uppercase tracking-wider text-white/60">
                  {user?.role}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={signOut}
              className="inline-flex items-center gap-2 rounded-full bg-white/8 hover:bg-white/15 border border-white/15 hover:border-white/30 px-4 py-1.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B1828]"
            >
              <LogOutIcon className="w-4 h-4" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
        <div
          className="h-px"
          style={{
            background:
              'linear-gradient(90deg, transparent, rgba(0,147,208,0.65) 30%, rgba(0,147,208,0.65) 70%, transparent)',
          }}
          aria-hidden
        />
      </header>

      <nav
        aria-label="Manager sections"
        className="bg-white border-b border-slate-200 shadow-sm"
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex overflow-x-auto">
          {TABS.map((t) => {
            const active = activeTab === t.key
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => onTabChange(t.key)}
                aria-current={active ? 'page' : undefined}
                className={`relative px-4 py-3 text-sm whitespace-nowrap transition focus:outline-none focus-visible:bg-slate-50 ${
                  active
                    ? 'text-[#0B1828] font-bold'
                    : 'text-slate-500 hover:text-[#0B1828] font-medium'
                }`}
              >
                {t.label}
                {active && (
                  <span
                    className="absolute bottom-0 left-3 right-3 h-[3px] bg-[#0093D0] rounded-t"
                    aria-hidden
                  />
                )}
              </button>
            )
          })}
        </div>
      </nav>

      {children}
    </div>
  )
}

// ─── Delivery Orders tab ───────────────────────────────────────────────

function DOsTab({ data }: { data: DOListItem[] | null }) {
  if (data === null) return <LoadingHint />
  if (data.length === 0)
    return (
      <EmptyHint
        title="No Delivery Orders yet"
        body="Submit a vendor shipment and a DO will be issued automatically."
      />
    )
  return (
    <div
      className="bg-white rounded-xl border border-slate-200 overflow-hidden"
      style={{
        boxShadow:
          '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
      }}
    >
      <div className="bg-slate-50 border-b border-slate-200 px-4 py-2.5">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#0093D0]">
          Delivery Orders
        </h3>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-white text-[10.5px] uppercase text-slate-500 border-b border-slate-200">
          <tr>
            <th className="text-left px-4 py-2 font-semibold tracking-wider">DO #</th>
            <th className="text-left px-4 py-2 font-semibold tracking-wider">WHPO/Load No</th>
            <th className="text-left px-4 py-2 font-semibold tracking-wider">Customer</th>
            <th className="text-left px-4 py-2 font-semibold tracking-wider">Status</th>
            <th className="text-right px-4 py-2 font-semibold tracking-wider">Containers</th>
            <th className="text-right px-4 py-2 font-semibold tracking-wider">Exceptions</th>
            <th className="text-left px-4 py-2 font-semibold tracking-wider">Expected</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.map((d) => (
            <tr
              key={d.do_id}
              className="hover:bg-[#0093D0]/5 transition cursor-pointer"
            >
              <td className="px-4 py-2 font-mono font-bold">
                <Link
                  to={`/manager/dos/${d.do_id}`}
                  className="text-[#1B4676] hover:text-[#0093D0]"
                >
                  {d.do_number}
                </Link>
              </td>
              <td className="px-4 py-2 font-mono text-slate-600">{d.whpo_number}</td>
              <td className="px-4 py-2 text-slate-700">{d.customer_name}</td>
              <td className="px-4 py-2">
                <StatusPill status={d.status} />
              </td>
              <td className="px-4 py-2 text-right text-slate-700 font-mono">
                {d.container_count}
              </td>
              <td className="px-4 py-2 text-right">
                {d.open_exceptions > 0 ? (
                  <span className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full text-xs font-semibold">
                    {d.open_exceptions}
                  </span>
                ) : (
                  <span className="text-slate-300">—</span>
                )}
              </td>
              <td className="px-4 py-2 text-slate-600 font-mono">
                {d.expected_arrival_date ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Warehouse map tab ─────────────────────────────────────────────────

function LotsTab({ data }: { data: LotMapItem[] | null }) {
  if (data === null) return <LoadingHint />
  return <WarehouseFloorPlan lots={data} />
}

// ─── Exceptions tab ────────────────────────────────────────────────────

function ExceptionsTab({
  data,
  resolvedBy,
  onResolved,
}: {
  data: ExceptionItem[] | null
  resolvedBy: string
  onResolved: () => void
}) {
  const [resolving, setResolving] = useState<ExceptionItem | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  if (data === null) return <LoadingHint />
  if (data.length === 0)
    return (
      <div
        className="bg-white rounded-xl border border-slate-200 p-8 text-center"
        style={{
          boxShadow:
            '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
        }}
      >
        <div className="w-12 h-12 mx-auto rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-600 mb-3">
          <CheckIcon className="w-6 h-6" />
        </div>
        <h3 className="text-lg font-bold text-[#1B4676]">No open exceptions</h3>
        <p className="text-sm text-slate-500 mt-1">
          Everything submitted is clean. New unknown-SKU events will appear here.
        </p>
      </div>
    )

  return (
    <>
      <div className="space-y-3">
        {data.map((e) => {
          const skuRaw = (e.payload?.sku_raw ?? e.payload?.sku) as string | undefined
          const customer = e.payload?.customer as string | undefined
          const doNumber = e.payload?.do_number as string | undefined
          const resolvable =
            e.kind === 'unknown_sku' || e.kind === 'missing_master_data'
          return (
            <div
              key={e.exception_id}
              className="bg-white rounded-xl border border-amber-200 p-4 sm:p-5"
              style={{ boxShadow: '0 1px 2px 0 rgba(15,23,42,0.04)' }}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="bg-amber-100 text-amber-900 px-2 py-0.5 rounded-full text-[10.5px] uppercase tracking-[0.15em] font-bold">
                  {e.kind.replace(/_/g, ' ')}
                </span>
                <span className="text-xs text-slate-500 font-mono">
                  #{e.exception_id}
                </span>
                {skuRaw && (
                  <span className="font-mono text-sm text-[#1B4676] font-bold">
                    {skuRaw}
                  </span>
                )}
                {customer && (
                  <span className="text-sm text-slate-600">· {customer}</span>
                )}
                {doNumber && (
                  <span className="font-mono text-sm text-slate-500">
                    · {doNumber}
                  </span>
                )}
                <div className="flex-1" />
                <span className="text-xs text-slate-400">
                  {new Date(e.opened_at).toLocaleString()}
                </span>
              </div>
              {resolvable && (
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setResolving(e)}
                    className="inline-flex items-center gap-2 bg-[#0093D0] hover:bg-[#00A8E8] text-white text-sm font-semibold px-5 py-2 rounded-full transition shadow-[0_6px_18px_-4px_rgba(0,147,208,0.4)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
                  >
                    <span>Resolve</span>
                    <ArrowRightIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {resolving && (
        <ResolveExceptionModal
          exception={resolving}
          resolvedBy={resolvedBy}
          onClose={() => setResolving(null)}
          onResolved={(result) => {
            setResolving(null)
            setToast(
              result.do_status_changed
                ? `Resolved · DO is now ${result.do_status?.replace(/_/g, ' ')}`
                : 'Resolved'
            )
            setTimeout(() => setToast(null), 3500)
            onResolved()
          }}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 bg-emerald-700 text-white px-4 py-2 rounded-md shadow-lg z-50 flex items-center gap-2">
          <CheckIcon className="w-4 h-4" />
          <span>{toast}</span>
        </div>
      )}
    </>
  )
}

// ─── Small helpers ─────────────────────────────────────────────────────

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    ready: 'bg-emerald-100 text-emerald-800',
    pending_master_data: 'bg-amber-100 text-amber-800',
    invoiced: 'bg-[#0093D0]/15 text-[#1B4676]',
  }
  const color = map[status] ?? 'bg-slate-100 text-slate-700'
  return (
    <span
      className={`${color} px-2 py-0.5 rounded-full text-[10.5px] uppercase tracking-[0.12em] font-bold`}
    >
      {status.replace(/_/g, ' ')}
    </span>
  )
}

function LoadingHint() {
  return (
    <div className="bg-white rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-500 flex items-center gap-2">
      <span
        className="inline-block w-2 h-2 rounded-full bg-[#0093D0] animate-pulse"
        aria-hidden
      />
      <span>Loading…</span>
    </div>
  )
}

function EmptyHint({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
      <h3 className="text-lg font-bold text-[#1B4676]">{title}</h3>
      <p className="text-sm text-slate-500 mt-1">{body}</p>
    </div>
  )
}

// ─── Brand mark ────────────────────────────────────────────────────────


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

function ArrowRightIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </Icon>
  )
}

function LogOutIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" x2="9" y1="12" y2="12" />
    </Icon>
  )
}
