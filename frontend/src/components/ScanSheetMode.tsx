import { useEffect, useRef, useState } from 'react'
import {
  api,
  ApiError,
  type LineProgress,
  type OutboundLineProgress,
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
  // Per-LPN progress (outbound only). Initialized from /open response,
  // refreshed off every accepted scan so the operator gets live visual
  // feedback without polling.
  const [outboundProgress, setOutboundProgress] = useState<
    OutboundLineProgress[] | null
  >(sheet.outbound_progress ?? null)
  // Inbound mixed-container: one entry per LPN (ContainerLine). Same shape as
  // outbound progress. Drives the LPN picker + per-LPN fill panel, and is
  // refreshed off every scan response.
  const isInbound = sheet.header.kind !== 'outbound'
  const [inboundProgress, setInboundProgress] = useState<LineProgress[] | null>(
    sheet.inbound_progress ?? null,
  )
  // The LPN the operator is currently scanning into. Defaults to the first
  // LPN that hasn't met its vendor quantity; falls back to the last line if
  // everything is already complete.
  const [activeLineId, setActiveLineId] = useState<number | null>(() => {
    const p = sheet.inbound_progress
    if (!p || p.length === 0) return null
    const firstIncomplete = p.find((l) => l.scanned_qty < l.order_qty)
    return (firstIncomplete ?? p[p.length - 1]).line_id
  })
  // When the active LPN fills (or the operator scans into a full LPN), we
  // pop a confirm modal before switching to the next LPN. Until they tap OK,
  // incoming scans are ignored so they can't bleed into the wrong line.
  const [advancePrompt, setAdvancePrompt] = useState<{
    completed: LineProgress
    next: LineProgress | null
  } | null>(null)
  // Refs mirror the above so the scanner-fast submit handler reads live
  // values instead of stale render closures.
  const activeLineIdRef = useRef<number | null>(activeLineId)
  const advancePromptRef = useRef(false)
  useEffect(() => {
    activeLineIdRef.current = activeLineId
  }, [activeLineId])
  useEffect(() => {
    advancePromptRef.current = advancePrompt != null
  }, [advancePrompt])
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

  // ── Auto-advance / auto-submit on scanner input ──────────────────────
  // Scanner emits ~10 chars in <50ms then (maybe) Enter. We watch the input
  // values and fire submitOrAdvance() ~250ms after the last keystroke. This
  // works whether or not the scanner emits a terminator, and never races a
  // pending state update.
  useEffect(() => {
    if (!serial.trim()) return
    if (busy || sheet.header.is_completed) return
    // For scooter: we want to advance to IMEI as soon as serial is done.
    // For non-scooter: we want to submit the row.
    const t = setTimeout(() => {
      submitOrAdvance()
    }, 250)
    return () => clearTimeout(t)
    // Depend on `busy` too so that when an in-flight submit completes,
    // any serial that arrived during it gets picked up automatically
    // (without requiring the operator to retype/re-scan).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial, busy])

  useEffect(() => {
    if (!sheet.header.requires_imei) return
    if (!imei.trim()) return
    if (busy || sheet.header.is_completed) return
    const t = setTimeout(() => {
      submitOrAdvance()
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imei, busy])

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

  // ── Batch-scan queue (scooter mode) ──────────────────────────────────
  // Scooters have no IMEI step → operators batch-scan 10 serials in
  // rapid succession with the BT-A500. The scanner emits each scan
  // ~50ms apart with an Enter terminator. The previous implementation
  // early-exited on `busy` while a submit was in-flight, dropping every
  // scan after the first. New behavior: when busy AND non-IMEI mode,
  // queue the serial and let the drain effect process it after the
  // in-flight submit completes.
  const serialQueueRef = useRef<string[]>([])
  const [queueLen, setQueueLen] = useState(0)

  // Drain worker — fires whenever `busy` flips to false and the queue
  // has items. Pulls the next queued serial and submits it.
  useEffect(() => {
    if (busy || sheet.header.is_completed) return
    if (serialQueueRef.current.length === 0) return
    const next = serialQueueRef.current.shift()!
    setQueueLen(serialQueueRef.current.length)
    // Fire-and-forget; submitOrAdvance handles its own busy guard.
    void submitOrAdvance(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queueLen])

  /** Core scan handler — called when the operator presses Enter (scanner or
   * keyboard) OR taps the "Add scan" button. Reads input values straight
   * from the DOM (not React state) so scanner-fast Enter can never race a
   * pending setState.
   *
   * `overrideSerial` is set by the queue drain effect to bypass the DOM
   * read (the input may have been cleared / overwritten by then). */
  async function submitOrAdvance(overrideSerial?: string) {
    // Waiting for the operator to acknowledge an LPN switch — swallow any
    // scans that arrive in the meantime so they don't land on the wrong LPN.
    if (advancePromptRef.current) {
      setSerial('')
      if (serialInputRef.current) serialInputRef.current.value = ''
      return
    }
    const serialVal = (overrideSerial ?? serialInputRef.current?.value ?? serial).trim()
    const imeiVal = (imeiInputRef.current?.value ?? imei).trim()

    // Batch-scan queue path: scooter mode + something already in-flight.
    // Push the just-scanned serial into the queue and bail — the drain
    // effect will pick it up the moment busy turns false.
    if (
      busy
      && !sheet.header.is_completed
      && !sheet.header.requires_imei
      && serialVal
      && /^[A-Za-z0-9-]+$/.test(serialVal)
      && overrideSerial === undefined
    ) {
      serialQueueRef.current.push(serialVal)
      setQueueLen(serialQueueRef.current.length)
      setSerial('')
      if (serialInputRef.current) serialInputRef.current.value = ''
      focusNext('serial')
      return
    }

    if (busy || sheet.header.is_completed) return
    if (!serialVal) {
      focusNext('serial')
      return
    }
    // Format validation — serials are alphanumeric (letters + digits, with
    // optional dashes); IMEIs are exactly digits.
    if (!/^[A-Za-z0-9-]+$/.test(serialVal)) {
      setError('Serial number must be alphanumeric (letters and digits only).')
      focusNext('serial')
      if (serialInputRef.current) serialInputRef.current.value = ''
      setSerial('')
      return
    }
    // Scooter: after serial is filled, advance to IMEI and wait for next scan.
    if (sheet.header.requires_imei && !imeiVal) {
      setError(null)
      focusNext('imei')
      return
    }
    if (sheet.header.requires_imei && !/^[0-9]+$/.test(imeiVal)) {
      setError('IMEI must be digits only.')
      focusNext('imei')
      if (imeiInputRef.current) imeiInputRef.current.value = ''
      setImei('')
      return
    }
    setError(null)
    // Clear input BEFORE the API call so the next scan can land in an
    // empty field while this one is still in-flight. Without this, a
    // fast scanner concatenates the next serial onto the previous one.
    setSerial('')
    setImei('')
    if (serialInputRef.current) serialInputRef.current.value = ''
    if (imeiInputRef.current) imeiInputRef.current.value = ''
    // Refocus immediately — don't wait for the API. The input is never
    // disabled (only readOnly on completion), so refocus is reliable.
    focusNext('serial')
    setBusy(true)
    try {
      const res = await api.recordScanRow(sheet.header.receipt_id, operator, {
        serial_number: serialVal,
        imei: imeiVal || null,
        notes: notes.trim() || null,
        container_line_id: isInbound ? activeLineIdRef.current : undefined,
      })
      // Keep the progress panels live regardless of accept/reject.
      if (res.outbound_progress) setOutboundProgress(res.outbound_progress)
      if (res.inbound_progress) setInboundProgress(res.inbound_progress)
      if (res.accepted && res.row) {
        setRows((prev) => [...prev, res.row!])
        setLastAccepted(res.row.id)
        setNotes('')
        // Inbound: if the active LPN just hit its vendor quantity, prompt the
        // operator to switch to the next LPN before more scans land.
        if (isInbound && res.inbound_progress) {
          maybePromptAdvance(res.inbound_progress)
        }
      } else if (res.line_full) {
        // Hard stop: the targeted LPN is already full. Not an error — prompt
        // the switch instead of flashing red.
        if (res.inbound_progress) maybePromptAdvance(res.inbound_progress)
      } else {
        setLastDupRowId(res.duplicate_of_row_id ?? null)
        setError(res.error ?? 'Scan rejected.')
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** Inbound only: after a scan refreshes per-LPN progress, decide whether the
   * active LPN is now full and the operator should switch. Clears any queued
   * scooter scans (they were aimed at the now-complete LPN) and raises the
   * switch modal. */
  function maybePromptAdvance(prog: LineProgress[]) {
    const active = prog.find((l) => l.line_id === activeLineIdRef.current)
    if (!active) return
    if (active.order_qty > 0 && active.scanned_qty >= active.order_qty) {
      // Drain the queue so nothing bleeds into the next LPN.
      serialQueueRef.current = []
      setQueueLen(0)
      const next = prog.find((l) => l.scanned_qty < l.order_qty) ?? null
      setAdvancePrompt({ completed: active, next })
    }
  }

  /** Operator tapped OK on the LPN-switch modal — advance the active LPN to
   * the next incomplete one (if any) and refocus the serial input. */
  function handleAdvanceConfirmed() {
    const next = advancePrompt?.next
    if (next) setActiveLineId(next.line_id)
    setAdvancePrompt(null)
    setError(null)
    focusNext('serial')
  }

  /** Catch Enter at the input level (more reliable than form onSubmit when
   * the submit button is disabled — some browsers won't fire onSubmit then). */
  function onScanKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      submitOrAdvance()
    }
  }

  // Form onSubmit kept for the "Add scan" tap-button case + accessibility.
  function submitSerial(e: React.FormEvent) {
    e.preventDefault()
    submitOrAdvance()
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
      {/* Outbound only: per-LPN progress panel. Tells the operator which
          SKUs are still owed on the TO, how many of each are scanned vs
          ordered, and which inbound container each line is drawn from.
          Auto-advances visually as scans land. */}
      {h.kind === 'outbound' && outboundProgress && outboundProgress.length > 0 && (
        <ProgressPanel progress={outboundProgress} mode="outbound" />
      )}

      {/* Inbound: per-LPN fill progress on a (possibly mixed) container. The
          active line follows the operator's LPN selection rather than the
          first-incomplete heuristic. */}
      {isInbound && inboundProgress && inboundProgress.length > 0 && (
        <ProgressPanel
          progress={inboundProgress}
          mode="inbound"
          activeLineId={activeLineId}
        />
      )}

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

        {/* Inbound mixed container: pick which LPN you're scanning into. The
            picker defaults to the first incomplete LPN and auto-advances on
            acknowledgement, but the operator can override at any time. Only
            shown when the container actually has more than one LPN. */}
        {isInbound && inboundProgress && inboundProgress.length > 1 && (
          <label className="block">
            <span className="text-[10.5px] uppercase tracking-[0.14em] font-bold text-[#1B4676] mb-1 block">
              Scanning into LPN
            </span>
            <select
              value={activeLineId ?? ''}
              onChange={(e) => setActiveLineId(Number(e.target.value))}
              disabled={h.is_completed}
              className="font-mono w-full border border-slate-300 rounded-md px-3 py-2.5 text-sm text-[#1B4676] focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition disabled:bg-slate-50"
            >
              {inboundProgress.map((l) => {
                const done = l.order_qty > 0 && l.scanned_qty >= l.order_qty
                return (
                  <option key={l.line_id} value={l.line_id}>
                    {l.sku_raw} — {l.scanned_qty}/{l.order_qty}
                    {done ? ' ✓ complete' : ''}
                  </option>
                )
              })}
            </select>
          </label>
        )}

        <div
          className={`grid grid-cols-1 gap-3 ${
            h.requires_imei
              ? 'sm:grid-cols-[2fr_2fr_1fr_auto]'
              : 'sm:grid-cols-[2fr_1fr_auto]'
          }`}
        >
          {/*
            NOTE on inputMode: previously these fields had inputMode="none"
            to suppress the on-screen keyboard on tablets. In practice that
            attribute also disrupted rapid keyboard events from the Keyence
            BT-A500 (scans dropped or arrived in the wrong field). Removed
            so the inputs behave like the Notes field, which always works.
            If virtual-keyboard suppression is needed later, gate it on a
            touch-device detect rather than always-on.
          */}
          <input
            ref={serialInputRef}
            type="text"
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            onKeyDown={onScanKeyDown}
            placeholder="Scan serial number"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            className="font-mono w-full border border-slate-300 rounded-md px-4 py-4 text-xl tracking-wider text-[#1B4676] placeholder:text-slate-400 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition disabled:bg-slate-50"
            disabled={h.is_completed}
          />
          {h.requires_imei && (
            <input
              ref={imeiInputRef}
              type="text"
              value={imei}
              onChange={(e) => setImei(e.target.value)}
              onKeyDown={onScanKeyDown}
              placeholder="IMEI (auto after serial)"
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
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

        <div className="text-xs text-slate-500 flex items-center gap-3 flex-wrap">
          <span>
            {rows.length === 0
              ? 'No scans yet — go ahead.'
              : `${rows.length} scan${rows.length === 1 ? '' : 's'} on this container so far.`}
          </span>
          {queueLen > 0 && (
            <span
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/30 text-[#1B4676] font-bold"
              title="Scans waiting to be recorded"
            >
              <Spinner size={10} className="text-[#0093D0]" />
              {queueLen} queued
            </span>
          )}
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

      {/* LPN-switch modal — inbound mixed container. Raised when the active
          LPN reaches its vendor quantity (or the operator scans into a full
          LPN). Blocks further scans until acknowledged. */}
      {advancePrompt && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/60 flex items-center justify-center px-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-md w-full p-6 space-y-4">
            <div className="flex items-center gap-2 text-emerald-700">
              <svg className="w-6 h-6" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                <path
                  fillRule="evenodd"
                  d="M16.7 5.3a1 1 0 010 1.4l-7 7a1 1 0 01-1.4 0l-3-3a1 1 0 011.4-1.4L9 11.6l6.3-6.3a1 1 0 011.4 0z"
                  clipRule="evenodd"
                />
              </svg>
              <h3 className="text-lg font-bold">LPN complete</h3>
            </div>
            <p className="text-sm text-slate-600">
              <span className="font-mono font-bold text-[#1B4676]">
                {advancePrompt.completed.sku_raw}
              </span>{' '}
              is fully scanned (
              <span className="font-bold">
                {advancePrompt.completed.scanned_qty}/{advancePrompt.completed.order_qty}
              </span>
              ).{' '}
              {advancePrompt.next ? (
                <>
                  Switching to{' '}
                  <span className="font-mono font-bold text-[#1B4676]">
                    {advancePrompt.next.sku_raw}
                  </span>{' '}
                  (
                  {advancePrompt.next.scanned_qty}/{advancePrompt.next.order_qty}
                  ). Tap OK, then continue scanning.
                </>
              ) : (
                <>All LPNs on this container are complete. Tap OK, then press FINISH to lock the sheet.</>
              )}
            </p>
            <div className="flex items-center justify-end pt-2">
              <button
                type="button"
                onClick={handleAdvanceConfirmed}
                className="inline-flex items-center gap-2 rounded-full bg-[#0093D0] hover:bg-[#00A8E8] text-white font-bold px-6 py-2.5 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

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
  // `isScooter` controls the Box # column + layout colspans. It's now
  // sourced from the dedicated uses_box_numbers flag, not requires_imei —
  // they were decoupled when IMEI flipped to eBikes/Gliders.
  const isScooter = !!h.uses_box_numbers
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

/* ─── Per-LPN progress panel (inbound + outbound) ───────────────────────
 * Renders above the scan grid. One row per line:
 *   • outbound — one OutboundLine on the TO; active line is the first with
 *     capacity remaining, source-container hint shows where to pull from.
 *   • inbound  — one ContainerLine (LPN) on the container; active line
 *     follows the operator's LPN selection (activeLineId).
 * Lines that are 100% complete are dimmed with a green check.
 */
function ProgressPanel({
  progress,
  mode,
  activeLineId,
}: {
  progress: LineProgress[]
  mode: 'inbound' | 'outbound'
  activeLineId?: number | null
}) {
  const totalOrdered = progress.reduce((s, p) => s + p.order_qty, 0)
  const totalScanned = progress.reduce((s, p) => s + p.scanned_qty, 0)
  const activeIdx =
    mode === 'inbound' && activeLineId != null
      ? progress.findIndex((p) => p.line_id === activeLineId)
      : progress.findIndex((p) => p.scanned_qty < p.order_qty)
  const heading =
    mode === 'inbound' ? 'Receiving progress — per LPN' : 'Loading progress — per LPN'

  return (
    <div
      className="bg-white rounded-xl border border-slate-200 overflow-hidden"
      style={{
        boxShadow:
          '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
      }}
    >
      <div className="bg-slate-50 border-b border-slate-200 px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#1B4676]">
          {heading}
        </h3>
        <div className="text-xs font-mono text-slate-600">
          <span className="text-[#1B4676] font-bold">{totalScanned}</span>
          <span className="text-slate-400"> / </span>
          <span>{totalOrdered}</span>
          <span className="ml-1 text-slate-500">items</span>
        </div>
      </div>
      <ul className="divide-y divide-slate-100">
        {progress.map((p, idx) => {
          const isActive = idx === activeIdx
          const isComplete = p.scanned_qty >= p.order_qty && p.order_qty > 0
          const pct = p.order_qty > 0
            ? Math.min(100, Math.round((p.scanned_qty / p.order_qty) * 100))
            : 0
          return (
            <li
              key={p.line_id}
              className={`px-4 py-3 ${
                isActive
                  ? 'bg-[#0093D0]/5'
                  : isComplete
                  ? 'bg-emerald-50/40 opacity-90'
                  : ''
              }`}
            >
              <div className="flex items-baseline justify-between gap-3 mb-1.5">
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="text-[10.5px] uppercase tracking-wider text-slate-500 font-bold">
                    Line {p.line_no}
                  </span>
                  <span className="font-mono font-bold text-[#1B4676] truncate">
                    {p.sku_raw}
                  </span>
                  {p.description && (
                    <span className="text-xs text-slate-500 truncate">
                      {p.description}
                    </span>
                  )}
                  {isActive && (
                    <span className="text-[9.5px] uppercase tracking-wider font-bold text-[#0093D0] bg-[#0093D0]/10 border border-[#0093D0]/25 rounded-full px-2 py-0.5">
                      Active
                    </span>
                  )}
                  {isComplete && (
                    <span className="text-[9.5px] uppercase tracking-wider font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5 inline-flex items-center gap-1">
                      <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                        <path
                          fillRule="evenodd"
                          d="M16.7 5.3a1 1 0 010 1.4l-7 7a1 1 0 01-1.4 0l-3-3a1 1 0 011.4-1.4L9 11.6l6.3-6.3a1 1 0 011.4 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                      Done
                    </span>
                  )}
                </div>
                <span className="font-mono text-sm whitespace-nowrap">
                  <span className={`font-bold ${isComplete ? 'text-emerald-700' : 'text-[#1B4676]'}`}>
                    {p.scanned_qty}
                  </span>
                  <span className="text-slate-400"> / </span>
                  <span className="text-slate-700">{p.order_qty}</span>
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    isComplete
                      ? 'bg-emerald-500'
                      : isActive
                      ? 'bg-[#0093D0]'
                      : 'bg-slate-300'
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              {p.source_container_no && (
                <div className="mt-1.5 text-[11px] text-slate-500">
                  Pull from{' '}
                  <span className="font-mono text-[#1B4676]">
                    {p.source_container_no}
                  </span>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
