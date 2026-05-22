import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  api,
  ApiError,
  type DriverDocsExtraction,
  type OutboundContainerRead,
  type OutboundLineInput,
  type OutboundOrderRead,
  type OutboundOrderListItem,
  type PickingTicketExtraction,
} from '../api/client'
import Spinner from '../components/Spinner'
import { useVendorAuth } from '../auth/VendorAuthContext'

/** Map a vendor user's company onto the new Transfer Order. */
function useVendorCompany(): string {
  const { user } = useVendorAuth()
  return user?.company || ''
}

// ─── 4-card chooser under OUTBOUND ─────────────────────────────────────
// Same shape as the inbound ModeChooser (rich icon tiles + meta strip +
// dark CTA bar) but with the navy/yellow palette instead of cyan, to
// signal that outbound is the "ship-out" half of the portal.

export function OutboundModeChooser({
  onChoose,
  onBack,
}: {
  onChoose: (m: 'out_new' | 'out_driver' | 'out_update' | 'out_view') => void
  onBack: () => void
}) {
  return (
    <OutboundShell breadcrumb="Outbound — select workflow" onBack={onBack}>
      <main className="relative z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
          {/* Hero */}
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#1B4676]/10 border border-[#1B4676]/30 text-[#1B4676] text-[11px] font-semibold tracking-[0.14em] uppercase mb-5">
              <span className="w-1.5 h-1.5 rounded-full bg-[#1B4676]" aria-hidden />
              Outbound
            </div>
            <h1 className="text-3xl sm:text-4xl lg:text-[2.75rem] font-bold tracking-tight text-[#1B4676] leading-[1.1]">
              What are you sending out today?
            </h1>
            <p className="mt-4 text-base sm:text-lg text-slate-600 max-w-2xl leading-relaxed">
              Pick the outbound workflow that matches your shipment. Conquer Nation
              operations is notified the moment your Transfer Order lands in our system.
            </p>
            <p className="mt-3 text-[11px] uppercase tracking-[0.22em] text-slate-400 font-semibold">
              Logistics Simplified.
            </p>
          </div>

          {/* Cards */}
          <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 items-stretch">
            <OutboundIntakeCard
              icon={<OutPackageIcon className="w-6 h-6" />}
              eyebrow="Order"
              title="New outbound order"
              description="Submit a Transfer Order / Picking Ticket — destination, SKU lines, optional specific serials. Internal PO# is auto-issued."
              metaLeft={{ icon: <OutClockIcon className="w-3.5 h-3.5" />, label: '~2 min' }}
              metaRight={{ icon: <OutHashIcon className="w-3.5 h-3.5" />, label: 'TO #' }}
              ctaLabel="Start new order"
              onClick={() => onChoose('out_new')}
            />
            <OutboundIntakeCard
              icon={<OutTruckIcon className="w-6 h-6" />}
              eyebrow="Driver"
              title="Driver & truck info"
              description="Attach an outbound container (BIC or truck) and driver / carrier / insurance / BOL. Upload photos to auto-fill."
              metaLeft={{ icon: <OutClockIcon className="w-3.5 h-3.5" />, label: '~1 min' }}
              metaRight={{ icon: <OutContainerIcon className="w-3.5 h-3.5" />, label: 'Container #' }}
              ctaLabel="Add driver details"
              onClick={() => onChoose('out_driver')}
            />
            <OutboundIntakeCard
              icon={<OutEditIcon className="w-6 h-6" />}
              eyebrow="Amend"
              title="Update order"
              description="Amend an open Transfer Order — fix destination, change lines, swap driver info, before picking starts."
              metaLeft={{ icon: <OutClockIcon className="w-3.5 h-3.5" />, label: '~1 min' }}
              metaRight={{ icon: <OutHashIcon className="w-3.5 h-3.5" />, label: 'TO #' }}
              ctaLabel="Update order"
              onClick={() => onChoose('out_update')}
            />
            <OutboundIntakeCard
              icon={<OutEyeIcon className="w-6 h-6" />}
              eyebrow="Review"
              title="View order"
              description="Pull up a Transfer Order to see lines, picked counts, attached containers, and driver details on file."
              metaLeft={{ icon: <OutClockIcon className="w-3.5 h-3.5" />, label: '~30 sec' }}
              metaRight={{ icon: <OutHashIcon className="w-3.5 h-3.5" />, label: 'TO #' }}
              ctaLabel="View order"
              onClick={() => onChoose('out_view')}
            />
          </div>

          {/* Support strip */}
          <section
            aria-label="Operations support"
            className="mt-12 rounded-xl border border-slate-200 bg-white p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center gap-5 sm:gap-8 shadow-sm"
          >
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-md bg-[#1B4676]/10 flex items-center justify-center text-[#1B4676]"
                aria-hidden
              >
                <OutHelpIcon className="w-5 h-5" />
              </div>
              <div className="leading-tight">
                <div className="text-sm font-bold text-[#1B4676]">Need help shipping out?</div>
                <div className="text-xs text-slate-500">
                  Ops keeps a real human on call during warehouse hours.
                </div>
              </div>
            </div>
            <div className="sm:ml-auto flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-600">
              <a
                href="tel:+13106786768"
                className="inline-flex items-center gap-1.5 hover:text-[#1B4676] font-semibold"
              >
                <OutPhoneIcon className="w-3.5 h-3.5 text-[#1B4676]" />
                <span>(310) 678-6768</span>
              </a>
              <a
                href="mailto:developer@conquernation.com"
                className="inline-flex items-center gap-1.5 hover:text-[#1B4676] font-semibold"
              >
                <OutMailIcon className="w-3.5 h-3.5 text-[#1B4676]" />
                <span>developer@conquernation.com</span>
              </a>
            </div>
          </section>
        </div>
      </main>
    </OutboundShell>
  )
}

function OutboundIntakeCard({
  icon,
  eyebrow,
  title,
  description,
  metaLeft,
  metaRight,
  ctaLabel,
  onClick,
}: {
  icon: ReactNode
  eyebrow: string
  title: string
  description: string
  metaLeft: { icon: ReactNode; label: string }
  metaRight: { icon: ReactNode; label: string }
  ctaLabel: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative h-full flex flex-col text-left rounded-xl bg-white border border-slate-200 hover:border-[#1B4676]/50 transition-all overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1B4676] focus-visible:ring-offset-2"
      style={{
        boxShadow:
          '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
      }}
    >
      <div className="p-6 flex-1 flex flex-col">
        <div className="flex items-start justify-between gap-3">
          <div
            className="w-12 h-12 rounded-lg bg-[#1B4676] flex items-center justify-center text-white group-hover:bg-[#0B1828] transition flex-shrink-0"
            aria-hidden
          >
            {icon}
          </div>
          <span className="text-[10.5px] uppercase tracking-[0.18em] text-slate-500 font-semibold text-right">
            {eyebrow}
          </span>
        </div>
        <h2 className="mt-6 text-xl font-bold text-[#1B4676] leading-snug min-h-[3.5rem]">
          {title}
        </h2>
        <p className="mt-2 text-sm text-slate-600 leading-relaxed flex-1">
          {description}
        </p>
        <div className="mt-6 flex items-center gap-3 text-xs text-slate-500 flex-wrap">
          <span className="inline-flex items-center gap-1.5">
            {metaLeft.icon}
            <span className="whitespace-nowrap">{metaLeft.label}</span>
          </span>
          <span className="w-px h-3 bg-slate-200" aria-hidden />
          <span className="inline-flex items-center gap-1.5">
            {metaRight.icon}
            <span className="whitespace-nowrap">{metaRight.label}</span>
          </span>
        </div>
      </div>
      {/* Navy CTA bar — outbound's dark counterpart to the inbound cyan bar */}
      <div
        className="px-6 py-4 flex items-center justify-between gap-2 transition text-white"
        style={{
          background: 'linear-gradient(90deg, #1B4676 0%, #0B1828 100%)',
        }}
      >
        <span className="font-bold text-sm leading-tight">{ctaLabel}</span>
        <OutArrowRightIcon className="w-4 h-4 group-hover:translate-x-1 transition-transform flex-shrink-0" />
      </div>
    </button>
  )
}

// ─── Inline icons for the outbound chooser ─────────────────────────────
// Lucide-style, 24x24, currentColor stroke. Duplicated locally (rather
// than imported from VendorIntakePage) so OutboundComponents stays
// self-contained.

function OutIcon({ children, className }: { children: ReactNode; className?: string }) {
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

function OutPackageIcon({ className }: { className?: string }) {
  return (
    <OutIcon className={className}>
      <path d="m16 16 4-4-4-4" />
      <path d="M20 12H8" />
      <path d="M4 4v16h12V4z" />
    </OutIcon>
  )
}
function OutTruckIcon({ className }: { className?: string }) {
  return (
    <OutIcon className={className}>
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
      <path d="M15 18H9" />
      <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
      <circle cx="17" cy="18" r="2" />
      <circle cx="7" cy="18" r="2" />
    </OutIcon>
  )
}
function OutEditIcon({ className }: { className?: string }) {
  return (
    <OutIcon className={className}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </OutIcon>
  )
}
function OutEyeIcon({ className }: { className?: string }) {
  return (
    <OutIcon className={className}>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </OutIcon>
  )
}
function OutClockIcon({ className }: { className?: string }) {
  return (
    <OutIcon className={className}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </OutIcon>
  )
}
function OutHashIcon({ className }: { className?: string }) {
  return (
    <OutIcon className={className}>
      <line x1="4" x2="20" y1="9" y2="9" />
      <line x1="4" x2="20" y1="15" y2="15" />
      <line x1="10" x2="8" y1="3" y2="21" />
      <line x1="16" x2="14" y1="3" y2="21" />
    </OutIcon>
  )
}
function OutContainerIcon({ className }: { className?: string }) {
  return (
    <OutIcon className={className}>
      <path d="M22 7.7c0-.6-.4-1.2-.8-1.5l-6.3-3.9a1.72 1.72 0 0 0-1.9 0l-10 6c-.5.3-.9.9-.9 1.5v8.1c0 .5.4 1.2.8 1.5l6.3 3.9a1.72 1.72 0 0 0 1.9 0l10-6c.5-.3.9-.9.9-1.5Z" />
      <path d="M10 21.9V14L2.1 9.1" />
      <path d="m10 14 11.9-6.9" />
      <path d="M14 19.5V8.5" />
    </OutIcon>
  )
}
function OutArrowRightIcon({ className }: { className?: string }) {
  return (
    <OutIcon className={className}>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </OutIcon>
  )
}
function OutHelpIcon({ className }: { className?: string }) {
  return (
    <OutIcon className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </OutIcon>
  )
}
function OutPhoneIcon({ className }: { className?: string }) {
  return (
    <OutIcon className={className}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92Z" />
    </OutIcon>
  )
}
function OutMailIcon({ className }: { className?: string }) {
  return (
    <OutIcon className={className}>
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </OutIcon>
  )
}

// ─── Shell + breadcrumb ────────────────────────────────────────────────

function OutboundShell({
  breadcrumb,
  onBack,
  children,
}: {
  breadcrumb: string
  onBack?: () => void
  children: ReactNode
}) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <nav aria-label="Breadcrumb" className="border-b border-slate-200 bg-white">
        <ol className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center gap-2 text-sm text-slate-500">
          <li className="flex items-center gap-2">
            {onBack ? (
              <button
                type="button"
                onClick={onBack}
                className="hover:text-[#1B4676] hover:underline"
              >
                Vendor Portal
              </button>
            ) : (
              <span>Vendor Portal</span>
            )}
          </li>
          <li aria-hidden>›</li>
          <li aria-current="page" className="text-[#1B4676] font-semibold">
            {breadcrumb}
          </li>
        </ol>
      </nav>
      <main>{children}</main>
    </div>
  )
}

// ─── Email-paste parser ────────────────────────────────────────────────
//
// Customer emails a list like:
//   TO21787 - LPN-001769 - Scooters - 3 units - Long Island City
//   TO21788 - LPN-001770 - Batteries - 50 units - LA Hub
//   TO21787 - LPN-001771 - Helmets - 25 units - Long Island City
//
// Columns: TO# | SKU | Product Type | Qty (with optional "units"/"ea") | Destination
//
// Same TO# = multiple lines on one order. Destination from the first row
// of that TO# wins (subsequent rows with the same TO# but a different
// destination are flagged as a soft warning in the preview).

export interface ParsedOutboundLine {
  raw: string
  line_idx: number
  transfer_order_no: string
  sku: string
  product_type: string
  qty: number
  destination: string
  error: string | null
}

export interface ParsedOutboundOrder {
  transfer_order_no: string
  destination: string
  lines: ParsedOutboundLine[]
  warning: string | null
}

const QTY_RE = /([0-9]+)/

export function parseOutboundPaste(text: string): {
  lines: ParsedOutboundLine[]
  orders: ParsedOutboundOrder[]
} {
  const out: ParsedOutboundLine[] = []
  const raws = text.split(/\r?\n/)
  let idx = 0
  for (const raw of raws) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    idx += 1
    // Split on dash variants (- — –) or pipes, with flexible whitespace
    const parts = trimmed.split(/\s*[-—–|]\s*/).map((p) => p.trim()).filter(Boolean)
    if (parts.length < 5) {
      out.push({
        raw: trimmed,
        line_idx: idx,
        transfer_order_no: '',
        sku: '',
        product_type: '',
        qty: 0,
        destination: '',
        error: `Need 5 columns (TO# - SKU - Product Type - Qty - Destination); got ${parts.length}.`,
      })
      continue
    }
    // First 4 fixed, destination is everything past field 4 rejoined
    const [tno, sku, ptype, qtyRaw, ...rest] = parts
    const destination = rest.join(' - ')
    const qtyMatch = qtyRaw.match(QTY_RE)
    if (!qtyMatch) {
      out.push({
        raw: trimmed,
        line_idx: idx,
        transfer_order_no: tno,
        sku,
        product_type: ptype,
        qty: 0,
        destination,
        error: `Couldn't read a quantity from "${qtyRaw}".`,
      })
      continue
    }
    out.push({
      raw: trimmed,
      line_idx: idx,
      transfer_order_no: tno.toUpperCase(),
      sku: sku.toUpperCase(),
      product_type: ptype,
      qty: parseInt(qtyMatch[1], 10),
      destination,
      error: null,
    })
  }

  // Group by TO#
  const byTno = new Map<string, ParsedOutboundLine[]>()
  for (const l of out) {
    if (l.error || !l.transfer_order_no) continue
    const arr = byTno.get(l.transfer_order_no) || []
    arr.push(l)
    byTno.set(l.transfer_order_no, arr)
  }
  const orders: ParsedOutboundOrder[] = []
  for (const [tno, lines] of byTno) {
    const dest = lines[0].destination
    const mismatch = lines.find((l) => l.destination !== dest)
    orders.push({
      transfer_order_no: tno,
      destination: dest,
      lines,
      warning: mismatch
        ? `Lines on ${tno} have mixed destinations (using "${dest}" for the order).`
        : null,
    })
  }
  return { lines: out, orders }
}

