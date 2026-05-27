import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { api, ApiError, SCAN_SHEETS_ENABLED } from '../api/client'
import { useVendorAuth } from '../auth/VendorAuthContext'
import Spinner from '../components/Spinner'
import VendorPortalChrome from '../components/VendorPortalChrome'
import { ContainerDocumentUploads } from '../components/ContainerDocumentUploads'
import { StatusTimeline } from '../components/StatusTimeline'
import { CalendarView } from '../components/CalendarView'
import type { WHPOIntakeResponse } from '../types/api'
import BrandMark from '../components/BrandMark'
import { isAuditor } from './AuditPage'
import {
  OutboundModeChooser,
  OutboundNewOrderForm,
  OutboundDriverInfoForm,
  OutboundUpdateOrderForm,
  OutboundViewOrderForm,
  OutboundInventoryDashboard,
} from './OutboundComponents'
import {
  parseShipments,
  groupByWHPO,
  type ParseResult,
  type WHPOGroup,
} from '../lib/parseShipments'
import StructuredShipmentsEditor, {
  makeEmptyWHPO,
  validateStructuredWHPO,
  type StructuredWHPO,
} from '../components/StructuredShipmentsEditor'
import QuickImportModal from '../components/QuickImportModal'
import VendorTallyStatus from '../components/VendorTallyStatus'

// Brand whose path keeps the legacy paste-format Quick Import shortcut
// (its parser was built for Lime's broker-email format). Other brands
// only see the structured per-container form.
const STRUCTURED_BRAND = 'Lime Mobility'

const CUSTOMERS = ['Lime Mobility', 'Boviet Solar', 'Pan American Wire MFG', 'National Plastic']

interface FormState {
  customer: string
  submitter_name: string
  submitter_email: string
  shipments: string  // big paste field
  notes: string
  damage_flag: 'No' | 'Yes'
  damage_notes: string
}

const EMPTY_FORM: FormState = {
  customer: '',
  submitter_name: '',
  submitter_email: '',
  shipments: '',
  notes: '',
  damage_flag: 'No',
  damage_notes: '',
}

// Parser extracted to lib/parseShipments — also used by QuickImportModal
// on the TQL → Lime structured path.

// ─── Page ──────────────────────────────────────────────────────────────

type Mode =
  | 'direction'       // top-level INBOUND vs OUTBOUND tile picker
  | 'outbound_soon'   // (legacy) outbound coming-soon placeholder
  | 'choose'          // inbound 4-card workflow picker
  | 'new'
  | 'driver'
  | 'update'
  | 'view'
  // Outbound (Phase 2)
  | 'out_choose'
  | 'out_new'
  | 'out_driver'
  | 'out_update'
  | 'out_view'
  | 'out_inventory'

