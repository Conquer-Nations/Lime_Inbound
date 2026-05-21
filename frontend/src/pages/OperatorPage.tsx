import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useAuth } from '../auth/AuthContext'
import {
  api,
  ApiError,
  OCR_AVAILABLE,
  SCAN_SHEETS_ENABLED,
  type ScanSheetOpenResponse,
} from '../api/client'
import BrandMark from '../components/BrandMark'
import CameraOcr from '../components/CameraOcr'
import ScanSheetMode from '../components/ScanSheetMode'
import type {
  ContainerLookupResponse,
  ScanResponse,
} from '../types/api'

type Phase = 'enter_container' | 'scanning' | 'done'

export default function OperatorPage() {
  const { user, signOut } = useAuth()
  const operator = user?.id ?? 'unknown'

  const [phase, setPhase] = useState<Phase>('enter_container')
  const [containerNo, setContainerNo] = useState('')
  const [lookup, setLookup] = useState<ContainerLookupResponse | null>(null)
  const [scanInput, setScanInput] = useState('')
  const [lastScan, setLastScan] = useState<ScanResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [finishSummary, setFinishSummary] = useState<{
    pallets_created: number
    total_scanned: number
  } | null>(null)

  // Scan-sheet mode state — used only when SCAN_SHEETS_ENABLED is true.
  // Holds the auto-opened receipt + pre-loaded rows from /operator/sheet/open.
  const [scanSheet, setScanSheet] = useState<ScanSheetOpenResponse | null>(null)
  const [sheetFinishSummary, setSheetFinishSummary] = useState<{
    container_no: string
    total_scanned: number
    download_url: string
  } | null>(null)

  const scanInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (phase === 'scanning') scanInputRef.current?.focus()
  }, [phase])

  async function handleContainerSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (SCAN_SHEETS_ENABLED) {
        // Scan-sheet flow: opens a Receipt + returns the pre-filled header
        // and any existing rows (re-open case). The legacy lookup path is
        // skipped entirely so we never create two receipts for the same
        // container.
        const sheet = await api.openScanSheet(
          containerNo.toUpperCase(),
          operator,
        )
        setScanSheet(sheet)
        setLookup(null)
        setLastScan(null)
        setPhase('scanning')
      } else {
        const data = await api.lookupContainer(
          containerNo.toUpperCase(),
          operator,
        )
        setLookup(data)
        setLastScan(null)
        setPhase('scanning')
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleScan(e: React.FormEvent) {
    e.preventDefault()
    if (!scanInput.trim() || !lookup) return
    setError(null)
    try {
      const data = await api.scan(lookup.receipt_id, scanInput.trim(), operator)
      setLastScan(data)
      setScanInput('')
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e))
    }
  }

  async function handleFinish() {
    if (!lookup) return
    setBusy(true)
    try {
      const data = await api.finishContainer(lookup.receipt_id, operator)
      setFinishSummary({
        pallets_created: data.pallets_created,
        total_scanned: data.total_scanned,
      })
      setPhase('done')
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setBusy(false)
    }
  }

  function resetForNextContainer() {
    setContainerNo('')
    setLookup(null)
    setLastScan(null)
    setFinishSummary(null)
    setScanSheet(null)
    setSheetFinishSummary(null)
    setError(null)
    setPhase('enter_container')
  }

  function handleSheetFinished(summary: {
    receipt_id: number
    container_no: string
    total_scanned: number
    download_url: string
  }) {
    setSheetFinishSummary({
      container_no: summary.container_no,
      total_scanned: summary.total_scanned,
      download_url: summary.download_url,
    })
    setPhase('done')
    // Auto-logout 4 seconds after the operator finishes a container — the
    // success card is the last thing they see, then they're back at the
    // sign-in screen for the next shift handoff.
    setTimeout(() => {
      signOut()
    }, 4000)
  }

  const activeContainerNo =
    scanSheet?.header.container_no ?? lookup?.container_no ?? ''
  const phaseLabel =
    phase === 'enter_container'
      ? 'Container intake'
      : phase === 'scanning'
      ? `Scanning ${activeContainerNo}`
      : 'Container closed'

  return (
    <OpsChrome role="Dock Operations" phaseLabel={phaseLabel}>
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-10">
        {error && (
          <div
            role="alert"
            className="mb-5 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5 flex items-start gap-2"
          >
            <span className="font-semibold">Error:</span>
            <span>{error}</span>
          </div>
        )}

        {phase === 'enter_container' && (
          <EnterContainer
            value={containerNo}
            onChange={setContainerNo}
            onSubmit={handleContainerSubmit}
            busy={busy}
          />
        )}

        {phase === 'scanning' && scanSheet && SCAN_SHEETS_ENABLED && (
          <ScanSheetMode
            sheet={scanSheet}
            operator={operator}
            onFinished={handleSheetFinished}
          />
        )}

        {phase === 'scanning' && lookup && !SCAN_SHEETS_ENABLED && (
          <Scanning
            lookup={lookup}
            lastScan={lastScan}
            scanInput={scanInput}
            scanInputRef={scanInputRef}
            onScanChange={setScanInput}
            onScanSubmit={handleScan}
            onFinish={handleFinish}
            busy={busy}
          />
        )}

        {phase === 'done' && sheetFinishSummary && (
          <SheetDonePanel summary={sheetFinishSummary} />
        )}

        {phase === 'done' && !sheetFinishSummary && finishSummary && (
          <DonePanel summary={finishSummary} onNext={resetForNextContainer} />
        )}
      </div>
    </OpsChrome>
  )
}