// ─── Form-line draft (manual + paste-derived) ──────────────────────────

interface LineDraft {
  id: string
  line_no: number
  sku: string
  description: string
  order_qty: string
  unit: string
  serial_specific: boolean
  serials: string
}

function emptyLine(line_no: number): LineDraft {
  return {
    id: crypto.randomUUID(),
    line_no,
    sku: '',
    description: '',
    order_qty: '',
    unit: 'EA',
    serial_specific: false,
    serials: '',
  }
}

// ─── New Outbound Order form (paste-driven) ────────────────────────────

export function OutboundNewOrderForm({ onBack }: { onBack: () => void }) {
  const company = useVendorCompany()
  const [tno, setTno] = useState('')
  const [orderDate, setOrderDate] = useState('')
  const [priority, setPriority] = useState<'normal' | 'urgent'>('normal')
  const [memo, setMemo] = useState('')
  const [shipFromName, setShipFromName] = useState('Conquer Nation Inc')
  const [shipFromAddress, setShipFromAddress] = useState(
    '2651 E 12 St\nVernon CA 90023\nUnited States',
  )
  const [shipToName, setShipToName] = useState('')
  const [shipToAddress, setShipToAddress] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(1)])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ tno: string; po: string | null; lines: number } | null>(null)

  // Picking-ticket upload state
  const pickingFileRef = useRef<HTMLInputElement | null>(null)
  const [pickingBusy, setPickingBusy] = useState(false)
  const [pickingError, setPickingError] = useState<string | null>(null)
  const [pickingExtract, setPickingExtract] = useState<PickingTicketExtraction | null>(null)
  const [pickingFilename, setPickingFilename] = useState<string | null>(null)

  async function handlePickingTicketUpload(file: File) {
    setPickingError(null)
    setPickingExtract(null)
    setPickingFilename(file.name)
    setPickingBusy(true)
    try {
      const result = await api.extractPickingTicket(file)
      setPickingExtract(result)
      // Auto-fill any fields that came back — never overwrite something
      // the user already typed.
      if (result.ship_to_name && !shipToName.trim()) setShipToName(result.ship_to_name)
      if (result.ship_to_address && !shipToAddress.trim())
        setShipToAddress(result.ship_to_address)
      if (result.ship_from_name && !shipFromName.trim())
        setShipFromName(result.ship_from_name)
      if (result.ship_from_address && shipFromAddress.trim() === '2651 E 12 St\nVernon CA 90023\nUnited States') {
        // Replace the default Ship-From only if user hasn't changed it
        setShipFromAddress(result.ship_from_address)
      }
      if (result.transfer_order_no && !tno.trim()) setTno(result.transfer_order_no)
      if (result.order_date && !orderDate) setOrderDate(result.order_date)
      if (result.memo && !memo.trim()) setMemo(result.memo)
      if (result.priority && (result.priority === 'urgent' || result.priority === 'normal')) {
        setPriority(result.priority)
      }
      // Auto-fill lines if the form still has a single empty line
      const formIsEmpty =
        lines.length === 1 && !lines[0].sku.trim() && !lines[0].order_qty.trim()
      if (result.lines.length > 0 && formIsEmpty) {
        setLines(
          result.lines.map((l, i) => ({
            id: crypto.randomUUID(),
            line_no: i + 1,
            sku: l.sku,
            description: l.description || '',
            order_qty: String(l.order_qty),
            unit: l.unit || 'EA',
            serial_specific: false,
            serials: '',
          })),
        )
      }
    } catch (e) {
      setPickingError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setPickingBusy(false)
    }
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine(prev.length + 1)])
  }
  function removeLine(id: string) {
    setLines((prev) =>
      prev
        .filter((l) => l.id !== id)
        .map((l, i) => ({ ...l, line_no: i + 1 })),
    )
  }
  function update<K extends keyof LineDraft>(
    id: string,
    k: K,
    v: LineDraft[K],
  ) {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, [k]: v } : l)))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!tno.trim()) return setError('Transfer Order # is required.')
    if (!shipToName.trim() && !shipToAddress.trim())
      return setError('Ship-To destination is required.')
    if (lines.length === 0) return setError('At least one line item is required.')
    const cleanLines: OutboundLineInput[] = []
    for (const l of lines) {
      if (!l.sku.trim() || !l.order_qty.trim()) {
        return setError(`Line ${l.line_no}: SKU and Order Qty are required.`)
      }
      const qty = parseInt(l.order_qty, 10)
      if (Number.isNaN(qty) || qty < 1)
        return setError(`Line ${l.line_no}: Order Qty must be a positive integer.`)
      const serials = l.serial_specific
        ? l.serials
            .split(/[\s,;]+/)
            .map((s) => s.trim())
            .filter(Boolean)
        : []
      if (l.serial_specific && serials.length !== qty) {
        return setError(
          `Line ${l.line_no}: serial-specific requires exactly ${qty} serials (got ${serials.length}).`,
        )
      }
      cleanLines.push({
        line_no: l.line_no,
        sku: l.sku.trim(),
        description: l.description.trim() || null,
        order_qty: qty,
        unit: l.unit.trim() || 'EA',
        serial_specific: l.serial_specific,
        serials: l.serial_specific ? serials : null,
      })
    }

    setBusy(true)
    try {
      const res = await api.submitOutboundOrder({
        transfer_order_no: tno.trim(),
        customer: company,
        order_date: orderDate || null,
        priority,
        memo: memo.trim() || null,
        ship_from_name: shipFromName.trim() || null,
        ship_from_address: shipFromAddress.trim() || null,
        ship_to_name: shipToName.trim() || null,
        ship_to_address: shipToAddress.trim() || null,
        lines: cleanLines,
        notes: notes.trim() || null,
      })
      setDone({ tno: res.transfer_order_no, po: res.po_number, lines: cleanLines.length })
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <OutboundShell breadcrumb="Outbound — order submitted" onBack={onBack}>
        <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          <div className="bg-white rounded-2xl border border-emerald-200 p-8 text-center">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 text-[11px] font-bold uppercase tracking-wider mb-4">
              Submitted
            </div>
            <h2 className="text-3xl font-bold text-[#1B4676]">
              Transfer Order recorded
            </h2>
            <p className="mt-3 text-slate-600">
              Customer TO{' '}
              <span className="font-mono font-bold text-[#1B4676]">
                {done.tno}
              </span>{' '}
              · {done.lines} line{done.lines === 1 ? '' : 's'}
            </p>
            {done.po && (
              <p className="mt-1 text-sm text-slate-600">
                Internal Pickup Order:{' '}
                <span className="font-mono font-bold text-[#1B4676]">
                  {done.po}
                </span>
              </p>
            )}
            <button
              type="button"
              onClick={onBack}
              className="mt-6 inline-flex items-center gap-2 rounded-full bg-[#1B4676] hover:bg-[#224E72] text-white font-bold px-6 py-3 text-sm transition"
            >
              Back to outbound menu
            </button>
          </div>
        </div>
      </OutboundShell>
    )
  }

  const haveExtract = !!pickingExtract && !pickingError
  const filledFields = haveExtract
    ? [
        pickingExtract?.transfer_order_no && 'TO#',
        pickingExtract?.order_date && 'Date',
        pickingExtract?.ship_to_name && 'Ship-to',
        pickingExtract && pickingExtract.lines.length > 0 && `${pickingExtract.lines.length} line${pickingExtract.lines.length === 1 ? '' : 's'}`,
      ].filter(Boolean)
    : []

  return (
    <OutboundShell breadcrumb="Outbound — new order" onBack={onBack}>
      <form onSubmit={submit} className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#1B4676]">
            New outbound order
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Submitting on behalf of{' '}
            <span className="font-semibold">{company || '(no company)'}</span>.
            Upload the picking ticket and we'll fill in the rest.
          </p>
        </div>

        {/* Hidden file input shared by the upload card + re-upload links */}
        <input
          ref={pickingFileRef}
          type="file"
          accept="application/pdf,image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) handlePickingTicketUpload(f)
            if (pickingFileRef.current) pickingFileRef.current.value = ''
          }}
        />

        {/* Picking-ticket upload card */}
        <button
          type="button"
          onClick={() => pickingFileRef.current?.click()}
          disabled={pickingBusy}
          className={`w-full rounded-2xl border-2 border-dashed transition p-6 sm:p-8 text-left ${
            haveExtract
              ? 'border-emerald-300 bg-emerald-50/40 hover:bg-emerald-50'
              : 'border-[#1B4676]/30 bg-[#1B4676]/[0.03] hover:bg-[#1B4676]/[0.06]'
          } disabled:opacity-60 disabled:cursor-wait`}
        >
          <div className="flex items-start gap-4">
            <div
              className={`shrink-0 w-12 h-12 rounded-full grid place-items-center font-bold text-xl ${
                haveExtract ? 'bg-emerald-100 text-emerald-700' : 'bg-[#FED641] text-[#1B4676]'
              }`}
              aria-hidden
            >
              {haveExtract ? '✓' : '↥'}
            </div>
            <div className="flex-1 min-w-0">
              {pickingBusy ? (
                <div className="flex items-center gap-2 text-[#1B4676] font-semibold">
                  <Spinner size={16} className="text-[#1B4676]" />
                  <span>Reading picking ticket…</span>
                </div>
              ) : haveExtract ? (
                <>
                  <div className="font-semibold text-emerald-900">
                    Picking ticket read{pickingFilename ? `: ${pickingFilename}` : ''}
                  </div>
                  <div className="mt-0.5 text-sm text-emerald-800">
                    {filledFields.length > 0
                      ? `Filled: ${filledFields.join(' · ')}. Review below.`
                      : 'No fields were extracted — fill in manually below.'}
                  </div>
                  <div className="mt-1 text-xs text-emerald-700 underline">
                    Upload a different file
                  </div>
                </>
              ) : (
                <>
                  <div className="font-semibold text-[#1B4676]">
                    Upload picking ticket (PDF or image)
                  </div>
                  <div className="mt-0.5 text-sm text-slate-600">
                    We'll extract the TO#, ship-to address, and all line items.
                    You can correct anything afterward.
                  </div>
                </>
              )}
            </div>
          </div>
        </button>

        {pickingError && (
          <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5">
            Couldn't read{pickingFilename ? ` ${pickingFilename}` : ' the file'}: {pickingError}
          </div>
        )}

        {/* Compact review/edit panel — every field is editable but visually
            calm. Fields the extractor missed get an amber dot indicator. */}
        <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
            <div className="sm:col-span-4">
              <CompactField label="Transfer Order #" required missing={haveExtract && !tno}>
                <Input value={tno} onChange={setTno} placeholder="TO21787" />
              </CompactField>
            </div>
            <div className="sm:col-span-4">
              <CompactField label="Order date">
                <Input type="date" value={orderDate} onChange={setOrderDate} />
              </CompactField>
            </div>
            <div className="sm:col-span-4">
              <CompactField label="Priority">
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as 'normal' | 'urgent')}
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
                >
                  <option value="normal">Normal</option>
                  <option value="urgent">Urgent</option>
                </select>
              </CompactField>
            </div>
            {(memo || haveExtract) && (
              <div className="sm:col-span-12">
                <CompactField label="Memo">
                  <Input value={memo} onChange={setMemo} placeholder="e.g., OD: Strategic Deployment" />
                </CompactField>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-12 gap-4 pt-1 border-t border-slate-100">
            <div className="sm:col-span-5">
              <CompactField label="Ship to" required missing={haveExtract && !shipToName && !shipToAddress}>
                <Input
                  value={shipToName}
                  onChange={setShipToName}
                  placeholder="OPS - US - NEW YORK - Long Island City"
                />
              </CompactField>
            </div>
            <div className="sm:col-span-7">
              <CompactField label="Address">
                <Textarea
                  value={shipToAddress}
                  onChange={setShipToAddress}
                  rows={2}
                  placeholder="48-29 31st Place&#10;Long Island City NY 11101"
                />
              </CompactField>
            </div>
          </div>
        </div>

        {/* Line items — compact table */}
        <Section
          title="Lines"
          right={
            <button
              type="button"
              onClick={addLine}
              className="inline-flex items-center gap-1 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold px-2.5 py-1 transition"
            >
              + Add
            </button>
          }
        >
          <div className="overflow-x-auto -mx-2 sm:mx-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10.5px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
                  <th className="py-2 pl-2 pr-2 font-semibold w-10">#</th>
                  <th className="py-2 pr-2 font-semibold">SKU</th>
                  <th className="py-2 pr-2 font-semibold">Description</th>
                  <th className="py-2 pr-2 font-semibold w-20 text-right">Qty</th>
                  <th className="py-2 pr-2 font-semibold w-16">Unit</th>
                  <th className="py-2 pr-2 font-semibold w-10" aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <Fragment key={line.id}>
                    <tr className="border-b border-slate-100 align-top">
                      <td className="py-2 pl-2 pr-2 text-slate-500 font-mono pt-3">{line.line_no}</td>
                      <td className="py-2 pr-2">
                        <Input
                          value={line.sku}
                          onChange={(v) => update(line.id, 'sku', v)}
                          placeholder="LPN-001769"
                        />
                      </td>
                      <td className="py-2 pr-2">
                        <Input
                          value={line.description}
                          onChange={(v) => update(line.id, 'description', v)}
                          placeholder="Scooter Gen 4.1"
                        />
                      </td>
                      <td className="py-2 pr-2">
                        <Input
                          type="number"
                          value={line.order_qty}
                          onChange={(v) => update(line.id, 'order_qty', v)}
                          min={1}
                        />
                      </td>
                      <td className="py-2 pr-2">
                        <Input
                          value={line.unit}
                          onChange={(v) => update(line.id, 'unit', v)}
                          placeholder="EA"
                        />
                      </td>
                      <td className="py-2 pr-2 pt-3">
                        {lines.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeLine(line.id)}
                            className="text-red-600 hover:text-red-800 text-lg leading-none"
                            aria-label={`Remove line ${line.line_no}`}
                            title="Remove line"
                          >
                            ×
                          </button>
                        )}
                      </td>
                    </tr>
                    <tr className="border-b border-slate-100">
                      <td />
                      <td colSpan={5} className="pb-3 pr-2">
                        <label className="inline-flex items-center gap-2 text-xs text-slate-600">
                          <input
                            type="checkbox"
                            checked={line.serial_specific}
                            onChange={(e) =>
                              update(line.id, 'serial_specific', e.target.checked)
                            }
                            className="w-3.5 h-3.5"
                          />
                          Customer specified exact serials
                        </label>
                        {line.serial_specific && (
                          <Textarea
                            value={line.serials}
                            onChange={(v) => update(line.id, 'serials', v)}
                            rows={Math.min(6, Math.max(2, parseInt(line.order_qty || '1', 10)))}
                            placeholder={`${line.order_qty || '0'} serial${line.order_qty === '1' ? '' : 's'}, one per line`}
                          />
                        )}
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* Notes — the one truly manual field */}
        <Section title="Notes (optional)">
          <Textarea
            value={notes}
            onChange={setNotes}
            rows={2}
            placeholder="Anything else for ops…"
          />
        </Section>

        {/* Advanced: ship-from override (hidden behind disclosure — almost
            always defaults to Conquer Nation HQ or auto-extracts). */}
        <details className="text-sm">
          <summary className="cursor-pointer text-slate-500 hover:text-[#1B4676] text-xs font-semibold uppercase tracking-wider">
            Advanced: override ship-from
          </summary>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-12 gap-4">
            <div className="sm:col-span-5">
              <CompactField label="Ship-from name">
                <Input value={shipFromName} onChange={setShipFromName} />
              </CompactField>
            </div>
            <div className="sm:col-span-7">
              <CompactField label="Ship-from address">
                <Textarea value={shipFromAddress} onChange={setShipFromAddress} rows={2} />
              </CompactField>
            </div>
          </div>
        </details>

        {error && (
          <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onBack}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold px-5 py-3 text-sm transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-full bg-[#1B4676] hover:bg-[#224E72] disabled:bg-slate-300 text-white font-bold px-6 py-3 text-sm transition shadow-[0_8px_24px_-4px_rgba(27,70,118,0.45)]"
          >
            {busy ? (
              <>
                <Spinner size={16} className="text-white" />
                <span>Submitting…</span>
              </>
            ) : (
              <span>Submit Transfer Order</span>
            )}
          </button>
        </div>
      </form>
    </OutboundShell>
  )
}