export default function VendorIntakePage() {
  const { isLoggedIn, user: vendorUser, signOut: vendorSignOut } = useVendorAuth()
  const nav = useNavigate()
  const handleVendorSignOut = () => {
    vendorSignOut()
    nav('/vendor', { replace: true })
  }
  const [mode, setMode] = useState<Mode>('direction')
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<WHPOIntakeResponse[] | null>(null)

  // Brands the vendor can submit shipments for, fetched from
  // /vendor/auth/my-brands. Backend resolves vendor.company → Account →
  // [brands under it], or → [single brand], or → [company-as-string].
  // If >1 → show "Submitting on behalf of" picker. If 1 → no picker, the
  // single brand is the customer automatically.
  const [myBrands, setMyBrands] = useState<string[] | null>(null)
  const [brandForTQL, setBrandForTQL] = useState<string>('')
  useEffect(() => {
    if (!isLoggedIn) return
    api
      .myBrands()
      .then((bs) => {
        setMyBrands(bs)
        // If only one brand, auto-select so submit doesn't gate on a picker.
        if (bs.length === 1) setBrandForTQL(bs[0])
      })
      .catch(() => setMyBrands([vendorUser?.company ?? ''])) // legacy fallback
  }, [isLoggedIn, vendorUser?.company])
  const needsBrandPicker = (myBrands?.length ?? 0) > 1
  // Effective brand = picked brand (if picker shown) else the single brand.
  const effectiveBrand = needsBrandPicker
    ? brandForTQL
    : myBrands?.[0] ?? vendorUser?.company ?? ''
  // Structured form is the default for every logged-in vendor — paste
  // textarea is legacy and only ever surfaces as the Quick Import shortcut
  // on the Lime path. (Multi-brand vendors still need to pick a brand
  // before submit, but the form layout doesn't depend on it.)
  const useStructuredForm = isLoggedIn
  const showQuickImport = effectiveBrand === STRUCTURED_BRAND
  const [structuredWHPO, setStructuredWHPO] = useState<StructuredWHPO>(() => makeEmptyWHPO())
  const [quickImportOpen, setQuickImportOpen] = useState(false)

  // Live parse for preview — must run on every render (React Rules of Hooks).
  const parsed = useMemo(() => parseShipments(form.shipments), [form.shipments])
  const groups = useMemo(() => groupByWHPO(parsed.lines), [parsed.lines])
  const structuredErrors = useMemo(
    () => (useStructuredForm ? validateStructuredWHPO(structuredWHPO) : []),
    [useStructuredForm, structuredWHPO]
  )

  // Gate: page reload wipes the in-memory session, which would land an
  // unauthenticated vendor on the chooser screen. Force them through login.
  // Must come AFTER all hooks per Rules of Hooks.
  if (!isLoggedIn) {
    return <Navigate to="/vendor" replace />
  }

  if (mode === 'direction') {
    return <DirectionChooser onChoose={setMode} />
  }
  if (mode === 'outbound_soon') {
    return <OutboundComingSoon onBack={() => setMode('direction')} />
  }
  if (mode === 'choose') {
    return <ModeChooser onChoose={setMode} onBack={() => setMode('direction')} />
  }
  if (mode === 'driver') {
    return <DriverInfoForm onBack={() => setMode('choose')} />
  }
  if (mode === 'update') {
    return <UpdateShipmentForm onBack={() => setMode('choose')} />
  }
  if (mode === 'view') {
    return <ViewShipmentForm onBack={() => setMode('choose')} />
  }
  // ── Outbound (Phase 2) ───────────────────────────────────────────
  if (mode === 'out_choose') {
    return (
      <OutboundModeChooser
        onChoose={setMode}
        onBack={() => setMode('direction')}
      />
    )
  }
  if (mode === 'out_new') {
    return <OutboundNewOrderForm onBack={() => setMode('out_choose')} />
  }
  if (mode === 'out_driver') {
    return <OutboundDriverInfoForm onBack={() => setMode('out_choose')} />
  }
  if (mode === 'out_update') {
    return <OutboundUpdateOrderForm onBack={() => setMode('out_choose')} />
  }
  if (mode === 'out_view') {
    return <OutboundViewOrderForm onBack={() => setMode('out_choose')} />
  }
  if (mode === 'out_inventory') {
    return <OutboundInventoryDashboard onBack={() => setMode('direction')} />
  }
  // mode === 'new' falls through to the existing form below

  function update<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((s) => ({ ...s, [k]: v }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    // Gate by the active input mode.
    if (useStructuredForm) {
      if (structuredErrors.length > 0) {
        setError(`Fix ${structuredErrors.length} field error(s) before submitting.`)
        return
      }
    } else {
      if (parsed.errors.length > 0) {
        setError(`Fix the ${parsed.errors.length} parse error(s) before submitting.`)
        return
      }
      if (groups.length === 0) {
        setError('Add at least one shipment line.')
        return
      }
    }
    // Multi-brand vendors must pick which brand they're submitting for
    // (their session's company is the Account, not a Customer the
    // warehouse can store against).
    if (needsBrandPicker && !brandForTQL) {
      setError('Select which company this shipment is for.')
      return
    }

    setSubmitting(true)
    try {
      const fullNotes = [
        form.notes,
        form.damage_flag === 'Yes' ? `Damage notes: ${form.damage_notes}` : null,
      ]
        .filter(Boolean)
        .join('\n')

      // Packaging is no longer collected from the vendor — the warehouse
      // operations team derives footprint from SKU master data + qty.
      const packaging = null

      // TQL submits ON BEHALF OF a brand they picked. Other logged-in
      // vendors submit for their own company. Anonymous fallback uses the
      // form field.
      const customer = isLoggedIn ? effectiveBrand : form.customer
      const submitterName =
        isLoggedIn && vendorUser ? vendorUser.full_name : form.submitter_name
      const submitterEmail =
        isLoggedIn && vendorUser ? vendorUser.email : form.submitter_email

      // Build the submission list. Structured-form path = single WHPO from
      // the editor. Paste path = one submission per parsed WHPO group.
      const submissions = useStructuredForm
        ? [
            {
              whpo_number: structuredWHPO.whpo_number,
              expected_arrival_date: structuredWHPO.expected_arrival_date,
              containers: structuredWHPO.containers,
            },
          ]
        : groups.map((g) => ({
            whpo_number: g.whpo,
            expected_arrival_date: g.expected_arrival_date,
            containers: g.containers,
          }))

      const allResults: WHPOIntakeResponse[] = []
      for (const s of submissions) {
        const result = await api.submitWHPO({
          customer,
          whpo_number: s.whpo_number,
          submitter_name: submitterName,
          submitter_email: submitterEmail,
          expected_arrival_date: s.expected_arrival_date,
          containers: s.containers,
          packaging,
          notes: fullNotes || null,
        })
        allResults.push(result)
      }
      setResults(allResults)
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  function startAnother() {
    setForm(EMPTY_FORM)
    setStructuredWHPO(makeEmptyWHPO())
    setResults(null)
    setError(null)
    // Keep brandForTQL so a multi-brand user can submit several WHPOs for
    // the same brand in a row without re-picking it each time.
  }

  if (results) {
    return (
      <SuccessPanel
        results={results}
        onNext={startAnother}
        onBackToChooser={() => {
          setMode('choose')
          startAnother()
        }}
      />
    )
  }

  return (
    <VendorPortalChrome
      breadcrumbCurrent="New Shipment"
      onBack={() => setMode('choose')}
    >
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
        {/* Title */}
        <div className="mb-8">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#1B4676] text-[11px] font-semibold tracking-[0.14em] uppercase mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
            WHPO/Load No Intake
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#1B4676]">
            NEW SHIPMENT
          </h1>
          <p className="mt-3 text-base text-slate-600 max-w-2xl leading-relaxed">
            Add each container and its SKU lines below.{' '}
            {needsBrandPicker &&
              'Pick which brand this shipment is for, then fill in the containers.'}
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-6 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5 flex items-start gap-2"
          >
            <span className="font-semibold">Error:</span>
            <span>{error}</span>
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-xl border border-slate-200 p-6 sm:p-8 space-y-7"
          style={{
            boxShadow:
              '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
          }}
        >
          <Section title="Who you are">
            {isLoggedIn && vendorUser ? (
              <div className="rounded-lg border border-[#0093D0]/25 bg-[#0093D0]/5 px-4 py-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0]">
                    Submitting as
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-[#1B4676]">
                      {vendorUser.full_name}
                      <span className="text-slate-400 font-normal">
                        {' '}· {vendorUser.email}
                      </span>
                    </div>
                    <div className="text-xs text-slate-600">
                      {vendorUser.company}
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex items-center justify-between gap-3 flex-wrap text-xs text-slate-500">
                  <span>
                    Your company, name, and email auto-fill from your account.
                  </span>
                  <button
                    type="button"
                    onClick={handleVendorSignOut}
                    className="font-semibold text-[#1B4676] hover:text-[#0093D0] underline-offset-2 hover:underline focus:outline-none focus-visible:underline"
                  >
                    Sign out
                  </button>
                </div>
                {needsBrandPicker && myBrands && (
                  <div className="mt-3 pt-3 border-t border-[#0093D0]/20">
                    <Select
                      label="Submitting on behalf of"
                      required
                      value={brandForTQL}
                      onChange={setBrandForTQL}
                      options={myBrands}
                    />
                    {brandForTQL && (
                      <p className="text-[11px] text-slate-500 mt-1">
                        {brandForTQL === STRUCTURED_BRAND
                          ? 'Lime shipments use the structured form below. The Quick Import shortcut takes the legacy paste format.'
                          : `${brandForTQL} shipments use the structured form below — enter each container and SKU directly.`}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <span className="font-semibold">Tip:</span> Vendors with a
                  Conquer Nation account can{' '}
                  <Link to="/vendor/login" className="underline font-medium">
                    sign in
                  </Link>{' '}
                  to skip these fields — they auto-fill from your registration.
                </div>
                <Select
                  label="Customer"
                  required
                  value={form.customer}
                  onChange={(v) => update('customer', v)}
                  options={CUSTOMERS}
                />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <TextField
                    label="Your name"
                    required
                    value={form.submitter_name}
                    onChange={(v) => update('submitter_name', v)}
                  />
                  <TextField
                    label="Your email"
                    type="email"
                    required
                    value={form.submitter_email}
                    onChange={(v) => update('submitter_email', v)}
                  />
                </div>
              </>
            )}
          </Section>

          <Section title="Shipments">
            {useStructuredForm ? (
              <StructuredShipmentsEditor
                whpo={structuredWHPO}
                onChange={setStructuredWHPO}
                onQuickImport={
                  // Quick Import wraps the legacy Lime-format parser.
                  // Only surface it on the Lime path; other brands' emails
                  // don't follow that token shape so it would just produce
                  // errors.
                  showQuickImport ? () => setQuickImportOpen(true) : undefined
                }
              />
            ) : (
              <>
                <div>
                  <label className="block text-xs font-semibold text-[#1B4676] mb-1.5">
                    Paste one line per (container × SKU){' '}
                    <span className="text-[#0093D0]">*</span>
                  </label>
                  <p className="text-xs text-slate-500 mb-2">
                    Format:&nbsp;
                    <code className="bg-slate-100 text-[#1B4676] px-1.5 py-0.5 rounded font-mono">
                      CONTAINER WHPO/LOAD NO DATE TIME QTY TYPE SKU
                    </code>
                    &nbsp;— whitespace-separated, any spacing.
                  </p>
                  <textarea
                    className="w-full border border-slate-300 rounded-md px-3 py-2 font-mono text-sm text-slate-800 placeholder:text-slate-400 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition h-44"
                    placeholder={`HPCU4492096   36648912   5/15   8am   320   Scooters       LPN-003743
ABCU1234567   36648912   5/15   9am   500   Bikes          LPN-001234
HPCU9999999   36648913   5/16   10am  100   Solar Panels   LPN-002222`}
                    value={form.shipments}
                    onChange={(e) => update('shipments', e.target.value)}
                    required
                    spellCheck={false}
                  />
                </div>

                {(parsed.lines.length > 0 || parsed.errors.length > 0) && (
                  <ParsePreview parsed={parsed} groups={groups} />
                )}
              </>
            )}
          </Section>

          <Section title="Notes">
            <Select
              label="Any known damage or special handling?"
              required
              value={form.damage_flag}
              onChange={(v) => update('damage_flag', v as 'Yes' | 'No')}
              options={['No', 'Yes']}
            />
            {form.damage_flag === 'Yes' && (
              <TextArea
                label="Damage / handling notes"
                required
                value={form.damage_notes}
                onChange={(v) => update('damage_notes', v)}
              />
            )}
            <TextArea
              label="Other notes (optional)"
              value={form.notes}
              onChange={(v) => update('notes', v)}
            />
          </Section>

          <button
            type="submit"
            disabled={
              submitting ||
              (useStructuredForm
                ? structuredErrors.length > 0
                : parsed.errors.length > 0 || groups.length === 0)
            }
            className={`w-full bg-[#0093D0] hover:bg-[#00A8E8] text-white font-bold rounded-full py-3.5 text-base transition flex items-center justify-center gap-2 shadow-[0_8px_24px_-4px_rgba(0,147,208,0.45)] hover:shadow-[0_8px_28px_-2px_rgba(0,147,208,0.6)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2 ${
              submitting
                ? 'opacity-90 cursor-wait'
                : 'disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed'
            }`}
          >
            {submitting ? (
              <>
                <Spinner size={18} className="text-white" />
                <span>Submitting…</span>
              </>
            ) : (
              <>
                <span>
                  {useStructuredForm
                    ? 'Submit shipment'
                    : groups.length <= 1
                    ? 'Submit shipment'
                    : `Submit ${groups.length} shipments`}
                </span>
                <ArrowRightIcon className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        <QuickImportModal
          open={quickImportOpen}
          onClose={() => setQuickImportOpen(false)}
          onApply={setStructuredWHPO}
        />
      </div>
    </VendorPortalChrome>
  )
}

// ─── Parse preview ─────────────────────────────────────────────────────

function ParsePreview({
  parsed,
  groups,
}: {
  parsed: ParseResult
  groups: WHPOGroup[]
}) {
  return (
    <div className="mt-3 space-y-3">
      {parsed.errors.length > 0 && (
        <div className="text-sm bg-red-50 border border-red-200 rounded-md px-3 py-2">
          <div className="font-medium text-red-800 mb-1">
            {parsed.errors.length} line{parsed.errors.length === 1 ? '' : 's'} couldn't be parsed:
          </div>
          <ul className="text-xs text-red-700 space-y-1">
            {parsed.errors.map((e, i) => (
              <li key={i}>
                <span className="font-mono">{e.raw.slice(0, 60)}</span>
                <span className="text-red-500"> — {e.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {groups.length > 0 && (
        <div className="text-sm bg-green-50 border border-green-200 rounded-md px-3 py-2">
          <div className="font-medium text-green-900 mb-1">
            ✓ Will submit {groups.length} WHPO/Load No{groups.length === 1 ? '' : 's'}
          </div>
          {groups.map((g) => (
            <details key={g.whpo} className="text-xs text-green-900 mt-1" open>
              <summary className="cursor-pointer">
                WHPO/Load No <span className="font-mono">{g.whpo}</span> — {g.containers.length} container
                {g.containers.length === 1 ? '' : 's'}, {' '}
                {g.containers.reduce((a, c) => a + c.lines.length, 0)} SKU lines
              </summary>
              <table className="w-full mt-2 text-xs font-mono">
                <thead className="text-green-700">
                  <tr>
                    <th className="text-left">Container</th>
                    <th className="text-left">Date</th>
                    <th className="text-left">Time</th>
                    <th className="text-right">Qty</th>
                    <th className="text-left">Type</th>
                    <th className="text-left">SKU</th>
                  </tr>
                </thead>
                <tbody>
                  {g.containers.flatMap((c) =>
                    c.lines.map((l, li) => (
                      <tr key={`${c.container_no}-${li}`} className="border-t border-green-200">
                        <td>{li === 0 ? c.container_no : ''}</td>
                        <td>{li === 0 ? c.expected_arrival_date : ''}</td>
                        <td>{li === 0 ? c.expected_arrival_time?.slice(0, 5) : ''}</td>
                        <td className="text-right">{l.qty}</td>
                        <td>{l.product_type ?? '—'}</td>
                        <td>{l.sku}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </details>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Success panel ─────────────────────────────────────────────────────

function SuccessPanel({
  results,
  onNext,
  onBackToChooser,
}: {
  results: WHPOIntakeResponse[]
  onNext: () => void
  onBackToChooser: () => void
}) {
  const totalExceptions = results.reduce((a, r) => a + r.exceptions_opened.length, 0)
  return (
    <VendorPortalChrome
      breadcrumbCurrent="Submission received"
      onBack={onBackToChooser}
    >
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
        {/* Header */}
        <div className="mb-8 flex items-start gap-4">
          <div
            className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-600 flex-shrink-0"
            aria-hidden
          >
            <CheckIcon className="w-6 h-6" />
          </div>
          <div>
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-700 text-[11px] font-semibold tracking-[0.14em] uppercase mb-2">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden />
              Received
            </div>
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#1B4676]">
              {results.length === 1
                ? 'Shipment submitted'
                : `${results.length} shipments submitted`}
            </h1>
            <p className="mt-2 text-slate-600">
              Conquer Nation operations has been notified. Delivery Order
              {results.length === 1 ? '' : 's'} below.
            </p>
          </div>
        </div>

        {/* DO list */}
        <div
          className="bg-white rounded-xl border border-slate-200 overflow-hidden"
          style={{
            boxShadow:
              '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
          }}
        >
          <div className="bg-slate-50 border-b border-slate-200 px-5 py-3">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#0093D0]">
              Delivery Orders Issued
            </h2>
          </div>
          <ul className="divide-y divide-slate-200">
            {results.map((r) => (
              <li key={r.whpo_id} className="px-5 py-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-bold text-[#1B4676] text-base">
                    {r.do_number}
                  </span>
                  <ArrowRightIcon className="w-4 h-4 text-slate-300" />
                  <span className="font-mono text-slate-600 text-sm">
                    WHPO/Load No {r.whpo_number}
                  </span>
                  <span className="ml-auto text-[10.5px] uppercase font-bold tracking-[0.15em] text-slate-600 bg-slate-100 px-2 py-0.5 rounded">
                    {r.do_status.replace(/_/g, ' ')}
                  </span>
                </div>
                <div className="text-xs text-slate-500 mt-1.5 flex items-center flex-wrap gap-x-3 gap-y-1">
                  <span>
                    {r.containers.length} container
                    {r.containers.length === 1 ? '' : 's'}
                  </span>
                  {r.exceptions_opened.length > 0 && (
                    <span className="text-amber-700 font-medium">
                      ⚠ {r.exceptions_opened.length} issue
                      {r.exceptions_opened.length === 1 ? '' : 's'} for warehouse review
                    </span>
                  )}
                  {r.idempotent_replay && (
                    <span className="text-slate-500 italic">
                      replay — existing DO returned
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>

        {totalExceptions > 0 && (
          <div className="mt-4 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2.5">
            <span className="font-semibold">Heads up:</span> warehouse manager will
            contact you for any missing SKU details.
          </div>
        )}

        {/* Actions */}
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <button
            onClick={onNext}
            className="inline-flex items-center gap-2 bg-[#0093D0] hover:bg-[#00A8E8] text-white font-semibold rounded-full px-6 py-3 transition shadow-[0_8px_24px_-4px_rgba(0,147,208,0.45)] hover:shadow-[0_8px_28px_-2px_rgba(0,147,208,0.6)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
          >
            <span>Submit another shipment</span>
            <ArrowRightIcon className="w-4 h-4" />
          </button>
          <button
            onClick={onBackToChooser}
            className="text-sm text-[#1B4676] hover:text-[#0093D0] font-medium transition focus:outline-none focus-visible:underline"
          >
            ← Back to portal home
          </button>
        </div>
      </div>
    </VendorPortalChrome>
  )
}

// ─── Reusable form bits ────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#0093D0] mb-4 pb-2 border-b border-slate-200">
        {title}
      </h3>
      <div className="space-y-4">{children}</div>
    </div>
  )
}

function TextField({
  label,
  value,
  onChange,
  required,
  type = 'text',
  placeholder,
  hint,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  required?: boolean
  type?: string
  placeholder?: string
  hint?: string
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-[#1B4676] mb-1.5">
        {label} {required && <span className="text-[#0093D0]">*</span>}
      </label>
      <input
        type={type}
        className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
      />
      {hint && <p className="text-xs text-slate-500 mt-1">{hint}</p>}
    </div>
  )
}

function TextArea({
  label,
  value,
  onChange,
  required,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  required?: boolean
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-[#1B4676] mb-1.5">
        {label} {required && <span className="text-[#0093D0]">*</span>}
      </label>
      <textarea
        className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition h-20"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
      />
    </div>
  )
}

function Select({
  label,
  value,
  onChange,
  options,
  required,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: string[]
  required?: boolean
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-[#1B4676] mb-1.5">
        {label} {required && <span className="text-[#0093D0]">*</span>}
      </label>
      <select
        className="w-full border border-slate-300 rounded-md px-3 py-2 bg-white text-sm text-slate-800 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
      >
        <option value="">— select —</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  )
}


// ─── Mode chooser ──────────────────────────────────────────────────────

function ModeChooser({
  onChoose,
  onBack,
}: {
  onChoose: (m: 'new' | 'driver' | 'update' | 'view') => void
  onBack?: () => void
}) {
  const { user, signOut } = useVendorAuth()
  const nav = useNavigate()
  const handleSignOut = () => {
    signOut()
    nav('/vendor', { replace: true })
  }
  const initial = user?.full_name?.[0]?.toUpperCase() ?? '?'
  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 antialiased relative overflow-hidden">
      {/* Faint industrial grid */}
      <div
        aria-hidden
        className="fixed inset-0 pointer-events-none"
        style={{
          backgroundImage:
            'linear-gradient(rgba(27,70,118,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(27,70,118,0.05) 1px, transparent 1px)',
          backgroundSize: '56px 56px',
          maskImage: 'radial-gradient(ellipse at top, black 35%, transparent 80%)',
          WebkitMaskImage: 'radial-gradient(ellipse at top, black 35%, transparent 80%)',
        }}
      />
      {/* Cyan wash from the top */}
      <div
        aria-hidden
        className="fixed inset-x-0 top-0 h-80 pointer-events-none"
        style={{
          background:
            'linear-gradient(to bottom, rgba(0,147,208,0.08), transparent)',
        }}
      />

      {/* Top bar — deep navy with cyan accent, matching conquernation.com */}
      <header
        className="relative z-20 text-white"
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
                Vendor Portal
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 sm:gap-4">
            <div className="hidden sm:flex items-center gap-2 text-xs text-white/80">
              <span
                className="inline-flex w-2 h-2 rounded-full bg-emerald-400"
                style={{ boxShadow: '0 0 10px rgba(110,231,183,0.8)' }}
                aria-hidden
              />
              <span>Systems operational</span>
            </div>
            {user && (
              <div className="hidden md:flex items-center gap-2 text-sm text-white/95">
                <span
                  className="w-8 h-8 rounded-full bg-white/10 ring-1 ring-white/20 flex items-center justify-center text-xs font-bold uppercase"
                  aria-hidden
                >
                  {initial}
                </span>
                <div className="leading-tight">
                  <div className="text-sm font-semibold">{user.full_name}</div>
                  <div className="text-[10.5px] uppercase tracking-wider text-white/60">
                    {user.company}
                  </div>
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={handleSignOut}
              className="inline-flex items-center gap-2 rounded-full bg-white/8 hover:bg-white/15 border border-white/15 hover:border-white/30 px-4 py-1.5 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B1828]"
              title="Sign out of your vendor account"
            >
              <LogOutIcon className="w-4 h-4" />
              <span>Sign out</span>
            </button>
          </div>
        </div>
      </header>

      {/* Cyan accent — matches the conquernation.com brand strip */}
      <div
        className="h-px"
        style={{
          background:
            'linear-gradient(90deg, transparent, rgba(0,147,208,0.65) 30%, rgba(0,147,208,0.65) 70%, transparent)',
        }}
        aria-hidden
      />

      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="relative z-10 border-b border-slate-200 bg-white">
        <ol className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center gap-2 text-sm text-slate-500">
          <li className="flex items-center gap-2">
            <LayoutDashboardIcon className="w-4 h-4 text-[#0093D0]" />
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
          <li aria-hidden>
            <ChevronRightIcon className="w-4 h-4 text-slate-300" />
          </li>
          <li aria-current="page" className="text-[#1B4676] font-semibold">
            Inbound — select workflow
          </li>
        </ol>
      </nav>

      {/* Main */}
      <main className="relative z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
          {/* Hero */}
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#1B4676] text-[11px] font-semibold tracking-[0.14em] uppercase mb-5">
              <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
              Inbound
            </div>
            <h1 className="text-3xl sm:text-4xl lg:text-[2.75rem] font-bold tracking-tight text-[#1B4676] leading-[1.1]">
              What are you submitting today?
            </h1>
            <p className="mt-4 text-base sm:text-lg text-slate-600 max-w-2xl leading-relaxed">
              Pick the inbound workflow that matches your delivery. Conquer Nation
              operations is notified the moment your information lands in our system.
            </p>
            <p className="mt-3 text-[11px] uppercase tracking-[0.22em] text-slate-400 font-semibold">
              Logistics Simplified.
            </p>
          </div>

          {/* Cards */}
          <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 items-stretch">
            <IntakeCard
              icon={<PackagePlusIcon className="w-6 h-6" />}
              eyebrow="Intake"
              title="New shipment"
              description="Submit a WHPO/Load No with container numbers, SKUs, and arrival date. A Delivery Order is issued automatically."
              metaLeft={{ icon: <ClockIcon className="w-3.5 h-3.5" />, label: '~2 min' }}
              metaRight={{
                icon: <HashIcon className="w-3.5 h-3.5" />,
                label: 'WHPO/Load No',
              }}
              ctaLabel="Start new shipment"
              onClick={() => onChoose('new')}
            />
            <IntakeCard
              icon={<TruckIcon className="w-6 h-6" />}
              eyebrow="Driver"
              title="Driver & truck info"
              description="Add driver, truck, carrier, insurance, and supporting photos to a container already on file."
              metaLeft={{ icon: <ClockIcon className="w-3.5 h-3.5" />, label: '~1 min' }}
              metaRight={{
                icon: <ContainerIcon className="w-3.5 h-3.5" />,
                label: 'Container #',
              }}
              ctaLabel="Add driver details"
              onClick={() => onChoose('driver')}
            />
            <IntakeCard
              icon={<EditIcon className="w-6 h-6" />}
              eyebrow="Amend"
              title="Update shipment"
              description="Amend an open WHPO/Load No — swap container numbers, fix arrival, or update SKU lines before receiving."
              metaLeft={{ icon: <ClockIcon className="w-3.5 h-3.5" />, label: '~1 min' }}
              metaRight={{
                icon: <HashIcon className="w-3.5 h-3.5" />,
                label: 'WHPO/Load No',
              }}
              ctaLabel="Update shipment"
              onClick={() => onChoose('update')}
            />
            <IntakeCard
              icon={<EyeIcon className="w-6 h-6" />}
              eyebrow="Review"
              title="View shipment"
              description="Pull up a WHPO/Load No to see containers, lines, driver details, and uploaded documents on file."
              metaLeft={{ icon: <ClockIcon className="w-3.5 h-3.5" />, label: '~30 sec' }}
              metaRight={{
                icon: <HashIcon className="w-3.5 h-3.5" />,
                label: 'WHPO/Load No',
              }}
              ctaLabel="View shipment"
              onClick={() => onChoose('view')}
            />
          </div>

          {/* Support strip */}
          <section
            aria-label="Operations support"
            className="mt-12 rounded-xl border border-slate-200 bg-white p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center gap-5 sm:gap-8 shadow-sm"
          >
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-md bg-[#0093D0]/10 flex items-center justify-center text-[#0093D0]"
                aria-hidden
              >
                <LifeBuoyIcon className="w-5 h-5" />
              </div>
              <div>
                <div className="text-sm font-semibold text-[#1B4676]">
                  Need help with intake?
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  Operations is on the dock Mon–Fri, 6:00 AM – 4:00 PM PT.
                </div>
              </div>
            </div>
            <div className="sm:ml-auto flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
              <a
                href="tel:+13106786768"
                className="inline-flex items-center gap-2 text-[#1B4676] font-medium hover:text-[#0093D0] transition"
              >
                <PhoneIcon className="w-4 h-4 text-[#0093D0]" />
                <span>(310) 678-6768</span>
              </a>
              <a
                href="mailto:developer@conquernation.com"
                className="inline-flex items-center gap-2 text-[#1B4676] font-medium hover:text-[#0093D0] transition"
              >
                <MailIcon className="w-4 h-4 text-[#0093D0]" />
                <span>developer@conquernation.com</span>
              </a>
            </div>
          </section>

          {/* Audit console link — rendered only for hardcoded auditor
              emails. Keeps the 4-tile hub above untouched for normal
              vendors; auditors get a thin admin entry below. Hidden
              entirely when SCAN_SHEETS_ENABLED is off. */}
          {SCAN_SHEETS_ENABLED && isAuditor(user?.email) && (
            <div className="mt-6">
              <Link
                to="/vendor/audit"
                className="group inline-flex items-center gap-3 rounded-xl border border-[#1B4676]/20 bg-[#1B4676]/[0.04] hover:bg-[#1B4676]/[0.08] px-5 py-3 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
              >
                <span className="inline-flex items-center justify-center w-9 h-9 rounded-md bg-[#1B4676] text-white">
                  <EyeIcon className="w-4 h-4" />
                </span>
                <span>
                  <span className="block text-[10px] uppercase tracking-[0.18em] font-bold text-[#0093D0]">
                    Admin
                  </span>
                  <span className="block text-sm font-semibold text-[#1B4676]">
                    Audit console — search and export scan sheets
                  </span>
                </span>
                <span className="ml-2 text-[#0093D0] group-hover:translate-x-0.5 transition-transform">→</span>
              </Link>
            </div>
          )}
        </div>
      </main>

      {/* Footer — navy bar, mirroring the cyan header for symmetry */}
      <footer className="relative z-10 bg-[#1B4676] text-white/85 mt-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col sm:flex-row gap-3 sm:items-center justify-between text-xs">
          <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4">
            <span className="font-semibold tracking-wide">© 2026 Conquer Nation Inc.</span>
            <span className="hidden sm:inline text-white/30">·</span>
            <span>2651 E. 12th St., Los Angeles, CA 90023</span>
          </div>
          <a
            href="https://www.conquernation.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-white/85 hover:text-white transition"
          >
            conquernation.com →
          </a>
        </div>
      </footer>
    </div>
  )
}

// ─── Direction chooser (INBOUND vs OUTBOUND) ──────────────────────────

function VendorPortalShell({
  breadcrumb,
  children,
  onBack,
}: {
  breadcrumb: string
  children: React.ReactNode
  onBack?: () => void
}) {
  const { user, signOut } = useVendorAuth()
  const nav = useNavigate()
  const handleSignOut = () => {
    signOut()
    nav('/vendor', { replace: true })
  }
  const initial = user?.full_name?.[0]?.toUpperCase() ?? '?'
  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 antialiased relative overflow-hidden">
      <div
        aria-hidden
        className="fixed inset-0 pointer-events-none"
        style={{
          backgroundImage:
            'linear-gradient(rgba(27,70,118,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(27,70,118,0.05) 1px, transparent 1px)',
          backgroundSize: '56px 56px',
          maskImage: 'radial-gradient(ellipse at top, black 35%, transparent 80%)',
          WebkitMaskImage: 'radial-gradient(ellipse at top, black 35%, transparent 80%)',
        }}
      />
      <header
        className="relative z-20 text-white"
        style={{ background: 'linear-gradient(180deg, #0B1828 0%, #14233A 100%)' }}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BrandMark className="h-12 text-white" />
            <div className="leading-tight">
              <div className="text-base font-extrabold tracking-[0.16em]">CONQUER NATION</div>
              <div className="text-[10px] uppercase tracking-[0.28em] text-[#0093D0]">
                Vendor Portal
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 sm:gap-4">
            {user && (
              <div className="hidden md:flex items-center gap-2 text-sm text-white/95">
                <span className="w-8 h-8 rounded-full bg-white/10 ring-1 ring-white/20 flex items-center justify-center text-xs font-bold uppercase">
                  {initial}
                </span>
                <div className="leading-tight">
                  <div className="text-sm font-semibold">{user.full_name}</div>
                  <div className="text-[10.5px] uppercase tracking-wider text-white/60">
                    {user.company}
                  </div>
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={handleSignOut}
              className="inline-flex items-center gap-2 rounded-full bg-white/8 hover:bg-white/15 border border-white/15 hover:border-white/30 px-4 py-1.5 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B1828]"
            >
              <LogOutIcon className="w-4 h-4" />
              <span>Sign out</span>
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
      <nav aria-label="Breadcrumb" className="relative z-10 border-b border-slate-200 bg-white">
        <ol className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center gap-2 text-sm text-slate-500">
          <li className="flex items-center gap-2">
            <LayoutDashboardIcon className="w-4 h-4 text-[#0093D0]" />
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
          <li aria-hidden>
            <ChevronRightIcon className="w-4 h-4 text-slate-300" />
          </li>
          <li aria-current="page" className="text-[#1B4676] font-semibold">
            {breadcrumb}
          </li>
        </ol>
      </nav>
      <main className="relative z-10">{children}</main>
    </div>
  )
}

function DirectionChooser({
  onChoose,
}: {
  onChoose: (m: Mode) => void
}) {
  // Live inventory snapshot so the vendor sees their inbound/outbound/
  // pending totals on the landing page. Best-effort: failures show as
  // dashes, never block the page.
  const [inventory, setInventory] = useState<{
    total_inbound: number
    total_outbound: number
    total_pending: number
    container_count: number
  } | null>(null)
  const [inventoryBusy, setInventoryBusy] = useState(true)
  useEffect(() => {
    let cancelled = false
    api
      .outboundContainerInventory()
      .then((r) => {
        if (cancelled) return
        setInventory({
          total_inbound: r.total_inbound,
          total_outbound: r.total_outbound,
          total_pending: r.total_pending,
          container_count: r.containers.length,
        })
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setInventoryBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <VendorPortalShell breadcrumb="Choose direction">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#1B4676] text-[11px] font-semibold tracking-[0.14em] uppercase mb-5">
            <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
            Vendor Portal
          </div>
          <h1 className="text-3xl sm:text-4xl lg:text-[2.75rem] font-bold tracking-tight text-[#1B4676] leading-[1.1]">
            What are you doing today?
          </h1>
          <p className="mt-4 text-base sm:text-lg text-slate-600 max-w-2xl leading-relaxed">
            Pick the direction of your shipment. Inbound means a shipment is
            arriving at Conquer Nation. Outbound means we ship items from the
            warehouse to your customer.
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 sm:grid-cols-2 gap-6">
          <DirectionTile
            label="INBOUND"
            tagline="Shipments arriving at our dock"
            description="Submit a new shipment, add driver / truck details, update an existing shipment, or look up a WHPO already on file."
            onClick={() => onChoose('choose')}
            accent="cyan"
          />
          <DirectionTile
            label="OUTBOUND"
            tagline="Orders leaving the warehouse"
            description="Place a Transfer Order, attach driver / truck info, update an existing order, or look up one already on file."
            onClick={() => onChoose('out_choose')}
            accent="navy"
          />
        </div>

        {/* Container inventory summary — live across all your inbound
            containers. Clicking opens the full per-container dashboard.
            Placed ABOVE the calendar — vendors most often check stock
            before doing anything else. */}
        <button
          type="button"
          onClick={() => onChoose('out_inventory')}
          className="group mt-12 w-full text-left rounded-2xl border border-slate-200 bg-white hover:border-[#1B4676]/50 hover:shadow-[0_24px_60px_-20px_rgba(15,23,42,0.18)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1B4676] focus-visible:ring-offset-2 transition-all duration-200 overflow-hidden"
          style={{
            boxShadow:
              '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
          }}
        >
          <div className="p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center gap-5">
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-md bg-[#1B4676]/10 flex items-center justify-center text-[#1B4676]"
                aria-hidden
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-5 h-5"
                >
                  <rect width="7" height="7" x="3" y="3" rx="1" />
                  <rect width="7" height="7" x="14" y="3" rx="1" />
                  <rect width="7" height="7" x="14" y="14" rx="1" />
                  <rect width="7" height="7" x="3" y="14" rx="1" />
                </svg>
              </div>
              <div className="leading-tight">
                <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#1B4676]">
                  Container inventory
                </div>
                <div className="text-sm font-semibold text-[#1B4676]">
                  {inventoryBusy
                    ? 'Loading…'
                    : inventory
                    ? `${inventory.container_count} container${inventory.container_count === 1 ? '' : 's'} on hand`
                    : 'Open the dashboard'}
                </div>
              </div>
            </div>

            <div className="sm:ml-auto grid grid-cols-3 gap-3 sm:gap-5">
              <SummaryStat
                label="Inbound"
                value={inventory ? inventory.total_inbound : null}
                tone="slate"
              />
              <SummaryStat
                label="Outbound"
                value={inventory ? inventory.total_outbound : null}
                tone="navy"
              />
              <SummaryStat
                label="Pending"
                value={inventory ? inventory.total_pending : null}
                tone="yellow"
              />
            </div>

            <span
              className="hidden sm:inline-flex items-center gap-1 text-sm font-bold text-[#1B4676] group-hover:translate-x-1 transition-transform"
              aria-hidden
            >
              <span>Open</span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-4 h-4"
              >
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </svg>
            </span>
          </div>
        </button>

        {/* Master inventory sheet — full row-per-container view across
            every brand the JWT can access. TQL logins see Lime + Pan
            American Wire + Boviet Solar + National Plastic on the same
            sheet (filterable). Direct-brand logins see only their brand. */}
        <Link
          to="/vendor/master-list"
          className="group mt-4 block w-full text-left rounded-2xl border border-slate-200 bg-white hover:border-[#0093D0]/50 hover:shadow-[0_24px_60px_-20px_rgba(15,23,42,0.18)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2 transition-all duration-200 overflow-hidden"
          style={{
            boxShadow:
              '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
          }}
        >
          <div className="p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center gap-5">
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-md bg-[#0093D0]/10 flex items-center justify-center text-[#0093D0]"
                aria-hidden
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-5 h-5"
                >
                  <path d="M3 3h18v18H3z" />
                  <path d="M3 9h18" />
                  <path d="M3 15h18" />
                  <path d="M9 3v18" />
                  <path d="M15 3v18" />
                </svg>
              </div>
              <div className="leading-tight">
                <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0]">
                  Master inventory sheet
                </div>
                <div className="text-sm font-semibold text-[#1B4676]">
                  Full inbound + outbound row per container, across every
                  brand under your account.
                </div>
              </div>
            </div>
            <span
              className="sm:ml-auto hidden sm:inline-flex items-center gap-1 text-sm font-bold text-[#0093D0] group-hover:translate-x-1 transition-transform"
              aria-hidden
            >
              <span>Open</span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-4 h-4"
              >
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </svg>
            </span>
          </div>
        </Link>

        {/* Activity calendar — your inbound + outbound over the next 2 weeks. */}
        <div className="mt-12">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="text-lg sm:text-xl font-bold tracking-tight text-[#1B4676]">
              Next 2 weeks — your activity
            </h2>
            <span className="text-[11px] uppercase tracking-[0.18em] text-slate-400 font-semibold">
              Calendar
            </span>
          </div>
          <CalendarView
            fetcher={(d) => api.vendorCalendar(d)}
            defaultDays={14}
            emptyHint="No inbound or outbound activity scheduled in the next 2 weeks. Submit a WHPO or Transfer Order to see it here."
          />
        </div>
      </div>
    </VendorPortalShell>
  )
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string
  value: number | null
  tone: 'slate' | 'navy' | 'yellow'
}) {
  const bg =
    tone === 'navy'
      ? 'bg-[#1B4676] text-white'
      : tone === 'yellow'
      ? 'bg-[#FED641] text-[#1B4676]'
      : 'bg-slate-100 text-slate-800'
  return (
    <div className={`rounded-md px-3 py-2 min-w-[5rem] text-center ${bg}`}>
      <div className="text-[10px] uppercase tracking-wider font-semibold opacity-80">
        {label}
      </div>
      <div className="text-lg font-bold font-mono leading-tight">
        {value === null ? '—' : value.toLocaleString()}
      </div>
    </div>
  )
}

function DirectionTile({
  label,
  tagline,
  description,
  onClick,
  accent,
  comingSoon,
}: {
  label: string
  tagline: string
  description: string
  onClick: () => void
  accent: 'cyan' | 'navy'
  comingSoon?: boolean
}) {
  const accentColor = accent === 'cyan' ? '#0093D0' : '#1B4676'
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative text-left bg-white rounded-2xl border border-slate-200 hover:border-[color:var(--accent)] hover:shadow-[0_24px_60px_-20px_rgba(15,23,42,0.18)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2 transition-all duration-200"
      style={{
        ['--accent' as any]: accentColor,
        boxShadow:
          '0 1px 2px 0 rgba(15,23,42,0.04), 0 12px 32px -10px rgba(15,23,42,0.10)',
      }}
    >
      <div className="p-7 sm:p-9">
        <div
          className="text-[10.5px] uppercase tracking-[0.18em] font-bold mb-3"
          style={{ color: accentColor }}
        >
          {tagline}
        </div>
        <div className="flex items-center gap-3 mb-4">
          <h2
            className="text-4xl sm:text-5xl font-extrabold tracking-tight"
            style={{ color: accentColor }}
          >
            {label}
          </h2>
          {comingSoon && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold uppercase tracking-wider">
              Coming soon
            </span>
          )}
        </div>
        <p className="text-sm sm:text-base text-slate-600 leading-relaxed">
          {description}
        </p>
        <div
          className="mt-6 inline-flex items-center gap-2 text-sm font-semibold transition-transform group-hover:translate-x-1"
          style={{ color: accentColor }}
        >
          <span>Continue</span>
          <ChevronRightIcon className="w-4 h-4" />
        </div>
      </div>
    </button>
  )
}

function OutboundComingSoon({ onBack }: { onBack: () => void }) {
  return (
    <VendorPortalShell breadcrumb="Outbound — coming soon" onBack={onBack}>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
        <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-amber-100 border border-amber-200 text-amber-800 text-[11px] font-semibold tracking-[0.14em] uppercase mb-6">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden />
          Coming Soon
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#1B4676] mb-5">
          Outbound orders are on the way
        </h1>
        <p className="text-base sm:text-lg text-slate-600 leading-relaxed mb-8">
          The same 4-step flow you use for inbound — New order, Driver & truck
          info, Update order, View order — will be available here once the
          matching engine and scan-out flow are wired. For now, use the
          INBOUND side to submit and track shipments arriving at the dock.
        </p>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 rounded-full bg-[#1B4676] hover:bg-[#224E72] text-white font-bold px-6 py-3 text-sm transition shadow-[0_8px_24px_-4px_rgba(27,70,118,0.45)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
        >
          ← Back to direction picker
        </button>
      </div>
    </VendorPortalShell>
  )
}

function IntakeCard({
  icon,
  eyebrow,
  title,
  description,
  metaLeft,
  metaRight,
  ctaLabel,
  onClick,
}: {
  icon: React.ReactNode
  eyebrow: string
  title: string
  description: string
  metaLeft: { icon: React.ReactNode; label: string }
  metaRight: { icon: React.ReactNode; label: string }
  ctaLabel: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative h-full flex flex-col text-left rounded-xl bg-white border border-slate-200 hover:border-[#0093D0]/50 transition-all overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
      style={{
        boxShadow:
          '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
      }}
    >
      {/* Body fills the cell so the CTA bar always sits flush at the bottom,
          regardless of description length. Title gets a min-h so 1- and 2-line
          titles occupy the same vertical space across cards. */}
      <div className="p-6 flex-1 flex flex-col">
        <div className="flex items-start justify-between gap-3">
          <div
            className="w-12 h-12 rounded-lg bg-[#0093D0] flex items-center justify-center text-white group-hover:bg-[#1B4676] transition flex-shrink-0"
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
      {/* Bright-blue CTA bar — matches the gradient pill style on conquernation.com */}
      <div
        className="px-6 py-4 flex items-center justify-between gap-2 transition text-white"
        style={{
          background:
            'linear-gradient(90deg, #0093D0 0%, #00A8E8 100%)',
        }}
      >
        <span className="font-bold text-sm leading-tight">{ctaLabel}</span>
        <ArrowRightIcon className="w-4 h-4 group-hover:translate-x-1 transition-transform flex-shrink-0" />
      </div>
    </button>
  )
}

// ─── Brand mark — approximation of the CN double-loop logo ─────────────


// ─── Inline icons (lucide-style, 24x24, currentColor stroke) ───────────

function Icon({
  children,
  className,
}: {
  children: React.ReactNode
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

function PackagePlusIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M16 16h6" />
      <path d="M19 13v6" />
      <path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0" />
      <path d="M3.3 7 12 12l8.7-5" />
      <path d="M12 22V12" />
    </Icon>
  )
}

function TruckIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
      <path d="M15 18H9" />
      <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
      <circle cx="17" cy="18" r="2" />
      <circle cx="7" cy="18" r="2" />
    </Icon>
  )
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </Icon>
  )
}

function HashIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <line x1="4" x2="20" y1="9" y2="9" />
      <line x1="4" x2="20" y1="15" y2="15" />
      <line x1="10" x2="8" y1="3" y2="21" />
      <line x1="16" x2="14" y1="3" y2="21" />
    </Icon>
  )
}

function ContainerIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M22 7.7c0-.6-.4-1.2-.8-1.5l-6.3-3.9a1.72 1.72 0 0 0-1.7 0l-10.3 6c-.5.2-.9.8-.9 1.4v6.6c0 .5.4 1.2.8 1.5l6.3 3.9a1.72 1.72 0 0 0 1.7 0l10.3-6c.5-.3.9-1 .9-1.5Z" />
      <path d="M10 21.9V14L2.1 9.1" />
      <path d="m10 14 11.9-6.9" />
      <path d="M14 19.8v-8.1" />
      <path d="M18 17.5V9.4" />
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

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="m9 18 6-6-6-6" />
    </Icon>
  )
}

function LayoutDashboardIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect width="7" height="9" x="3" y="3" rx="1" />
      <rect width="7" height="5" x="14" y="3" rx="1" />
      <rect width="7" height="9" x="14" y="12" rx="1" />
      <rect width="7" height="5" x="3" y="16" rx="1" />
    </Icon>
  )
}

function LifeBuoyIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="m4.93 4.93 4.24 4.24" />
      <path d="m14.83 9.17 4.24-4.24" />
      <path d="m14.83 14.83 4.24 4.24" />
      <path d="m9.17 14.83-4.24 4.24" />
      <circle cx="12" cy="12" r="4" />
    </Icon>
  )
}

function PhoneIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </Icon>
  )
}

function MailIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </Icon>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <polyline points="20 6 9 17 4 12" />
    </Icon>
  )
}

function EditIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </Icon>
  )
}

function EyeIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  )
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </Icon>
  )
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </Icon>
  )
}

function LockIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
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

// ─── Driver info form ──────────────────────────────────────────────────

interface ContainerOption {
  container_no: string
  has_driver_info: boolean
  driver_name: string | null
}

interface DriverFormState {
  carrier: string
  driver_name: string
  driver_license: string
  driver_phone: string
  truck_license_plate: string
  insurance: string
}

const EMPTY_DRIVER: DriverFormState = {
  carrier: '',
  driver_name: '',
  driver_license: '',
  driver_phone: '',
  truck_license_plate: '',
  insurance: '',
}

function DriverInfoForm({ onBack }: { onBack: () => void }) {
  const [whpoNumber, setWhpoNumber] = useState('')
  const [lookupBusy, setLookupBusy] = useState(false)
  const [containers, setContainers] = useState<ContainerOption[] | null>(null)
  const [whpoMeta, setWhpoMeta] = useState<{ do_number: string; customer_name: string } | null>(
    null,
  )
  const [selectedContainer, setSelectedContainer] = useState<string>('')

  const [d, setD] = useState<DriverFormState>(EMPTY_DRIVER)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    container_no: string
    whpo_number: string
    do_number: string
    rows_affected: number
  } | null>(null)

  function update<K extends keyof DriverFormState>(k: K, v: DriverFormState[K]) {
    setD((s) => ({ ...s, [k]: v }))
  }

  function resetWhpo() {
    setContainers(null)
    setWhpoMeta(null)
    setSelectedContainer('')
    setD(EMPTY_DRIVER)
    setError(null)
  }

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!/^\d{8}$/.test(whpoNumber)) {
      setError('WHPO/Load No must be exactly 8 digits.')
      return
    }
    setLookupBusy(true)
    try {
      const r = await api.listWHPOContainers(whpoNumber)
      setContainers(r.containers)
      setWhpoMeta({ do_number: r.do_number, customer_name: r.customer_name })
      // Auto-select if there's only one container
      if (r.containers.length === 1) {
        setSelectedContainer(r.containers[0].container_no)
      } else if (r.containers.length === 0) {
        setError('No containers found for this WHPO/Load No.')
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setLookupBusy(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!selectedContainer) {
      setError('Pick a container first.')
      return
    }
    setSubmitting(true)
    try {
      const r = await api.submitContainerDriverInfo(selectedContainer, {
        carrier: d.carrier,
        driver_name: d.driver_name,
        driver_license: d.driver_license,
        driver_phone: d.driver_phone,
        truck_license_plate: d.truck_license_plate,
        insurance: d.insurance,
      })
      setResult(r)
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  if (result) {
    return (
      <VendorPortalChrome breadcrumbCurrent="Driver info recorded" onBack={onBack}>
        <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
          {/* Header */}
          <div className="mb-8 flex items-start gap-4">
            <div
              className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-600 flex-shrink-0"
              aria-hidden
            >
              <CheckIcon className="w-6 h-6" />
            </div>
            <div>
              <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-700 text-[11px] font-semibold tracking-[0.14em] uppercase mb-2">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden />
                Recorded
              </div>
              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#1B4676]">
                Driver info recorded
              </h1>
              <p className="mt-2 text-slate-600">
                The dock and OneDrive sheet should reflect the new driver fields within
                a few seconds.
              </p>
            </div>
          </div>

          {/* Detail card */}
          <div
            className="bg-white rounded-xl border border-slate-200 overflow-hidden"
            style={{
              boxShadow:
                '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
            }}
          >
            <div className="bg-slate-50 border-b border-slate-200 px-5 py-3">
              <h2 className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#0093D0]">
                Update summary
              </h2>
            </div>
            <dl className="text-sm divide-y divide-slate-200">
              <div className="flex items-center px-5 py-3">
                <dt className="w-36 text-xs uppercase tracking-wider font-semibold text-slate-500">
                  Container
                </dt>
                <dd className="font-mono font-bold text-[#1B4676]">{result.container_no}</dd>
              </div>
              <div className="flex items-center px-5 py-3">
                <dt className="w-36 text-xs uppercase tracking-wider font-semibold text-slate-500">
                  WHPO/Load No
                </dt>
                <dd className="font-mono text-slate-700">{result.whpo_number}</dd>
              </div>
              <div className="flex items-center px-5 py-3">
                <dt className="w-36 text-xs uppercase tracking-wider font-semibold text-slate-500">
                  Delivery Order
                </dt>
                <dd className="font-mono text-slate-700">{result.do_number}</dd>
              </div>
              <div className="flex items-center px-5 py-3">
                <dt className="w-36 text-xs uppercase tracking-wider font-semibold text-slate-500">
                  Rows updated
                </dt>
                <dd className="text-slate-700">{result.rows_affected}</dd>
              </div>
            </dl>
          </div>

          {/* Documents the vendor uploaded for this container — visible
              confirmation + re-upload if something's wrong. */}
          <div
            className="mt-6 bg-white rounded-xl border border-slate-200 p-5 sm:p-6"
            style={{
              boxShadow:
                '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
            }}
          >
            <ContainerDocumentUploads
              containerNo={result.container_no}
              title="Documents on file for this container"
              description="Everything you've uploaded for this driver/truck. Tap Replace if anything looks off, or upload a missing one."
            />
          </div>

          {/* Actions */}
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <button
              onClick={() => {
                setResult(null)
                setWhpoNumber('')
                resetWhpo()
              }}
              className="inline-flex items-center gap-2 bg-[#0093D0] hover:bg-[#00A8E8] text-white font-semibold rounded-full px-6 py-3 transition shadow-[0_8px_24px_-4px_rgba(0,147,208,0.45)] hover:shadow-[0_8px_28px_-2px_rgba(0,147,208,0.6)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
            >
              <span>Submit for another container</span>
              <ArrowRightIcon className="w-4 h-4" />
            </button>
            <button
              onClick={onBack}
              className="text-sm text-[#1B4676] hover:text-[#0093D0] font-medium transition focus:outline-none focus-visible:underline"
            >
              ← Back to portal home
            </button>
          </div>
        </div>
      </VendorPortalChrome>
    )
  }

  return (
    <VendorPortalChrome breadcrumbCurrent="Driver & Truck Info" onBack={onBack}>
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
        {/* Title */}
        <div className="mb-8">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#1B4676] text-[11px] font-semibold tracking-[0.14em] uppercase mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
            Driver Update
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#1B4676]">
            DRIVER &amp; TRUCK INFO
          </h1>
          <p className="mt-3 text-base text-slate-600 max-w-xl leading-relaxed">
            One driver per container. Look up your WHPO/Load No, pick the container, and add
            driver, license, plate, and insurance details.
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-6 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5 flex items-start gap-2"
          >
            <span className="font-semibold">Error:</span>
            <span>{error}</span>
          </div>
        )}

        {/* Stage 1: WHPO lookup */}
        {!containers && (
          <form
            onSubmit={handleLookup}
            className="bg-white rounded-xl border border-slate-200 p-6 sm:p-8 space-y-5"
            style={{
              boxShadow:
                '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
            }}
          >
            <Section title="Step 1 — Find your shipment">
              <TextField
                label="WHPO/Load No (8 digits)"
                required
                value={whpoNumber}
                onChange={(v) => setWhpoNumber(v.replace(/\D/g, '').slice(0, 8))}
                placeholder="36648912"
                hint="The 8-digit reference you used when submitting the shipment."
              />
            </Section>
            <button
              type="submit"
              disabled={lookupBusy || whpoNumber.length !== 8}
              className={`w-full bg-[#0093D0] hover:bg-[#00A8E8] text-white font-bold rounded-full py-3.5 text-base transition flex items-center justify-center gap-2 shadow-[0_8px_24px_-4px_rgba(0,147,208,0.45)] hover:shadow-[0_8px_28px_-2px_rgba(0,147,208,0.6)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2 ${
                lookupBusy
                  ? 'opacity-90 cursor-wait'
                  : 'disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed'
              }`}
            >
              {lookupBusy ? (
                <>
                  <Spinner size={18} className="text-white" />
                  <span>Looking up…</span>
                </>
              ) : (
                <>
                  <span>Look up WHPO/Load No</span>
                  <ArrowRightIcon className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        )}

        {/* Stage 2: container selection + driver fields */}
        {containers && whpoMeta && (
          <form
            onSubmit={handleSubmit}
            className="bg-white rounded-xl border border-slate-200 p-6 sm:p-8 space-y-7"
            style={{
              boxShadow:
                '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
            }}
          >
            {/* WHPO summary banner */}
            <div className="rounded-lg border border-[#0093D0]/25 bg-[#0093D0]/5 px-4 py-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0]">
                    Found
                  </span>
                  <span className="text-sm">
                    WHPO <span className="font-mono font-bold text-[#1B4676]">{whpoNumber}</span>
                    <span className="text-slate-400 mx-1.5">·</span>
                    <span className="text-slate-700">{whpoMeta.customer_name}</span>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setWhpoNumber('')
                    resetWhpo()
                  }}
                  className="text-xs font-medium text-[#1B4676] hover:text-[#0093D0] transition focus:outline-none focus-visible:underline"
                >
                  Change WHPO/Load No
                </button>
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Delivery Order:{' '}
                <span className="font-mono text-slate-700">{whpoMeta.do_number}</span>
              </div>
            </div>

            <Section title="Step 2 — Pick container">
              {containers.length === 1 ? (
                <div>
                  <label className="block text-xs font-semibold text-[#1B4676] mb-1.5">
                    Container
                  </label>
                  <div className="font-mono text-base font-bold text-[#1B4676] bg-slate-100 border border-slate-200 rounded-md px-3 py-2.5">
                    {containers[0].container_no}
                  </div>
                  {containers[0].has_driver_info && (
                    <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-2 mt-2 flex items-start gap-1.5">
                      <span className="font-semibold">Heads up:</span>
                      <span>
                        Driver already on file ({containers[0].driver_name}). Submitting
                        will overwrite.
                      </span>
                    </p>
                  )}
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-semibold text-[#1B4676] mb-1.5">
                    Container <span className="text-[#0093D0]">*</span>
                  </label>
                  <select
                    className="w-full border border-slate-300 rounded-md px-3 py-2 bg-white text-sm text-slate-800 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
                    value={selectedContainer}
                    onChange={(e) => setSelectedContainer(e.target.value)}
                    required
                  >
                    <option value="">— pick a container —</option>
                    {containers.map((c) => (
                      <option key={c.container_no} value={c.container_no}>
                        {c.container_no}
                        {c.has_driver_info ? `  (driver: ${c.driver_name})` : ''}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-slate-500 mt-1.5">
                    This WHPO/Load No has {containers.length} containers. Pick the one this
                    driver is hauling.
                  </p>
                </div>
              )}
            </Section>

            {selectedContainer && (
              <>
                <Section title="Step 3 — Carrier, driver & truck">
                  <p className="text-xs text-slate-500 mb-3">
                    All fields are optional — fill in whatever info you have on
                    hand. Update later as more details come in.
                  </p>
                  <TextField
                    label="Carrier (transport company)"
                    value={d.carrier}
                    onChange={(v) => update('carrier', v)}
                    placeholder="2Fast Transportation"
                  />
                  <TextField
                    label="Driver name"
                    value={d.driver_name}
                    onChange={(v) => update('driver_name', v)}
                    placeholder="Alex Carter"
                  />
                  <TextField
                    label="Driver's license number"
                    value={d.driver_license}
                    onChange={(v) => update('driver_license', v)}
                    placeholder="CA-D1234567"
                  />
                  <TextField
                    label="Driver's contact number"
                    type="tel"
                    value={d.driver_phone}
                    onChange={(v) => update('driver_phone', v)}
                    placeholder="+1 (555) 123-4567"
                  />
                  <TextField
                    label="Truck license plate"
                    value={d.truck_license_plate}
                    onChange={(v) => update('truck_license_plate', v.toUpperCase())}
                    placeholder="1ABC234"
                  />
                  <TextField
                    label="Insurance (carrier / policy #)"
                    value={d.insurance}
                    onChange={(v) => update('insurance', v)}
                    placeholder="Travelers / POL-12345"
                  />
                </Section>

                <Section title="Step 4 — Upload supporting documents">
                  <p className="text-xs text-slate-600 mb-3">
                    These attach to <span className="font-mono font-bold text-[#1B4676]">{selectedContainer}</span>.
                    You can upload now or come back via the Update flow before
                    the truck arrives — re-uploading replaces the prior file.
                  </p>
                  <ContainerDocumentUploads
                    containerNo={selectedContainer}
                    title="Required documents"
                    description="Front + back plate photos, the door (with MC/DOT numbers), driver's license, insurance, registration, and the dispatch order / tender. JPEG, PNG, HEIC, or PDF."
                  />
                </Section>

                <button
                  type="submit"
                  disabled={submitting}
                  className={`w-full bg-[#0093D0] hover:bg-[#00A8E8] text-white font-bold rounded-full py-3.5 text-base transition flex items-center justify-center gap-2 shadow-[0_8px_24px_-4px_rgba(0,147,208,0.45)] hover:shadow-[0_8px_28px_-2px_rgba(0,147,208,0.6)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2 ${
                    submitting ? 'opacity-90 cursor-wait' : ''
                  }`}
                >
                  {submitting ? (
                    <>
                      <Spinner size={18} className="text-white" />
                      <span>Submitting…</span>
                    </>
                  ) : (
                    <>
                      <span>Submit driver info for {selectedContainer}</span>
                      <ArrowRightIcon className="w-4 h-4" />
                    </>
                  )}
                </button>
              </>
            )}
          </form>
        )}
      </div>
    </VendorPortalChrome>
  )
}

// ─── Update Shipment Form ──────────────────────────────────────────────

interface UpdateLine {
  sku: string
  qty: string         // string for input convenience; coerce to int on submit
  product_type: string
}

interface UpdateContainer {
  original_container_no: string
  container_no: string
  expected_arrival_date: string  // YYYY-MM-DD
  expected_arrival_time: string  // HH:MM
  status: string
  is_locked: boolean
  // Driver/truck — all editable; pre-filled from current state.
  carrier: string
  driver_name: string
  driver_license: string
  driver_phone: string
  truck_license_plate: string
  insurance: string
  lines: UpdateLine[]
}

interface UpdateState {
  whpo_number: string
  do_number: string
  customer_name: string
  expected_arrival_date: string
  bol_number: string
  any_locked: boolean
  containers: UpdateContainer[]
}

function UpdateShipmentForm({ onBack }: { onBack: () => void }) {
  const [whpoNumber, setWhpoNumber] = useState('')
  const [lookupBusy, setLookupBusy] = useState(false)
  const [state, setState] = useState<UpdateState | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    whpo_number: string
    do_number: string
    summary: string
    excel_resynced: boolean
    changes: {
      scope: string
      container_no: string | null
      field: string
      before: string | null
      after: string | null
      sku: string | null
    }[]
  } | null>(null)

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!/^\d{8}$/.test(whpoNumber)) {
      setError('WHPO/Load No must be exactly 8 digits.')
      return
    }
    setLookupBusy(true)
    try {
      const r = await api.getWHPOCurrent(whpoNumber)
      setState({
        whpo_number: r.whpo_number,
        do_number: r.do_number,
        customer_name: r.customer_name,
        expected_arrival_date: r.expected_arrival_date ?? '',
        bol_number: r.bol_number ?? '',
        any_locked: r.any_locked,
        containers: r.containers.map((c) => ({
          original_container_no: c.container_no,
          container_no: c.container_no,
          expected_arrival_date: c.expected_arrival_date ?? '',
          expected_arrival_time: (c.expected_arrival_time ?? '').slice(0, 5),
          status: c.status,
          is_locked: c.is_locked,
          carrier: c.carrier ?? '',
          driver_name: c.driver_name ?? '',
          driver_license: c.driver_license ?? '',
          driver_phone: c.driver_phone ?? '',
          truck_license_plate: c.truck_license_plate ?? '',
          insurance: c.insurance ?? '',
          lines: c.lines.map((ln) => ({
            sku: ln.sku,
            qty: String(ln.qty),
            product_type: ln.product_type ?? '',
          })),
        })),
      })
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setLookupBusy(false)
    }
  }

  function resetLookup() {
    setState(null)
    setWhpoNumber('')
    setError(null)
  }

  function patchContainer(idx: number, patch: Partial<UpdateContainer>) {
    setState((s) =>
      s
        ? {
            ...s,
            containers: s.containers.map((c, i) =>
              i === idx ? { ...c, ...patch } : c,
            ),
          }
        : s,
    )
  }

  function patchLine(cIdx: number, lIdx: number, patch: Partial<UpdateLine>) {
    setState((s) =>
      s
        ? {
            ...s,
            containers: s.containers.map((c, i) =>
              i === cIdx
                ? {
                    ...c,
                    lines: c.lines.map((ln, j) =>
                      j === lIdx ? { ...ln, ...patch } : ln,
                    ),
                  }
                : c,
            ),
          }
        : s,
    )
  }

  function addLine(cIdx: number) {
    setState((s) =>
      s
        ? {
            ...s,
            containers: s.containers.map((c, i) =>
              i === cIdx
                ? {
                    ...c,
                    lines: [...c.lines, { sku: '', qty: '', product_type: '' }],
                  }
                : c,
            ),
          }
        : s,
    )
  }

  function removeLine(cIdx: number, lIdx: number) {
    setState((s) =>
      s
        ? {
            ...s,
            containers: s.containers.map((c, i) =>
              i === cIdx
                ? { ...c, lines: c.lines.filter((_, j) => j !== lIdx) }
                : c,
            ),
          }
        : s,
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!state) return

    // Validate
    for (const c of state.containers) {
      if (!/^[A-Z]{4}\d{7}$/.test(c.container_no)) {
        setError(`Container "${c.container_no}" — expected ISO 6346 (4 letters + 7 digits)`)
        return
      }
      if (c.lines.length === 0) {
        setError(`Container ${c.container_no} has no SKU lines`)
        return
      }
      for (const ln of c.lines) {
        const q = parseInt(ln.qty, 10)
        if (!ln.sku || !Number.isFinite(q) || q <= 0) {
          setError(`Invalid line on ${c.container_no}: SKU="${ln.sku}", qty="${ln.qty}"`)
          return
        }
      }
    }

    setSubmitting(true)
    try {
      const r = await api.updateWHPO(state.whpo_number, {
        expected_arrival_date: state.expected_arrival_date || null,
        bol_number: state.bol_number,        // empty string = explicit clear
        containers: state.containers.map((c) => ({
          original_container_no: c.original_container_no,
          container_no: c.container_no,
          expected_arrival_date: c.expected_arrival_date || null,
          expected_arrival_time: c.expected_arrival_time
            ? c.expected_arrival_time + ':00'
            : null,
          carrier: c.carrier,
          driver_name: c.driver_name,
          driver_license: c.driver_license,
          driver_phone: c.driver_phone,
          truck_license_plate: c.truck_license_plate,
          insurance: c.insurance,
          lines: c.lines.map((ln) => ({
            sku: ln.sku.trim(),
            qty: parseInt(ln.qty, 10),
            product_type: ln.product_type.trim() || null,
          })),
        })),
      })
      setResult(r)
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  // ── Render: success panel ────────────────────────────────────────
  if (result) {
    return (
      <VendorPortalChrome breadcrumbCurrent="Update applied" onBack={onBack}>
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
          <div className="mb-8 flex items-start gap-4">
            <div
              className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-600 flex-shrink-0"
              aria-hidden
            >
              <CheckIcon className="w-6 h-6" />
            </div>
            <div>
              <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-700 text-[11px] font-semibold tracking-[0.14em] uppercase mb-2">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden />
                Updated
              </div>
              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#1B4676]">
                Shipment updated
              </h1>
              <p className="mt-2 text-slate-600">{result.summary}</p>
            </div>
          </div>

          <div
            className="bg-white rounded-xl border border-slate-200 overflow-hidden"
            style={{
              boxShadow:
                '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
            }}
          >
            <div className="bg-slate-50 border-b border-slate-200 px-5 py-3">
              <h2 className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#0093D0]">
                What changed
              </h2>
            </div>
            {result.changes.length === 0 ? (
              <div className="px-5 py-4 text-sm text-slate-500 italic">
                No changes detected.
              </div>
            ) : (
              <ul className="divide-y divide-slate-200">
                {result.changes.map((c, i) => (
                  <li key={i} className="px-5 py-3 text-sm flex items-center gap-3 flex-wrap">
                    <span className="text-[10.5px] uppercase tracking-[0.15em] font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded">
                      {c.scope}
                    </span>
                    {c.container_no && (
                      <span className="font-mono text-xs text-[#1B4676]">
                        {c.container_no}
                      </span>
                    )}
                    <span className="text-slate-700">
                      <span className="font-semibold">{c.field}</span>
                      {c.sku && (
                        <span className="text-slate-500"> · SKU {c.sku}</span>
                      )}
                      {c.before !== null && c.after !== null && (
                        <>
                          : <span className="font-mono text-red-700">{c.before || '∅'}</span>
                          <span className="mx-1.5 text-slate-400">→</span>
                          <span className="font-mono text-emerald-700">{c.after || '∅'}</span>
                        </>
                      )}
                      {c.before === null && c.after !== null && (
                        <> → <span className="font-mono text-emerald-700">{c.after}</span></>
                      )}
                      {c.before !== null && c.after === null && (
                        <> · <span className="font-mono text-red-700">{c.before}</span></>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {!result.excel_resynced && (
            <div className="mt-4 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2.5">
              <span className="font-semibold">Note:</span> Postgres is up-to-date but the OneDrive Excel re-sync didn't complete.
              The manager can hit "Resend driver info" in the Inbound tab to retry.
            </div>
          )}

          <div className="mt-8 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={() => {
                setResult(null)
                resetLookup()
              }}
              className="inline-flex items-center gap-2 bg-[#0093D0] hover:bg-[#00A8E8] text-white font-semibold rounded-full px-6 py-3 transition shadow-[0_8px_24px_-4px_rgba(0,147,208,0.45)] hover:shadow-[0_8px_28px_-2px_rgba(0,147,208,0.6)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
            >
              <span>Update another shipment</span>
              <ArrowRightIcon className="w-4 h-4" />
            </button>
            <button
              onClick={onBack}
              className="text-sm text-[#1B4676] hover:text-[#0093D0] font-medium transition"
            >
              ← Back to portal home
            </button>
          </div>
        </div>
      </VendorPortalChrome>
    )
  }

  // ── Render: lookup stage ─────────────────────────────────────────
  if (!state) {
    return (
      <VendorPortalChrome breadcrumbCurrent="Update Shipment" onBack={onBack}>
        <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
          <div className="mb-8">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#1B4676] text-[11px] font-semibold tracking-[0.14em] uppercase mb-4">
              <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
              Amendment
            </div>
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#1B4676]">
              UPDATE SHIPMENT
            </h1>
            <p className="mt-3 text-base text-slate-600 leading-relaxed">
              Find your shipment by WHPO/Load No. You'll be able to edit container numbers,
              arrival dates, and SKU lines — as long as the dock hasn't started
              receiving yet.
            </p>
          </div>

          {error && (
            <div
              role="alert"
              className="mb-6 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5 flex items-start gap-2"
            >
              <span className="font-semibold">Error:</span>
              <span>{error}</span>
            </div>
          )}

          <form
            onSubmit={handleLookup}
            className="bg-white rounded-xl border border-slate-200 p-6 sm:p-8 space-y-5"
            style={{
              boxShadow:
                '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
            }}
          >
            <Section title="Step 1 — Find your shipment">
              <TextField
                label="WHPO/Load No (8 digits)"
                required
                value={whpoNumber}
                onChange={(v) => setWhpoNumber(v.replace(/\D/g, '').slice(0, 8))}
                placeholder="36648912"
              />
            </Section>
            <button
              type="submit"
              disabled={lookupBusy || whpoNumber.length !== 8}
              className={`w-full bg-[#0093D0] hover:bg-[#00A8E8] text-white font-bold rounded-full py-3.5 text-base transition flex items-center justify-center gap-2 shadow-[0_8px_24px_-4px_rgba(0,147,208,0.45)] hover:shadow-[0_8px_28px_-2px_rgba(0,147,208,0.6)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2 ${
                lookupBusy
                  ? 'opacity-90 cursor-wait'
                  : 'disabled:bg-slate-200 disabled:text-slate-400'
              }`}
            >
              {lookupBusy ? (
                <>
                  <Spinner size={18} className="text-white" />
                  <span>Looking up…</span>
                </>
              ) : (
                <>
                  <span>Look up shipment</span>
                  <ArrowRightIcon className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </div>
      </VendorPortalChrome>
    )
  }

  // ── Render: edit stage ───────────────────────────────────────────
  return (
    <VendorPortalChrome breadcrumbCurrent="Update Shipment" onBack={onBack}>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
        <div className="mb-6">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#1B4676] text-[11px] font-semibold tracking-[0.14em] uppercase mb-3">
            <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
            Amendment
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#1B4676]">
            UPDATE SHIPMENT
          </h1>
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <span className="text-sm text-slate-700">
              WHPO <span className="font-mono font-bold text-[#1B4676]">{state.whpo_number}</span>
              <span className="text-slate-400 mx-1.5">·</span>
              <span className="font-mono text-slate-600">{state.do_number}</span>
              <span className="text-slate-400 mx-1.5">·</span>
              <span className="text-slate-700">{state.customer_name}</span>
            </span>
            <button
              type="button"
              onClick={resetLookup}
              className="text-xs font-medium text-[#1B4676] hover:text-[#0093D0] transition underline-offset-2 hover:underline"
            >
              Change WHPO/Load No
            </button>
          </div>
        </div>

        {state.any_locked && (
          <div className="mb-6 rounded-xl border border-red-300 bg-red-50 p-4 sm:p-5 flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-red-100 border border-red-300 flex items-center justify-center text-red-700 flex-shrink-0" aria-hidden>
              <LockIcon className="w-5 h-5" />
            </div>
            <div>
              <div className="text-[10.5px] uppercase tracking-[0.15em] font-bold text-red-700 mb-1">
                Receiving in progress
              </div>
              <p className="text-sm text-red-900">
                One or more containers in this WHPO/Load No are already being received at the dock.
                Updates are blocked. Email <a href="mailto:developer@conquernation.com" className="underline font-semibold">developer@conquernation.com</a> if you really need a change.
              </p>
            </div>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mb-6 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5 flex items-start gap-2"
          >
            <span className="font-semibold">Error:</span>
            <span>{error}</span>
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-xl border border-slate-200 p-6 sm:p-8 space-y-7"
          style={{
            boxShadow:
              '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
          }}
        >
          <Section title="Expected arrival (WHPO/Load No level)">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <TextField
                label="Expected arrival date"
                type="date"
                value={state.expected_arrival_date}
                onChange={(v) =>
                  setState((s) => (s ? { ...s, expected_arrival_date: v } : s))
                }
              />
              <TextField
                label="BOL # / Tracking #"
                value={state.bol_number}
                onChange={(v) =>
                  setState((s) => (s ? { ...s, bol_number: v } : s))
                }
                placeholder="e.g. 36185694"
                hint="From the carrier's Bill of Lading. The PDF itself uploads alongside the driver documents below."
              />
            </div>
          </Section>

          {state.containers.map((c, cIdx) => (
            <div key={cIdx} className="border border-slate-200 rounded-lg p-4 sm:p-5 bg-slate-50/50">
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0]">
                  Container {cIdx + 1}
                </div>
                <span className={`text-[10.5px] uppercase tracking-[0.15em] font-bold px-2 py-0.5 rounded ${
                  c.is_locked
                    ? 'bg-red-100 text-red-800'
                    : 'bg-emerald-100 text-emerald-800'
                }`}>
                  {c.status}{c.is_locked ? ' (locked)' : ''}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <TextField
                  label="Container #"
                  required
                  value={c.container_no}
                  onChange={(v) => patchContainer(cIdx, { container_no: v.toUpperCase() })}
                  placeholder="HPCU4492096"
                />
                <TextField
                  label="Arrival date"
                  type="date"
                  value={c.expected_arrival_date}
                  onChange={(v) => patchContainer(cIdx, { expected_arrival_date: v })}
                />
                <TextField
                  label="Arrival time"
                  type="time"
                  value={c.expected_arrival_time}
                  onChange={(v) => patchContainer(cIdx, { expected_arrival_time: v })}
                />
              </div>

              <div className="mt-4">
                <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0] mb-2">
                  Carrier, driver & truck
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <TextField
                    label="Carrier (transport company)"
                    value={c.carrier}
                    onChange={(v) => patchContainer(cIdx, { carrier: v })}
                    placeholder="2Fast Transportation"
                  />
                  <TextField
                    label="Driver name"
                    value={c.driver_name}
                    onChange={(v) => patchContainer(cIdx, { driver_name: v })}
                    placeholder="Alex Carter"
                  />
                  <TextField
                    label="Driver's license number"
                    value={c.driver_license}
                    onChange={(v) => patchContainer(cIdx, { driver_license: v })}
                    placeholder="CA-D1234567"
                  />
                  <TextField
                    label="Driver's contact number"
                    type="tel"
                    value={c.driver_phone}
                    onChange={(v) => patchContainer(cIdx, { driver_phone: v })}
                    placeholder="+1 (555) 123-4567"
                  />
                  <TextField
                    label="Truck license plate"
                    value={c.truck_license_plate}
                    onChange={(v) => patchContainer(cIdx, { truck_license_plate: v.toUpperCase() })}
                    placeholder="1ABC234"
                  />
                  <TextField
                    label="Insurance (carrier / policy #)"
                    value={c.insurance}
                    onChange={(v) => patchContainer(cIdx, { insurance: v })}
                    placeholder="Travelers / POL-12345"
                  />
                </div>
                <p className="text-xs text-slate-500 mt-1.5">
                  Pre-filled with current values. Edit to update, or clear a
                  field to wipe it.
                </p>
              </div>

              <div className="mt-4">
                <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0] mb-2">
                  SKU lines
                </div>
                <div className="space-y-2">
                  {c.lines.map((ln, lIdx) => (
                    <div key={lIdx} className="grid grid-cols-12 gap-2 items-start">
                      <div className="col-span-5">
                        <input
                          type="text"
                          placeholder="SKU"
                          value={ln.sku}
                          onChange={(e) => patchLine(cIdx, lIdx, { sku: e.target.value })}
                          className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm font-mono text-slate-800 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
                        />
                      </div>
                      <div className="col-span-2">
                        <input
                          type="number"
                          placeholder="qty"
                          value={ln.qty}
                          onChange={(e) => patchLine(cIdx, lIdx, { qty: e.target.value })}
                          className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm text-slate-800 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
                        />
                      </div>
                      <div className="col-span-4">
                        <input
                          type="text"
                          placeholder="product type"
                          value={ln.product_type}
                          onChange={(e) => patchLine(cIdx, lIdx, { product_type: e.target.value })}
                          className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm text-slate-800 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
                        />
                      </div>
                      <div className="col-span-1 flex">
                        <button
                          type="button"
                          onClick={() => removeLine(cIdx, lIdx)}
                          disabled={c.lines.length === 1}
                          className="w-full inline-flex items-center justify-center text-slate-400 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed transition"
                          aria-label="Remove line"
                          title="Remove line"
                        >
                          <TrashIcon className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => addLine(cIdx)}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#1B4676] hover:text-[#0093D0] transition mt-1"
                  >
                    <PlusIcon className="w-3.5 h-3.5" />
                    <span>Add SKU line</span>
                  </button>
                </div>
              </div>

              <div className="mt-4 pt-4 border-t border-slate-200">
                <ContainerDocumentUploads
                  containerNo={c.original_container_no}
                  title="Driver / truck documents"
                  description="Re-upload anytime — the newest file replaces the prior one. Plate photos, door (MC/DOT), driver's license, insurance, registration, dispatch order."
                />
              </div>
            </div>
          ))}

          <button
            type="submit"
            disabled={submitting || state.any_locked}
            className={`w-full bg-[#0093D0] hover:bg-[#00A8E8] text-white font-bold rounded-full py-3.5 text-base transition flex items-center justify-center gap-2 shadow-[0_8px_24px_-4px_rgba(0,147,208,0.45)] hover:shadow-[0_8px_28px_-2px_rgba(0,147,208,0.6)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2 ${
              submitting
                ? 'opacity-90 cursor-wait'
                : 'disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed'
            }`}
          >
            {submitting ? (
              <>
                <Spinner size={18} className="text-white" />
                <span>Applying update…</span>
              </>
            ) : (
              <>
                <span>Submit update</span>
                <ArrowRightIcon className="w-4 h-4" />
              </>
            )}
          </button>
        </form>
      </div>
    </VendorPortalChrome>
  )
}

// ─── View Shipment (read-only review) ──────────────────────────────────

interface ViewLine {
  sku: string
  qty: number
  product_type: string | null
}

interface ViewContainer {
  container_no: string
  expected_arrival_date: string | null
  expected_arrival_time: string | null
  status: string
  is_locked: boolean
  has_driver_info: boolean
  driver_name: string | null
  driver_license: string | null
  driver_phone: string | null
  truck_license_plate: string | null
  insurance: string | null
  carrier: string | null
  lines: ViewLine[]
}

interface ViewState {
  whpo_number: string
  do_number: string
  customer_name: string
  expected_arrival_date: string | null
  containers: ViewContainer[]
}

function ViewShipmentForm({ onBack }: { onBack: () => void }) {
  const [whpoNumber, setWhpoNumber] = useState('')
  const [loading, setLoading] = useState(false)
  const [state, setState] = useState<ViewState | null>(null)
  const [status, setStatus] = useState<import('../api/client').WHPOStatusResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!/^\d{8}$/.test(whpoNumber)) {
      setError('WHPO/Load No must be exactly 8 digits.')
      return
    }
    setLoading(true)
    try {
      const [r, st] = await Promise.all([
        api.getWHPOCurrent(whpoNumber),
        api.whpoStatus(whpoNumber).catch(() => null),
      ])
      setState({
        whpo_number: r.whpo_number,
        do_number: r.do_number,
        customer_name: r.customer_name,
        expected_arrival_date: r.expected_arrival_date,
        containers: r.containers,
      })
      setStatus(st)
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setLoading(false)
    }
  }

  if (!state) {
    return (
      <VendorPortalChrome breadcrumbCurrent="View shipment status" onBack={onBack}>
        <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
          <div className="mb-8">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#1B4676] text-[11px] font-semibold tracking-[0.14em] uppercase mb-4">
              <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
              Review
            </div>
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#1B4676]">
              View shipment status
            </h1>
            <p className="mt-3 text-base text-slate-600 max-w-xl leading-relaxed">
              Pull up everything we have on file for a WHPO/Load No — container lines,
              driver/truck details, and your uploaded documents.
            </p>
          </div>

          {error && (
            <div
              role="alert"
              className="mb-6 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5 flex items-start gap-2"
            >
              <span className="font-semibold">Error:</span>
              <span>{error}</span>
            </div>
          )}

          <form
            onSubmit={handleLookup}
            className="bg-white rounded-xl border border-slate-200 p-6 sm:p-8 space-y-5"
            style={{
              boxShadow:
                '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
            }}
          >
            <Section title="Look up your shipment">
              <TextField
                label="WHPO/Load No (8 digits)"
                required
                value={whpoNumber}
                onChange={(v) => setWhpoNumber(v.replace(/\D/g, '').slice(0, 8))}
                placeholder="36648912"
                hint="The 8-digit reference you used when submitting the shipment."
              />
            </Section>
            <button
              type="submit"
              disabled={loading || whpoNumber.length !== 8}
              className={`w-full bg-[#0093D0] hover:bg-[#00A8E8] text-white font-bold rounded-full py-3.5 text-base transition flex items-center justify-center gap-2 shadow-[0_8px_24px_-4px_rgba(0,147,208,0.45)] hover:shadow-[0_8px_28px_-2px_rgba(0,147,208,0.6)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2 ${
                loading
                  ? 'opacity-90 cursor-wait'
                  : 'disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed'
              }`}
            >
              {loading ? (
                <>
                  <Spinner size={18} className="text-white" />
                  <span>Loading…</span>
                </>
              ) : (
                <>
                  <span>View shipment</span>
                  <ArrowRightIcon className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </div>
      </VendorPortalChrome>
    )
  }

  return (
    <VendorPortalChrome
      breadcrumbCurrent={`Shipment ${state.whpo_number}`}
      onBack={onBack}
    >
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
        <div className="mb-8 flex items-start justify-between flex-wrap gap-3">
          <div>
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#1B4676] text-[11px] font-semibold tracking-[0.14em] uppercase mb-3">
              <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
              On file
            </div>
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#1B4676]">
              WHPO <span className="font-mono">{state.whpo_number}</span>
            </h1>
            <p className="mt-2 text-sm text-slate-600">
              {state.customer_name} ·{' '}
              <span className="font-mono">{state.do_number}</span>
              {state.expected_arrival_date && (
                <>
                  {' '}
                  · expected{' '}
                  <span className="text-[#1B4676] font-semibold">
                    {state.expected_arrival_date}
                  </span>
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setState(null)
              setWhpoNumber('')
            }}
            className="text-sm font-medium text-[#1B4676] hover:text-[#0093D0]"
          >
            ← Look up another
          </button>
        </div>

        {status && status.containers.length > 0 && (
          <div className="mb-8">
            <h2 className="text-sm font-bold text-[#1B4676] mb-3 uppercase tracking-wider">
              Container status
            </h2>
            <div className="space-y-3">
              {status.containers.map((c) => (
                <StatusTimeline
                  key={c.container_no}
                  container={c}
                  accent="cyan"
                />
              ))}
            </div>
          </div>
        )}

        <div className="space-y-6">
          {state.containers.map((c, idx) => (
            <div
              key={c.container_no}
              className="bg-white rounded-xl border border-slate-200 overflow-hidden"
              style={{
                boxShadow:
                  '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
              }}
            >
              <div className="bg-slate-50 border-b border-slate-200 px-5 py-3 flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-3">
                  <span className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0]">
                    Container {idx + 1}
                  </span>
                  <span className="font-mono font-bold text-[#1B4676]">
                    {c.container_no}
                  </span>
                </div>
                <span
                  className={`text-[10.5px] uppercase tracking-[0.15em] font-bold px-2 py-0.5 rounded ${
                    c.is_locked
                      ? 'bg-red-100 text-red-800'
                      : c.has_driver_info
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-amber-100 text-amber-800'
                  }`}
                >
                  {c.status}
                  {!c.has_driver_info && !c.is_locked && ' · driver pending'}
                </span>
              </div>

              <div className="px-5 py-4 space-y-5">
                {/* Arrival */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div>
                    <div className="text-[10.5px] uppercase tracking-wider text-slate-500 font-semibold">
                      Arrival date
                    </div>
                    <div className="mt-0.5 text-[#1B4676] font-semibold">
                      {c.expected_arrival_date ?? '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10.5px] uppercase tracking-wider text-slate-500 font-semibold">
                      Arrival time
                    </div>
                    <div className="mt-0.5 text-[#1B4676] font-semibold">
                      {c.expected_arrival_time ?? '—'}
                    </div>
                  </div>
                </div>

                {/* Driver / truck */}
                <div>
                  <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0] mb-2">
                    Driver &amp; truck
                  </div>
                  {c.has_driver_info ? (
                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
                      <ViewKV k="Carrier" v={c.carrier} />
                      <ViewKV k="Driver name" v={c.driver_name} />
                      <ViewKV k="Driver license" v={c.driver_license} />
                      <ViewKV k="Driver phone" v={c.driver_phone} />
                      <ViewKV k="Truck plate" v={c.truck_license_plate} />
                      <ViewKV k="Insurance" v={c.insurance} />
                    </dl>
                  ) : (
                    <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5">
                      No driver info submitted yet. Use the "Driver &amp; truck
                      info" tile on the portal home to add it.
                    </p>
                  )}
                </div>

                {/* Tally / POD status — read from /vendor/container/.../tally.
                    Tally row gets created when the warehouse manager files
                    the POD on arrival; once present, operators can scan. */}
                <VendorTallyStatus containerNo={c.container_no} />

                {/* SKU lines */}
                <div>
                  <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0] mb-2">
                    SKU lines ({c.lines.length})
                  </div>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[10.5px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
                        <th className="py-1.5 pr-3 font-semibold">SKU</th>
                        <th className="py-1.5 pr-3 font-semibold">Qty</th>
                        <th className="py-1.5 font-semibold">Product type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.lines.map((ln, i) => (
                        <tr
                          key={`${ln.sku}-${i}`}
                          className="border-b border-slate-100 last:border-0"
                        >
                          <td className="py-1.5 pr-3 font-mono text-[#1B4676]">
                            {ln.sku}
                          </td>
                          <td className="py-1.5 pr-3 text-slate-700">{ln.qty}</td>
                          <td className="py-1.5 text-slate-700">
                            {ln.product_type ?? '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Documents */}
                <div className="pt-2 border-t border-slate-100">
                  <ContainerDocumentUploads
                    containerNo={c.container_no}
                    title="Uploaded documents"
                    description="What you've sent for this container. Re-upload anytime to replace."
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </VendorPortalChrome>
  )
}

function ViewKV({ k, v }: { k: string; v: string | null }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <dt className="text-[10.5px] uppercase tracking-wider text-slate-500 font-semibold flex-shrink-0">
        {k}
      </dt>
      <dd className="text-[#1B4676] font-medium truncate" title={v ?? ''}>
        {v && v.length > 0 ? v : '—'}
      </dd>
    </div>
  )
}
