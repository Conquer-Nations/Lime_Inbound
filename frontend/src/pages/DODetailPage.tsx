import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import type { DODetail, ContainerInDO } from '../types/api'

export default function DODetailPage() {
  const { do_id } = useParams<{ do_id: string }>()
  const { user, signOut } = useAuth()
  const nav = useNavigate()
  const [detail, setDetail] = useState<DODetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!do_id) return
    setError(null)
    api
      .getDODetail(parseInt(do_id, 10))
      .then(setDetail)
      .catch((e) => setError(String(e)))
  }, [do_id])

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 antialiased">
      <DetailChrome
        breadcrumb={[
          { label: 'Manager Console', to: '/manager' },
          { label: 'Delivery Order' },
        ]}
        user={user}
        onSignOut={() => {
          signOut()
          nav('/login')
        }}
      />
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        <Link
          to="/manager"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[#1B4676] hover:text-[#0093D0] transition focus:outline-none focus-visible:underline"
        >
          <span aria-hidden>←</span>
          <span>Back to all DOs</span>
        </Link>

        {error && (
          <div
            role="alert"
            className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5 flex items-start gap-2"
          >
            <span className="font-semibold">Error:</span>
            <span>{error}</span>
          </div>
        )}

        {!detail ? <LoadingCard /> : <Detail detail={detail} />}
      </main>
    </div>
  )
}