function CompactField({
  label,
  required,
  missing,
  children,
}: {
  label: string
  required?: boolean
  missing?: boolean
  children: ReactNode
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          {label}
          {required && <span className="text-[#E6C200] ml-0.5">*</span>}
        </label>
        {missing && (
          <span
            className="text-[10px] font-bold uppercase tracking-wider text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded"
            title="The picking ticket didn't have this field — please fill it in."
          >
            needs you
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

// ─── Driver / truck attach ─────────────────────────────────────────────

export function OutboundDriverInfoForm({ onBack }: { onBack: () => void }) {
  const [tno, setTno] = useState('')
  const [driverName, setDriverName] = useState('')
  const [driverLicense, setDriverLicense] = useState('')
  const [driverPhone, setDriverPhone] = useState('')
  const [truckPlate, setTruckPlate] = useState('')
  const [carrier, setCarrier] = useState('')
  const [insurance, setInsurance] = useState('')
  const [bol, setBol] = useState('')
  const [scheduledArrival, setScheduledArrival] = useState('') // datetime-local
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ container: string } | null>(null)

  // Driver-docs upload state
  const docsFileRef = useRef<HTMLInputElement | null>(null)
  const [docsBusy, setDocsBusy] = useState(false)
  const [docsError, setDocsError] = useState<string | null>(null)
  const [docsExtract, setDocsExtract] = useState<DriverDocsExtraction | null>(null)
  const [docsCount, setDocsCount] = useState(0)

  async function handleDocsUpload(files: File[]) {
    if (!files.length) return
    setDocsError(null)
    setDocsExtract(null)
    setDocsCount(files.length)
    setDocsBusy(true)
    try {
      const result = await api.extractDriverDocs(files)
      setDocsExtract(result)
      // Non-destructive autofill — never overwrite a typed value.
      if (result.driver_name && !driverName.trim()) setDriverName(result.driver_name)
      if (result.driver_license && !driverLicense.trim())
        setDriverLicense(result.driver_license)
      if (result.driver_phone && !driverPhone.trim())
        setDriverPhone(result.driver_phone)
      if (result.truck_license_plate && !truckPlate.trim())
        setTruckPlate(result.truck_license_plate)
      if (result.carrier && !carrier.trim()) setCarrier(result.carrier)
      if (result.insurance && !insurance.trim()) setInsurance(result.insurance)
      if (result.bol_number && !bol.trim()) setBol(result.bol_number)
      if (result.scheduled_arrival_at && !scheduledArrival) {
        // Trim seconds + timezone if present so <input type="datetime-local"> accepts it.
        setScheduledArrival(result.scheduled_arrival_at.slice(0, 16))
      }
    } catch (e) {
      setDocsError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setDocsBusy(false)
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!tno.trim()) return setError('Transfer Order # is required.')
    setBusy(true)
    try {
      const res = await api.attachOutboundContainer(tno.trim(), {
        container_no: null, // backend auto-derives from plate / TO
        container_type: 'truck',
        driver_name: driverName.trim() || null,
        driver_license: driverLicense.trim() || null,
        driver_phone: driverPhone.trim() || null,
        truck_license_plate: truckPlate.trim() || null,
        carrier: carrier.trim() || null,
        insurance: insurance.trim() || null,
        bol_number: bol.trim() || null,
        scheduled_arrival_at: scheduledArrival
          ? new Date(scheduledArrival).toISOString()
          : null,
      })
      setDone({ container: res.container_no })
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <OutboundShell breadcrumb="Outbound — driver attached" onBack={onBack}>
        <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 text-[11px] font-bold uppercase tracking-wider mb-4">
            Saved
          </div>
          <h2 className="text-3xl font-bold text-[#1B4676]">Driver info recorded</h2>
          <p className="mt-3 text-slate-600">
            Container <span className="font-mono font-bold">{done.container}</span> is ready for loading.
          </p>
          <button
            type="button"
            onClick={onBack}
            className="mt-6 inline-flex items-center gap-2 rounded-full bg-[#1B4676] hover:bg-[#224E72] text-white font-bold px-6 py-3 text-sm transition"
          >
            Back to outbound menu
          </button>
        </div>
      </OutboundShell>
    )
  }

  return (
    <OutboundShell breadcrumb="Outbound — driver & truck" onBack={onBack}>
      <form onSubmit={submit} className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#1B4676]">
            Driver & truck info
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Tell us when the driver is arriving at the dock and who's driving.
            Upload the driver information sheet (and any supporting photos —
            CDL, insurance card, truck plate, BOL) and we'll OCR what we can.
            Everything below is optional except the TO #.
          </p>
        </div>

        {/* Driver-docs upload card */}
        <input
          ref={docsFileRef}
          type="file"
          accept="application/pdf,image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const list = e.target.files
            if (list && list.length > 0) handleDocsUpload(Array.from(list))
            if (docsFileRef.current) docsFileRef.current.value = ''
          }}
        />

        <button
          type="button"
          onClick={() => docsFileRef.current?.click()}
          disabled={docsBusy}
          className={`w-full rounded-2xl border-2 border-dashed transition p-5 sm:p-6 text-left ${
            docsExtract
              ? 'border-emerald-300 bg-emerald-50/40 hover:bg-emerald-50'
              : 'border-[#1B4676]/30 bg-[#1B4676]/[0.03] hover:bg-[#1B4676]/[0.06]'
          } disabled:opacity-60 disabled:cursor-wait`}
        >
          <div className="flex items-start gap-4">
            <div
              className={`shrink-0 w-11 h-11 rounded-full grid place-items-center font-bold text-lg ${
                docsExtract ? 'bg-emerald-100 text-emerald-700' : 'bg-[#FED641] text-[#1B4676]'
              }`}
              aria-hidden
            >
              {docsExtract ? '✓' : '↥'}
            </div>
            <div className="flex-1 min-w-0">
              {docsBusy ? (
                <div className="flex items-center gap-2 text-[#1B4676] font-semibold">
                  <Spinner size={16} className="text-[#1B4676]" />
                  <span>Reading {docsCount} document{docsCount === 1 ? '' : 's'}…</span>
                </div>
              ) : docsExtract ? (
                <>
                  <div className="font-semibold text-emerald-900">
                    Driver documents read ({docsCount} file{docsCount === 1 ? '' : 's'})
                  </div>
                  <div className="mt-0.5 text-sm text-emerald-800">
                    Fields below were prefilled from what we could read. Edit anything that's wrong; nothing's mandatory.
                  </div>
                  <div className="mt-1 text-xs text-emerald-700 underline">
                    Upload more / replace
                  </div>
                </>
              ) : (
                <>
                  <div className="font-semibold text-[#1B4676]">
                    Upload driver information sheet + photos
                  </div>
                  <div className="mt-0.5 text-sm text-slate-600">
                    Driver info sheet, CDL, insurance, plate, BOL — any combination, up to 6 files. We'll OCR all of them at once (including the scheduled arrival time).
                  </div>
                </>
              )}
            </div>
          </div>
        </button>

        {docsError && (
          <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5">
            Couldn't read the documents: {docsError}
          </div>
        )}

        <Section title="Transfer Order + arrival">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Transfer Order #" required>
              <Input value={tno} onChange={setTno} placeholder="TO21787" />
            </Field>
            <Field label="Driver arrives at dock">
              <input
                type="datetime-local"
                value={scheduledArrival}
                onChange={(e) => setScheduledArrival(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm text-slate-800 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
              />
            </Field>
            <Field label="Truck plate">
              <Input
                value={truckPlate}
                onChange={setTruckPlate}
                placeholder="1ABC234"
              />
            </Field>
            <Field label="BOL # / Tracking #">
              <Input value={bol} onChange={setBol} placeholder="e.g. 36185694" />
            </Field>
          </div>
        </Section>

        <Section title="Driver + carrier (all optional — fill what isn't auto-filled)">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Driver name">
              <Input value={driverName} onChange={setDriverName} />
            </Field>
            <Field label="Driver license #">
              <Input value={driverLicense} onChange={setDriverLicense} />
            </Field>
            <Field label="Driver phone">
              <Input value={driverPhone} onChange={setDriverPhone} />
            </Field>
            <Field label="Carrier">
              <Input value={carrier} onChange={setCarrier} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Insurance (policy # + provider)">
                <Input value={insurance} onChange={setInsurance} />
              </Field>
            </div>
          </div>
        </Section>

        {error && (
          <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onBack}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold px-5 py-3 text-sm transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-full bg-[#1B4676] hover:bg-[#224E72] disabled:bg-slate-300 text-white font-bold px-6 py-3 text-sm transition"
          >
            {busy ? (
              <>
                <Spinner size={16} className="text-white" />
                <span>Saving…</span>
              </>
            ) : (
              <span>Save driver info</span>
            )}
          </button>
        </div>
      </form>
    </OutboundShell>
  )
}

// ─── Update existing order ─────────────────────────────────────────────

export function OutboundUpdateOrderForm({ onBack }: { onBack: () => void }) {
  const company = useVendorCompany()
  const [stage, setStage] = useState<'lookup' | 'edit'>('lookup')
  const [tnoLookup, setTnoLookup] = useState('')
  const [lookupBusy, setLookupBusy] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [original, setOriginal] = useState<OutboundOrderRead | null>(null)

  // Editable form state — populated when an order loads
  const [orderDate, setOrderDate] = useState('')
  const [priority, setPriority] = useState<'normal' | 'urgent'>('normal')
  const [memo, setMemo] = useState('')
  const [shipFromName, setShipFromName] = useState('')
  const [shipFromAddress, setShipFromAddress] = useState('')
  const [shipToName, setShipToName] = useState('')
  const [shipToAddress, setShipToAddress] = useState('')
  const [notes, setNotes] = useState('')

  // Picking-ticket re-upload (refreshes editable order fields)
  const pickingFileRef = useRef<HTMLInputElement | null>(null)
  const [pickingBusy, setPickingBusy] = useState(false)
  const [pickingError, setPickingError] = useState<string | null>(null)
  const [pickingExtract, setPickingExtract] = useState<PickingTicketExtraction | null>(
    null,
  )

  // Inline container management — which container is being added/edited
  // by container.id, or 'new' for the add-flow, or null.
  const [editingContainerId, setEditingContainerId] = useState<number | 'new' | null>(
    null,
  )
  // Bumped after a successful container save → triggers a re-fetch of
  // `original` so the editable list reflects backend state.
  const [containersRefreshTick, setContainersRefreshTick] = useState(0)
  const [lines, setLines] = useState<LineDraft[]>([])

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ tno: string; po: string | null; lines: number } | null>(null)

  const locked = original
    ? original.status !== 'open' && original.status !== 'picking'
    : false
  const hasPickedLines = original
    ? original.lines.some((l) => l.picked_qty > 0)
    : false
  const hasContainers = original ? original.containers.length > 0 : false

  async function lookup(e: React.FormEvent) {
    e.preventDefault()
    setLookupError(null)
    if (!tnoLookup.trim()) {
      setLookupError('Enter a Transfer Order #.')
      return
    }
    setLookupBusy(true)
    try {
      const o = await api.viewOutboundOrder(tnoLookup.trim().toUpperCase())
      setOriginal(o)
      setOrderDate(o.order_date || '')
      setPriority((o.priority as 'normal' | 'urgent') || 'normal')
      setMemo(o.memo || '')
      setShipFromName(o.ship_from_name || '')
      setShipFromAddress(o.ship_from_address || '')
      setShipToName(o.ship_to_name || '')
      setShipToAddress(o.ship_to_address || '')
      setNotes(o.notes || '')
      setLines(
        o.lines.map((l, i) => ({
          id: crypto.randomUUID(),
          line_no: i + 1,
          sku: l.sku,
          description: l.description || '',
          order_qty: String(l.order_qty),
          unit: l.unit || 'EA',
          serial_specific: l.serial_specific,
          serials: (l.serials_requested || []).join('\n'),
        })),
      )
      setStage('edit')
    } catch (e) {
      setLookupError(
        e instanceof ApiError
          ? e.status === 404
            ? `Transfer Order ${tnoLookup.trim()} not found.`
            : e.detail
          : String(e),
      )
    } finally {
      setLookupBusy(false)
    }
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine(prev.length + 1)])
  }
  function removeLine(id: string) {
    setLines((prev) =>
      prev
        .filter((l) => l.id !== id)
        .map((l, i) => ({ ...l, line_no: i + 1 })),
    )
  }
  function update<K extends keyof LineDraft>(
    id: string,
    k: K,
    v: LineDraft[K],
  ) {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, [k]: v } : l)))
  }

  // Picking-ticket re-upload (Update flow) — same auto-fill behaviour
  // as the New order form: never overwrites a value the vendor has
  // already typed in the form.
  async function handlePickingTicketReupload(file: File) {
    setPickingError(null)
    setPickingExtract(null)
    setPickingBusy(true)
    try {
      const result = await api.extractPickingTicket(file)
      setPickingExtract(result)
      if (result.ship_to_name && !shipToName.trim()) setShipToName(result.ship_to_name)
      if (result.ship_to_address && !shipToAddress.trim())
        setShipToAddress(result.ship_to_address)
      if (result.ship_from_name && !shipFromName.trim())
        setShipFromName(result.ship_from_name)
      if (result.ship_from_address && !shipFromAddress.trim())
        setShipFromAddress(result.ship_from_address)
      if (result.order_date && !orderDate) setOrderDate(result.order_date)
      if (result.memo && !memo.trim()) setMemo(result.memo)
      if (result.priority === 'urgent' || result.priority === 'normal') {
        setPriority(result.priority)
      }
      // Lines auto-populate only when the form has no real lines yet.
      const formIsEmpty =
        lines.length === 0 ||
        (lines.length === 1 && !lines[0].sku.trim() && !lines[0].order_qty.trim())
      if (result.lines.length > 0 && formIsEmpty) {
        setLines(
          result.lines.map((l, i) => ({
            id: crypto.randomUUID(),
            line_no: i + 1,
            sku: l.sku,
            description: l.description || '',
            order_qty: String(l.order_qty),
            unit: l.unit || 'EA',
            serial_specific: false,
            serials: '',
          })),
        )
      }
    } catch (e) {
      setPickingError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setPickingBusy(false)
    }
  }

  // Re-fetch the order after a container save so the inline list updates.
  useEffect(() => {
    if (!original || containersRefreshTick === 0) return
    let cancelled = false
    ;(async () => {
      try {
        const fresh = await api.viewOutboundOrder(original.transfer_order_no)
        if (!cancelled) setOriginal(fresh)
      } catch {
        /* leave the cached original — error already surfaced inline */
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containersRefreshTick])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!original) return
    setError(null)
    if (!shipToName.trim() && !shipToAddress.trim())
      return setError('Ship-To destination is required.')
    if (lines.length === 0) return setError('At least one line item is required.')
    const cleanLines: OutboundLineInput[] = []
    for (const l of lines) {
      if (!l.sku.trim() || !l.order_qty.trim()) {
        return setError(`Line ${l.line_no}: SKU and Order Qty are required.`)
      }
      const qty = parseInt(l.order_qty, 10)
      if (Number.isNaN(qty) || qty < 1)
        return setError(`Line ${l.line_no}: Order Qty must be a positive integer.`)
      const serials = l.serial_specific
        ? l.serials
            .split(/[\s,;]+/)
            .map((s) => s.trim())
            .filter(Boolean)
        : []
      if (l.serial_specific && serials.length !== qty) {
        return setError(
          `Line ${l.line_no}: serial-specific requires exactly ${qty} serials (got ${serials.length}).`,
        )
      }
      cleanLines.push({
        line_no: l.line_no,
        sku: l.sku.trim(),
        description: l.description.trim() || null,
        order_qty: qty,
        unit: l.unit.trim() || 'EA',
        serial_specific: l.serial_specific,
        serials: l.serial_specific ? serials : null,
      })
    }

    setBusy(true)
    try {
      const res = await api.updateOutboundOrder(original.transfer_order_no, {
        customer: company,
        order_date: orderDate || null,
        priority,
        memo: memo.trim() || null,
        ship_from_name: shipFromName.trim() || null,
        ship_from_address: shipFromAddress.trim() || null,
        ship_to_name: shipToName.trim() || null,
        ship_to_address: shipToAddress.trim() || null,
        lines: cleanLines,
        notes: notes.trim() || null,
      })
      setDone({ tno: res.transfer_order_no, po: res.po_number, lines: cleanLines.length })
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setBusy(false)
    }
  }

  function backToLookup() {
    setStage('lookup')
    setOriginal(null)
    setError(null)
    setDone(null)
  }

  // ── Success view
  if (done) {
    return (
      <OutboundShell breadcrumb="Outbound — order updated" onBack={onBack}>
        <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          <div className="bg-white rounded-2xl border border-emerald-200 p-8 text-center">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 text-[11px] font-bold uppercase tracking-wider mb-4">
              Updated
            </div>
            <h2 className="text-3xl font-bold text-[#1B4676]">
              Transfer Order amended
            </h2>
            <p className="mt-3 text-slate-600">
              Customer TO{' '}
              <span className="font-mono font-bold text-[#1B4676]">
                {done.tno}
              </span>{' '}
              · {done.lines} line{done.lines === 1 ? '' : 's'}
            </p>
            {done.po && (
              <p className="mt-1 text-sm text-slate-600">
                Internal Pickup Order:{' '}
                <span className="font-mono font-bold text-[#1B4676]">
                  {done.po}
                </span>
              </p>
            )}
            <div className="mt-6 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={backToLookup}
                className="inline-flex items-center gap-2 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold px-5 py-3 text-sm transition"
              >
                Amend another order
              </button>
              <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center gap-2 rounded-full bg-[#1B4676] hover:bg-[#224E72] text-white font-bold px-6 py-3 text-sm transition"
              >
                Back to outbound menu
              </button>
            </div>
          </div>
        </div>
      </OutboundShell>
    )
  }

  // ── Lookup stage
  if (stage === 'lookup') {
    return (
      <OutboundShell breadcrumb="Outbound — update order" onBack={onBack}>
        <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-6">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#1B4676]">
            Update outbound order
          </h1>
          <p className="text-sm text-slate-600">
            Enter the Transfer Order # you want to amend. Edits are only
            allowed while the order is{' '}
            <span className="font-semibold text-[#1B4676]">open</span> or{' '}
            <span className="font-semibold text-[#1B4676]">picking</span> — once
            it ships, the record is locked.
          </p>

          <form onSubmit={lookup} className="space-y-4">
            <Field label="Transfer Order #" required>
              <Input
                value={tnoLookup}
                onChange={(v) => setTnoLookup(v.toUpperCase())}
                placeholder="TO21787"
              />
            </Field>

            {lookupError && (
              <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5">
                {lookupError}
              </div>
            )}

            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onBack}
                disabled={lookupBusy}
                className="inline-flex items-center gap-2 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold px-5 py-3 text-sm transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={lookupBusy}
                className="inline-flex items-center gap-2 rounded-full bg-[#1B4676] hover:bg-[#224E72] disabled:bg-slate-300 text-white font-bold px-6 py-3 text-sm transition"
              >
                {lookupBusy ? (
                  <>
                    <Spinner size={16} className="text-white" />
                    <span>Looking up…</span>
                  </>
                ) : (
                  <span>Look up order</span>
                )}
              </button>
            </div>
          </form>
        </div>
      </OutboundShell>
    )
  }

  // ── Edit stage — original guaranteed non-null here
  return (
    <OutboundShell breadcrumb={`Outbound — amend ${original!.transfer_order_no}`} onBack={onBack}>
      <form onSubmit={submit} className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#1B4676]">
              Amend Transfer Order{' '}
              <span className="font-mono">{original!.transfer_order_no}</span>
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Submitting on behalf of{' '}
              <span className="font-semibold">{company || '(no company)'}</span>
              {original!.po_number && (
                <>
                  {' '}· Internal PO{' '}
                  <span className="font-mono font-semibold text-[#1B4676]">
                    {original!.po_number}
                  </span>
                </>
              )}
              .
            </p>
          </div>
          <button
            type="button"
            onClick={backToLookup}
            className="text-sm text-[#1B4676] hover:underline font-semibold"
          >
            ← Pick a different order
          </button>
        </div>

        {/* Status / lock banner */}
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            locked
              ? 'border-red-300 bg-red-50 text-red-800'
              : hasContainers || hasPickedLines
              ? 'border-amber-300 bg-amber-50 text-amber-900'
              : 'border-emerald-300 bg-emerald-50 text-emerald-900'
          }`}
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-semibold">
              Status:{' '}
              <span className="font-mono uppercase tracking-wider">{original!.status}</span>
            </span>
            <span>·</span>
            <span>{original!.lines.length} line{original!.lines.length === 1 ? '' : 's'}</span>
            <span>·</span>
            <span>
              {original!.containers.length} container
              {original!.containers.length === 1 ? '' : 's'}
            </span>
          </div>
          {locked && (
            <p className="mt-1">
              This order is {original!.status} — amendments are blocked. Cancel
              and re-submit a new TO if anything needs to change.
            </p>
          )}
          {!locked && hasPickedLines && (
            <p className="mt-1">
              ⚠ Some lines have items already picked. Reducing quantities or
              removing those lines may de-sync the pick. Talk to ops before
              submitting.
            </p>
          )}
          {!locked && !hasPickedLines && hasContainers && (
            <p className="mt-1">
              Containers are attached but no items picked yet — safe to amend.
            </p>
          )}
        </div>

        {/* Picking-ticket re-upload — same pattern as New order. Auto-fills
            the editable fields below from a fresh copy of the picking ticket. */}
        <input
          ref={pickingFileRef}
          type="file"
          accept="application/pdf,image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) handlePickingTicketReupload(f)
            if (pickingFileRef.current) pickingFileRef.current.value = ''
          }}
        />
        <button
          type="button"
          onClick={() => pickingFileRef.current?.click()}
          disabled={pickingBusy || locked}
          className={`w-full rounded-2xl border-2 border-dashed transition p-5 text-left ${
            pickingExtract && !pickingError
              ? 'border-emerald-300 bg-emerald-50/40 hover:bg-emerald-50'
              : 'border-[#1B4676]/30 bg-[#1B4676]/[0.03] hover:bg-[#1B4676]/[0.06]'
          } disabled:opacity-60 disabled:cursor-not-allowed`}
        >
          <div className="flex items-start gap-4">
            <div
              className={`shrink-0 w-11 h-11 rounded-full grid place-items-center font-bold text-lg ${
                pickingExtract && !pickingError
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-[#FED641] text-[#1B4676]'
              }`}
              aria-hidden
            >
              {pickingExtract && !pickingError ? '✓' : '↥'}
            </div>
            <div className="flex-1 min-w-0">
              {pickingBusy ? (
                <div className="flex items-center gap-2 text-[#1B4676] font-semibold">
                  <Spinner size={16} className="text-[#1B4676]" />
                  <span>Reading the picking ticket…</span>
                </div>
              ) : pickingExtract ? (
                <>
                  <div className="font-semibold text-emerald-900">
                    Updated picking ticket read
                  </div>
                  <div className="mt-0.5 text-sm text-emerald-800">
                    Anything you'd already changed below was preserved. Review and
                    save when ready.
                  </div>
                </>
              ) : (
                <>
                  <div className="font-semibold text-[#1B4676]">
                    Re-upload the picking ticket (PDF or image)
                  </div>
                  <div className="mt-0.5 text-sm text-slate-600">
                    Optional — if the customer sent a corrected ticket, drop it
                    here and we'll refresh the fields below.
                  </div>
                </>
              )}
            </div>
          </div>
        </button>
        {pickingError && (
          <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5">
            Couldn't read the picking ticket: {pickingError}
          </div>
        )}

        {/* Header */}
        <Section title="Order header">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Transfer Order #">
              <Input value={original!.transfer_order_no} onChange={() => {}} />
              <p className="mt-1 text-[11px] text-slate-500">TO # can't be changed.</p>
            </Field>
            <Field label="Order date">
              <Input type="date" value={orderDate} onChange={setOrderDate} />
            </Field>
            <Field label="Priority">
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as 'normal' | 'urgent')}
                disabled={locked}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none disabled:bg-slate-50 disabled:text-slate-400"
              >
                <option value="normal">Normal</option>
                <option value="urgent">Urgent</option>
              </select>
            </Field>
            <Field label="Memo">
              <Input value={memo} onChange={setMemo} />
            </Field>
          </div>
        </Section>

        <Section title="Ship from">
          <div className="grid grid-cols-1 gap-3">
            <Field label="Name">
              <Input value={shipFromName} onChange={setShipFromName} />
            </Field>
            <Field label="Address">
              <Textarea value={shipFromAddress} onChange={setShipFromAddress} rows={3} />
            </Field>
          </div>
        </Section>

        <Section title="Ship to">
          <div className="grid grid-cols-1 gap-3">
            <Field label="Destination name" required>
              <Input value={shipToName} onChange={setShipToName} />
            </Field>
            <Field label="Address">
              <Textarea value={shipToAddress} onChange={setShipToAddress} rows={3} />
            </Field>
          </div>
        </Section>

        <Section
          title="Line items"
          right={
            <button
              type="button"
              onClick={addLine}
              disabled={locked}
              className="inline-flex items-center gap-1.5 rounded-md bg-[#1B4676] hover:bg-[#224E72] disabled:bg-slate-300 text-white text-xs font-semibold px-3 py-1.5 transition"
            >
              + Add line
            </button>
          }
        >
          <div className="space-y-4">
            {lines.map((line) => {
              const origLine = original!.lines[line.line_no - 1]
              const pickedOnLine = origLine?.picked_qty ?? 0
              return (
                <div
                  key={line.id}
                  className="rounded-lg border border-slate-200 bg-slate-50/40 p-4 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <div className="text-xs uppercase tracking-wider font-bold text-slate-500">
                      Line {line.line_no}
                      {pickedOnLine > 0 && (
                        <span className="ml-2 text-amber-700 normal-case tracking-normal">
                          ({pickedOnLine} already picked)
                        </span>
                      )}
                    </div>
                    {lines.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeLine(line.id)}
                        disabled={locked}
                        className="text-xs text-red-600 hover:text-red-800 font-semibold disabled:text-slate-300"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-6 gap-3">
                    <div className="sm:col-span-2">
                      <Field label="SKU" required>
                        <Input
                          value={line.sku}
                          onChange={(v) => update(line.id, 'sku', v)}
                        />
                      </Field>
                    </div>
                    <div className="sm:col-span-3">
                      <Field label="Description">
                        <Input
                          value={line.description}
                          onChange={(v) => update(line.id, 'description', v)}
                        />
                      </Field>
                    </div>
                    <div>
                      <Field label="Qty" required>
                        <Input
                          type="number"
                          value={line.order_qty}
                          onChange={(v) => update(line.id, 'order_qty', v)}
                          min={1}
                        />
                      </Field>
                    </div>
                    <div>
                      <Field label="Unit">
                        <Input
                          value={line.unit}
                          onChange={(v) => update(line.id, 'unit', v)}
                        />
                      </Field>
                    </div>
                    <div className="sm:col-span-5 flex items-center gap-2">
                      <input
                        type="checkbox"
                        id={`ss-upd-${line.id}`}
                        checked={line.serial_specific}
                        onChange={(e) =>
                          update(line.id, 'serial_specific', e.target.checked)
                        }
                        className="w-4 h-4"
                      />
                      <label
                        htmlFor={`ss-upd-${line.id}`}
                        className="text-sm text-slate-700"
                      >
                        Customer specified exact serials for this line
                      </label>
                    </div>
                    {line.serial_specific && (
                      <div className="sm:col-span-6">
                        <Field
                          label={`Serial numbers (${line.order_qty || 0} required, one per line or comma-separated)`}
                        >
                          <Textarea
                            value={line.serials}
                            onChange={(v) => update(line.id, 'serials', v)}
                            rows={Math.min(8, Math.max(2, parseInt(line.order_qty || '1', 10)))}
                          />
                        </Field>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </Section>

        <Section title="Notes (optional)">
          <Textarea value={notes} onChange={setNotes} rows={3} />
        </Section>

        {/* Editable containers section */}
        <Section
          title="Trucks & driver info"
          right={
            !locked && editingContainerId !== 'new' && (
              <button
                type="button"
                onClick={() => setEditingContainerId('new')}
                className="inline-flex items-center gap-1.5 rounded-md bg-[#1B4676] hover:bg-[#224E72] text-white text-xs font-semibold px-3 py-1.5 transition"
              >
                + Add truck
              </button>
            )
          }
        >
          {original!.containers.length === 0 && editingContainerId !== 'new' && (
            <p className="text-sm text-slate-500 italic">
              No trucks attached yet. Click <span className="font-semibold">+ Add truck</span> to record the truck plate, driver info, BOL, and scheduled arrival time.
            </p>
          )}

          <div className="space-y-3">
            {original!.containers.map((c) => (
              <ContainerEditCard
                key={c.id}
                tno={original!.transfer_order_no}
                container={c}
                editing={editingContainerId === c.id}
                locked={locked}
                onStartEdit={() => setEditingContainerId(c.id)}
                onCancel={() => setEditingContainerId(null)}
                onSaved={() => {
                  setEditingContainerId(null)
                  setContainersRefreshTick((n) => n + 1)
                }}
              />
            ))}

            {editingContainerId === 'new' && (
              <ContainerEditCard
                tno={original!.transfer_order_no}
                container={null}
                editing
                locked={locked}
                onStartEdit={() => {}}
                onCancel={() => setEditingContainerId(null)}
                onSaved={() => {
                  setEditingContainerId(null)
                  setContainersRefreshTick((n) => n + 1)
                }}
              />
            )}
          </div>
        </Section>

        {error && (
          <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={backToLookup}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold px-5 py-3 text-sm transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || locked}
            className="inline-flex items-center gap-2 rounded-full bg-[#1B4676] hover:bg-[#224E72] disabled:bg-slate-300 text-white font-bold px-6 py-3 text-sm transition shadow-[0_8px_24px_-4px_rgba(27,70,118,0.45)]"
          >
            {busy ? (
              <>
                <Spinner size={16} className="text-white" />
                <span>Saving…</span>
              </>
            ) : (
              <span>{locked ? 'Amendments locked' : 'Save changes'}</span>
            )}
          </button>
        </div>
      </form>
    </OutboundShell>
  )
}

// ─── View existing order ───────────────────────────────────────────────

export function OutboundViewOrderForm({ onBack }: { onBack: () => void }) {
  const [tno, setTno] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [order, setOrder] = useState<OutboundOrderRead | null>(null)
  const [list, setList] = useState<OutboundOrderListItem[] | null>(null)

  useEffect(() => {
    let cancelled = false
    api.listMyOutboundOrders().then(
      (r) => !cancelled && setList(r.orders),
      () => !cancelled && setList([]),
    )
    return () => {
      cancelled = true
    }
  }, [])

  async function lookup(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!tno.trim()) return
    setBusy(true)
    try {
      const res = await api.viewOutboundOrder(tno.trim())
      setOrder(res)
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e))
      setOrder(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <OutboundShell breadcrumb="Outbound — view order" onBack={onBack}>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-6">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#1B4676]">
          View Transfer Order
        </h1>

        <form onSubmit={lookup} className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[200px]">
            <Field label="Transfer Order #">
              <Input value={tno} onChange={setTno} placeholder="TO21787" />
            </Field>
          </div>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-full bg-[#1B4676] hover:bg-[#224E72] disabled:bg-slate-300 text-white font-bold px-6 py-3 text-sm transition"
          >
            {busy ? <Spinner size={16} className="text-white" /> : 'Look up'}
          </button>
        </form>

        {error && (
          <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5">
            {error}
          </div>
        )}

        {order && (
          <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.14em] font-bold text-slate-500">
                  Customer Transfer Order
                </div>
                <h2 className="text-xl font-bold text-[#1B4676] font-mono">
                  {order.transfer_order_no}
                </h2>
                {order.po_number && (
                  <div className="mt-1 text-xs text-slate-600">
                    Internal PO:{' '}
                    <span className="font-mono font-bold text-[#1B4676]">
                      {order.po_number}
                    </span>
                  </div>
                )}
              </div>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700 text-xs font-semibold uppercase tracking-wider">
                {order.status}
              </span>
            </div>
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <Stat k="Customer" v={order.customer_name} />
              <Stat k="Order date" v={order.order_date ?? '—'} />
              <Stat k="Priority" v={order.priority} />
              <Stat k="Submitted" v={new Date(order.submitted_at).toLocaleString()} />
              <Stat k="Ship to" v={order.ship_to_name ?? '—'} />
              <Stat k="Memo" v={order.memo ?? '—'} />
            </dl>
            <div>
              <h3 className="text-sm font-bold text-[#1B4676] mb-2">Lines</h3>
              <table className="w-full text-sm border border-slate-200 rounded-md overflow-hidden">
                <thead className="bg-[#0B1828] text-white text-[10.5px] uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold">#</th>
                    <th className="text-left px-3 py-2 font-semibold">SKU</th>
                    <th className="text-left px-3 py-2 font-semibold">Description</th>
                    <th className="text-right px-3 py-2 font-semibold">Order qty</th>
                    <th className="text-right px-3 py-2 font-semibold">Picked</th>
                    <th className="text-left px-3 py-2 font-semibold">Unit</th>
                    <th className="text-left px-3 py-2 font-semibold">Serial-specific</th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((l) => (
                    <tr key={l.id} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-mono text-slate-500">{l.line_no}</td>
                      <td className="px-3 py-2 font-mono text-[#1B4676] font-bold">{l.sku}</td>
                      <td className="px-3 py-2 text-slate-700">{l.description ?? '—'}</td>
                      <td className="px-3 py-2 text-right font-mono">{l.order_qty}</td>
                      <td className="px-3 py-2 text-right font-mono">{l.picked_qty}</td>
                      <td className="px-3 py-2 text-slate-600">{l.unit}</td>
                      <td className="px-3 py-2 text-slate-600">{l.serial_specific ? 'Yes' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {order.containers.length > 0 && (
              <div>
                <h3 className="text-sm font-bold text-[#1B4676] mb-2">Attached containers</h3>
                <ul className="space-y-2 text-sm">
                  {order.containers.map((c) => (
                    <li
                      key={c.id}
                      className="rounded-md border border-slate-200 bg-slate-50/40 px-3 py-2 flex items-center justify-between"
                    >
                      <span className="font-mono font-bold text-[#1B4676]">
                        {c.container_no}
                        <span className="ml-2 text-xs uppercase font-semibold text-slate-500">
                          {c.container_type}
                        </span>
                      </span>
                      <span className="text-xs text-slate-500">
                        {c.driver_name ?? '—'} · {c.carrier ?? '—'} · BOL {c.bol_number ?? '—'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {!order && list && list.length > 0 && (
          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <h3 className="text-sm font-bold text-[#1B4676] mb-3">
              Your recent Transfer Orders
            </h3>
            <ul className="divide-y divide-slate-100 text-sm">
              {list.map((o) => (
                <li key={o.id} className="py-2 flex items-center justify-between gap-3">
                  <div className="flex flex-col">
                    <button
                      type="button"
                      onClick={() => {
                        setTno(o.transfer_order_no)
                        void lookup(new Event('submit') as unknown as React.FormEvent)
                      }}
                      className="text-left font-mono font-bold text-[#1B4676] hover:underline"
                    >
                      {o.transfer_order_no}
                    </button>
                    {o.po_number && (
                      <span className="text-[11px] font-mono text-slate-500">
                        PO: {o.po_number}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-slate-500">
                    {o.status} · {o.line_count} line{o.line_count === 1 ? '' : 's'} · {o.priority}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </OutboundShell>
  )
}

// ─── Tiny shared building blocks ───────────────────────────────────────

function Section({
  title,
  right,
  children,
}: {
  title: string
  right?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="bg-white rounded-xl border border-slate-200 p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-bold tracking-wider uppercase text-[#1B4676]">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-slate-700 mb-1">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </span>
      {children}
    </label>
  )
}

function Input({
  value,
  onChange,
  type,
  placeholder,
  min,
}: {
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
  min?: number
}) {
  return (
    <input
      type={type ?? 'text'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      min={min}
      className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
    />
  )
}

function Textarea({
  value,
  onChange,
  rows,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows ?? 3}
      placeholder={placeholder}
      className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
    />
  )
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider font-semibold text-slate-500">{k}</dt>
      <dd className="mt-0.5 text-sm text-slate-800">{v}</dd>
    </div>
  )
}

// ─── Container edit card (used inside OutboundUpdateOrderForm) ─────────
// One self-contained card per container — supports both "edit existing"
// and "add new" modes through the same component. Each card has its own
// driver-docs upload + save (calls api.attachOutboundContainer which is
// upsert by container_no). On success the parent reloads `original`.

function ContainerEditCard({
  tno,
  container,
  editing,
  locked,
  onStartEdit,
  onCancel,
  onSaved,
}: {
  tno: string
  container: OutboundContainerRead | null
  editing: boolean
  locked: boolean
  onStartEdit: () => void
  onCancel: () => void
  onSaved: () => void
}) {
  const isNew = container === null
  // container_no stays on existing rows so the upsert hits the right
  // OutboundContainer; for new attaches we pass null and let the backend
  // auto-derive it from the truck plate.
  const lockedContainerNo = container?.container_no ?? null
  const [driverName, setDriverName] = useState(container?.driver_name ?? '')
  const [driverLicense, setDriverLicense] = useState(container?.driver_license ?? '')
  const [driverPhone, setDriverPhone] = useState(container?.driver_phone ?? '')
  const [truckPlate, setTruckPlate] = useState(container?.truck_license_plate ?? '')
  const [carrier, setCarrier] = useState(container?.carrier ?? '')
  const [insurance, setInsurance] = useState(container?.insurance ?? '')
  const [bol, setBol] = useState(container?.bol_number ?? '')
  const [scheduledArrival, setScheduledArrival] = useState(
    container?.scheduled_arrival_at
      ? container.scheduled_arrival_at.slice(0, 16)
      : '',
  )

  const [docsBusy, setDocsBusy] = useState(false)
  const [docsError, setDocsError] = useState<string | null>(null)
  const [docsExtract, setDocsExtract] = useState<DriverDocsExtraction | null>(null)
  const [docsCount, setDocsCount] = useState(0)
  const docsFileRef = useRef<HTMLInputElement | null>(null)

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  async function handleDocsUpload(files: File[]) {
    if (!files.length) return
    setDocsError(null)
    setDocsCount(files.length)
    setDocsBusy(true)
    try {
      const result = await api.extractDriverDocs(files)
      setDocsExtract(result)
      if (result.driver_name && !driverName.trim()) setDriverName(result.driver_name)
      if (result.driver_license && !driverLicense.trim())
        setDriverLicense(result.driver_license)
      if (result.driver_phone && !driverPhone.trim())
        setDriverPhone(result.driver_phone)
      if (result.truck_license_plate && !truckPlate.trim())
        setTruckPlate(result.truck_license_plate)
      if (result.carrier && !carrier.trim()) setCarrier(result.carrier)
      if (result.insurance && !insurance.trim()) setInsurance(result.insurance)
      if (result.bol_number && !bol.trim()) setBol(result.bol_number)
      if (result.scheduled_arrival_at && !scheduledArrival) {
        setScheduledArrival(result.scheduled_arrival_at.slice(0, 16))
      }
    } catch (e) {
      setDocsError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setDocsBusy(false)
    }
  }

  async function save() {
    setSaveError(null)
    setSaving(true)
    try {
      await api.attachOutboundContainer(tno, {
        container_no: lockedContainerNo, // null for new (backend auto-derives)
        container_type: 'truck',
        driver_name: driverName.trim() || null,
        driver_license: driverLicense.trim() || null,
        driver_phone: driverPhone.trim() || null,
        truck_license_plate: truckPlate.trim() || null,
        carrier: carrier.trim() || null,
        insurance: insurance.trim() || null,
        bol_number: bol.trim() || null,
        scheduled_arrival_at: scheduledArrival
          ? new Date(scheduledArrival).toISOString()
          : null,
      })
      onSaved()
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setSaving(false)
    }
  }

  // Collapsed (read-only) summary mode for existing containers
  if (!editing && container) {
    const eta = container.scheduled_arrival_at
      ? new Date(container.scheduled_arrival_at).toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        })
      : null
    return (
      <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <div className="font-mono font-bold text-[#1B4676]">
          {container.truck_license_plate || container.container_no}
        </div>
        <span className="text-slate-600">·</span>
        <span className="text-slate-700">{container.driver_name || 'no driver'}</span>
        <span className="text-slate-600">·</span>
        <span className="text-slate-700">{container.carrier || 'no carrier'}</span>
        {eta && (
          <>
            <span className="text-slate-600">·</span>
            <span className="text-slate-700">
              <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mr-1">
                ETA
              </span>
              {eta}
            </span>
          </>
        )}
        <span className="text-slate-600">·</span>
        <span className="text-slate-500">BOL {container.bol_number || '—'}</span>
        {!locked && (
          <button
            type="button"
            onClick={onStartEdit}
            className="ml-auto text-xs font-bold text-[#1B4676] hover:underline"
          >
            Edit driver info
          </button>
        )}
      </div>
    )
  }

  // Expanded edit mode (also used for "new" container)
  return (
    <div className="rounded-lg border-2 border-[#1B4676]/30 bg-[#1B4676]/[0.02] p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs uppercase tracking-wider font-bold text-[#1B4676]">
          {isNew
            ? 'New truck'
            : `Editing ${container?.truck_license_plate || container?.container_no}`}
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-slate-500 hover:text-slate-800 font-semibold"
        >
          Cancel
        </button>
      </div>

      {/* Driver-docs upload */}
      <input
        ref={docsFileRef}
        type="file"
        accept="application/pdf,image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const list = e.target.files
          if (list && list.length > 0) handleDocsUpload(Array.from(list))
          if (docsFileRef.current) docsFileRef.current.value = ''
        }}
      />
      <button
        type="button"
        onClick={() => docsFileRef.current?.click()}
        disabled={docsBusy}
        className={`w-full rounded-lg border-2 border-dashed transition px-4 py-3 text-left text-sm ${
          docsExtract
            ? 'border-emerald-300 bg-emerald-50/40 hover:bg-emerald-50'
            : 'border-slate-300 bg-white hover:bg-slate-50'
        } disabled:opacity-60`}
      >
        {docsBusy ? (
          <span className="inline-flex items-center gap-2 text-[#1B4676] font-semibold">
            <Spinner size={14} className="text-[#1B4676]" />
            Reading {docsCount} document{docsCount === 1 ? '' : 's'}…
          </span>
        ) : docsExtract ? (
          <span className="text-emerald-800">
            <span className="font-semibold">✓ Documents read</span> ({docsCount} file{docsCount === 1 ? '' : 's'}) — fields prefilled below. Click to upload more.
          </span>
        ) : (
          <span className="text-[#1B4676]">
            <span className="font-semibold">↥ Upload driver photos</span>
            <span className="text-slate-600"> — license / insurance / plate / BOL. Auto-fills the fields below.</span>
          </span>
        )}
      </button>
      {docsError && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {docsError}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <CompactField label="Truck plate">
          <Input value={truckPlate} onChange={setTruckPlate} placeholder="1ABC234" />
        </CompactField>
        <CompactField label="Driver arrives at dock">
          <input
            type="datetime-local"
            value={scheduledArrival}
            onChange={(e) => setScheduledArrival(e.target.value)}
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm text-slate-800 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
          />
        </CompactField>
        <CompactField label="Driver name">
          <Input value={driverName} onChange={setDriverName} />
        </CompactField>
        <CompactField label="Driver license #">
          <Input value={driverLicense} onChange={setDriverLicense} />
        </CompactField>
        <CompactField label="Driver phone">
          <Input value={driverPhone} onChange={setDriverPhone} />
        </CompactField>
        <CompactField label="Carrier">
          <Input value={carrier} onChange={setCarrier} />
        </CompactField>
        <CompactField label="Insurance">
          <Input value={insurance} onChange={setInsurance} />
        </CompactField>
        <CompactField label="BOL # / Tracking #">
          <Input value={bol} onChange={setBol} />
        </CompactField>
      </div>

      {saveError && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {saveError}
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold px-4 py-2 text-sm transition disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving || locked}
          className="inline-flex items-center gap-2 rounded-full bg-[#1B4676] hover:bg-[#224E72] disabled:bg-slate-300 text-white font-bold px-5 py-2 text-sm transition"
        >
          {saving ? (
            <>
              <Spinner size={14} className="text-white" />
              <span>Saving…</span>
            </>
          ) : (
            <span>{isNew ? 'Attach truck' : 'Save driver info'}</span>
          )}
        </button>
      </div>
    </div>
  )
}
