import { useEffect, useRef, useState } from 'react'
import {
  api,
  ApiError,
  type ScanSheetHeader,
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
  const imeiInputRef = useRef<HTMLInputElement>(null)

  // Autofocus the serial input on mount and after every successful scan.
  useEffect(() => {
    serialInputRef.current?.focus()
  }, [])

  // Request a screen wake lock so the scanner device doesn't sleep mid-shift.
  // Best-effort: falls back silently if the browser doesn't support it.
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nav: any = navigator
    if (!nav.wakeLock) return
    let wakeLock: { release: () => Promise<void> } | null = null
    let cancelled = false
    nav.wakeLock
      .request('screen')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((sentinel: any) => {
        if (cancelled) {
          sentinel.release().catch(() => {})
        } else {
          wakeLock = sentinel
        }
      })
      .catch(() => {})
    const reacquire = () => {
      if (document.visibilityState === 'visible' && !wakeLock && nav.wakeLock) {
        nav.wakeLock
          .request('screen')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .then((s: any) => (wakeLock = s))
          .catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', reacquire)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', reacquire)
      wakeLock?.release().catch(() => {})
    }
  }, [])

  // Clear duplicate flash after 1.5s so the row goes back to normal.
  useEffect(() => {
    if (lastDupRowId == null) return
    const t = setTimeout(() => setLastDupRowId(null), 1500)
    return () => clearTimeout(t)
  }, [lastDupRowId])

  /** Robustly move focus to the next input. Uses requestAnimationFrame so
   * React has rendered before we move focus — otherwise focus calls during
   * a state update can be lost. */
  function focusNext(target: 'serial' | 'imei') {
    requestAnimationFrame(() => {
      const el = target === 'serial' ? serialInputRef.current : imeiInputRef.current
      el?.focus()
      el?.select()
    })
  }

  async function submitSerial(e: React.FormEvent) {
    e.preventDefault()
    // Read straight from DOM, not state — Enter from scanner can fire before
    // React has finished applying the last keystroke's setState.
    const serialVal = (serialInputRef.current?.value ?? serial).trim()
    const imeiVal = (imeiInputRef.current?.value ?? imei).trim()
    if (!serialVal) {
      focusNext('serial')
      return
    }
    // For scooters: serial → IMEI auto-advance. Scanner emits text+Enter.
    // When IMEI is still empty, intercept the Enter, move focus to IMEI,
    // and wait for the next scan (which will then submit the row).
    if (sheet.header.requires_imei && !imeiVal) {
      setError(null)
      focusNext('imei')
      return
    }
    setError(null)
    setBusy(true)
    try {
      const res = await api.recordScanRow(sheet.header.receipt_id, operator, {
        serial_number: serialVal,
        imei: imeiVal || null,
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
      // Always return focus to the serial input for the next scan.
      focusNext('serial')
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
      {/* Excel-style scan sheet — visual clone of TEMPLATE.xlsx (read-only) */}
      <ExcelStyleSheet h={h} rows={rows} lastAccepted={lastAccepted} lastDupRowId={lastDupRowId} />

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
            placeholder="Scan serial number"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            inputMode="none"
            className="font-mono w-full border border-slate-300 rounded-md px-4 py-4 text-xl tracking-wider text-[#1B4676] placeholder:text-slate-400 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
            disabled={busy || h.is_completed}
          />
          {h.requires_imei && (
            <input
              ref={imeiInputRef}
              type="text"
              value={imei}
              onChange={(e) => setImei(e.target.value)}
              placeholder="IMEI (auto after serial)"
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              inputMode="none"
              className="font-mono w-full border border-slate-300 rounded-md px-4 py-4 text-xl tracking-wider text-[#1B4676] placeholder:text-slate-400 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
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

      {/* FINISH bar — big tappable button on mobile */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 sm:flex sm:items-center sm:justify-between gap-4">
        <div className="text-sm text-slate-600 hidden sm:block">
          Done scanning this container? Locking saves the sheet.
        </div>
        <button
          type="button"
          onClick={() => setConfirmFinish(true)}
          disabled={h.is_completed || rows.length === 0}
          className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-full bg-[#1B4676] hover:bg-[#224E72] disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-white font-bold px-6 py-4 sm:py-3 text-base sm:text-sm transition shadow-[0_8px_24px_-4px_rgba(27,70,118,0.45)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
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

// ─── Excel-faithful scan sheet (visual clone of TEMPLATE.xlsx, read-only) ───

function ExcelStyleSheet({
  h,
  rows,
  lastAccepted,
  lastDupRowId,
}: {
  h: ScanSheetHeader
  rows: ScanSheetRow[]
  lastAccepted: number | null
  lastDupRowId: number | null
}) {
  const isScooter = h.requires_imei
  const colCount = isScooter ? 8 : 7
  // Column widths in px — match TEMPLATE.xlsx proportions
  const cols = isScooter
    ? [140, 70, 145, 110, 200, 125, 135, 280]
    : [140, 145, 145, 200, 125, 135, 280]

  const NAVY = '#073763'
  const WHITE = '#FFFFFF'
  const PEACH = '#F9CB9C'
  const LIGHT_PEACH = '#FCE5CD'
  const YELLOW = '#FFFF00'
  const BORDER = '1px solid #888'

  const cellBase: React.CSSProperties = {
    border: BORDER,
    fontFamily: 'Arial, sans-serif',
    padding: '4px 8px',
    verticalAlign: 'middle',
  }
  const label: React.CSSProperties = {
    ...cellBase,
    fontWeight: 700,
    textAlign: 'center',
    background: WHITE,
  }
  const peach: React.CSSProperties = {
    ...cellBase,
    background: PEACH,
    fontWeight: 700,
    textAlign: 'center',
  }
  const lightPeach: React.CSSProperties = {
    ...cellBase,
    background: LIGHT_PEACH,
    fontWeight: 700,
    textAlign: 'center',
  }
  const navy: React.CSSProperties = {
    ...cellBase,
    background: NAVY,
    color: WHITE,
    fontWeight: 700,
    textAlign: 'center',
    whiteSpace: 'pre-wrap',
  }
  const yellow: React.CSSProperties = {
    ...cellBase,
    background: YELLOW,
    fontWeight: 700,
    textAlign: 'center',
  }

  return (
    <div className="bg-white border border-slate-300 rounded-md overflow-x-auto">
      <table style={{ borderCollapse: 'collapse', fontFamily: 'Arial, sans-serif' }}>
        <colgroup>
          {cols.map((w, i) => (
            <col key={i} style={{ width: w }} />
          ))}
        </colgroup>
        <tbody>
          {/* Title row */}
          <tr>
            <td
              colSpan={colCount}
              style={{
                ...cellBase,
                fontSize: 17,
                fontWeight: 700,
                textAlign: 'center',
                height: 50,
                background: WHITE,
              }}
            >
              LIME 3PL INBOUND RECEIPT
            </td>
          </tr>

          {/* Row 3: Received Date + 3PL Location */}
          <tr>
            <td style={{ ...label, fontSize: 13, height: 32 }}>Received Date:</td>
            <td colSpan={isScooter ? 3 : 2} style={{ ...peach, fontSize: 12 }}>
              {h.received_date}
            </td>
            <td colSpan={2} style={{ ...label, fontSize: 14 }}>
              3PL Location:
            </td>
            <td colSpan={2} style={{ ...navy, fontSize: 12 }}>
              {h.location}
            </td>
          </tr>

          {/* Row 4: blank separator */}
          <tr>
            <td colSpan={colCount} style={{ ...cellBase, height: 8, background: WHITE }} />
          </tr>

          {/* Row 5: Container Number + BOL # */}
          <tr>
            <td style={{ ...label, fontSize: 13, height: 32 }}>Container Number</td>
            <td colSpan={isScooter ? 3 : 2} style={{ ...peach, fontSize: 12 }}>
              {h.container_no}
            </td>
            <td colSpan={2} style={{ ...label, fontSize: 13 }}>
              BOL # or Tracking #:
            </td>
            <td colSpan={2} style={{ ...lightPeach, fontSize: 16 }}>
              {h.bol_number || '—'}
            </td>
          </tr>

          {/* Row 6: Start | Completed | Customer */}
          <tr>
            <td style={{ ...label, fontSize: 11, height: 30 }}>Start Timestamp</td>
            <td style={{ ...label, fontSize: 11 }}>
              {new Date(h.start_timestamp).toLocaleString()}
            </td>
            <td style={{ ...label, fontSize: 11 }}>Completed Timestamp</td>
            <td style={{ ...label, fontSize: 11 }}>
              {h.completed_timestamp
                ? new Date(h.completed_timestamp).toLocaleString()
                : ''}
            </td>
            <td style={{ ...yellow, fontSize: 10 }}>Customer:</td>
            <td colSpan={isScooter ? 3 : 2} style={{ ...yellow, fontSize: 10 }}>
              {h.customer_name}
            </td>
          </tr>

          {/* Row 7: column header band */}
          <tr>
            <td style={{ ...navy, fontSize: 12, height: 60 }}>Container Number</td>
            {isScooter && <td style={{ ...navy, fontSize: 12 }}>Box #</td>}
            <td style={{ ...navy, fontSize: 12 }}>SKU</td>
            <td style={{ ...navy, fontSize: 12 }}>Received Qty:</td>
            <td style={{ ...navy, fontSize: 12 }}>
              {'Serial Number\n(For Vehicles and Batteries ONLY)'}
            </td>
            <td style={{ ...navy, fontSize: 12 }}>IMEI</td>
            <td style={{ ...navy, fontSize: 12 }}>{'Scanned by:\n(Insert Name)'}</td>
            <td style={{ ...navy, fontSize: 12 }}>Notes</td>
          </tr>

          {/* Data rows */}
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={colCount}
                style={{
                  ...cellBase,
                  textAlign: 'center',
                  color: '#9ca3af',
                  padding: 24,
                  background: WHITE,
                  fontSize: 12,
                }}
              >
                Scans will appear here as they're recorded.
              </td>
            </tr>
          ) : (
            rows.map((r, i) => {
              const isDup = r.id === lastDupRowId
              const isJustAdded = r.id === lastAccepted
              const rowBg = isDup
                ? '#fef2f2'
                : isJustAdded
                ? '#ecfdf5'
                : i % 2 === 0
                ? WHITE
                : '#fafafa'
              const dataCell: React.CSSProperties = {
                ...cellBase,
                background: rowBg,
                fontSize: 11,
                textAlign: 'left',
              }
              return (
                <tr key={r.id}>
                  <td style={{ ...dataCell, fontWeight: 700, textAlign: 'center' }}>
                    {h.container_no}
                  </td>
                  {isScooter && (
                    <td style={{ ...dataCell, textAlign: 'center', fontWeight: 700 }}>
                      {r.box_number ?? ''}
                    </td>
                  )}
                  <td style={dataCell}>{r.sku ?? ''}</td>
                  <td style={{ ...dataCell, textAlign: 'right' }}>{r.qty}</td>
                  <td style={{ ...dataCell, fontWeight: 700 }}>{r.serial_number}</td>
                  <td style={dataCell}>{r.imei ?? ''}</td>
                  <td style={dataCell}>{r.scanned_by}</td>
                  <td style={dataCell}>{r.notes ?? ''}</td>
                </tr>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}
