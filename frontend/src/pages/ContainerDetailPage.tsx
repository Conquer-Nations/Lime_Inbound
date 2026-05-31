import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, API_BASE } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import type {
  ContainerErpDetail,
  ContainerErpScanRow,
  ContainerErpOutboundLink,
  ContainerErpDocument,
  ContainerErpException,
  ContainerErpActivity,
  ErpStageEvent,
} from '../api/client'
import BrandMark from '../components/BrandMark'

/**
 * Manager ERP drilldown — comprehensive container detail.
 *
 * Everything about a single inbound container in one page: order chain,
 * driver/truck, scan sheet preview, lot put-away, documents, downstream
 * outbound TOs (drilldown), exceptions, activity log. Designed as the
 * single pane of glass the manager uses before invoicing.
 */
export default function ContainerDetailPage() {
  const { container_no } = useParams<{ container_no: string }>()
  const { user, signOut } = useAuth()
  const nav = useNavigate()
  const [data, setData] = useState<ContainerErpDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!container_no) return
    setErr(null)
    setData(null)
    api
      .getContainerDetail(container_no)
      .then(setData)
      .catch((e) => setErr(String(e?.detail || e)))
  }, [container_no])

  // Silent re-fetch (no loading flash) — used after an inline manager edit
  // such as a per-LPN quantity override.
  function reload() {
    if (!container_no) return
    api
      .getContainerDetail(container_no)
      .then(setData)
      .catch((e) => setErr(String(e?.detail || e)))
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 antialiased">
      <DetailChrome
        breadcrumb={[
          { label: 'Manager Console', to: '/manager' },
          { label: 'Containers' },
          { label: container_no ?? '' },
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
              <DriverCard d={data} />
              <PackagingCard d={data} />
            </div>
            <ManifestCard d={data} onReload={reload} />
            <ScanSheetCard d={data} />
            <LotAssignmentsCard d={data} />
            <OutboundLinksCard links={data.outbound_links} />
            <DocumentsCard documents={data.documents} />
            {data.exceptions.length > 0 && (
              <ExceptionsCard exceptions={data.exceptions} />
            )}
            {data.activity.length > 0 && (
              <ActivityCard entries={data.activity} />
            )}
          </>
        )}
      </main>
    </div>
  )
}

// ─── Cards ─────────────────────────────────────────────────────────────

