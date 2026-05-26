import { useEffect, useMemo, useState } from 'react'
import { api, billingApi } from '../api/client'
import type {
  CustomerRead,
  InvoiceListItem,
  InvoicePreview,
  InvoiceRead,
  InvoiceStatus,
  RateCardRow,
} from '../api/client'

/**
 * Manager Invoicing — main billing surface.
 *
 * Layout: list of invoices on the left, detail on the right. Above the
 * list, two "Generate from…" buttons (WHPO and TO) that open the preview
 * → commit flow.
 *
 * Detail panel shows lines (auto + manual), totals, status transitions.
 *
 * Phase 1: tax rate, adjustment, and operational charge are read-only
 * on the invoice (manager can edit lines only). Phase 2: inline adjust +
 * customer profile editor.
 */

type GenerateMode = { scope: 'inbound'; whpoNumber: string } | { scope: 'outbound'; transferOrderNo: string }

const STATUS_FILTERS: { key: 'all' | InvoiceStatus; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'ready', label: 'Ready' },
  { key: 'sent', label: 'Sent' },
  { key: 'payment_submitted', label: 'Verify' },
  { key: 'paid', label: 'Paid' },
  { key: 'void', label: 'Void' },
]

const STATUS_PILL: Record<InvoiceStatus, { cls: string; label: string }> = {
  draft: { cls: 'bg-slate-100 text-slate-700', label: 'Draft' },
  ready: { cls: 'bg-amber-100 text-amber-800', label: 'Ready' },
  sent: { cls: 'bg-[#0093D0]/15 text-[#1B4676]', label: 'Sent — awaiting payment' },
  payment_submitted: {
    cls: 'bg-orange-100 text-orange-800 border border-orange-200',
    label: 'Payment submitted — verify',
  },
  paid: { cls: 'bg-emerald-100 text-emerald-800', label: 'Paid' },
  void: { cls: 'bg-rose-100 text-rose-700', label: 'Void' },
}

function fmtMoney(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(n)
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—'
  // Treat as local date if it's YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d
  return new Date(d).toLocaleDateString()
}

