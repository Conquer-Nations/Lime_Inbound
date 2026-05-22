import { useEffect, useState, type ReactNode } from 'react'
import {
  api,
  ApiError,
  type OutboundLineInput,
  type OutboundOrderRead,
  type OutboundOrderListItem,
} from '../api/client'
import Spinner from '../components/Spinner'
import { useVendorAuth } from '../auth/VendorAuthContext'

/** Map a vendor user's company onto the new Transfer Order. */
function useVendorCompany(): string {
  const { user } = useVendorAuth()
  return user?.company || ''
}

// ─── 4-card chooser under OUTBOUND ─────────────────────────────────────

export function OutboundModeChooser({
  onChoose,
  onBack,
}: {
  onChoose: (m: 'out_new' | 'out_driver' | 'out_update' | 'out_view') => void
  onBack: () => void
}) {
  return (
    <OutboundShell breadcrumb="Outbound — select workflow" onBack={onBack}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#1B4676]/10 border border-[#1B4676]/25 text-[#1B4676] text-[11px] font-semibold tracking-[0.14em] uppercase mb-5">
            <span className="w-1.5 h-1.5 rounded-full bg-[#1B4676]" aria-hidden />
            Outbound
          </div>
          <h1 className="text-3xl sm:text-4xl lg:text-[2.75rem] font-bold tracking-tight text-[#1B4676] leading-[1.1]">
            What are you sending out today?
          </h1>
          <p className="mt-4 text-base sm:text-lg text-slate-600 max-w-2xl leading-relaxed">
            Pick the outbound workflow that matches your shipment. Place a new
            Transfer Order, attach driver / truck details, update an existing
            order, or look up one already on file.
          </p>
        </div>

        <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 items-stretch">
          <OutboundCard
            eyebrow="Order"
            title="New outbound order"
            description="Submit a Transfer Order / Picking Ticket — destination, SKU lines, optional specific serials."
            ctaLabel="Start new order"
            onClick={() => onChoose('out_new')}
          />
          <OutboundCard
            eyebrow="Driver"
            title="Driver & truck info"
            description="Attach an outbound container (BIC or truck) and driver / carrier / insurance / BOL info."
            ctaLabel="Add driver details"
            onClick={() => onChoose('out_driver')}
          />
          <OutboundCard
            eyebrow="Amend"
            title="Update order"
            description="Amend an open Transfer Order — fix destination, change lines, before picking starts."
            ctaLabel="Update order"
            onClick={() => onChoose('out_update')}
          />
          <OutboundCard
            eyebrow="Review"
            title="View order"
            description="Pull up a Transfer Order to see lines, picked counts, and attached containers."
            ctaLabel="View order"
            onClick={() => onChoose('out_view')}
          />
        </div>
      </div>
    </OutboundShell>
  )
}

