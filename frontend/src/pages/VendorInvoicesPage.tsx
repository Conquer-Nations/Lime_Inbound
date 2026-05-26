import { useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { billingApi } from '../api/client'
import type { InvoiceListItem, InvoiceStatus } from '../api/client'
import { useVendorAuth } from '../auth/VendorAuthContext'
import VendorPortalChrome from '../components/VendorPortalChrome'

/**
 * Vendor-facing invoice list. Strictly read-only — vendors only see their
 * own invoices (server-side scoped via JWT to the customer IDs they have
 * access to) and only at status `sent` or `paid` (drafts/ready are
 * internal). Click an invoice to inline-download the customer PDF.
 *
 * No money internals exposed beyond the totals row that's already on the
 * PDF: subtotal / fees / tax / total appear on the PDF, the listing
 * shows just the headline total and key dates.
 */

const STATUS_PILL: Record<InvoiceStatus, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'bg-slate-100 text-slate-700' },
  ready: { label: 'Ready', cls: 'bg-amber-100 text-amber-800' },
  sent: { label: 'Unpaid', cls: 'bg-[#0093D0]/15 text-[#1B4676]' },
  payment_submitted: {
    label: 'Payment submitted',
    cls: 'bg-orange-100 text-orange-800 border border-orange-200',
  },
  paid: { label: 'Paid', cls: 'bg-emerald-100 text-emerald-800' },
  void: { label: 'Void', cls: 'bg-rose-100 text-rose-700' },
}

function fmtMoney(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(n)
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—'
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d
  return new Date(d).toLocaleDateString()
}

