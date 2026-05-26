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
  sent: { label: 'Sent — unpaid', cls: 'bg-[#0093D0]/15 text-[#1B4676]' },
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
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'sent' | 'paid'>('all')
  const [downloading, setDownloading] = useState<number | null>(null)

  useEffect(() => {
    if (!isLoggedIn) return
    billingApi
      .vendorListInvoices()
      .then(setItems)
      .catch((e: { detail?: string } | Error) => {
        const detail = (e as { detail?: string })?.detail
        setError(detail || (e as Error)?.message || String(e))
      })
  }, [isLoggedIn])

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
    const paidYtd = all
      .filter((r) => r.status === 'paid')
      .reduce((sum, r) => sum + r.total, 0)
    return { outstanding, paidYtd, total: all.length }
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <StatTile
            label="Outstanding (sent, unpaid)"
            value={fmtMoney(totals.outstanding)}
            tone="cyan"
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
            {(['all', 'sent', 'paid'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`text-[11px] uppercase tracking-wider font-semibold px-2.5 py-1 rounded-full border transition ${
                  statusFilter === s
                    ? 'bg-[#1B4676] text-white border-[#1B4676]'
                    : 'bg-white text-slate-700 border-slate-200 hover:border-[#0093D0]'
                }`}
              >
                {s === 'all' ? 'All' : s === 'sent' ? 'Outstanding' : 'Paid'}
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
                      <td className="px-4 py-2.5 text-right">
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
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </VendorPortalChrome>
  )
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: 'cyan' | 'emerald' | 'slate'
}) {
  const ring =
    tone === 'cyan'
      ? 'border-[#0093D0]/30 text-[#1B4676]'
      : tone === 'emerald'
        ? 'border-emerald-300 text-emerald-800'
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