function OutboundCard({
  eyebrow,
  title,
  description,
  ctaLabel,
  onClick,
}: {
  eyebrow: string
  title: string
  description: string
  ctaLabel: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group text-left bg-white rounded-2xl border border-slate-200 hover:border-[#1B4676] hover:shadow-[0_24px_60px_-20px_rgba(15,23,42,0.18)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2 transition-all duration-200 p-6 flex flex-col"
    >
      <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#1B4676]">
        {eyebrow}
      </div>
      <div className="mt-2 text-xl font-bold tracking-tight text-[#1B4676]">
        {title}
      </div>
      <p className="mt-2 text-sm text-slate-600 leading-relaxed flex-1">
        {description}
      </p>
      <div className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-[#1B4676] group-hover:translate-x-1 transition-transform">
        <span>{ctaLabel}</span>
        <span aria-hidden>→</span>
      </div>
    </button>
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

// ─── New Outbound Order form ───────────────────────────────────────────

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
  const [done, setDone] = useState<{ tno: string; lines: number } | null>(null)

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
      setDone({ tno: res.transfer_order_no, lines: cleanLines.length })
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
              <span className="font-mono font-bold text-[#1B4676]">
                {done.tno}
              </span>{' '}
              · {done.lines} line{done.lines === 1 ? '' : 's'}
            </p>
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

  return (
    <OutboundShell breadcrumb="Outbound — new order" onBack={onBack}>
      <form onSubmit={submit} className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-6">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#1B4676]">
          New outbound order
        </h1>
        <p className="text-sm text-slate-600">
          Submitting on behalf of <span className="font-semibold">{company || '(no company)'}</span>.
        </p>

        {/* Header */}
        <Section title="Order header">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Transfer Order #" required>
              <Input value={tno} onChange={setTno} placeholder="TO21787" />
            </Field>
            <Field label="Order date">
              <Input type="date" value={orderDate} onChange={setOrderDate} />
            </Field>
            <Field label="Priority">
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as 'normal' | 'urgent')}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
              >
                <option value="normal">Normal</option>
                <option value="urgent">Urgent</option>
              </select>
            </Field>
            <Field label="Memo">
              <Input value={memo} onChange={setMemo} placeholder="e.g., OD: Strategic Deployment" />
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
              <Input
                value={shipToName}
                onChange={setShipToName}
                placeholder="OPS - US - NEW YORK - Long Island City"
              />
            </Field>
            <Field label="Address" required>
              <Textarea
                value={shipToAddress}
                onChange={setShipToAddress}
                rows={3}
                placeholder="48-29 31st Place&#10;Long Island City NY 11101&#10;United States"
              />
            </Field>
          </div>
        </Section>

        <Section
          title="Line items"
          right={
            <button
              type="button"
              onClick={addLine}
              className="inline-flex items-center gap-1.5 rounded-md bg-[#1B4676] hover:bg-[#224E72] text-white text-xs font-semibold px-3 py-1.5 transition"
            >
              + Add line
            </button>
          }
        >
          <div className="space-y-4">
            {lines.map((line) => (
              <div
                key={line.id}
                className="rounded-lg border border-slate-200 bg-slate-50/40 p-4 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div className="text-xs uppercase tracking-wider font-bold text-slate-500">
                    Line {line.line_no}
                  </div>
                  {lines.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeLine(line.id)}
                      className="text-xs text-red-600 hover:text-red-800 font-semibold"
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
                        placeholder="LPN-001769"
                      />
                    </Field>
                  </div>
                  <div className="sm:col-span-3">
                    <Field label="Description">
                      <Input
                        value={line.description}
                        onChange={(v) => update(line.id, 'description', v)}
                        placeholder="Scooter Gen 4.1 US Version Without Battery"
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
                  <div className="sm:col-span-1">
                    <Field label="Unit">
                      <Input
                        value={line.unit}
                        onChange={(v) => update(line.id, 'unit', v)}
                        placeholder="EA"
                      />
                    </Field>
                  </div>
                  <div className="sm:col-span-5 flex items-center gap-2">
                    <input
                      type="checkbox"
                      id={`ss-${line.id}`}
                      checked={line.serial_specific}
                      onChange={(e) =>
                        update(line.id, 'serial_specific', e.target.checked)
                      }
                      className="w-4 h-4"
                    />
                    <label
                      htmlFor={`ss-${line.id}`}
                      className="text-sm text-slate-700"
                    >
                      Customer specified exact serials for this line
                    </label>
                  </div>
                  {line.serial_specific && (
                    <div className="sm:col-span-6">
                      <Field label={`Serial numbers (${line.order_qty || 0} required, one per line or comma-separated)`}>
                        <Textarea
                          value={line.serials}
                          onChange={(v) => update(line.id, 'serials', v)}
                          rows={Math.min(8, Math.max(2, parseInt(line.order_qty || '1', 10)))}
                          placeholder="ELHE5XD162603251598&#10;ELHE5XD162603251481&#10;..."
                        />
                      </Field>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Notes (optional)">
          <Textarea value={notes} onChange={setNotes} rows={3} placeholder="Anything else for ops..." />
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

// ─── Driver / truck attach ─────────────────────────────────────────────

export function OutboundDriverInfoForm({ onBack }: { onBack: () => void }) {
  const [tno, setTno] = useState('')
  const [containerNo, setContainerNo] = useState('')
  const [containerType, setContainerType] = useState<'bic' | 'truck'>('bic')
  const [driverName, setDriverName] = useState('')
  const [driverLicense, setDriverLicense] = useState('')
  const [driverPhone, setDriverPhone] = useState('')
  const [truckPlate, setTruckPlate] = useState('')
  const [carrier, setCarrier] = useState('')
  const [insurance, setInsurance] = useState('')
  const [bol, setBol] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ container: string } | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!tno.trim()) return setError('Transfer Order # is required.')
    if (!containerNo.trim()) return setError('Container # (or truck plate) is required.')
    setBusy(true)
    try {
      const res = await api.attachOutboundContainer(tno.trim(), {
        container_no: containerNo.trim().toUpperCase(),
        container_type: containerType,
        driver_name: driverName.trim() || null,
        driver_license: driverLicense.trim() || null,
        driver_phone: driverPhone.trim() || null,
        truck_license_plate: truckPlate.trim() || null,
        carrier: carrier.trim() || null,
        insurance: insurance.trim() || null,
        bol_number: bol.trim() || null,
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
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#1B4676]">
          Driver & truck info
        </h1>
        <p className="text-sm text-slate-600">
          Attach the outbound container (BIC code or truck plate) to a Transfer Order and capture driver / carrier / BOL info.
        </p>

        <Section title="Transfer Order + container">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Transfer Order #" required>
              <Input value={tno} onChange={setTno} placeholder="TO21787" />
            </Field>
            <Field label="Container type">
              <select
                value={containerType}
                onChange={(e) => setContainerType(e.target.value as 'bic' | 'truck')}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
              >
                <option value="bic">BIC container (ISO 6346)</option>
                <option value="truck">Truck / trailer (license plate)</option>
              </select>
            </Field>
            <Field label={containerType === 'bic' ? 'Container number' : 'Truck / trailer plate'} required>
              <Input
                value={containerNo}
                onChange={setContainerNo}
                placeholder={containerType === 'bic' ? 'JZPU8021688' : '1ABC234'}
              />
            </Field>
            <Field label="BOL # or Tracking #">
              <Input value={bol} onChange={setBol} placeholder="e.g. 36185694" />
            </Field>
          </div>
        </Section>

        <Section title="Driver + carrier">
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
            <Field label="Truck license plate">
              <Input value={truckPlate} onChange={setTruckPlate} />
            </Field>
            <Field label="Carrier">
              <Input value={carrier} onChange={setCarrier} />
            </Field>
            <Field label="Insurance">
              <Input value={insurance} onChange={setInsurance} />
            </Field>
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

// ─── Update existing order (minimal — pulls + replaces lines) ──────────

export function OutboundUpdateOrderForm({ onBack }: { onBack: () => void }) {
  return (
    <OutboundShell breadcrumb="Outbound — update order" onBack={onBack}>
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#1B4676]">
          Update outbound order
        </h1>
        <p className="mt-3 text-slate-600">
          Coming in the next commit — same shape as the new-order form, pre-filled from an existing Transfer Order, with the option to amend lines before picking starts.
        </p>
        <button
          type="button"
          onClick={onBack}
          className="mt-6 inline-flex items-center gap-2 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold px-5 py-3 text-sm transition"
        >
          Back
        </button>
      </div>
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
              <h2 className="text-xl font-bold text-[#1B4676]">
                {order.transfer_order_no}
              </h2>
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
                  <button
                    type="button"
                    onClick={() => {
                      setTno(o.transfer_order_no)
                      void lookup(new Event('submit') as unknown as React.FormEvent)
                    }}
                    className="font-mono font-bold text-[#1B4676] hover:underline"
                  >
                    {o.transfer_order_no}
                  </button>
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