// ─── Chrome ────────────────────────────────────────────────────────────
// Navy top bar (vs. cyan for public vendor portal) signals "internal tool".
// Yellow accent strip + CN wordmark keep the brand cohesive.

function OpsChrome({
  role,
  phaseLabel,
  children,
}: {
  role: string
  phaseLabel?: string
  children: ReactNode
}) {
  const { user, signOut } = useAuth()
  const initial = user?.name?.[0]?.toUpperCase() ?? '?'

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 antialiased">
      <header
        className="text-white"
        style={{
          background:
            'linear-gradient(180deg, #0B1828 0%, #14233A 100%)',
        }}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BrandMark className="h-12 text-white" />
            <div className="leading-tight">
              <div className="text-base font-extrabold tracking-[0.16em]">
                CONQUER NATION
              </div>
              <div className="text-[10px] uppercase tracking-[0.28em] text-[#0093D0]">
                {role}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 sm:gap-4">
            {phaseLabel && (
              <div className="hidden sm:flex items-center gap-2 text-xs">
                <span
                  className="inline-flex w-2 h-2 rounded-full bg-[#0093D0]"
                  style={{ boxShadow: '0 0 10px rgba(0,147,208,0.8)' }}
                  aria-hidden
                />
                <span className="text-white/90">{phaseLabel}</span>
              </div>
            )}
            <div className="hidden md:flex items-center gap-2 text-sm text-white/90">
              <span
                className="w-8 h-8 rounded-full bg-white/10 ring-1 ring-white/20 flex items-center justify-center text-xs font-bold uppercase"
                aria-hidden
              >
                {initial}
              </span>
              <span>{user?.name}</span>
            </div>
            <button
              type="button"
              onClick={signOut}
              className="inline-flex items-center gap-2 rounded-full bg-white/8 hover:bg-white/15 border border-white/15 hover:border-white/30 px-4 py-1.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B1828]"
            >
              <LogOutIcon className="w-4 h-4" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      <div
        className="h-px"
        style={{
          background:
            'linear-gradient(90deg, transparent, rgba(0,147,208,0.65) 30%, rgba(0,147,208,0.65) 70%, transparent)',
        }}
        aria-hidden
      />

      <main>{children}</main>
    </div>
  )
}

// ─── Phase 1: enter container ──────────────────────────────────────────