function Detail({ detail }: { detail: DODetail }) {
  return (
    <div className="mt-5 space-y-5">
      {/* Header card */}
      <div
        className="bg-white rounded-xl border border-slate-200 p-6"
        style={{
          boxShadow:
            '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
        }}
      >
        <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0] mb-1">
          Delivery Order
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-3xl font-bold font-mono tracking-tight text-[#1B4676]">
            {detail.do_number}
          </h1>
          <StatusPill status={detail.status} />
          {detail.open_exceptions > 0 && (
            <span className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full text-[10.5px] uppercase tracking-[0.12em] font-bold">
              {detail.open_exceptions} open exception
              {detail.open_exceptions === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <dl className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <Field k="WHPO/Load No" v={detail.whpo_number} mono />
          <Field k="Customer" v={detail.customer_name} />
          <Field k="Expected" v={detail.expected_arrival_date ?? '—'} />
          <Field k="Issued" v={new Date(detail.issued_at).toLocaleString()} />
        </dl>
      </div>

      {/* Containers */}
      {detail.containers.map((c) => (
        <ContainerCard key={c.container_id} c={c} />
      ))}
    </div>
  )
}

function ContainerCard({ c }: { c: ContainerInDO }) {
  const pct =
    c.total_expected === 0
      ? 0
      : Math.round((c.total_received / c.total_expected) * 100)
  return (
    <div
      className="bg-white rounded-xl border border-slate-200 p-6"
      style={{
        boxShadow:
          '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
      }}
    >
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-xl font-bold font-mono tracking-wider text-[#1B4676]">
          {c.container_no}
        </h2>
        <StatusPill status={c.status} />
        <div className="flex-1" />
        <span className="text-sm font-mono text-slate-700">
          <span className="font-bold text-[#1B4676]">{c.total_received}</span>
          {' / '}
          {c.total_expected} items{' '}
          <span className="text-slate-400">({pct}%)</span>
        </span>
      </div>

      {c.total_expected > 0 && (
        <div className="mt-3 w-full bg-slate-100 rounded-full h-2 overflow-hidden">
          <div
            className="bg-[#0093D0] h-2 transition-all duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {/* Packaging + space */}
      <div className="mt-4 bg-slate-50 rounded-md border border-slate-200 px-4 py-3">
        <div className="flex items-baseline justify-between flex-wrap gap-3">
          <div className="text-[10.5px] uppercase text-[#0093D0] font-bold tracking-[0.18em]">
            Packaging &amp; footprint
          </div>
          <div className="font-mono text-sm">
            <span className="font-bold text-base text-[#1B4676]">
              {c.total_sqft_needed.toLocaleString()}
            </span>
            <span className="text-slate-500"> sqft total</span>
            <span className="mx-2 text-slate-300">·</span>
            <span className="text-slate-700">
              ≈ {c.lots_equivalent} lot
              {c.lots_equivalent === 1 ? '' : 's'}
            </span>
          </div>
        </div>
        <div className="text-xs text-slate-600 mt-1.5">
          {c.on_pallet === true && (
            <>
              On pallets{' '}
              {c.pallet_length_in && c.pallet_width_in && (
                <>
                  ·{' '}
                  <span className="font-mono">
                    {c.pallet_length_in}″ × {c.pallet_width_in}″
                  </span>{' '}
                  pallet
                </>
              )}
            </>
          )}
          {c.on_pallet === false && (
            <>
              Loose items{' '}
              {c.item_length_in && c.item_width_in && (
                <>
                  ·{' '}
                  <span className="font-mono">
                    {c.item_length_in}″ × {c.item_width_in}″
                    {c.item_height_in ? ` × ${c.item_height_in}″` : ''}
                  </span>
                </>
              )}
            </>
          )}
          {c.on_pallet === null && (
            <span className="text-amber-700 font-medium">
              ⚠ Vendor didn't declare packaging — using SKU master defaults
            </span>
          )}
        </div>
      </div>

      {/* Lines */}
      <div className="mt-5">
        <div className="text-[10.5px] uppercase text-[#0093D0] font-bold tracking-[0.18em] mb-2">
          Manifest
        </div>
        <div className="rounded-md border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[10.5px] uppercase text-slate-500 border-b border-slate-200">
              <tr>
                <th className="text-left px-3 py-2 font-semibold tracking-wider">
                  SKU
                </th>
                <th className="text-right px-3 py-2 font-semibold tracking-wider">
                  Qty
                </th>
                <th className="text-right px-3 py-2 font-semibold tracking-wider">
                  Sqft/unit
                </th>
                <th className="text-right px-3 py-2 font-semibold tracking-wider">
                  Total sqft
                </th>
                <th className="text-center px-3 py-2 font-semibold tracking-wider">
                  Source
                </th>
                <th className="text-center px-3 py-2 font-semibold tracking-wider">
                  Resolved
                </th>
              </tr>
            </thead>
            <tbody className="font-mono text-sm divide-y divide-slate-100">
              {c.lines.map((l) => (
                <tr key={l.line_id}>
                  <td className="px-3 py-2 text-[#1B4676]">{l.sku}</td>
                  <td className="px-3 py-2 text-right text-slate-700">{l.qty}</td>
                  <td className="px-3 py-2 text-right text-slate-700">
                    {l.computed_sqft_per_unit.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-700">
                    {l.computed_total_sqft.toFixed(0)}
                  </td>
                  <td className="px-3 py-2 text-center text-xs text-slate-500">
                    {l.space_basis.replace(/_/g, ' ')}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {l.sku_resolved ? (
                      <CheckIcon className="w-4 h-4 text-emerald-600 inline" />
                    ) : (
                      <span className="text-amber-700 text-xs font-bold uppercase tracking-wider">
                        Pending
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Assignments */}
      <div className="mt-5">
        <div className="text-[10.5px] uppercase text-[#0093D0] font-bold tracking-[0.18em] mb-2">
          Lot assignments
        </div>
        {c.assignments.length === 0 ? (
          <p className="text-sm text-slate-500 italic px-3 py-2 bg-slate-50 rounded-md border border-slate-200">
            No lot assignments yet (lookup pending).
          </p>
        ) : (
          <div className="rounded-md border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[10.5px] uppercase text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold tracking-wider">
                    #
                  </th>
                  <th className="text-left px-3 py-2 font-semibold tracking-wider">
                    Lot
                  </th>
                  <th className="text-left px-3 py-2 font-semibold tracking-wider">
                    Floor
                  </th>
                  <th className="text-left px-3 py-2 font-semibold tracking-wider">
                    SKU
                  </th>
                  <th className="text-right px-3 py-2 font-semibold tracking-wider">
                    Planned
                  </th>
                  <th className="text-right px-3 py-2 font-semibold tracking-wider">
                    Actual
                  </th>
                  <th className="text-left px-3 py-2 font-semibold tracking-wider">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="text-sm divide-y divide-slate-100">
                {c.assignments.map((a) => (
                  <tr key={a.assignment_order}>
                    <td className="px-3 py-2 font-mono text-slate-500">
                      {a.assignment_order}
                    </td>
                    <td className="px-3 py-2 font-mono text-[#1B4676] font-bold">
                      {a.lot_code}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{a.floor_name}</td>
                    <td className="px-3 py-2 font-mono text-slate-700">
                      {a.sku}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-slate-700">
                      {a.planned_pallets}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-slate-700">
                      {a.actual_pallets}
                    </td>
                    <td className="px-3 py-2">
                      <StatusPill status={a.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function Field({
  k,
  v,
  mono = false,
}: {
  k: string
  v: string
  mono?: boolean
}) {
  return (
    <div>
      <dt className="text-[10.5px] uppercase text-slate-500 font-bold tracking-[0.15em]">
        {k}
      </dt>
      <dd className={`mt-0.5 text-[#1B4676] ${mono ? 'font-mono' : ''}`}>
        {v}
      </dd>
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    ready: 'bg-emerald-100 text-emerald-800',
    received: 'bg-emerald-100 text-emerald-800',
    completed: 'bg-emerald-100 text-emerald-800',
    full: 'bg-emerald-100 text-emerald-800',
    pending_master_data: 'bg-amber-100 text-amber-800',
    planned: 'bg-amber-100 text-amber-800',
    receiving: 'bg-[#0093D0]/15 text-[#1B4676]',
    active: 'bg-[#0093D0]/15 text-[#1B4676]',
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

function LoadingCard() {
  return (
    <div className="mt-5 bg-white rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-500 flex items-center gap-2">
      <span
        className="inline-block w-2 h-2 rounded-full bg-[#0093D0] animate-pulse"
        aria-hidden
      />
      <span>Loading…</span>
    </div>
  )
}

// ─── Shared detail-page chrome ─────────────────────────────────────────

function DetailChrome({
  breadcrumb,
  user,
  onSignOut,
}: {
  breadcrumb: { label: string; to?: string }[]
  user: { name: string; role: string } | null
  onSignOut: () => void
}) {
  const initial = user?.name?.[0]?.toUpperCase() ?? '?'
  return (
    <>
      <header
        className="text-white"
        style={{
          background:
            'linear-gradient(180deg, #0B1828 0%, #14233A 100%)',
        }}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <Link to="/manager" className="flex items-center gap-3 group">
            <BrandMark className="w-9 h-9 text-white" />
            <div className="leading-tight">
              <div className="text-base font-extrabold tracking-[0.16em] group-hover:text-white/90 transition">
                CONQUER NATION
              </div>
              <div className="text-[10px] uppercase tracking-[0.28em] text-[#0093D0]">
                Manager Console
              </div>
            </div>
          </Link>

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
              onClick={onSignOut}
              className="inline-flex items-center gap-2 rounded-full bg-white/8 hover:bg-white/15 border border-white/15 hover:border-white/30 px-4 py-1.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B1828]"
            >
              <LogOutIcon className="w-4 h-4" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      <nav aria-label="Breadcrumb" className="bg-white border-b border-slate-200">
        <ol className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex items-center gap-2 text-sm text-slate-500">
          {breadcrumb.map((b, i) => {
            const last = i === breadcrumb.length - 1
            return (
              <li key={i} className="flex items-center gap-2">
                {b.to && !last ? (
                  <Link to={b.to} className="hover:text-[#1B4676] transition">
                    {b.label}
                  </Link>
                ) : (
                  <span
                    aria-current={last ? 'page' : undefined}
                    className={
                      last ? 'text-[#1B4676] font-semibold' : 'text-slate-500'
                    }
                  >
                    {b.label}
                  </span>
                )}
                {!last && (
                  <ChevronRightIcon className="w-4 h-4 text-slate-300" />
                )}
              </li>
            )
          })}
        </ol>
      </nav>
    </>
  )
}

// ─── Brand mark ────────────────────────────────────────────────────────

function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="3.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M30 16c-9 0-16 7-16 16s7 16 16 16" />
      <path d="M30 22c-6 0-10 5-10 10s4 10 10 10" />
      <path d="M34 16c9 0 16 7 16 16s-7 16-16 16" />
      <path d="M34 22c6 0 10 5 10 10s-4 10-10 10" />
    </svg>
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

function LogOutIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" x2="9" y1="12" y2="12" />
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
