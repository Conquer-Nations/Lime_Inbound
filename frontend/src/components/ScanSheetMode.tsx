import { useEffect, useRef, useState } from 'react'
import {
  api,
  ApiError,
  type ScanSheetOpenResponse,
  type ScanSheetRow,
} from '../api/client'
import Spinner from './Spinner'

interface Props {
  sheet: ScanSheetOpenResponse
  operator: string
  /** Called when the operator confirms FINISH and the receipt is locked. */
  onFinished: (summary: {
    receipt_id: number
    container_no: string
    total_scanned: number
    download_url: string
  }) => void
}

/**
 * Live scan-sheet grid for operators. Matches the TEMPLATE.xlsx layout:
 *   - Header card with container / WHPO / customer / BOL / start time
 *   - Single autofocused input for the serial number (BT-A500 friendly)
 *   - Read-only grid below filling in real time as scans land
 *   - FINISH button at the bottom (confirm modal)
 *
 * No edit / no delete affordance — the operator can only append rows and
 * call FINISH. Duplicates within the same receipt are blocked with a
 * brief red flash pointing at the existing row.
 */
export default function ScanSheetMode({ sheet, operator, onFinished }: Props) {
  const [rows, setRows] = useState<ScanSheetRow[]>(sheet.rows)
  const [serial, setSerial] = useState('')
  const [imei, setImei] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastAccepted, setLastAccepted] = useState<number | null>(null)
  const [lastDupRowId, setLastDupRowId] = useState<number | null>(null)
  const [confirmFinish, setConfirmFinish] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const serialInputRef = useRef<HTMLInputElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  // Autofocus the serial input on mount and after every successful scan.
  useEffect(() => {
    serialInputRef.current?.focus()
  }, [])

  // Scroll the latest row into view when a row is accepted.
  useEffect(() => {
    if (lastAccepted == null) return
    const el = gridRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastAccepted, rows.length])

  // Clear duplicate flash after 1.5s so the row goes back to normal.
  useEffect(() => {
    if (lastDupRowId == null) return
    const t = setTimeout(() => setLastDupRowId(null), 1500)
    return () => clearTimeout(t)
  }, [lastDupRowId])

  async function submitSerial(e: React.FormEvent) {
    e.preventDefault()
    if (!serial.trim()) return
    if (sheet.header.requires_imei && !imei.trim()) {
      setError('IMEI is required for scooter SKUs.')
      return
    }
    setError(null)
    setBusy(true)
    const value = serial.trim()
    const imeiValue = imei.trim()
    try {
      const res = await api.recordScanRow(sheet.header.receipt_id, operator, {
        serial_number: value,
        imei: imeiValue || null,
        notes: notes.trim() || null,
      })
      if (res.accepted && res.row) {
        setRows((prev) => [...prev, res.row!])
        setLastAccepted(res.row.id)
        setSerial('')
        setImei('')
        setNotes('')
      } else {
        setLastDupRowId(res.duplicate_of_row_id ?? null)
        setError(res.error ?? 'Scan rejected.')
        // Don't clear — operator can correct
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setBusy(false)
      // Always return focus to the serial input — operator's next scan
      // shouldn't require a click.
      serialInputRef.current?.focus()
    }
  }

  async function handleFinishConfirmed() {
    setError(null)
    setFinishing(true)
    try {
      const res = await api.finishScanSheet(sheet.header.receipt_id, operator)
      onFinished({
        receipt_id: res.receipt_id,
        container_no: res.container_no,
        total_scanned: res.total_scanned,
        download_url: res.download_url,
      })
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setFinishing(false)
      setConfirmFinish(false)
    }
  }

  const h = sheet.header

  return (
    <div className="space-y-4">
      {/* Header card — Receipt block from the template */}
      <div
        className="bg-white rounded-xl border border-slate-200 p-5"
        style={{
          boxShadow:
            '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
        }}
      >
        <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0] mb-2">
          LIME 3PL Inbound
        </div>
        <h2 className="text-2xl font-bold tracking-tight text-[#1B4676] font-mono">
          {h.container_no}
        </h2>
        <dl className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <Field k="Received" v={h.received_date} />
          <Field k="3PL Location" v={h.location} />
          <Field k="WHPO/Load No" v={h.whpo_number} mono />
          <Field k="BOL / Tracking" v={h.bol_number ?? '—'} mono />
          <Field k="Customer" v={h.customer_name} />
          <Field k="DO #" v={h.do_number} mono />
          <Field
            k="Start"
            v={new Date(h.start_timestamp).toLocaleString()}
          />
          <Field
            k="Status"
            v={h.is_completed ? 'COMPLETED' : 'IN PROGRESS'}
          />
        </dl>
      </div>

      {/* Scan input */}
      <form
        onSubmit={submitSerial}
        className="bg-white rounded-xl border border-slate-200 p-5 space-y-3"
        style={{
          boxShadow:
            '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
        }}
      >
        <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0]">
          Next scan
        </div>
        <div
          className={`grid grid-cols-1 gap-3 ${
            h.requires_imei
              ? 'sm:grid-cols-[2fr_2fr_1fr_auto]'
              : 'sm:grid-cols-[2fr_1fr_auto]'
          }`}
        >
          <input
            ref={serialInputRef}
            type="text"
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            placeholder="Scan or type serial number…"
            spellCheck={false}
            autoComplete="off"
            inputMode="text"
            className="font-mono w-full border border-slate-300 rounded-md px-4 py-3 text-lg tracking-wider text-[#1B4676] placeholder:text-slate-400 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
            disabled={busy || h.is_completed}
          />
          {h.requires_imei && (
            <input
              type="text"
              value={imei}
              onChange={(e) => setImei(e.target.value)}
              placeholder="IMEI (required for scooters)"
              spellCheck={false}
              autoComplete="off"
              inputMode="text"
              className="font-mono w-full border border-slate-300 rounded-md px-4 py-3 text-lg tracking-wider text-[#1B4676] placeholder:text-slate-400 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
              disabled={busy || h.is_completed}
            />
          )}
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes (optional)"
            className="w-full border border-slate-300 rounded-md px-4 py-3 text-sm text-slate-700 placeholder:text-slate-400 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
            disabled={busy || h.is_completed}
          />
          <button
            type="submit"
            disabled={busy || h.is_completed || !serial.trim() || (h.requires_imei && !imei.trim())}
            className={`inline-flex items-center justify-center gap-2 bg-[#0093D0] hover:bg-[#00A8E8] text-white font-bold rounded-md px-5 py-3 text-sm transition shadow-[0_4px_14px_-2px_rgba(0,147,208,0.5)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2 ${
              busy
                ? 'opacity-90 cursor-wait'
                : 'disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed'
            }`}
          >
            {busy ? (
              <>
                <Spinner size={16} className="text-white" />
                <span>Adding…</span>
              </>
            ) : (
              <span>Add scan</span>
            )}
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5"
          >
            {error}
          </div>
        )}

        <div className="text-xs text-slate-500">
          {rows.length === 0
            ? 'No scans yet — go ahead.'
            : `${rows.length} scan${rows.length === 1 ? '' : 's'} on this container so far.`}
        </div>
      </form>

      {/* Live grid */}
      <div
        ref={gridRef}
        className="bg-white rounded-xl border border-slate-200 overflow-hidden max-h-[420px] overflow-y-auto"
        style={{
          boxShadow:
            '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
        }}
      >
        <table className="w-full text-sm">
          <thead className="bg-[#0B1828] text-white text-[10.5px] uppercase tracking-wider sticky top-0 z-10">
            <tr>
              <th className="text-left px-4 py-2 font-semibold">Container Number</th>
              {h.requires_imei && (
                <th className="text-right px-4 py-2 font-semibold">Box #</th>
              )}
              <th className="text-left px-4 py-2 font-semibold">SKU</th>
              <th className="text-right px-4 py-2 font-semibold">Received Qty</th>
              <th className="text-left px-4 py-2 font-semibold">Serial Number</th>
              <th className="text-left px-4 py-2 font-semibold">IMEI</th>
              <th className="text-left px-4 py-2 font-semibold">Scanned by</th>
              <th className="text-left px-4 py-2 font-semibold">Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={h.requires_imei ? 8 : 7}
                  className="px-4 py-6 text-center text-slate-400 text-sm"
                >
                  Scans will appear here as they're recorded.
                </td>
              </tr>
            ) : (
              rows.map((r, i) => {
                const isDup = r.id === lastDupRowId
                const isJustAdded = r.id === lastAccepted
                return (
                  <tr
                    key={r.id}
                    className={`border-t border-slate-100 transition-colors ${
                      isDup
                        ? 'bg-red-50'
                        : isJustAdded
                        ? 'bg-emerald-50'
                        : i % 2 === 0
                        ? 'bg-white'
                        : 'bg-slate-50/40'
                    }`}
                  >
                    <td className="px-4 py-2 font-mono font-bold text-[#1B4676]">
                      {h.container_no}
                    </td>
                    {h.requires_imei && (
                      <td className="px-4 py-2 text-right font-mono font-bold text-[#0093D0]">
                        {r.box_number ?? ''}
                      </td>
                    )}
                    <td className="px-4 py-2 font-mono text-slate-600">
                      {r.sku ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-right font-mono">{r.qty}</td>
                    <td className="px-4 py-2 font-mono text-[#1B4676]">
                      {r.serial_number}
                    </td>
                    <td className="px-4 py-2 font-mono text-slate-600">
                      {r.imei ?? ''}
                    </td>
                    <td className="px-4 py-2 text-slate-700">{r.scanned_by}</td>
                    <td className="px-4 py-2 text-slate-600">{r.notes ?? ''}</td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* FINISH bar */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center justify-between gap-4">
        <div className="text-sm text-slate-600">
          Done scanning this container? Locking saves the sheet to the database
          and lets you download it as Excel.
        </div>
        <button
          type="button"
          onClick={() => setConfirmFinish(true)}
          disabled={h.is_completed || rows.length === 0}
          className="inline-flex items-center gap-2 rounded-full bg-[#1B4676] hover:bg-[#224E72] disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-white font-bold px-6 py-3 text-sm transition shadow-[0_8px_24px_-4px_rgba(27,70,118,0.45)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
        >
          <span>FINISH</span>
        </button>
      </div>

      {/* Confirm modal */}
      {confirmFinish && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/60 flex items-center justify-center px-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-md w-full p-6 space-y-4">
            <h3 className="text-lg font-bold text-[#1B4676]">
              Lock this receipt?
            </h3>
            <p className="text-sm text-slate-600">
              You've scanned <span className="font-bold">{rows.length}</span>{' '}
              item{rows.length === 1 ? '' : 's'} on{' '}
              <span className="font-mono font-bold">{h.container_no}</span>.
              Once you click <span className="font-bold">Lock</span>, no more
              scans can be added and the row counts cannot be edited from this
              app.
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirmFinish(false)}
                disabled={finishing}
                className="inline-flex items-center gap-2 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold px-4 py-2 text-sm transition disabled:opacity-50"
              >
                Keep scanning
              </button>
              <button
                type="button"
                onClick={handleFinishConfirmed}
                disabled={finishing}
                className={`inline-flex items-center gap-2 rounded-full bg-[#1B4676] hover:bg-[#224E72] text-white font-bold px-5 py-2 text-sm transition ${
                  finishing ? 'opacity-90 cursor-wait' : ''
                }`}
              >
                {finishing ? (
                  <>
                    <Spinner size={14} className="text-white" />
                    <span>Locking…</span>
                  </>
                ) : (
                  <span>Lock and finish</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
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
      <dt className="text-[10px] uppercase tracking-wider font-semibold text-slate-500">
        {k}
      </dt>
      <dd
        className={`mt-0.5 text-sm text-slate-800 ${mono ? 'font-mono' : ''}`}
      >
        {v}
      </dd>
    </div>
  )
}
