import { useEffect, useState } from 'react'
import { tallyApi } from '../api/client'
import type {
  TallySheetRead,
  TallySheetUpdate,
} from '../api/client'

/**
 * Manager-facing Tally Sheets admin.
 *
 * Three sections:
 *   1. Upload form — manager files a POD for an arriving container.
 *      Backend runs OCR + snapshots driver/truck/carrier from the
 *      Container row. One tally per container (enforced by UNIQUE).
 *   2. Filters — billing_status, date range.
 *   3. List — clickable rows open a side panel for review / correction /
 *      flipping billing status.
 *
 * Tally rows exist BECAUSE the operator can't scan a container until
 * one's on file (server-side 409 gate). Without this screen, nothing
 * gets offloaded.
 */

type StatusFilter = 'all' | 'pending' | 'billed' | 'disputed' | 'waived'

const STATUS_PILL: Record<TallySheetRead['billing_status'], string> = {
  pending: 'bg-amber-100 text-amber-800 border-amber-200',
  billed: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  disputed: 'bg-rose-100 text-rose-800 border-rose-200',
  waived: 'bg-slate-100 text-slate-600 border-slate-200',
}

export default function TallySheetsAdmin() {
  const [items, setItems] = useState<TallySheetRead[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [selected, setSelected] = useState<TallySheetRead | null>(null)

  function reload() {
    setError(null)
    tallyApi
      .list({
        billing_status: statusFilter === 'all' ? undefined : statusFilter,
        limit: 200,
      })
      .then((r) => {
        setItems(r.items)
        setTotal(r.total)
      })
      .catch((e) => setError(String(e?.detail || e)))
  }

  useEffect(reload, [statusFilter])

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  return (
    <div className="space-y-6">
      <header>
        <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#1B4676] text-[11px] font-semibold tracking-[0.14em] uppercase mb-3">
          <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
          Tally Sheets
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#1B4676]">
          Proof of Delivery & Billing
        </h1>
        <p className="mt-1.5 text-sm text-slate-600 max-w-2xl">
          Upload the POD when a driver arrives. The system OCRs origin/
          destination and snapshots driver, truck and carrier from the
          container record. Operators can only start offloading once the
          tally is on file.
        </p>
      </header>

      {error && (
        <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-3 py-2">
          <span className="font-semibold">Error:</span> {error}
        </div>
      )}
      {toast && (
        <div className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
          {toast}
        </div>
      )}

      <UploadCard
        onCreated={(t) => {
          showToast(`Tally filed for ${t.container_no}`)
          reload()
          setSelected(t)
        }}
      />

      <section className="bg-white border border-slate-200 rounded-xl shadow-sm">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-200">
          <div>
            <h2 className="text-sm font-bold text-[#1B4676]">
              Tally history
            </h2>
            <p className="text-xs text-slate-500">
              {items === null
                ? 'Loading…'
                : `${total} tally row${total === 1 ? '' : 's'}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {(['all', 'pending', 'billed', 'disputed', 'waived'] as StatusFilter[]).map(
              (s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatusFilter(s)}
                  className={`text-xs font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full transition ${
                    statusFilter === s
                      ? 'bg-[#1B4676] text-white'
                      : 'text-slate-500 hover:text-[#1B4676] hover:bg-slate-100'
                  }`}
                >
                  {s}
                </button>
              )
            )}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-4 py-2">Container</th>
                <th className="text-left px-4 py-2">Driver</th>
                <th className="text-left px-4 py-2">Carrier · Truck</th>
                <th className="text-left px-4 py-2">From → To (OCR)</th>
                <th className="text-left px-4 py-2">Tallied</th>
                <th className="text-left px-4 py-2">Billing</th>
              </tr>
            </thead>
            <tbody>
              {items?.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="text-center px-4 py-8 text-sm text-slate-400"
                  >
                    No tally rows {statusFilter !== 'all' ? `for "${statusFilter}"` : 'yet'}.
                  </td>
                </tr>
              )}
              {items?.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => setSelected(t)}
                  className={`border-t border-slate-100 cursor-pointer hover:bg-[#0093D0]/5 transition ${
                    selected?.id === t.id ? 'bg-[#0093D0]/10' : ''
                  }`}
                >
                  <td className="px-4 py-2.5 font-mono font-semibold text-[#1B4676]">
                    {t.container_no}
                  </td>
                  <td className="px-4 py-2.5 text-slate-700">
                    {t.matched_driver_name || (
                      <span className="text-slate-300">—</span>
                    )}
                    {t.matched_driver_license && (
                      <div className="text-[11px] text-slate-400 font-mono">
                        {t.matched_driver_license}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-slate-700">
                    {t.matched_carrier || <span className="text-slate-300">—</span>}
                    {t.matched_truck_plate && (
                      <div className="text-[11px] text-slate-400 font-mono">
                        {t.matched_truck_plate}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-600 max-w-[260px]">
                    {t.ocr_from_location || t.ocr_to_location ? (
                      <>
                        <div className="truncate">{t.ocr_from_location || '—'}</div>
                        <div className="truncate text-slate-400">
                          → {t.ocr_to_location || '—'}
                        </div>
                      </>
                    ) : (
                      <span className="text-slate-300">OCR pending</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">
                    {new Date(t.tallied_at).toLocaleDateString()}
                    <div className="text-[10px] text-slate-400">{t.tallied_by}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`text-[10.5px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${STATUS_PILL[t.billing_status]}`}
                    >
                      {t.billing_status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {selected && (
        <DetailPanel
          tally={selected}
          onClose={() => setSelected(null)}
          onUpdated={(t) => {
            setSelected(t)
            reload()
            showToast(`${t.container_no} updated`)
          }}
        />
      )}
    </div>
  )
}

// ─── Upload form ────────────────────────────────────────────────────────


function UploadCard({ onCreated }: { onCreated: (t: TallySheetRead) => void }) {
  const [containerNo, setContainerNo] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [talliedBy, setTalliedBy] = useState('')
  const [sealNo, setSealNo] = useState('')
  const [chassisNo, setChassisNo] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!file) {
      setErr('Pick a POD image or PDF first.')
      return
    }
    if (!/^[A-Z]{4}\d{7}$/.test(containerNo.toUpperCase())) {
      setErr('Container # must be ISO 6346 (4 letters + 7 digits).')
      return
    }
    if (!talliedBy.trim()) {
      setErr('Your name is required (for the audit log).')
      return
    }
    setSubmitting(true)
    try {
      const t = await tallyApi.uploadPod(
        containerNo.toUpperCase(),
        file,
        talliedBy.trim(),
        {
          manual_seal_no: sealNo.trim() || undefined,
          manual_chassis_no: chassisNo.trim() || undefined,
        }
      )
      // Reset for next upload
      setContainerNo('')
      setFile(null)
      setSealNo('')
      setChassisNo('')
      onCreated(t)
    } catch (e: unknown) {
      setErr(String((e as { detail?: string })?.detail ?? e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="bg-white border border-slate-200 rounded-xl shadow-sm">
      <div className="px-4 py-3 border-b border-slate-200">
        <h2 className="text-sm font-bold text-[#1B4676]">New tally</h2>
        <p className="text-xs text-slate-500">
          Driver arrived? Upload the POD and we'll do the rest.
        </p>
      </div>
      <form onSubmit={submit} className="p-4 space-y-3">
        {err && (
          <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-3 py-2">
            {err}
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="block text-[11px] font-semibold text-[#1B4676] mb-1">
              Container # <span className="text-[#0093D0]">*</span>
            </label>
            <input
              type="text"
              value={containerNo}
              onChange={(e) => setContainerNo(e.target.value.toUpperCase())}
              maxLength={11}
              placeholder="HLXU9005263"
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm font-mono focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
              required
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[#1B4676] mb-1">
              Your name (audit) <span className="text-[#0093D0]">*</span>
            </label>
            <input
              type="text"
              value={talliedBy}
              onChange={(e) => setTalliedBy(e.target.value)}
              placeholder="Tiana Pinto"
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
              required
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[#1B4676] mb-1">
              POD photo/PDF <span className="text-[#0093D0]">*</span>
            </label>
            <input
              type="file"
              accept="image/*,application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm text-slate-700 file:mr-2 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-[#1B4676] file:text-white hover:file:bg-[#224E72]"
              required
            />
          </div>
        </div>

        <details className="text-xs">
          <summary className="cursor-pointer text-[#1B4676] font-semibold">
            Optional: seal / chassis (if visible on POD but not OCR'd)
          </summary>
          <div className="grid grid-cols-2 gap-3 mt-2">
            <input
              type="text"
              value={sealNo}
              onChange={(e) => setSealNo(e.target.value)}
              placeholder="Seal no."
              className="border border-slate-300 rounded-md px-2.5 py-1.5 text-sm"
            />
            <input
              type="text"
              value={chassisNo}
              onChange={(e) => setChassisNo(e.target.value)}
              placeholder="Chassis no."
              className="border border-slate-300 rounded-md px-2.5 py-1.5 text-sm"
            />
          </div>
        </details>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={submitting}
            className="bg-[#0093D0] hover:bg-[#00A8E8] text-white font-bold rounded-full px-5 py-2 text-sm transition disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitting ? 'Uploading + OCR…' : 'File tally'}
          </button>
        </div>
      </form>
    </section>
  )
}

// ─── Detail panel ───────────────────────────────────────────────────────


function DetailPanel({
  tally,
  onClose,
  onUpdated,
}: {
  tally: TallySheetRead
  onClose: () => void
  onUpdated: (t: TallySheetRead) => void
}) {
  const [from, setFrom] = useState(tally.ocr_from_location ?? '')
  const [to, setTo] = useState(tally.ocr_to_location ?? '')
  const [sealNo, setSealNo] = useState(tally.manual_seal_no ?? '')
  const [chassisNo, setChassisNo] = useState(tally.manual_chassis_no ?? '')
  const [status, setStatus] = useState(tally.billing_status)
  const [notes, setNotes] = useState(tally.billing_notes ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // When user picks a different row, reset local edit state.
  useEffect(() => {
    setFrom(tally.ocr_from_location ?? '')
    setTo(tally.ocr_to_location ?? '')
    setSealNo(tally.manual_seal_no ?? '')
    setChassisNo(tally.manual_chassis_no ?? '')
    setStatus(tally.billing_status)
    setNotes(tally.billing_notes ?? '')
    setErr(null)
  }, [tally.id])

  async function save() {
    setErr(null)
    setBusy(true)
    const patch: TallySheetUpdate = {}
    if (from !== (tally.ocr_from_location ?? '')) patch.ocr_from_location = from || null
    if (to !== (tally.ocr_to_location ?? '')) patch.ocr_to_location = to || null
    if (sealNo !== (tally.manual_seal_no ?? '')) patch.manual_seal_no = sealNo || null
    if (chassisNo !== (tally.manual_chassis_no ?? '')) patch.manual_chassis_no = chassisNo || null
    if (status !== tally.billing_status) patch.billing_status = status
    if (notes !== (tally.billing_notes ?? '')) patch.billing_notes = notes || null
    if (Object.keys(patch).length === 0) {
      setBusy(false)
      return
    }
    try {
      const t = await tallyApi.update(tally.id, patch)
      onUpdated(t)
    } catch (e: unknown) {
      setErr(String((e as { detail?: string })?.detail ?? e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-slate-900/40 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="bg-white w-full max-w-lg h-full overflow-y-auto shadow-2xl">
        <header className="px-5 py-4 border-b border-slate-200 sticky top-0 bg-white">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-[0.18em] font-bold text-[#0093D0]">
                Tally #{tally.id}
              </div>
              <h3 className="font-mono font-bold text-[#1B4676] text-lg mt-0.5">
                {tally.container_no}
              </h3>
              <p className="text-[11px] text-slate-500">
                Filed {new Date(tally.tallied_at).toLocaleString()} by {tally.tallied_by}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 text-2xl leading-none px-1"
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </header>

        <div className="p-5 space-y-5">
          {err && (
            <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-3 py-2">
              {err}
            </div>
          )}

          {/* Snapshot from container — read-only, audit-grade */}
          <section>
            <h4 className="text-[11px] uppercase tracking-wider font-bold text-slate-500 mb-2">
              Snapshot from container
            </h4>
            <dl className="text-sm space-y-1.5 bg-slate-50 border border-slate-200 rounded-md p-3">
              <FieldRow label="Driver" value={tally.matched_driver_name} />
              <FieldRow label="License #" value={tally.matched_driver_license} mono />
              <FieldRow label="Phone" value={tally.matched_driver_phone} />
              <FieldRow label="Carrier" value={tally.matched_carrier} />
              <FieldRow label="Truck plate" value={tally.matched_truck_plate} mono />
            </dl>
          </section>

          {/* POD reference */}
          <section>
            <h4 className="text-[11px] uppercase tracking-wider font-bold text-slate-500 mb-2">
              POD file
            </h4>
            <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-md p-3">
              <div className="font-mono">{tally.pod_filename}</div>
              <div className="text-slate-400 mt-0.5">
                {tally.pod_content_type} · {(tally.pod_file_size / 1024).toFixed(0)} KB
                {tally.ocr_engine && <> · OCR via {tally.ocr_engine}</>}
              </div>
            </div>
          </section>

          {/* OCR fields — editable to correct misreads */}
          <section>
            <h4 className="text-[11px] uppercase tracking-wider font-bold text-slate-500 mb-2">
              OCR / manual fields
            </h4>
            <div className="space-y-2">
              <FieldEdit label="From location" value={from} onChange={setFrom} multiline />
              <FieldEdit label="To location" value={to} onChange={setTo} multiline />
              <div className="grid grid-cols-2 gap-2">
                <FieldEdit label="Seal #" value={sealNo} onChange={setSealNo} />
                <FieldEdit label="Chassis #" value={chassisNo} onChange={setChassisNo} />
              </div>
            </div>
          </section>

          {/* Billing */}
          <section>
            <h4 className="text-[11px] uppercase tracking-wider font-bold text-slate-500 mb-2">
              Billing
            </h4>
            <div className="space-y-2">
              <label className="block">
                <span className="text-[11px] text-slate-500 font-semibold">Status</span>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as TallySheetRead['billing_status'])}
                  className="mt-1 w-full border border-slate-300 rounded-md px-2.5 py-1.5 text-sm"
                >
                  <option value="pending">Pending</option>
                  <option value="billed">Billed</option>
                  <option value="disputed">Disputed</option>
                  <option value="waived">Waived</option>
                </select>
              </label>
              <FieldEdit label="Notes" value={notes} onChange={setNotes} multiline />
            </div>
          </section>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="text-sm text-slate-600 hover:text-slate-800 px-3 py-2"
            >
              Close
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="bg-[#0093D0] hover:bg-[#00A8E8] text-white font-bold rounded-full px-5 py-2 text-sm transition disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function FieldRow({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="flex">
      <dt className="text-xs text-slate-500 w-28 shrink-0">{label}</dt>
      <dd className={`text-sm text-slate-800 flex-1 ${mono ? 'font-mono' : ''}`}>
        {value ?? <span className="text-slate-300">—</span>}
      </dd>
    </div>
  )
}

function FieldEdit({
  label,
  value,
  onChange,
  multiline,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  multiline?: boolean
}) {
  return (
    <label className="block">
      <span className="text-[11px] text-slate-500 font-semibold">{label}</span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          className="mt-1 w-full border border-slate-300 rounded-md px-2.5 py-1.5 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full border border-slate-300 rounded-md px-2.5 py-1.5 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
        />
      )}
    </label>
  )
}
