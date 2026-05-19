import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import type { LotDetail } from '../types/api'

export default function LotDetailPage() {
  const { lot_id } = useParams<{ lot_id: string }>()
  const { user, signOut } = useAuth()
  const nav = useNavigate()
  const [detail, setDetail] = useState<LotDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!lot_id) return
    setError(null)
    api
      .getLotDetail(parseInt(lot_id, 10))
      .then(setDetail)
      .catch((e) => setError(String(e)))
  }, [lot_id])

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 antialiased">
      <DetailChrome
        breadcrumb={[{ label: 'Manager Console', to: '/manager' }, { label: 'Lot' }]}
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
          <span>Back to warehouse map</span>
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

        {!detail ? (
          <LoadingCard />
        ) : (
          <Detail detail={detail} />
        )}
      </main>
    </div>
  )
}

function Detail({ detail }: { detail: LotDetail }) {
  const occupied = detail.pallets_used + detail.pallets_reserved
  const occ_pct =
    detail.pallet_capacity === 0
      ? 0
      : Math.round((occupied / detail.pallet_capacity) * 100)

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
          Lot
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-3xl font-bold font-mono tracking-tight text-[#1B4676]">
            {detail.lot_code}
          </h1>
          <span className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full text-[10.5px] uppercase tracking-[0.12em] font-bold capitalize">
            {detail.type}
          </span>
          {detail.blocked && (
            <span className="bg-red-100 text-red-800 px-2 py-0.5 rounded-full text-[10.5px] uppercase tracking-[0.12em] font-bold">
              Blocked
            </span>
          )}
          <div className="flex-1" />
          <span className="text-sm text-slate-500">{detail.floor_name}</span>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          label="Capacity"
          value={`${detail.pallet_capacity}`}
          sub={`${detail.sqft_capacity} sqft`}
          accent="slate"
        />
        <Stat
          label="Used"
          value={`${detail.pallets_used}`}
          sub="placed pallets"
          accent="blue"
        />
        <Stat
          label="Reserved"
          value={`${detail.pallets_reserved}`}
          sub="planned put-aways"
          accent="amber"
        />
        <Stat
          label="Free"
          value={`${detail.pallets_free}`}
          sub={`${occ_pct}% occupied`}
          accent={
            detail.pallets_free === 0
              ? 'red'
              : detail.pallets_free < 5
              ? 'amber'
              : 'green'
          }
        />
      </div>

      {/* Occupancy bar */}
      <div
        className="bg-white rounded-xl border border-slate-200 p-5"
        style={{ boxShadow: '0 1px 2px 0 rgba(15,23,42,0.04)' }}
      >
        <div className="flex items-baseline justify-between text-sm mb-1.5">
          <span className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0]">
            Occupancy
          </span>
          <span className="font-mono text-[#1B4676] font-semibold">
            {occupied} / {detail.pallet_capacity}{' '}
            <span className="text-slate-400">({occ_pct}%)</span>
          </span>
        </div>
        <div className="w-full bg-slate-100 rounded-full h-3 overflow-hidden flex">
          <div
            className="bg-[#0093D0] h-3 transition-all duration-200"
            style={{
              width: `${
                (detail.pallets_used / Math.max(1, detail.pallet_capacity)) * 100
              }%`,
            }}
            title={`${detail.pallets_used} placed`}
          />
          <div
            className="bg-amber-400 h-3 transition-all duration-200"
            style={{
              width: `${
                (detail.pallets_reserved /
                  Math.max(1, detail.pallet_capacity)) *
                100
              }%`,
            }}
            title={`${detail.pallets_reserved} reserved`}
          />
        </div>
        <div className="mt-2 flex gap-4 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block w-2.5 h-2.5 bg-[#0093D0] rounded-sm"
              aria-hidden
            />
            placed
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block w-2.5 h-2.5 bg-amber-400 rounded-sm"
              aria-hidden
            />
            reserved
          </span>
        </div>
      </div>

      {/* Pallets table */}
      <div
        className="bg-white rounded-xl border border-slate-200 overflow-hidden"
        style={{
          boxShadow:
            '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
        }}
      >
        <div className="bg-slate-50 border-b border-slate-200 px-5 py-3 flex items-baseline gap-2">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#0093D0]">
            Pallets currently in lot
          </h2>
          <span className="text-xs text-slate-500 font-mono">
            ({detail.pallets.length})
          </span>
        </div>
        {detail.pallets.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No pallets in this lot yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-white text-[10.5px] uppercase text-slate-500 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-2 font-semibold tracking-wider">
                  Pallet #
                </th>
                <th className="text-left px-4 py-2 font-semibold tracking-wider">
                  SKU
                </th>
                <th className="text-left px-4 py-2 font-semibold tracking-wider">
                  Container
                </th>
                <th className="text-right px-4 py-2 font-semibold tracking-wider">
                  Qty
                </th>
                <th className="text-right px-4 py-2 font-semibold tracking-wider">
                  Level
                </th>
                <th className="text-left px-4 py-2 font-semibold tracking-wider">
                  Palletized
                </th>
                <th className="text-left px-4 py-2 font-semibold tracking-wider">
                  By
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {detail.pallets.map((p) => (
                <tr key={p.pallet_id} className="hover:bg-[#0093D0]/5 transition">
                  <td className="px-4 py-2 font-mono text-[#1B4676] font-bold">
                    #{p.pallet_id}
                  </td>
                  <td className="px-4 py-2 font-mono text-slate-700">{p.sku}</td>
                  <td className="px-4 py-2 font-mono text-slate-600">
                    {p.container_no}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-700">
                    {p.qty}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-500">
                    L{p.level}
                  </td>
                  <td className="px-4 py-2 text-slate-600 font-mono text-xs">
                    {new Date(p.palletized_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{p.palletized_by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
  accent = 'slate',
}: {
  label: string
  value: string
  sub?: string
  accent?: 'slate' | 'green' | 'amber' | 'red' | 'blue'
}) {
  const valueColor = {
    slate: 'text-[#1B4676]',
    blue: 'text-[#0093D0]',
    green: 'text-emerald-700',
    amber: 'text-amber-700',
    red: 'text-red-700',
  }[accent]
  const dotColor = {
    slate: 'bg-slate-300',
    blue: 'bg-[#0093D0]',
    green: 'bg-emerald-500',
    amber: 'bg-amber-500',
    red: 'bg-red-500',
  }[accent]
  return (
    <div
      className="bg-white rounded-xl border border-slate-200 p-3.5"
      style={{ boxShadow: '0 1px 2px 0 rgba(15,23,42,0.04)' }}
    >
      <div className="text-[10px] uppercase text-slate-500 font-bold tracking-[0.15em] flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} aria-hidden />
        <span>{label}</span>
      </div>
      <div className={`text-3xl font-bold mt-1.5 tabular-nums ${valueColor}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
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

      <nav
        aria-label="Breadcrumb"
        className="bg-white border-b border-slate-200"
      >
        <ol className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex items-center gap-2 text-sm text-slate-500">
          {breadcrumb.map((b, i) => {
            const last = i === breadcrumb.length - 1
            return (
              <li key={i} className="flex items-center gap-2">
                {b.to && !last ? (
                  <Link
                    to={b.to}
                    className="hover:text-[#1B4676] transition"
                  >
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