function EnterContainer({
  value,
  onChange,
  onSubmit,
  busy,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: (e: React.FormEvent) => void
  busy: boolean
}) {
  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#1B4676] text-[11px] font-semibold tracking-[0.14em] uppercase mb-3">
          <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
          Step 1 of 3
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#1B4676]">
          CONTAINER INTAKE
        </h1>
        <p className="mt-2 text-slate-600">
          {OCR_AVAILABLE
            ? 'Photograph the container number plate, or type it directly.'
            : 'Type the container number to open the scan sheet.'}
        </p>
      </div>

      <div
        className="bg-white rounded-xl border border-slate-200 p-6 sm:p-7 space-y-5"
        style={{
          boxShadow:
            '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
        }}
      >
        {/* The photo-capture flow only shows up when VITE_OCR_BASE is
            wired — otherwise the OCR service isn't reachable and the
            operator would hit a confusing 503. Manual entry below
            always works regardless. */}
        {OCR_AVAILABLE && (
          <>
            <CameraOcr onAccept={(c) => onChange(c)} />
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-slate-200" />
              <span className="text-[10.5px] text-slate-500 uppercase tracking-[0.18em] font-semibold">
                or type manually
              </span>
              <div className="flex-1 h-px bg-slate-200" />
            </div>
          </>
        )}

        <form onSubmit={onSubmit}>
          <label className="block text-xs font-semibold text-[#1B4676] mb-1.5">
            Container number <span className="text-slate-400 font-normal">(ISO 6346)</span>
          </label>
          <input
            type="text"
            className="w-full border-2 border-slate-300 rounded-md px-3 py-3 font-mono text-lg tracking-wider uppercase text-[#1B4676] placeholder:text-slate-400 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
            placeholder="HLXU9005263"
            value={value}
            onChange={(e) => onChange(e.target.value.toUpperCase())}
            pattern="^[A-Z]{4}\d{7}$"
            required
          />
          <button
            type="submit"
            disabled={busy || value.length === 0}
            className="mt-4 w-full bg-[#0093D0] hover:bg-[#00A8E8] disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-white font-bold rounded-full py-3.5 text-base transition flex items-center justify-center gap-2 shadow-[0_8px_24px_-4px_rgba(0,147,208,0.45)] hover:shadow-[0_8px_28px_-2px_rgba(0,147,208,0.6)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
          >
            {busy ? (
              <span>Looking up…</span>
            ) : (
              <>
                <span>Look up container</span>
                <ArrowRightIcon className="w-4 h-4" />
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  )
}

// ─── Phase 2: scanning ─────────────────────────────────────────────────

function Scanning({
  lookup,
  lastScan,
  scanInput,
  scanInputRef,
  onScanChange,
  onScanSubmit,
  onFinish,
  busy,
}: {
  lookup: ContainerLookupResponse
  lastScan: ScanResponse | null
  scanInput: string
  scanInputRef: React.RefObject<HTMLInputElement>
  onScanChange: (v: string) => void
  onScanSubmit: (e: React.FormEvent) => void
  onFinish: () => void
  busy: boolean
}) {
  const totalScanned = lastScan?.total_scanned ?? lookup.total_scanned
  const totalExpected = lookup.total_expected
  const pct = totalExpected === 0 ? 0 : Math.round((totalScanned / totalExpected) * 100)
  const currentAssignment = lastScan?.current_assignment ?? lookup.assignments[0] ?? null
  const nextAssignment = lastScan?.next_assignment ?? null
  const autoFinish = lastScan?.auto_finish ?? false

  return (
    <div className="space-y-5">
      {/* Header card */}
      <div
        className="bg-white rounded-xl border border-slate-200 px-5 py-4"
        style={{ boxShadow: '0 1px 2px 0 rgba(15,23,42,0.04)' }}
      >
        <div className="flex items-center gap-3 flex-wrap">
          <div className="font-mono text-xl font-bold tracking-wider text-[#1B4676]">
            {lookup.container_no}
          </div>
          <span className="text-xs bg-[#0093D0]/10 text-[#1B4676] font-semibold px-2 py-0.5 rounded-full">
            {lookup.do_number}
          </span>
          <span className="text-xs bg-slate-100 text-slate-700 font-medium px-2 py-0.5 rounded-full">
            {lookup.customer_name}
          </span>
          <div className="flex-1" />
          <span className="text-[10.5px] uppercase font-bold tracking-[0.15em] text-white bg-[#1B4676] px-2 py-0.5 rounded">
            {lookup.container_status}
          </span>
        </div>

        {lookup.alerts.length > 0 && (
          <div className="mt-3 space-y-2">
            {lookup.alerts.map((a, i) => (
              <div
                key={i}
                className="text-sm bg-amber-50 border border-amber-300 text-amber-900 rounded-md px-3 py-2 flex items-start gap-2"
              >
                <span className="font-bold">⚠</span>
                <span>{a.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Current assignment / auto-finish callout */}
      {currentAssignment && (
        <div
          className={`rounded-xl px-6 py-5 border-2 ${
            autoFinish
              ? 'bg-emerald-50 border-emerald-500'
              : 'bg-white border-[#0093D0]'
          }`}
          style={{ boxShadow: '0 4px 12px -4px rgba(0,147,208,0.15)' }}
        >
          {autoFinish ? (
            <>
              <div className="flex items-center gap-3">
                <CheckIcon className="w-7 h-7 text-emerald-600" />
                <h3 className="text-xl font-bold text-emerald-900">All items received</h3>
              </div>
              <p className="text-sm text-emerald-800 mt-2">
                Tap FINISH to close container{' '}
                <span className="font-mono font-semibold">{lookup.container_no}</span>.
              </p>
            </>
          ) : (
            <>
              <div className="text-[10.5px] uppercase text-[#0093D0] font-bold tracking-[0.18em]">
                Put pallets in
              </div>
              <div className="text-3xl sm:text-4xl font-bold mt-1 text-[#1B4676]">
                Lot {currentAssignment.lot_code}
              </div>
              <div className="text-sm text-slate-600 mt-1">
                {currentAssignment.floor_name} ·{' '}
                <span className="font-mono">{currentAssignment.sku}</span>
              </div>
              <div className="text-sm text-slate-700 mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                <span>
                  <span className="font-bold text-[#1B4676]">
                    {currentAssignment.items_placed}
                  </span>
                  {' / '}
                  {currentAssignment.items_expected} items
                </span>
                <span className="text-slate-300">·</span>
                <span>
                  <span className="font-bold text-[#1B4676]">
                    {currentAssignment.actual_pallets}
                  </span>
                  {' / '}
                  {currentAssignment.planned_pallets} pallets
                </span>
              </div>
            </>
          )}
        </div>
      )}

      {/* Scan input or finish button */}
      {autoFinish ? (
        <button
          type="button"
          onClick={onFinish}
          disabled={busy}
          className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white text-xl font-bold rounded-xl py-5 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 flex items-center justify-center gap-3"
        >
          <CheckIcon className="w-6 h-6" />
          <span>{busy ? 'CLOSING…' : 'FINISH CONTAINER'}</span>
        </button>
      ) : (
        <form
          onSubmit={onScanSubmit}
          className="bg-white rounded-xl border border-slate-200 p-5"
          style={{ boxShadow: '0 1px 2px 0 rgba(15,23,42,0.04)' }}
        >
          <label className="block text-[10.5px] uppercase text-[#0093D0] font-bold tracking-[0.18em] mb-1.5">
            Scan item
          </label>
          <input
            ref={scanInputRef}
            type="text"
            className="w-full border-2 border-slate-300 rounded-md px-3 py-3 font-mono tracking-wider text-lg text-[#0B1828] placeholder:text-slate-400 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/30 focus:outline-none transition"
            placeholder="Scan or type barcode + Enter"
            value={scanInput}
            onChange={(e) => onScanChange(e.target.value)}
            autoFocus
          />
          {lastScan && (
            <div
              className={`mt-3 text-sm rounded-md px-3 py-2 flex items-start gap-2 ${
                lastScan.accepted
                  ? 'bg-emerald-50 text-emerald-900 border border-emerald-300'
                  : 'bg-red-50 text-red-800 border border-red-300'
              }`}
            >
              {lastScan.accepted ? (
                <CheckIcon className="w-4 h-4 mt-0.5 flex-shrink-0 text-emerald-600" />
              ) : (
                <span className="font-bold flex-shrink-0">✕</span>
              )}
              <span>
                {lastScan.accepted
                  ? lastScan.auto_cut
                    ? `Recorded. Lot ${currentAssignment?.lot_code} is full.${
                        nextAssignment
                          ? ` Next: Lot ${nextAssignment.lot_code}.`
                          : ' No more lots.'
                      }`
                    : 'Recorded.'
                  : `${lastScan.result}: ${lastScan.error_reason ?? ''}`}
              </span>
            </div>
          )}
        </form>
      )}

      {/* Progress bar */}
      <div
        className="bg-white rounded-xl border border-slate-200 p-4"
        style={{ boxShadow: '0 1px 2px 0 rgba(15,23,42,0.04)' }}
      >
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="text-[10.5px] uppercase text-[#0093D0] font-bold tracking-[0.18em]">
            Container progress
          </span>
          <span className="font-mono text-sm text-[#1B4676] font-semibold">
            {totalScanned} / {totalExpected}{' '}
            <span className="text-slate-400">({pct}%)</span>
          </span>
        </div>
        <div className="w-full bg-slate-100 rounded-full h-3 overflow-hidden">
          <div
            className="bg-[#0093D0] h-3 transition-all duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Manifest */}
      <div
        className="bg-white rounded-xl border border-slate-200 overflow-hidden"
        style={{ boxShadow: '0 1px 2px 0 rgba(15,23,42,0.04)' }}
      >
        <div className="bg-slate-50 border-b border-slate-200 px-4 py-2.5">
          <h3 className="text-[10.5px] uppercase font-bold tracking-[0.18em] text-[#0093D0]">
            Manifest
          </h3>
        </div>
        <table className="w-full text-sm">
          <thead className="text-[10.5px] text-slate-500 uppercase tracking-wider">
            <tr>
              <th className="text-left px-4 py-2 font-semibold">SKU</th>
              <th className="text-right px-4 py-2 font-semibold">Expected</th>
              <th className="text-right px-4 py-2 font-semibold">Scanned</th>
              <th className="text-right px-4 py-2 font-semibold">Items / pallet</th>
            </tr>
          </thead>
          <tbody className="font-mono divide-y divide-slate-100">
            {lookup.lines.map((l, i) => (
              <tr key={i}>
                <td className="px-4 py-2 text-[#1B4676]">{l.sku}</td>
                <td className="px-4 py-2 text-right text-slate-700">{l.qty}</td>
                <td
                  className={`px-4 py-2 text-right font-bold ${
                    l.scanned >= l.qty ? 'text-emerald-700' : 'text-[#1B4676]'
                  }`}
                >
                  {l.scanned}
                </td>
                <td className="px-4 py-2 text-right text-slate-500">
                  {l.items_per_pallet ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Phase 3: done ─────────────────────────────────────────────────────

function DonePanel({
  summary,
  onNext,
}: {
  summary: { pallets_created: number; total_scanned: number }
  onNext: () => void
}) {
  return (
    <div className="max-w-xl mx-auto text-center">
      <div className="mb-6 flex flex-col items-center">
        <div
          className="w-16 h-16 rounded-full bg-emerald-500/10 border-2 border-emerald-500/40 flex items-center justify-center text-emerald-600 mb-4"
          aria-hidden
        >
          <CheckIcon className="w-8 h-8" />
        </div>
        <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-700 text-[11px] font-semibold tracking-[0.14em] uppercase mb-2">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden />
          Closed
        </div>
        <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#1B4676]">
          Container closed
        </h2>
        <p className="mt-2 text-slate-600">
          <span className="font-bold text-[#1B4676]">{summary.total_scanned}</span> items
          received across{' '}
          <span className="font-bold text-[#1B4676]">{summary.pallets_created}</span>{' '}
          pallets.
        </p>
      </div>

      <button
        type="button"
        onClick={onNext}
        className="inline-flex items-center gap-2 bg-[#0093D0] hover:bg-[#00A8E8] text-white font-bold rounded-full px-7 py-3.5 text-base transition shadow-[0_8px_24px_-4px_rgba(0,147,208,0.5)] hover:shadow-[0_8px_28px_-2px_rgba(0,147,208,0.65)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
      >
        <span>Next container</span>
        <ArrowRightIcon className="w-4 h-4" />
      </button>
    </div>
  )
}

// ─── Phase 3 (scan-sheet variant): done ────────────────────────────────

function SheetDonePanel({
  summary,
}: {
  summary: { container_no: string; total_scanned: number; download_url: string }
}) {
  return (
    <div className="max-w-xl mx-auto text-center">
      <div className="mb-6 flex flex-col items-center">
        <div
          className="w-16 h-16 rounded-full bg-emerald-500/10 border-2 border-emerald-500/40 flex items-center justify-center text-emerald-600 mb-4"
          aria-hidden
        >
          <CheckIcon className="w-8 h-8" />
        </div>
        <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-700 text-[11px] font-semibold tracking-[0.14em] uppercase mb-2">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden />
          Locked
        </div>
        <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#1B4676]">
          Sheet finalized
        </h2>
        <p className="mt-2 text-slate-600">
          <span className="font-mono font-bold text-[#1B4676]">
            {summary.container_no}
          </span>{' '}
          —{' '}
          <span className="font-bold text-[#1B4676]">
            {summary.total_scanned}
          </span>{' '}
          scan{summary.total_scanned === 1 ? '' : 's'} recorded.
        </p>
        <p className="mt-4 text-sm text-slate-500">
          Signing you out…
        </p>
      </div>
    </div>
  )
}

// ─── Brand mark ────────────────────────────────────────────────────────


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

function ArrowRightIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
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