export default function BillingInvoices() {
  const [list, setList] = useState<InvoiceListItem[] | null>(null)
  const [statusFilter, setStatusFilter] = useState<'all' | InvoiceStatus>('all')
  const [customerFilter, setCustomerFilter] = useState<number | 'all'>('all')
  const [customers, setCustomers] = useState<CustomerRead[]>([])
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<InvoiceRead | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [generateMode, setGenerateMode] = useState<GenerateMode | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // Load the customer (brand) list once for the filter dropdown.
  useEffect(() => {
    api
      .listManagerCustomers()
      .then((rows) =>
        // Stable alphabetical so the dropdown reads predictably.
        setCustomers([...rows].sort((a, b) => a.name.localeCompare(b.name))),
      )
      .catch(() => {
        /* non-fatal — invoice list still works without filter */
      })
  }, [])

  function reloadList() {
    setError(null)
    billingApi
      .listInvoices({
        status: statusFilter === 'all' ? undefined : statusFilter,
        customer_id: customerFilter === 'all' ? undefined : customerFilter,
      })
      .then((rows) => {
        setList(rows)
        // If the selected invoice is gone, clear.
        if (selectedId && !rows.some((r) => r.id === selectedId)) {
          setSelectedId(null)
          setDetail(null)
        }
      })
      .catch((e) => setError(String(e?.detail || e)))
  }

  function reloadDetail(id: number) {
    setDetailLoading(true)
    billingApi
      .getInvoice(id)
      .then((d) => setDetail(d))
      .catch((e) => setError(String(e?.detail || e)))
      .finally(() => setDetailLoading(false))
  }

  useEffect(reloadList, [statusFilter, customerFilter])

  useEffect(() => {
    if (selectedId == null) {
      setDetail(null)
      return
    }
    reloadDetail(selectedId)
  }, [selectedId])

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 3500)
  }

  const filteredList = useMemo(() => {
    if (!list) return null
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (r) =>
        r.invoice_number.toLowerCase().includes(q) ||
        (r.customer_name ?? '').toLowerCase().includes(q) ||
        (r.whpo_number ?? '').toLowerCase().includes(q) ||
        (r.transfer_order_no ?? '').toLowerCase().includes(q),
    )
  }, [list, search])

  return (
    <div className="space-y-5">
      <header>
        <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#1B4676] text-[11px] font-semibold tracking-[0.14em] uppercase mb-3">
          <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
          Invoicing
        </div>
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#1B4676]">
              Customer invoices
            </h1>
            <p className="mt-1.5 text-sm text-slate-600 max-w-2xl">
              One invoice per inbound WHPO and one per outbound Transfer
              Order. Auto-charges are proposed from warehouse activity;
              add manual lines from the rate card as needed.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                setGenerateMode({ scope: 'inbound', whpoNumber: '' })
              }
              className="inline-flex items-center gap-1.5 bg-[#0093D0] hover:bg-[#00A8E8] text-white text-sm font-semibold px-3.5 py-2 rounded-md transition"
            >
              <PlusIcon className="w-4 h-4" />
              Generate from WHPO
            </button>
            <button
              type="button"
              onClick={() =>
                setGenerateMode({ scope: 'outbound', transferOrderNo: '' })
              }
              className="inline-flex items-center gap-1.5 bg-[#1B4676] hover:bg-[#244e7d] text-white text-sm font-semibold px-3.5 py-2 rounded-md transition"
            >
              <PlusIcon className="w-4 h-4" />
              Generate from TO
            </button>
          </div>
        </div>
      </header>

      {error && (
        <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-3 py-2 flex items-start gap-2">
          <span className="font-semibold">Error:</span>
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-rose-700/60 hover:text-rose-700"
          >
            ×
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search invoice #, customer, WHPO, TO…"
          className="w-72 max-w-full border border-slate-200 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-[#0093D0]"
        />
        {/* Brand / customer picker — server-side filter. */}
        <label className="inline-flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.14em] font-bold text-slate-500">
            Brand
          </span>
          <select
            value={customerFilter === 'all' ? '' : String(customerFilter)}
            onChange={(e) =>
              setCustomerFilter(e.target.value ? Number(e.target.value) : 'all')
            }
            className="border border-slate-200 rounded-md px-2 py-1 text-sm focus:outline-none focus:border-[#0093D0] bg-white min-w-[10rem]"
          >
            <option value="">All brands</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.account_name ? ` · ${c.account_name}` : ''}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-1 flex-wrap">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setStatusFilter(s.key)}
              className={`text-[11px] uppercase tracking-wider font-semibold px-2.5 py-1 rounded-full border transition ${
                statusFilter === s.key
                  ? 'bg-[#1B4676] text-white border-[#1B4676]'
                  : 'bg-white text-slate-700 border-slate-200 hover:border-[#0093D0]'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Master / detail */}
      <div className="grid lg:grid-cols-5 gap-5">
        {/* List column */}
        <div className="lg:col-span-2 space-y-2">
          {filteredList === null && (
            <div className="bg-white border border-slate-200 rounded-md px-3 py-2.5 text-sm text-slate-500">
              Loading invoices…
            </div>
          )}
          {filteredList && filteredList.length === 0 && (
            <div className="bg-white border border-slate-200 rounded-md p-6 text-center text-slate-500 text-sm">
              No invoices match those filters.
            </div>
          )}
          {filteredList?.map((inv) => {
            const active = inv.id === selectedId
            return (
              <button
                key={inv.id}
                type="button"
                onClick={() => setSelectedId(inv.id)}
                className={`w-full text-left bg-white rounded-lg border px-4 py-3 transition ${
                  active
                    ? 'border-[#0093D0] ring-1 ring-[#0093D0]'
                    : 'border-slate-200 hover:border-[#0093D0]/50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-bold text-[#1B4676] text-sm">
                    {inv.invoice_number}
                  </span>
                  <span
                    className={`${STATUS_PILL[inv.status].cls} px-2 py-0.5 rounded-full text-[10px] uppercase tracking-[0.12em] font-bold`}
                  >
                    {STATUS_PILL[inv.status].label}
                  </span>
                </div>
                <div className="mt-1 text-sm text-slate-700 font-semibold truncate">
                  {inv.customer_name ?? '—'}
                </div>
                <div className="mt-0.5 text-xs text-slate-500 flex items-center gap-2 flex-wrap">
                  {inv.whpo_number && (
                    <span className="font-mono">WHPO {inv.whpo_number}</span>
                  )}
                  {inv.transfer_order_no && (
                    <span className="font-mono">TO {inv.transfer_order_no}</span>
                  )}
                  <span className="text-slate-400">·</span>
                  <span>{fmtDate(inv.invoice_date)}</span>
                </div>
                <div className="mt-1 text-right font-mono font-bold text-slate-800">
                  {fmtMoney(inv.total)}
                </div>
              </button>
            )
          })}
        </div>

        {/* Detail column */}
        <div className="lg:col-span-3">
          {selectedId == null ? (
            <div className="bg-white border border-dashed border-slate-300 rounded-xl p-12 text-center text-slate-500">
              Select an invoice from the list to see lines + actions, or
              click <strong>Generate</strong> to create a new one.
            </div>
          ) : (
            <InvoiceDetailPanel
              invoice={detail}
              loading={detailLoading}
              onChanged={(updated) => {
                setDetail(updated)
                // Refresh list so totals/status reflect.
                reloadList()
              }}
              onError={(msg) => setError(msg)}
              onToast={showToast}
            />
          )}
        </div>
      </div>

      {generateMode && (
        <GenerateInvoiceModal
          mode={generateMode}
          onClose={() => setGenerateMode(null)}
          onGenerated={(inv) => {
            setGenerateMode(null)
            showToast(`Invoice ${inv.invoice_number} created`)
            reloadList()
            setSelectedId(inv.id)
          }}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 bg-emerald-700 text-white px-4 py-2 rounded-md shadow-lg z-50 flex items-center gap-2">
          <CheckIcon className="w-4 h-4" />
          <span>{toast}</span>
        </div>
      )}
    </div>
  )
}