export default function VendorInvoicesPage() {
  const { isLoggedIn } = useVendorAuth()
  const nav = useNavigate()

  const [items, setItems] = useState<InvoiceListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'sent' | 'payment_submitted' | 'paid'
  >('all')
  const [downloading, setDownloading] = useState<number | null>(null)
  const [marking, setMarking] = useState<InvoiceListItem | null>(null)

  function reload() {
    setError(null)
    billingApi
      .vendorListInvoices()
      .then(setItems)
      .catch((e: { detail?: string } | Error) => {
        const detail = (e as { detail?: string })?.detail
        setError(detail || (e as Error)?.message || String(e))
      })
  }

  useEffect(() => {
    if (!isLoggedIn) return
    reload()
  }, [isLoggedIn])

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 4000)
  }

  const filtered = useMemo(() => {
    if (!items) return null
    const q = search.trim().toLowerCase()
    return items
      .filter((r) => (statusFilter === 'all' ? true : r.status === statusFilter))
      .filter(
        (r) =>
          !q ||
          r.invoice_number.toLowerCase().includes(q) ||
          (r.customer_name ?? '').toLowerCase().includes(q) ||
          (r.whpo_number ?? '').toLowerCase().includes(q) ||
          (r.transfer_order_no ?? '').toLowerCase().includes(q),
      )
  }, [items, search, statusFilter])

  const totals = useMemo(() => {
    const all = items ?? []
    const outstanding = all
      .filter((r) => r.status === 'sent')
      .reduce((sum, r) => sum + r.total, 0)
    const submitted = all
      .filter((r) => r.status === 'payment_submitted')
      .reduce((sum, r) => sum + r.total, 0)
    const paidYtd = all
      .filter((r) => r.status === 'paid')
      .reduce((sum, r) => sum + r.total, 0)
    return { outstanding, submitted, paidYtd, total: all.length }
  }, [items])

  async function downloadPdf(inv: InvoiceListItem) {
    setDownloading(inv.id)
    try {
      const blob = await billingApi.vendorFetchPdf(inv.id)
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank', 'noopener,noreferrer')
      // Revoke after a delay so the new tab has time to load
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (e) {
      const err = e as { detail?: string } | string
      setError(typeof err === 'object' && err.detail ? err.detail : String(err))
    } finally {
      setDownloading(null)
    }
  }

  if (!isLoggedIn) {
    return <Navigate to="/vendor/login" replace />
  }

  return (
    <VendorPortalChrome
      breadcrumbCurrent="Invoices"
      onBack={() => nav('/vendor-intake')}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-10 space-y-6">
        <header>
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#1B4676] text-[11px] font-semibold tracking-[0.14em] uppercase mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
            Invoices
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#1B4676]">
            Your invoices
          </h1>
          <p className="mt-2 text-sm sm:text-base text-slate-600 max-w-2xl">
            One invoice per inbound WHPO and one per outbound Transfer
            Order. Open any row to download the PDF. Reach out to
            ops if anything looks off.
          </p>
        </header>

        {/* Stat tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatTile
            label="Unpaid"
            value={fmtMoney(totals.outstanding)}
            tone="cyan"
          />
          <StatTile
            label="Payment submitted"
            value={fmtMoney(totals.submitted)}
            tone="orange"
          />
          <StatTile
            label="Paid"
            value={fmtMoney(totals.paidYtd)}
            tone="emerald"
          />
          <StatTile
            label="Total invoices"
            value={String(totals.total)}
            tone="slate"
          />
        </div>

        {error && (
          <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-3 py-2.5 flex items-start gap-2">
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
            placeholder="Search invoice #, WHPO, TO…"
            className="w-72 max-w-full border border-slate-200 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-[#0093D0]"
          />
          <div className="flex items-center gap-1 flex-wrap">
            {(
              [
                ['all', 'All'],
                ['sent', 'Unpaid'],
                ['payment_submitted', 'Payment submitted'],
                ['paid', 'Paid'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setStatusFilter(key)}
                className={`text-[11px] uppercase tracking-wider font-semibold px-2.5 py-1 rounded-full border transition ${
                  statusFilter === key
                    ? 'bg-[#1B4676] text-white border-[#1B4676]'
                    : 'bg-white text-slate-700 border-slate-200 hover:border-[#0093D0]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        {filtered === null ? (
          <div className="bg-white border border-slate-200 rounded-md px-3 py-2.5 text-sm text-slate-500">
            Loading invoices…
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
            <div className="w-12 h-12 mx-auto rounded-full bg-[#0093D0]/10 border border-[#0093D0]/30 flex items-center justify-center text-[#0093D0] mb-3">
              <DocIcon className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-bold text-[#1B4676]">No invoices yet</h3>
            <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
              Invoices appear here once Conquer Nation has issued them
              against one of your WHPOs or Transfer Orders.
            </p>
          </div>
        ) : (
          <div
            className="bg-white rounded-xl border border-slate-200 overflow-hidden"
            style={{
              boxShadow:
                '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
            }}
          >
            <div className="bg-slate-50 border-b border-slate-200 px-4 py-2.5 flex items-baseline justify-between">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#0093D0]">
                Invoices
              </h3>
              <span className="text-[11px] text-slate-400 uppercase tracking-wider">
                {filtered.length} item{filtered.length === 1 ? '' : 's'}
              </span>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-white text-[10.5px] uppercase text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="text-left px-4 py-2 font-semibold tracking-wider">
                    Invoice #
                  </th>
                  <th className="text-left px-4 py-2 font-semibold tracking-wider">
                    Brand
                  </th>
                  <th className="text-left px-4 py-2 font-semibold tracking-wider">
                    Reference
                  </th>
                  <th className="text-left px-4 py-2 font-semibold tracking-wider">
                    Status
                  </th>
                  <th className="text-left px-4 py-2 font-semibold tracking-wider">
                    Issued
                  </th>
                  <th className="text-left px-4 py-2 font-semibold tracking-wider">
                    Due
                  </th>
                  <th className="text-right px-4 py-2 font-semibold tracking-wider">
                    Total
                  </th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((inv) => {
                  const pill = STATUS_PILL[inv.status]
                  return (
                    <tr
                      key={inv.id}
                      className="hover:bg-[#0093D0]/5 transition"
                    >
                      <td className="px-4 py-2.5 font-mono font-bold text-[#1B4676]">
                        {inv.invoice_number}
                      </td>
                      <td className="px-4 py-2.5 text-slate-700">
                        {inv.customer_name ?? '—'}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600 font-mono text-xs">
                        {inv.whpo_number ? (
                          <span>WHPO {inv.whpo_number}</span>
                        ) : inv.transfer_order_no ? (
                          <span>TO {inv.transfer_order_no}</span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`${pill.cls} px-2 py-0.5 rounded-full text-[10.5px] uppercase tracking-[0.12em] font-bold`}
                        >
                          {pill.label}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-600 font-mono">
                        {fmtDate(inv.invoice_date)}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600 font-mono">
                        {fmtDate(inv.due_date)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono font-bold text-slate-800">
                        {fmtMoney(inv.total)}
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-3">
                          {inv.status === 'sent' && (
                            <button
                              type="button"
                              onClick={() => setMarking(inv)}
                              className="inline-flex items-center gap-1 text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white rounded px-2.5 py-1 transition"
                              title="I have paid this invoice"
                            >
                              <CheckIcon className="w-3.5 h-3.5" />
                              <span>Mark as paid</span>
                            </button>
                          )}
                          {inv.status === 'payment_submitted' && (
                            <span
                              className="inline-flex items-center gap-1 text-[11px] font-semibold text-orange-700"
                              title="Awaiting verification from Conquer Nation"
                            >
                              <ClockIcon className="w-3.5 h-3.5" />
                              <span>Awaiting verification</span>
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => downloadPdf(inv)}
                            disabled={downloading === inv.id}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-[#0093D0] hover:text-[#1B4676] disabled:opacity-50"
                          >
                            {downloading === inv.id ? (
                              <span>Opening…</span>
                            ) : (
                              <>
                                <DocIcon className="w-3.5 h-3.5" />
                                <span>View PDF</span>
                              </>
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {marking && (
        <VendorMarkPaidModal
          invoice={marking}
          onClose={() => setMarking(null)}
          onSubmitted={() => {
            setMarking(null)
            showToast(
              'Payment submission recorded — Conquer Nation will verify shortly.',
            )
            reload()
          }}
          onError={(msg) => setError(msg)}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 bg-emerald-700 text-white px-4 py-2.5 rounded-md shadow-lg z-50 flex items-center gap-2 max-w-md">
          <CheckIcon className="w-4 h-4 shrink-0" />
          <span className="text-sm">{toast}</span>
        </div>
      )}
    </VendorPortalChrome>
  )
}

// ─── Mark-as-paid modal (vendor self-report) ───────────────────────────

function VendorMarkPaidModal({
  invoice,
  onClose,
  onSubmitted,
  onError,
}: {
  invoice: InvoiceListItem
  onClose: () => void
  onSubmitted: () => void
  onError: (msg: string) => void
}) {
  const [paymentMethod, setPaymentMethod] = useState('ACH')
  const [paymentReference, setPaymentReference] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    try {
      await billingApi.vendorMarkPaid(invoice.id, {
        payment_method: paymentMethod.trim() || null,
        payment_reference: paymentReference.trim() || null,
        notes: notes.trim() || null,
      })
      onSubmitted()
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
        className="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-[#1B4676]">Mark invoice as paid</h2>
            <p className="text-xs text-slate-500 mt-0.5 font-mono">
              {invoice.invoice_number} · {fmtMoney(invoice.total)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-700 text-xl leading-none"
          >
            ×
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-slate-600">
            Submit your payment details so Conquer Nation can verify
            receipt. The invoice stays in <em>Payment submitted</em> until
            verification clears it to <em>Paid</em>.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">
                Method
              </span>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
                className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#0093D0] bg-white"
              >
                <option>ACH</option>
                <option>Wire</option>
                <option>Check</option>
                <option>Zelle</option>
                <option>Credit card</option>
                <option>Other</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">
                Reference / Check #
              </span>
              <input
                type="text"
                value={paymentReference}
                onChange={(e) => setPaymentReference(e.target.value)}
                placeholder="e.g. CHK 10432 or ACH-9F1A"
                className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#0093D0]"
              />
            </label>
          </div>
          <label className="block">
            <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">
              Notes (optional)
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Anything Conquer Nation should know — wired today, includes credit, etc."
              className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#0093D0]"
            />
          </label>
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
            disabled={busy}
            className="text-sm bg-emerald-600 hover:bg-emerald-700 text-white font-semibold px-4 py-1.5 rounded disabled:opacity-50 inline-flex items-center gap-2"
          >
            {busy ? (
              <span>Submitting…</span>
            ) : (
              <>
                <CheckIcon className="w-4 h-4" />
                <span>Submit payment</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: 'cyan' | 'emerald' | 'slate' | 'orange'
}) {
  const ring =
    tone === 'cyan'
      ? 'border-[#0093D0]/30 text-[#1B4676]'
      : tone === 'emerald'
        ? 'border-emerald-300 text-emerald-800'
        : tone === 'orange'
          ? 'border-orange-300 text-orange-800'
          : 'border-slate-200 text-slate-700'
  return (
    <div
      className={`bg-white rounded-xl border ${ring} px-4 py-3`}
      style={{
        boxShadow:
          '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 20px -8px rgba(15,23,42,0.08)',
      }}
    >
      <div className="text-[10.5px] uppercase tracking-[0.16em] font-bold opacity-70">
        {label}
      </div>
      <div className="mt-1 font-bold font-mono text-2xl text-[#1B4676]">
        {value}
      </div>
    </div>
  )
}

function DocIcon({ className }: { className?: string }) {
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
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" x2="15" y1="13" y2="13" />
      <line x1="9" x2="15" y1="17" y2="17" />
    </svg>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
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

function ClockIcon({ className }: { className?: string }) {
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
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}
