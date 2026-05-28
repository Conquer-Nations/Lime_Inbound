import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import type {
  ContainerErpActivity,
  ErpStageEvent,
  OutboundOrderErpContainer,
  OutboundOrderErpDetail,
  OutboundOrderErpLine,
} from '../api/client'
import BrandMark from '../components/BrandMark'

/**
 * Manager ERP drilldown — comprehensive outbound Transfer Order detail.
 *
 * Mirror of ContainerDetailPage but for outbound flow: TO# / PO# header,
 * customer + ship-to, lines with picked vs ordered, trucks attached,
 * linked inbound source containers (clickable back to inbound drilldown),
 * status timeline, activity log.
 *
 * Uses the dark-navy accent (the outbound colour) while keeping the same
 * card grid as the container page so the manager sees consistent shapes.
 */
export default function OutboundOrderDetailPage() {
  const { transfer_order_no } = useParams<{ transfer_order_no: string }>()
  const { user, signOut } = useAuth()
  const nav = useNavigate()
  const [data, setData] = useState<OutboundOrderErpDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const reload = () => {
    if (!transfer_order_no) return
    setErr(null)
    api
      .getOutboundOrderDetail(transfer_order_no)
      .then(setData)
      .catch((e) => setErr(String(e?.detail || e)))
  }

  useEffect(() => {
    if (!transfer_order_no) return
    setErr(null)
    setData(null)
    api
      .getOutboundOrderDetail(transfer_order_no)
      .then(setData)
      .catch((e) => setErr(String(e?.detail || e)))
  }, [transfer_order_no])

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 antialiased">
      <DetailChrome
        breadcrumb={[
          { label: 'Manager Console', to: '/manager' },
          { label: 'Transfer Orders' },
          { label: transfer_order_no ?? '' },
        ]}
        user={user}
        onSignOut={() => {
          signOut()
          nav('/login')
        }}
      />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-5">
        <Link
          to="/manager"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[#1B4676] hover:text-[#0093D0] transition"
        >
          <span aria-hidden>←</span>
          <span>Back to manager console</span>
        </Link>

        {err && (
          <div
            role="alert"
            className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5 flex items-start gap-2"
          >
            <span className="font-semibold">Error:</span>
            <span>{err}</span>
          </div>
        )}

        {!data && !err && <LoadingCard />}

        {data && (
          <>
            <HeaderCard d={data} />
            <TimelineCard timeline={data.timeline} currentStage={data.current_stage} />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <ShipFromToCard d={data} />
              <SubmissionCard d={data} />
            </div>
            <LinesCard d={data} onReload={reload} />
            <ContainersCard containers={data.containers} />
            <LinkedInboundCard linked={data.linked_inbound_containers} />
            {data.activity.length > 0 && <ActivityCard entries={data.activity} />}
          </>
        )}
      </main>
    </div>
  )
}

// ─── Cards ─────────────────────────────────────────────────────────────