// ─── Detail panel ──────────────────────────────────────────────────────

function InvoiceDetailPanel({
  invoice,
  loading,
  onChanged,
  onError,
  onToast,
}: {
  invoice: InvoiceRead | null
  loading: boolean
  onChanged: (inv: InvoiceRead) => void
  onError: (msg: string) => void
  onToast: (msg: string) => void
}) {
  const [addingLine, setAddingLine] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)

  if (loading || invoice === null) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-6 text-sm text-slate-500">
        Loading invoice…
      </div>
    )
  }

  const editable = invoice.status === 'draft' || invoice.status === 'ready'

  async function doTransition(
    label: string,
    fn: () => Promise<InvoiceRead>,
  ) {
    setBusyAction(label)
    try {
      const updated = await fn()
      onChanged(updated)
      onToast(`Invoice marked ${label}`)
    } catch (e) {
      const err = e as { detail?: string } | string
      onError(typeof err === 'object' && err.detail ? err.detail : String(err))
    } finally {
      setBusyAction(null)
    }
  }

  async function deleteLine(line_id: number) {
    if (!invoice) return
    if (!confirm('Remove this line?')) return
    try {
      const updated = await billingApi.removeLine(invoice.id, line_id)
      onChanged(updated)
      onToast('Line removed')
    } catch (e) {
      const err = e as { detail?: string } | string
      onError(typeof err === 'object' && err.detail ? err.detail : String(err))
    }
  }

  return (
    <div
      className="bg-white rounded-xl border border-slate-200 overflow-hidden"
      style={{
        boxShadow:
          '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
      }}
    >
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-200 bg-slate-50">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <div className="font-mono text-lg font-bold text-[#1B4676]">
              {invoice.invoice_number}
            </div>
            <div className="text-sm text-slate-600 mt-0.5">
              {invoice.customer_name ?? '—'}
              {invoice.whpo_number && (
                <span className="text-slate-400 ml-2 font-mono">
                  WHPO {invoice.whpo_number}
                </span>
              )}
              {invoice.transfer_order_no && (
                <span className="text-slate-400 ml-2 font-mono">
                  TO {invoice.transfer_order_no}
                </span>
              )}
            </div>
          </div>
          <span
            className={`${STATUS_PILL[invoice.status].cls} px-3 py-1 rounded-full text-[11px] uppercase tracking-[0.14em] font-bold`}
          >
            {STATUS_PILL[invoice.status].label}
          </span>
        </div>
        <div className="mt-2 text-xs text-slate-500 flex items-center gap-3 flex-wrap">
          <span>Issued {fmtDate(invoice.invoice_date)}</span>
          <span className="text-slate-300">·</span>
          <span>Due {fmtDate(invoice.due_date)}</span>
          <span className="text-slate-300">·</span>
          <span>{invoice.terms}</span>
          {invoice.sent_at && (
            <>
              <span className="text-slate-300">·</span>
              <span>Sent {fmtDate(invoice.sent_at)}</span>
            </>
          )}
          {invoice.paid_at && (
            <>
              <span className="text-slate-300">·</span>
              <span>Paid {fmtDate(invoice.paid_at)}</span>
              {invoice.payment_method && (
                <span className="text-slate-400">({invoice.payment_method})</span>
              )}
            </>
          )}
        </div>
      </div>

      {/* Vendor payment submission callout — shows when vendor has self-
          reported payment and we're awaiting manager verification. */}
      {invoice.status === 'payment_submitted' && (
        <div className="px-5 py-3 border-b border-orange-200 bg-orange-50">
          <div className="flex items-start gap-3">
            <span
              className="inline-flex w-8 h-8 rounded-full bg-orange-200 text-orange-800 items-center justify-center shrink-0"
              aria-hidden
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-4 h-4"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" x2="12" y1="8" y2="12" />
                <line x1="12" x2="12.01" y1="16" y2="16" />
              </svg>
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold text-orange-900">
                Vendor reported payment — awaiting verification
              </div>
              <div className="text-xs text-orange-800 mt-1 grid sm:grid-cols-2 gap-x-4 gap-y-0.5">
                {invoice.vendor_marked_paid_by && (
                  <span>
                    <span className="text-orange-700/70">Submitted by:</span>{' '}
                    <span className="font-mono">{invoice.vendor_marked_paid_by}</span>
                  </span>
                )}
                {invoice.vendor_marked_paid_at && (
                  <span>
                    <span className="text-orange-700/70">When:</span>{' '}
                    {fmtDate(invoice.vendor_marked_paid_at)}
                  </span>
                )}
                {invoice.payment_method && (
                  <span>
                    <span className="text-orange-700/70">Method:</span>{' '}
                    {invoice.payment_method}
                  </span>
                )}
                {invoice.vendor_payment_reference && (
                  <span>
                    <span className="text-orange-700/70">Reference:</span>{' '}
                    <span className="font-mono">{invoice.vendor_payment_reference}</span>
                  </span>
                )}
              </div>
              <div className="text-[11px] text-orange-700/80 mt-1.5">
                Confirm the payment has landed before clicking{' '}
                <strong>Verify &amp; mark paid</strong>.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Lines */}
      <div className="px-5 py-4">
        <div className="flex items-baseline justify-between mb-2">
          <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#0093D0]">
            Charge lines
          </h3>
          {editable && (
            <button
              type="button"
              onClick={() => setAddingLine(true)}
              className="text-xs text-[#1B4676] hover:text-[#0093D0] font-semibold"
            >
              + Add line
            </button>
          )}
        </div>
        {invoice.lines.length === 0 ? (
          <div className="text-sm text-slate-500 italic">No lines.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-[10.5px] uppercase text-slate-500 border-b border-slate-200">
              <tr>
                <th className="text-left py-1.5 font-semibold tracking-wider">Code</th>
                <th className="text-left py-1.5 font-semibold tracking-wider">Description</th>
                <th className="text-right py-1.5 font-semibold tracking-wider">Qty</th>
                <th className="text-right py-1.5 font-semibold tracking-wider">Rate</th>
                <th className="text-right py-1.5 font-semibold tracking-wider">Amount</th>
                {editable && <th />}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {invoice.lines.map((line) => (
                <tr key={line.id} className="text-slate-700">
                  <td className="py-1.5 font-mono text-xs">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[#1B4676] font-bold">{line.code}</span>
                      {line.auto_applied && (
                        <span
                          title="Auto-applied from warehouse activity"
                          className="bg-[#0093D0]/15 text-[#1B4676] px-1 rounded text-[9px] font-bold uppercase tracking-wider"
                        >
                          Auto
                        </span>
                      )}
                      {line.taxable && (
                        <span
                          title="Taxable"
                          className="bg-amber-100 text-amber-800 px-1 rounded text-[9px] font-bold uppercase tracking-wider"
                        >
                          Tax
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-1.5 text-slate-600">{line.description}</td>
                  <td className="py-1.5 text-right font-mono">
                    {line.quantity}
                    <span className="text-slate-400 text-xs ml-1">{line.unit}</span>
                  </td>
                  <td className="py-1.5 text-right font-mono">
                    {fmtMoney(line.unit_rate)}
                  </td>
                  <td className="py-1.5 text-right font-mono font-semibold">
                    {fmtMoney(line.line_total)}
                  </td>
                  {editable && (
                    <td className="py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => deleteLine(line.id)}
                        className="text-rose-600 hover:text-rose-800 text-xs"
                        title="Remove line"
                      >
                        ×
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Operational charge */}
      {invoice.operational_charge > 0 && invoice.operational_charge_breakdown && (
        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/50">
          <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#0093D0] mb-1">
            Account & operations management — {invoice.operational_charge_breakdown.tier_label}
          </h3>
          <ul className="text-xs text-slate-600 space-y-0.5">
            {invoice.operational_charge_breakdown.items.map((item, idx) => (
              <li key={idx} className="flex justify-between gap-2">
                <span>{item.label}</span>
                <span className="font-mono">{fmtMoney(item.monthly)}</span>
              </li>
            ))}
            <li className="flex justify-between gap-2 pt-1 border-t border-slate-200 font-semibold text-slate-700">
              <span>Operational charge</span>
              <span className="font-mono">
                {fmtMoney(invoice.operational_charge)}
              </span>
            </li>
          </ul>
        </div>
      )}

      {/* Totals */}
      <div className="px-5 py-3 border-t border-slate-200 bg-white">
        <dl className="text-sm space-y-0.5">
          <Row label="Subtotal" value={fmtMoney(invoice.subtotal)} />
          {invoice.fuel_surcharge > 0 && (
            <Row label="Fuel surcharge" value={fmtMoney(invoice.fuel_surcharge)} />
          )}
          {invoice.advancing > 0 && (
            <Row label="Advancing fees" value={fmtMoney(invoice.advancing)} />
          )}
          {invoice.operational_charge > 0 && (
            <Row
              label="Account & operations management"
              value={fmtMoney(invoice.operational_charge)}
            />
          )}
          {invoice.adjustment !== 0 && (
            <Row
              label={`Adjustment${invoice.adjustment_note ? ` · ${invoice.adjustment_note}` : ''}`}
              value={fmtMoney(invoice.adjustment)}
            />
          )}
          <Row label="Tax (9.5%)" value={fmtMoney(invoice.tax)} />
          <div className="border-t border-slate-200 mt-1 pt-1.5 flex justify-between text-base font-bold text-[#1B4676]">
            <span>Total</span>
            <span className="font-mono">{fmtMoney(invoice.total)}</span>
          </div>
        </dl>
      </div>

      {/* Actions */}
      <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <a
            href={billingApi.pdfUrl(invoice.id, 'customer')}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-[#1B4676] hover:text-[#0093D0] font-semibold underline"
          >
            View customer PDF
          </a>
          <span className="text-slate-300">·</span>
          <a
            href={billingApi.pdfUrl(invoice.id, 'servicelog')}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-slate-500 hover:text-[#1B4676] font-semibold underline"
          >
            Service log (AP backup)
          </a>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {invoice.status === 'draft' || invoice.status === 'ready' ? (
            <button
              type="button"
              onClick={() => doTransition('sent', () => billingApi.markSent(invoice.id))}
              disabled={busyAction !== null}
              className="text-xs bg-[#0093D0] hover:bg-[#00A8E8] text-white font-semibold px-3 py-1.5 rounded disabled:opacity-50"
            >
              Mark sent
            </button>
          ) : null}
          {invoice.status !== 'paid' && invoice.status !== 'void' ? (
            <button
              type="button"
              onClick={() => doTransition('paid', () => billingApi.markPaid(invoice.id))}
              disabled={busyAction !== null}
              className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white font-semibold px-3 py-1.5 rounded disabled:opacity-50"
            >
              {invoice.status === 'payment_submitted' ? 'Verify & mark paid' : 'Mark paid'}
            </button>
          ) : null}
          {invoice.status !== 'void' && invoice.status !== 'paid' ? (
            <button
              type="button"
              onClick={() => doTransition('void', () => billingApi.markVoid(invoice.id))}
              disabled={busyAction !== null}
              className="text-xs bg-white hover:bg-rose-50 border border-rose-200 text-rose-700 font-semibold px-3 py-1.5 rounded disabled:opacity-50"
            >
              Void
            </button>
          ) : null}
        </div>
      </div>

      {addingLine && (
        <AddLineModal
          invoiceId={invoice.id}
          onClose={() => setAddingLine(false)}
          onAdded={(updated) => {
            setAddingLine(false)
            onChanged(updated)
            onToast('Line added')
          }}
          onError={onError}
        />
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 text-slate-600">
      <span>{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  )
}

// ─── Generate invoice (WHPO or TO) ─────────────────────────────────────

function GenerateInvoiceModal({
  mode,
  onClose,
  onGenerated,
}: {
  mode: GenerateMode
  onClose: () => void
  onGenerated: (inv: InvoiceRead) => void
}) {
  const [identifier, setIdentifier] = useState(
    mode.scope === 'inbound' ? mode.whpoNumber : mode.transferOrderNo,
  )
  const [preview, setPreview] = useState<InvoicePreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function runPreview() {
    if (!identifier.trim()) return
    setError(null)
    setPreviewing(true)
    try {
      const p =
        mode.scope === 'inbound'
          ? await billingApi.previewInbound(identifier.trim())
          : await billingApi.previewOutbound(identifier.trim())
      setPreview(p)
    } catch (e) {
      const err = e as { detail?: string } | string
      setError(typeof err === 'object' && err.detail ? err.detail : String(err))
    } finally {
      setPreviewing(false)
    }
  }

  async function commit() {
    if (!identifier.trim()) return
    setCommitting(true)
    setError(null)
    try {
      const inv =
        mode.scope === 'inbound'
          ? await billingApi.generateInbound(identifier.trim())
          : await billingApi.generateOutbound(identifier.trim())
      onGenerated(inv)
    } catch (e) {
      const err = e as { detail?: string } | string
      setError(typeof err === 'object' && err.detail ? err.detail : String(err))
    } finally {
      setCommitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-lg font-bold text-[#1B4676]">
            Generate invoice from {mode.scope === 'inbound' ? 'WHPO' : 'Transfer Order'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-700"
          >
            ×
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <label className="block">
            <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">
              {mode.scope === 'inbound' ? 'WHPO number' : 'Transfer Order number'}
            </span>
            <input
              type="text"
              value={identifier}
              onChange={(e) => {
                setIdentifier(e.target.value)
                setPreview(null)
              }}
              placeholder={mode.scope === 'inbound' ? 'e.g. 8612345' : 'e.g. TO-2026-001'}
              className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#0093D0]"
            />
          </label>
          <button
            type="button"
            onClick={runPreview}
            disabled={!identifier.trim() || previewing}
            className="text-sm bg-[#1B4676] hover:bg-[#244e7d] text-white font-semibold px-4 py-2 rounded-md disabled:opacity-50"
          >
            {previewing ? 'Loading…' : 'Preview charges'}
          </button>
          {error && (
            <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-3 py-2">
              {error}
            </div>
          )}
          {preview && (
            <div className="border border-slate-200 rounded-md p-4 bg-slate-50">
              <div className="flex items-baseline justify-between mb-3">
                <div>
                  <div className="font-semibold text-[#1B4676]">
                    {preview.customer_name ?? '—'}
                  </div>
                  <div className="text-xs text-slate-500 font-mono">
                    {preview.scope.toUpperCase()} ·{' '}
                    {preview.whpo_number ?? preview.transfer_order_no}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs uppercase tracking-wider text-slate-500">
                    Estimated total
                  </div>
                  <div className="font-mono font-bold text-lg text-[#1B4676]">
                    {fmtMoney(preview.total)}
                  </div>
                </div>
              </div>
              {preview.proposed_lines.length === 0 ? (
                <div className="text-sm italic text-slate-500">
                  No auto-charge lines proposed. You can still generate the
                  invoice (just operational charge) and add manual lines after.
                </div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="text-[10px] uppercase text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="text-left py-1 font-semibold tracking-wider">Code</th>
                      <th className="text-left py-1 font-semibold tracking-wider">Description</th>
                      <th className="text-right py-1 font-semibold tracking-wider">Qty</th>
                      <th className="text-right py-1 font-semibold tracking-wider">Rate</th>
                      <th className="text-right py-1 font-semibold tracking-wider">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {preview.proposed_lines.map((line, idx) => (
                      <tr key={idx}>
                        <td className="py-1 font-mono font-bold text-[#1B4676]">
                          {line.code}
                        </td>
                        <td className="py-1 text-slate-600">{line.description}</td>
                        <td className="py-1 text-right font-mono">{line.quantity}</td>
                        <td className="py-1 text-right font-mono">
                          {fmtMoney(line.unit_rate)}
                        </td>
                        <td className="py-1 text-right font-mono font-semibold">
                          {fmtMoney(line.line_total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {preview.operational_charge > 0 && (
                <div className="mt-3 text-xs text-slate-600 flex justify-between border-t border-slate-200 pt-2">
                  <span>+ Operational charge ({preview.operational_charge_breakdown?.tier_label ?? '—'})</span>
                  <span className="font-mono">{fmtMoney(preview.operational_charge)}</span>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-slate-700 hover:bg-slate-100 px-3 py-1.5 rounded"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={commit}
            disabled={!identifier.trim() || committing}
            className="text-sm bg-[#0093D0] hover:bg-[#00A8E8] text-white font-semibold px-4 py-1.5 rounded disabled:opacity-50"
          >
            {committing ? 'Generating…' : 'Generate invoice'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Add line modal ────────────────────────────────────────────────────

function AddLineModal({
  invoiceId,
  onClose,
  onAdded,
  onError,
}: {
  invoiceId: number
  onClose: () => void
  onAdded: (inv: InvoiceRead) => void
  onError: (msg: string) => void
}) {
  const [rateCard, setRateCard] = useState<RateCardRow[] | null>(null)
  const [code, setCode] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [unitRateOverride, setUnitRateOverride] = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  // Eat `api` to avoid the unused-import lint error after refactors.
  void api

  useEffect(() => {
    billingApi.rateCard().then(setRateCard)
  }, [])

  const filtered = useMemo(() => {
    const data = rateCard ?? []
    const q = search.trim().toLowerCase()
    if (!q) return data.slice(0, 200)
    return data
      .filter(
        (r) =>
          r.code.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q),
      )
      .slice(0, 200)
  }, [rateCard, search])

  const selected = useMemo(
    () => (rateCard ?? []).find((r) => r.code === code) ?? null,
    [rateCard, code],
  )

  async function submit() {
    if (!code || !quantity) return
    const qty = parseFloat(quantity)
    if (!Number.isFinite(qty) || qty <= 0) {
      onError('Quantity must be greater than zero')
      return
    }
    setBusy(true)
    try {
      const override = unitRateOverride ? parseFloat(unitRateOverride) : undefined
      const updated = await billingApi.addLine(invoiceId, {
        code,
        quantity: qty,
        unit_rate_override: Number.isFinite(override ?? NaN)
          ? (override as number)
          : null,
        override_reason: overrideReason.trim() || null,
      })
      onAdded(updated)
    } catch (e) {
      const err = e as { detail?: string } | string
      onError(typeof err === 'object' && err.detail ? err.detail : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-lg font-bold text-[#1B4676]">Add invoice line</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-700"
          >
            ×
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          {/* Code picker */}
          <label className="block">
            <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">
              Search rate code
            </span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="HND-005, picking, hazmat…"
              className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#0093D0]"
            />
          </label>
          <div className="max-h-64 overflow-y-auto border border-slate-200 rounded-md">
            <table className="w-full text-xs">
              <tbody className="divide-y divide-slate-100">
                {filtered.map((r) => {
                  const active = r.code === code
                  return (
                    <tr
                      key={r.code}
                      onClick={() => setCode(r.code)}
                      className={`cursor-pointer transition ${
                        active
                          ? 'bg-[#0093D0]/10'
                          : 'hover:bg-slate-50'
                      }`}
                    >
                      <td className="px-3 py-1.5 font-mono font-bold text-[#1B4676] whitespace-nowrap">
                        {r.code}
                      </td>
                      <td className="px-3 py-1.5 text-slate-600">
                        {r.description}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-slate-600 whitespace-nowrap">
                        {r.rate != null ? fmtMoney(r.rate) : '—'} / {r.unit}
                      </td>
                    </tr>
                  )
                })}
                {rateCard === null && (
                  <tr>
                    <td colSpan={3} className="px-3 py-3 text-center text-slate-500">
                      Loading rate card…
                    </td>
                  </tr>
                )}
                {rateCard !== null && filtered.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-3 py-3 text-center text-slate-500">
                      No matching codes.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {/* Inputs */}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">
                Selected code
              </span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#0093D0]"
              />
              {selected && (
                <span className="text-[11px] text-slate-500 mt-0.5 block">
                  {selected.description} · default {fmtMoney(selected.rate ?? 0)} /{' '}
                  {selected.unit}
                </span>
              )}
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">
                Quantity{selected ? ` (${selected.unit})` : ''}
              </span>
              <input
                type="number"
                step="any"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#0093D0]"
              />
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">
                Unit rate override (optional)
              </span>
              <input
                type="number"
                step="any"
                value={unitRateOverride}
                onChange={(e) => setUnitRateOverride(e.target.value)}
                placeholder={selected ? String(selected.rate ?? '') : ''}
                className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#0093D0]"
              />
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">
                Override reason
              </span>
              <input
                type="text"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="e.g. customer agreement"
                className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#0093D0]"
              />
            </label>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-slate-700 hover:bg-slate-100 px-3 py-1.5 rounded"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!code || !quantity || busy}
            className="text-sm bg-[#0093D0] hover:bg-[#00A8E8] text-white font-semibold px-4 py-1.5 rounded disabled:opacity-50"
          >
            {busy ? 'Adding…' : 'Add line'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Icons ─────────────────────────────────────────────────────────────

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