function HeaderCard({ d }: { d: ContainerErpDetail }) {
  return (
    <Card>
      <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0] mb-1">
        Inbound container
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-3xl font-bold font-mono tracking-tight text-[#1B4676]">
          {d.container_no}
        </h1>
        <StatusPill status={d.status} />
        {d.open_exceptions > 0 && (
          <span className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full text-[10.5px] uppercase tracking-[0.12em] font-bold">
            {d.open_exceptions} open exception{d.open_exceptions === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <dl className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <Field
          k="WHPO / Load #"
          v={d.whpo_number}
          mono
        />
        <Field
          k="DO #"
          to={`/manager/dos/${d.do_id}`}
          v={d.do_number}
          mono
        />
        <Field k="Customer" v={d.customer_name} />
        <Field k="BOL #" v={d.bol_number ?? '—'} mono />
        <Field
          k="Expected"
          v={
            d.expected_arrival_date
              ? `${d.expected_arrival_date}${
                  d.expected_arrival_time ? ' · ' + d.expected_arrival_time : ''
                }`
              : '—'
          }
        />
        <Field
          k="Actual"
          v={
            d.actual_arrival_date
              ? `${d.actual_arrival_date}${
                  d.actual_arrival_time ? ' · ' + d.actual_arrival_time : ''
                }`
              : '—'
          }
        />
        <Field k="Started by" v={d.started_by ?? '—'} />
        <Field k="Finished by" v={d.finished_by ?? '—'} />
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
      <ol className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2 mt-3">
        {timeline.map((ev) => {
          const done = ev.at !== null
          const current = ev.stage === currentStage
          return (
            <li
              key={ev.stage}
              className={`relative px-3 py-3 rounded-md border ${
                done
                  ? current
                    ? 'border-[#0093D0] bg-[#0093D0]/10'
                    : 'border-emerald-300 bg-emerald-50/60'
                  : 'border-slate-200 bg-slate-50/60'
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`inline-grid place-items-center w-6 h-6 rounded-full text-[11px] font-bold ${
                    done
                      ? current
                        ? 'bg-[#0093D0] text-white ring-2 ring-[#0093D0]/30'
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

function DriverCard({ d }: { d: ContainerErpDetail }) {
  const hasInfo = !!(
    d.driver_name ||
    d.driver_license ||
    d.driver_phone ||
    d.truck_license_plate ||
    d.carrier ||
    d.insurance
  )
  return (
    <Card>
      <SectionHeading>Driver &amp; truck</SectionHeading>
      {!hasInfo && (
        <p className="text-sm text-slate-500 italic mt-2">
          Driver / truck info not provided yet.
        </p>
      )}
      {hasInfo && (
        <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <Field k="Driver" v={d.driver_name ?? '—'} />
          <Field k="License" v={d.driver_license ?? '—'} mono />
          <Field k="Phone" v={d.driver_phone ?? '—'} mono />
          <Field k="Truck plate" v={d.truck_license_plate ?? '—'} mono />
          <Field k="Carrier" v={d.carrier ?? '—'} />
          <Field k="Insurance" v={d.insurance ?? '—'} />
          <Field
            k="Received at"
            v={
              d.driver_info_received_at
                ? new Date(d.driver_info_received_at).toLocaleString()
                : '—'
            }
          />
        </dl>
      )}
    </Card>
  )
}

function PackagingCard({ d }: { d: ContainerErpDetail }) {
  return (
    <Card>
      <SectionHeading>Packaging &amp; footprint</SectionHeading>
      <div className="mt-3 text-sm">
        <div className="font-mono text-sm">
          <span className="font-bold text-base text-[#1B4676]">
            {d.total_sqft_needed.toLocaleString()}
          </span>
          <span className="text-slate-500"> sqft total</span>
          <span className="mx-2 text-slate-300">·</span>
          <span className="text-slate-700">
            ≈ {d.lots_equivalent} lot{d.lots_equivalent === 1 ? '' : 's'}
          </span>
        </div>
        <div className="text-xs text-slate-600 mt-2">
          {d.on_pallet === true && (
            <>
              On pallets
              {d.pallet_length_in && d.pallet_width_in && (
                <>
                  {' · '}
                  <span className="font-mono">
                    {d.pallet_length_in}″ × {d.pallet_width_in}″
                  </span>
                </>
              )}
            </>
          )}
          {d.on_pallet === false && (
            <>
              Loose items
              {d.item_length_in && d.item_width_in && (
                <>
                  {' · '}
                  <span className="font-mono">
                    {d.item_length_in}″ × {d.item_width_in}″
                    {d.item_height_in ? ` × ${d.item_height_in}″` : ''}
                  </span>
                </>
              )}
            </>
          )}
          {d.on_pallet === null && (
            <span className="text-amber-700 font-medium">
              Vendor didn't declare packaging — using SKU master defaults.
            </span>
          )}
        </div>
      </div>
    </Card>
  )
}

function ManifestCard({
  d,
  onReload,
}: {
  d: ContainerErpDetail
  onReload: () => void
}) {
  const pct =
    d.total_expected_qty === 0
      ? 0
      : Math.round((d.total_received_qty / d.total_expected_qty) * 100)
  // A "mixed container" carries more than one LPN line. We surface the
  // per-LPN qty as a manager-editable field so an over-scan that hard-stopped
  // at the dock can be reconciled by bumping the vendor quantity here.
  const isMixed = d.lines.length > 1
  return (
    <Card>
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <SectionHeading>Manifest</SectionHeading>
        <span className="text-sm font-mono text-slate-700">
          <span className="font-bold text-[#1B4676]">{d.total_received_qty}</span>
          {' / '}
          {d.total_expected_qty} received{' '}
          <span className="text-slate-400">({pct}%)</span>
        </span>
      </div>
      {isMixed && (
        <div className="mt-1 text-xs text-slate-500">
          Mixed container — {d.lines.length} LPNs. Quantities below are
          manager-editable (used to clear an over-scan hard stop).
        </div>
      )}
      {d.total_expected_qty > 0 && (
        <div className="mt-2 w-full bg-slate-100 rounded-full h-2 overflow-hidden">
          <div
            className="bg-[#0093D0] h-2 transition-all duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      <div className="mt-3 rounded-md border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[10.5px] uppercase text-slate-500 border-b border-slate-200">
            <tr>
              <Th>LPN / SKU</Th>
              <Th>Product type</Th>
              <Th>Description</Th>
              <Th align="right">Qty</Th>
              <Th align="center">Resolved</Th>
            </tr>
          </thead>
          <tbody className="text-sm divide-y divide-slate-100">
            {d.lines.map((ln) => (
              <ManifestLineRow
                key={ln.line_id}
                containerNo={d.container_no}
                line={ln}
                onSaved={onReload}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/** One manifest line. The Qty cell flips to an inline editor on click,
 * PATCHes /manager/container/{no}/line/{id}/qty, and re-fetches on success.
 * The server rejects a qty below the number already scanned (409). */
function ManifestLineRow({
  containerNo,
  line,
  onSaved,
}: {
  containerNo: string
  line: ContainerErpDetail['lines'][number]
  onSaved: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(String(line.qty))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    const qty = Number(value)
    if (!Number.isFinite(qty) || qty < 0 || !Number.isInteger(qty)) {
      setErr('Enter a whole number ≥ 0.')
      return
    }
    if (qty === line.qty) {
      setEditing(false)
      setErr(null)
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await api.updateContainerLineQty(containerNo, line.line_id, qty)
      setEditing(false)
      onSaved()
    } catch (e) {
      const detail = (e as { detail?: string })?.detail
      setErr(detail || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <tr>
      <td className="px-3 py-2 font-mono text-[#1B4676] font-bold">{line.sku}</td>
      <td className="px-3 py-2 text-slate-700">{line.product_type ?? '—'}</td>
      <td className="px-3 py-2 text-slate-500">{line.description ?? '—'}</td>
      <td className="px-3 py-2 text-right font-mono text-slate-700">
        {editing ? (
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center justify-end gap-1.5">
              <input
                type="number"
                min={0}
                value={value}
                autoFocus
                disabled={busy}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') save()
                  if (e.key === 'Escape') {
                    setEditing(false)
                    setValue(String(line.qty))
                    setErr(null)
                  }
                }}
                className="w-20 border border-slate-300 rounded px-2 py-1 text-right font-mono focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
              />
              <button
                type="button"
                onClick={save}
                disabled={busy}
                className="text-xs font-bold text-white bg-[#0093D0] hover:bg-[#00A8E8] disabled:bg-slate-200 rounded px-2 py-1"
              >
                {busy ? '…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false)
                  setValue(String(line.qty))
                  setErr(null)
                }}
                disabled={busy}
                className="text-xs font-semibold text-slate-600 hover:text-slate-900 px-1"
              >
                Cancel
              </button>
            </div>
            {err && <span className="text-[11px] text-red-600">{err}</span>}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="font-mono text-slate-700 hover:text-[#0093D0] underline decoration-dotted decoration-slate-300 hover:decoration-[#0093D0]"
            title="Edit vendor quantity for this LPN"
          >
            {line.qty}
          </button>
        )}
      </td>
      <td className="px-3 py-2 text-center">
        {line.sku_resolved ? (
          <span className="text-emerald-600 font-bold">✓</span>
        ) : (
          <span className="text-amber-700 text-xs font-bold uppercase tracking-wider">
            Pending
          </span>
        )}
      </td>
    </tr>
  )
}

function ScanSheetCard({ d }: { d: ContainerErpDetail }) {
  return (
    <Card>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <SectionHeading>Scan sheet</SectionHeading>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          {d.receipt_id && (
            <span className="font-mono">
              Receipt #{d.receipt_id}
              {d.receipt_status && (
                <span className="ml-1.5 text-slate-400">· {d.receipt_status}</span>
              )}
            </span>
          )}
          <span className="font-mono">
            <span className="font-bold text-[#1B4676]">{d.total_scanned}</span> scanned
          </span>
          {d.last_scan_at && (
            <span className="font-mono">
              Last: {new Date(d.last_scan_at).toLocaleString()}
            </span>
          )}
          {d.receipt_id && (
            <a
              href={`${API_BASE}/audit/sheets/${d.receipt_id}/export.xlsx`}
              className="inline-flex items-center gap-1.5 bg-[#1B4676] hover:bg-[#224E72] text-white text-xs font-bold rounded-md px-3 py-1.5 transition"
            >
              Download .xlsx
            </a>
          )}
        </div>
      </div>
      {d.recent_scans.length === 0 ? (
        <p className="text-sm text-slate-500 italic mt-3">
          No scans recorded yet.
        </p>
      ) : (
        <div className="mt-3 rounded-md border border-slate-200 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase text-slate-500 border-b border-slate-200">
              <tr>
                <Th>#</Th>
                <Th>Serial</Th>
                <Th>IMEI</Th>
                <Th>SKU</Th>
                <Th>Scanned by</Th>
                <Th>Scanned at</Th>
                <Th>Notes</Th>
              </tr>
            </thead>
            <tbody className="font-mono text-xs divide-y divide-slate-100">
              {d.recent_scans.map((s: ContainerErpScanRow, i: number) => (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="px-3 py-1.5 text-slate-400">{i + 1}</td>
                  <td className="px-3 py-1.5 text-[#1B4676] font-bold">
                    {s.serial_number ?? '—'}
                  </td>
                  <td className="px-3 py-1.5 text-slate-700">{s.imei ?? '—'}</td>
                  <td className="px-3 py-1.5 text-slate-700">{s.sku ?? '—'}</td>
                  <td className="px-3 py-1.5 text-slate-700">{s.scanned_by}</td>
                  <td className="px-3 py-1.5 text-slate-500">
                    {new Date(s.scanned_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-1.5 text-slate-500">{s.notes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.total_scanned > d.recent_scans.length && (
        <p className="text-xs text-slate-500 mt-2 italic">
          Showing {d.recent_scans.length} of {d.total_scanned} scans (most recent).
          Download the .xlsx for the complete sheet.
        </p>
      )}
    </Card>
  )
}

function LotAssignmentsCard({ d }: { d: ContainerErpDetail }) {
  return (
    <Card>
      <SectionHeading>Lot assignments</SectionHeading>
      {d.lot_assignments.length === 0 ? (
        <p className="text-sm text-slate-500 italic mt-2">
          No lot assignments yet (lookup pending).
        </p>
      ) : (
        <div className="mt-3 rounded-md border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[10.5px] uppercase text-slate-500 border-b border-slate-200">
              <tr>
                <Th>#</Th>
                <Th>Lot</Th>
                <Th>Floor</Th>
                <Th>SKU</Th>
                <Th align="right">Planned</Th>
                <Th align="right">Actual</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="text-sm divide-y divide-slate-100">
              {d.lot_assignments.map((a) => (
                <tr key={a.assignment_order}>
                  <td className="px-3 py-2 font-mono text-slate-500">
                    {a.assignment_order}
                  </td>
                  <td className="px-3 py-2 font-mono text-[#1B4676] font-bold">
                    {a.lot_code}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{a.floor_name}</td>
                  <td className="px-3 py-2 font-mono text-slate-700">{a.sku}</td>
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
    </Card>
  )
}

function OutboundLinksCard({ links }: { links: ContainerErpOutboundLink[] }) {
  return (
    <Card>
      <SectionHeading>Outbound shipments sourcing this container</SectionHeading>
      {links.length === 0 ? (
        <p className="text-sm text-slate-500 italic mt-2">
          No outbound Transfer Orders currently pull from this container.
        </p>
      ) : (
        <div className="mt-3 rounded-md border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[10.5px] uppercase text-slate-500 border-b border-slate-200">
              <tr>
                <Th>TO #</Th>
                <Th>PO #</Th>
                <Th>Customer</Th>
                <Th>Status</Th>
                <Th>SKU</Th>
                <Th align="right">Picked / Ordered</Th>
                <Th>Order date</Th>
              </tr>
            </thead>
            <tbody className="text-sm divide-y divide-slate-100">
              {links.map((l) => (
                <tr key={l.line_id} className="hover:bg-[#0093D0]/5">
                  <td className="px-3 py-2 font-mono font-bold">
                    <Link
                      to={`/manager/outbound-orders/${encodeURIComponent(
                        l.transfer_order_no,
                      )}`}
                      className="text-[#1B4676] hover:text-[#0093D0]"
                    >
                      {l.transfer_order_no}
                    </Link>
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-500">
                    {l.po_number ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-slate-700">{l.customer_name}</td>
                  <td className="px-3 py-2">
                    <StatusPill status={l.order_status} />
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-700">{l.sku}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-700">
                    <span className="font-bold text-[#1B4676]">{l.picked_qty}</span>
                    {' / '}
                    {l.order_qty}
                  </td>
                  <td className="px-3 py-2 text-slate-500 font-mono">
                    {l.order_date ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function DocumentsCard({ documents }: { documents: ContainerErpDocument[] }) {
  return (
    <Card>
      <SectionHeading>Documents</SectionHeading>
      {documents.length === 0 ? (
        <p className="text-sm text-slate-500 italic mt-2">
          No documents uploaded for this container.
        </p>
      ) : (
        <ul className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
          {documents.map((d) => (
            <li
              key={d.kind}
              className="flex items-center gap-3 px-3 py-2 rounded-md border border-slate-200 bg-slate-50/40"
            >
              <span
                className="inline-grid place-items-center w-9 h-9 rounded-md bg-[#0093D0]/10 text-[#0093D0] text-xs font-bold uppercase"
                aria-hidden
              >
                {d.content_type.includes('pdf') ? 'PDF' : 'IMG'}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-[#1B4676] truncate">
                  {d.label}
                </div>
                <div className="text-xs text-slate-500 truncate">{d.filename}</div>
                <div className="text-[10.5px] text-slate-400 mt-0.5">
                  Uploaded {new Date(d.uploaded_at).toLocaleString()}{' '}
                  {d.uploaded_by && <>· {d.uploaded_by}</>}
                </div>
              </div>
              <a
                href={`${API_BASE}${d.url}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-bold text-[#1B4676] hover:text-[#0093D0]"
              >
                View ↗
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function ExceptionsCard({ exceptions }: { exceptions: ContainerErpException[] }) {
  return (
    <Card>
      <SectionHeading>Exceptions</SectionHeading>
      <ul className="mt-3 space-y-2">
        {exceptions.map((e) => (
          <li
            key={e.exception_id}
            className={`px-3 py-2 rounded-md border ${
              e.status === 'open'
                ? 'border-amber-200 bg-amber-50/60'
                : 'border-slate-200 bg-slate-50/40'
            }`}
          >
            <div className="flex items-center gap-2 flex-wrap text-sm">
              <span
                className={`px-2 py-0.5 rounded-full text-[10.5px] uppercase tracking-[0.15em] font-bold ${
                  e.status === 'open'
                    ? 'bg-amber-100 text-amber-900'
                    : 'bg-emerald-100 text-emerald-800'
                }`}
              >
                {e.kind.replace(/_/g, ' ')}
              </span>
              <span className="text-xs text-slate-500 font-mono">
                #{e.exception_id}
              </span>
              <span className="text-xs text-slate-500">
                opened {new Date(e.opened_at).toLocaleString()}
              </span>
              {e.resolved_at && (
                <span className="text-xs text-emerald-700">
                  · resolved {new Date(e.resolved_at).toLocaleString()}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
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
            <span className="text-xs uppercase tracking-wider font-bold text-[#0093D0] whitespace-nowrap">
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
    <h2 className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0]">
      {children}
    </h2>
  )
}

function Field({
  k,
  v,
  to,
  mono = false,
}: {
  k: string
  v: string
  to?: string
  mono?: boolean
}) {
  return (
    <div>
      <dt className="text-[10.5px] uppercase text-slate-500 font-bold tracking-[0.15em]">
        {k}
      </dt>
      <dd className={`mt-0.5 text-[#1B4676] ${mono ? 'font-mono' : ''}`}>
        {to ? (
          <Link to={to} className="hover:text-[#0093D0] underline decoration-dotted">
            {v}
          </Link>
        ) : (
          v
        )}
      </dd>
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
        className="inline-block w-2 h-2 rounded-full bg-[#0093D0] animate-pulse"
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