function HeaderCard({ d }: { d: OutboundOrderErpDetail }) {
  return (
    <Card>
      <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#1B4676] mb-1">
        Outbound transfer order
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-3xl font-bold font-mono tracking-tight text-[#1B4676]">
          {d.transfer_order_no}
        </h1>
        <StatusPill status={d.status} />
        {d.priority && d.priority !== 'normal' && (
          <span className="bg-rose-100 text-rose-800 px-2 py-0.5 rounded-full text-[10.5px] uppercase tracking-[0.12em] font-bold">
            {d.priority}
          </span>
        )}
      </div>
      <dl className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <Field k="PO #" v={d.po_number ?? '—'} mono />
        <Field k="Customer" v={d.customer_name} />
        <Field k="Order date" v={d.order_date ?? '—'} mono />
        <Field
          k="Picked / ordered"
          v={`${d.total_picked_qty} / ${d.total_order_qty}`}
          mono
        />
      </dl>
    </Card>
  )
}

function TimelineCard({
  timeline,
  currentStage,
}: {
  timeline: ErpStageEvent[]
  currentStage: string
}) {
  return (
    <Card>
      <SectionHeading>Status timeline</SectionHeading>
      <ol className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-2 mt-3">
        {timeline.map((ev) => {
          const done = ev.at !== null
          const current = ev.stage === currentStage
          return (
            <li
              key={ev.stage}
              className={`relative px-3 py-3 rounded-md border ${
                done
                  ? current
                    ? 'border-[#1B4676] bg-[#1B4676]/10'
                    : 'border-emerald-300 bg-emerald-50/60'
                  : 'border-slate-200 bg-slate-50/60'
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`inline-grid place-items-center w-6 h-6 rounded-full text-[11px] font-bold ${
                    done
                      ? current
                        ? 'bg-[#1B4676] text-white ring-2 ring-[#1B4676]/30'
                        : 'bg-emerald-500 text-white'
                      : 'bg-slate-200 text-slate-500'
                  }`}
                >
                  {done ? '✓' : '·'}
                </span>
                <span
                  className={`text-[11px] uppercase tracking-wider font-bold ${
                    done ? 'text-[#1B4676]' : 'text-slate-400'
                  }`}
                >
                  {ev.label}
                </span>
              </div>
              <div className="mt-1 text-xs text-slate-500 ml-8 font-mono">
                {ev.at ? new Date(ev.at).toLocaleString() : '—'}
              </div>
            </li>
          )
        })}
      </ol>
    </Card>
  )
}

function ShipFromToCard({ d }: { d: OutboundOrderErpDetail }) {
  return (
    <Card>
      <SectionHeading>Ship from / Ship to</SectionHeading>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
        <div>
          <div className="text-[10.5px] uppercase text-slate-500 font-bold tracking-[0.15em] mb-1">
            Ship from
          </div>
          <div className="font-semibold text-[#1B4676]">
            {d.ship_from_name ?? '—'}
          </div>
          <div className="text-slate-700 whitespace-pre-line text-xs mt-1">
            {d.ship_from_address ?? '—'}
          </div>
        </div>
        <div>
          <div className="text-[10.5px] uppercase text-slate-500 font-bold tracking-[0.15em] mb-1">
            Ship to
          </div>
          <div className="font-semibold text-[#1B4676]">
            {d.ship_to_name ?? '—'}
          </div>
          <div className="text-slate-700 whitespace-pre-line text-xs mt-1">
            {d.ship_to_address ?? '—'}
          </div>
        </div>
      </div>
    </Card>
  )
}

function SubmissionCard({ d }: { d: OutboundOrderErpDetail }) {
  return (
    <Card>
      <SectionHeading>Submission</SectionHeading>
      <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
        <Field k="Submitted at" v={new Date(d.submitted_at).toLocaleString()} />
        <Field k="Submitted by" v={d.submitted_by ?? '—'} />
        <Field k="Memo" v={d.memo ?? '—'} />
        <Field k="Internal notes" v={d.notes ?? '—'} />
      </dl>
    </Card>
  )
}

function LinesCard({ d, onReload }: { d: OutboundOrderErpDetail; onReload: () => void }) {
  const { user } = useAuth()
  const canAssign = user?.role === 'developer' || user?.role === 'manager'
  const [assigning, setAssigning] = useState<OutboundOrderErpLine | null>(null)
  const pct =
    d.total_order_qty === 0
      ? 0
      : Math.round((d.total_picked_qty / d.total_order_qty) * 100)
  return (
    <Card>
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <SectionHeading>Picking ticket</SectionHeading>
        <span className="text-sm font-mono text-slate-700">
          <span className="font-bold text-[#1B4676]">{d.total_picked_qty}</span>
          {' / '}
          {d.total_order_qty} picked{' '}
          <span className="text-slate-400">({pct}%)</span>
        </span>
      </div>
      {d.total_order_qty > 0 && (
        <div className="mt-2 w-full bg-slate-100 rounded-full h-2 overflow-hidden">
          <div
            className="bg-[#1B4676] h-2 transition-all duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      <div className="mt-3 rounded-md border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[10.5px] uppercase text-slate-500 border-b border-slate-200">
            <tr>
              <Th>#</Th>
              <Th>SKU</Th>
              <Th>Description</Th>
              <Th align="right">Picked / Ordered</Th>
              <Th>Source container</Th>
              <Th>Mode</Th>
            </tr>
          </thead>
          <tbody className="text-sm divide-y divide-slate-100">
            {d.lines.map((ln: OutboundOrderErpLine) => (
              <tr key={ln.line_id}>
                <td className="px-3 py-2 font-mono text-slate-500">{ln.line_no}</td>
                <td className="px-3 py-2 font-mono text-[#1B4676] font-bold">
                  {ln.sku}
                </td>
                <td className="px-3 py-2 text-slate-500">{ln.description ?? '—'}</td>
                <td className="px-3 py-2 text-right font-mono text-slate-700">
                  <span className="font-bold text-[#1B4676]">{ln.picked_qty}</span>
                  {' / '}
                  {ln.order_qty}
                  <span className="ml-1 text-xs text-slate-400">{ln.unit}</span>
                </td>
                <td className="px-3 py-2 font-mono">
                  <div className="flex items-center gap-2 flex-wrap">
                    {ln.source_container_no ? (
                      <Link
                        to={`/manager/containers/${encodeURIComponent(
                          ln.source_container_no,
                        )}`}
                        className="text-[#1B4676] hover:text-[#0093D0] underline decoration-dotted"
                      >
                        {ln.source_container_no}
                      </Link>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5 text-[10.5px] uppercase tracking-wider font-bold">
                        Unassigned
                      </span>
                    )}
                    {canAssign && (
                      <button
                        type="button"
                        onClick={() => setAssigning(ln)}
                        className="text-[10.5px] uppercase tracking-wider font-bold text-[#0093D0] hover:text-[#1B4676] hover:underline"
                        title={ln.source_container_no ? 'Reassign source container' : 'Assign source container'}
                      >
                        {ln.source_container_no ? 'Change' : 'Assign'}
                      </button>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 text-xs text-slate-600">
                  {ln.serial_specific ? (
                    <span title={ln.serials_requested.join('\n')}>
                      Serial-specific ({ln.serials_requested.length})
                    </span>
                  ) : (
                    'FIFO'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {assigning && (
        <AssignSourceContainerModal
          transferOrderNo={d.transfer_order_no}
          line={assigning}
          onClose={() => setAssigning(null)}
          onSaved={() => {
            setAssigning(null)
            onReload()
          }}
        />
      )}
    </Card>
  )
}

function ContainersCard({
  containers,
}: {
  containers: OutboundOrderErpContainer[]
}) {
  return (
    <Card>
      <SectionHeading>Trucks attached</SectionHeading>
      {containers.length === 0 ? (
        <p className="text-sm text-slate-500 italic mt-2">
          No trucks attached yet.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {containers.map((c) => (
            <div
              key={c.container_id}
              className="rounded-md border border-slate-200 p-3 bg-slate-50/30"
            >
              <div className="flex items-center gap-3 flex-wrap">
                <span className="font-mono font-bold text-[#1B4676]">
                  {c.container_no}
                </span>
                <span className="text-[10.5px] uppercase tracking-wider text-slate-500 font-semibold">
                  {c.container_type}
                </span>
                <StatusPill status={c.status} />
                <span className="text-xs font-mono text-slate-600">
                  <span className="font-bold text-[#1B4676]">{c.total_scanned}</span>{' '}
                  scanned
                </span>
                {c.scheduled_arrival_at && (
                  <span className="text-xs text-slate-500">
                    Scheduled: {new Date(c.scheduled_arrival_at).toLocaleString()}
                  </span>
                )}
                {c.sealed_at && (
                  <span className="text-xs text-emerald-700">
                    Sealed {new Date(c.sealed_at).toLocaleString()}
                  </span>
                )}
              </div>
              <dl className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                <SmallField k="Driver" v={c.driver_name ?? '—'} />
                <SmallField k="License" v={c.driver_license ?? '—'} mono />
                <SmallField k="Phone" v={c.driver_phone ?? '—'} mono />
                <SmallField k="Truck plate" v={c.truck_license_plate ?? '—'} mono />
                <SmallField k="Carrier" v={c.carrier ?? '—'} />
                <SmallField k="BOL" v={c.bol_number ?? '—'} mono />
              </dl>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

function LinkedInboundCard({ linked }: { linked: string[] }) {
  return (
    <Card>
      <SectionHeading>Linked inbound containers</SectionHeading>
      {linked.length === 0 ? (
        <p className="text-sm text-slate-500 italic mt-2">
          No inbound containers sourced for this TO yet.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {linked.map((cn) => (
            <Link
              key={cn}
              to={`/manager/containers/${encodeURIComponent(cn)}`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#0093D0]/10 hover:bg-[#0093D0]/20 text-[#1B4676] text-sm font-mono font-bold transition"
            >
              {cn}
              <span className="text-xs text-[#0093D0]">↗</span>
            </Link>
          ))}
        </div>
      )}
    </Card>
  )
}

function ActivityCard({ entries }: { entries: ContainerErpActivity[] }) {
  return (
    <Card>
      <SectionHeading>Activity log</SectionHeading>
      <ol className="mt-3 space-y-1.5 text-sm">
        {entries.map((a) => (
          <li
            key={a.id}
            className="grid grid-cols-[auto_auto_1fr] gap-3 px-2 py-1.5 rounded hover:bg-slate-50"
          >
            <span className="text-xs text-slate-400 font-mono whitespace-nowrap">
              {new Date(a.t).toLocaleString()}
            </span>
            <span className="text-xs uppercase tracking-wider font-bold text-[#1B4676] whitespace-nowrap">
              {a.kind.replace(/_/g, ' ')}
            </span>
            <span className="text-sm text-slate-700">
              {a.message ?? '—'}
              {a.actor && (
                <span className="text-xs text-slate-400 ml-2">by {a.actor}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  )
}

// ─── Reusable bits ─────────────────────────────────────────────────────

function Card({ children }: { children: ReactNode }) {
  return (
    <div
      className="bg-white rounded-xl border border-slate-200 p-5 sm:p-6"
      style={{
        boxShadow:
          '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
      }}
    >
      {children}
    </div>
  )
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#1B4676]">
      {children}
    </h2>
  )
}

function Field({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[10.5px] uppercase text-slate-500 font-bold tracking-[0.15em]">
        {k}
      </dt>
      <dd className={`mt-0.5 text-[#1B4676] ${mono ? 'font-mono' : ''}`}>{v}</dd>
    </div>
  )
}

function SmallField({
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
      <dt className="text-[9.5px] uppercase text-slate-500 font-semibold tracking-wider">
        {k}
      </dt>
      <dd className={`text-slate-700 ${mono ? 'font-mono' : ''}`}>{v}</dd>
    </div>
  )
}

function Th({
  children,
  align = 'left',
}: {
  children: ReactNode
  align?: 'left' | 'right' | 'center'
}) {
  return (
    <th
      className={`px-3 py-2 font-semibold tracking-wider text-${align} whitespace-nowrap`}
    >
      {children}
    </th>
  )
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    ready: 'bg-emerald-100 text-emerald-800',
    received: 'bg-emerald-100 text-emerald-800',
    completed: 'bg-emerald-100 text-emerald-800',
    full: 'bg-emerald-100 text-emerald-800',
    shipped: 'bg-emerald-100 text-emerald-800',
    pending_master_data: 'bg-amber-100 text-amber-800',
    planned: 'bg-amber-100 text-amber-800',
    receiving: 'bg-[#0093D0]/15 text-[#1B4676]',
    active: 'bg-[#0093D0]/15 text-[#1B4676]',
    in_progress: 'bg-[#0093D0]/15 text-[#1B4676]',
    invoiced: 'bg-[#0093D0]/15 text-[#1B4676]',
    open: 'bg-amber-100 text-amber-800',
    picking: 'bg-[#0093D0]/15 text-[#1B4676]',
    loading: 'bg-[#0093D0]/15 text-[#1B4676]',
    sealed: 'bg-[#1B4676]/15 text-[#1B4676]',
    cancelled: 'bg-slate-100 text-slate-500',
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
    <div className="bg-white rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-500 flex items-center gap-2">
      <span
        className="inline-block w-2 h-2 rounded-full bg-[#1B4676] animate-pulse"
        aria-hidden
      />
      <span>Loading…</span>
    </div>
  )
}

// ─── Chrome ────────────────────────────────────────────────────────────

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
          background: 'linear-gradient(180deg, #0B1828 0%, #14233A 100%)',
        }}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <Link to="/manager" className="flex items-center gap-3 group">
            <BrandMark className="h-12 text-white" />
            <div className="leading-tight">
              <div className="text-base font-extrabold tracking-[0.16em]">
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
              className="inline-flex items-center gap-2 rounded-full bg-white/8 hover:bg-white/15 border border-white/15 hover:border-white/30 px-4 py-1.5 text-sm font-medium transition"
            >
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
                {!last && <span className="text-slate-300">›</span>}
              </li>
            )
          })}
        </ol>
      </nav>
    </>
  )
}

// ─── Assign source-container modal ───────────────────────────────────
// Loads candidates (containers with stock of this line's SKU + remaining
// qty after other TO allocations), lets the manager pick one or clear.
// Server validates again on save — if the picked container's stock got
// allocated to another TO between load + save, that returns 400 inline.
function AssignSourceContainerModal({
  transferOrderNo,
  line,
  onClose,
  onSaved,
}: {
  transferOrderNo: string
  line: OutboundOrderErpLine
  onClose: () => void
  onSaved: () => void
}) {
  const [candidates, setCandidates] = useState<
    {
      container_no: string
      inbound_qty: number
      already_allocated_qty: number
      remaining_qty: number
      received_date: string | null
      is_current: boolean
    }[]
  >([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [picked, setPicked] = useState<string | null>(line.source_container_no ?? null)
  const [err, setErr] = useState<string | null>(null)
  const [manual, setManual] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    api
      .listSourceContainerCandidates(transferOrderNo, line.line_id)
      .then((r) => {
        if (cancelled) return
        setCandidates(r.candidates)
      })
      .catch((e: { detail?: string }) => {
        if (!cancelled) setErr(e?.detail ?? String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [transferOrderNo, line.line_id])

  async function save() {
    setSaving(true)
    setErr(null)
    try {
      const finalVal = manual.trim() || picked
      await api.assignSourceContainer(
        transferOrderNo,
        line.line_id,
        finalVal && finalVal.length > 0 ? finalVal : null,
      )
      onSaved()
    } catch (e: unknown) {
      const msg = (e as { detail?: string; message?: string })?.detail
        ?? (e as { message?: string })?.message
        ?? String(e)
      setErr(msg)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4"
      onClick={() => !saving && onClose()}
    >
      <div
        className="bg-white rounded-xl shadow-2xl max-w-2xl w-full p-6 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold text-[#1B4676]">
          Assign source container
        </h2>
        <p className="text-sm text-slate-600 mt-1">
          TO <span className="font-mono font-bold">{transferOrderNo}</span>
          {' · '}line {line.line_no}
          {' · '}SKU <span className="font-mono font-bold">{line.sku}</span>
          {' · '}
          <span className="font-mono">{line.order_qty}</span> {line.unit} needed
        </p>

        {err && (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {err}
          </div>
        )}

        <div className="mt-4 space-y-1">
          <div className="text-[11px] uppercase tracking-[0.14em] font-bold text-slate-500">
            Available containers
          </div>
          {loading && (
            <div className="text-sm text-slate-500 py-4">Loading candidates…</div>
          )}
          {!loading && candidates.length === 0 && (
            <div className="text-sm text-slate-500 py-4 italic">
              No inbound containers on file with stock of {line.sku}. Either
              no shipment has arrived yet, or every container is fully
              allocated to other TOs. Use the manual entry below if you
              want to assign anyway.
            </div>
          )}
          {!loading && candidates.length > 0 && (
            <div className="rounded-md border border-slate-200 divide-y divide-slate-100">
              <label
                className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-slate-50 ${
                  picked === null && manual === '' ? 'bg-slate-50' : ''
                }`}
              >
                <input
                  type="radio"
                  name="container-pick"
                  checked={picked === null && manual === ''}
                  onChange={() => {
                    setPicked(null)
                    setManual('')
                  }}
                  className="w-4 h-4"
                />
                <div className="flex-1 text-sm">
                  <div className="font-semibold text-slate-700">Unassigned (clear)</div>
                  <div className="text-xs text-slate-500">
                    Operator scan flow will FIFO-pick at the dock.
                  </div>
                </div>
              </label>
              {candidates.map((c) => (
                <label
                  key={c.container_no}
                  className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-slate-50 ${
                    picked === c.container_no ? 'bg-[#0093D0]/5' : ''
                  }`}
                >
                  <input
                    type="radio"
                    name="container-pick"
                    checked={picked === c.container_no && manual === ''}
                    onChange={() => {
                      setPicked(c.container_no)
                      setManual('')
                    }}
                    className="w-4 h-4"
                    disabled={c.remaining_qty < line.order_qty && !c.is_current}
                  />
                  <div className="flex-1 text-sm">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-mono font-bold text-[#1B4676]">
                        {c.container_no}
                      </span>
                      {c.is_current && (
                        <span className="text-[10px] uppercase tracking-wider font-bold text-[#0093D0] bg-[#0093D0]/10 border border-[#0093D0]/25 rounded-full px-1.5 py-0.5">
                          Current
                        </span>
                      )}
                      {c.remaining_qty < line.order_qty && !c.is_current && (
                        <span className="text-[10px] uppercase tracking-wider font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-1.5 py-0.5">
                          Short
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 font-mono">
                      remaining <span className={`font-bold ${c.remaining_qty >= line.order_qty ? 'text-emerald-700' : 'text-slate-700'}`}>{c.remaining_qty}</span>
                      {' / '}inbound {c.inbound_qty}
                      {c.already_allocated_qty > 0 && (
                        <span className="text-slate-400"> · {c.already_allocated_qty} allocated</span>
                      )}
                      {c.received_date && (
                        <span className="text-slate-400"> · arrived {c.received_date}</span>
                      )}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 space-y-1">
          <div className="text-[11px] uppercase tracking-[0.14em] font-bold text-slate-500">
            Or type a container number manually
          </div>
          <input
            type="text"
            value={manual}
            onChange={(e) => {
              setManual(e.target.value.toUpperCase())
              if (e.target.value) setPicked(null)
            }}
            placeholder="e.g. TESU1234567"
            className="w-full border border-slate-300 rounded-md px-3 py-2 font-mono text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
            disabled={saving}
          />
          <div className="text-xs text-slate-500">
            Server validates the container exists + carries SKU {line.sku} before
            saving.
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || loading}
            className="px-4 py-1.5 rounded-md bg-[#1B4676] hover:bg-[#224E72] text-white text-sm font-bold disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
