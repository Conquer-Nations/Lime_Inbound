import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, billingApi } from '../api/client'
import type {
  CustomerRead,
  InvoiceListItem,
  InvoiceStatus,
} from '../api/client'
import FilterBar, {
  resolveFilterDates,
  useFilterFromURL,
} from './FilterBar'

/**
 * Manager Order History — finalized invoices. Shows `paid` and `void`
 * invoices with explicit Inbound / Outbound sub-tabs. Brand filter
 * mirrors the active Invoices view.
 *
 * Active (draft → sent → payment_submitted) invoices stay on the main
 * Invoices tab — once a manager hits "Verify & mark paid" (or "Void"),
 * the invoice rolls here.
 *
 * No detail-panel editing (these are terminal). Click an invoice → PDF.
 */

type Direction = 'inbound' | 'outbound'
type HistoryStatus = 'paid' | 'void'

const STATUS_PILL: Record<HistoryStatus, { cls: string; label: string }> = {
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
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d
  return new Date(d).toLocaleDateString()
}

function isHistoryStatus(s: InvoiceStatus): s is HistoryStatus {
  return s === 'paid' || s === 'void'
}

export default function BillingOrderHistory() {
  const [direction, setDirection] = useState<Direction>('inbound')
  const [statusFilter, setStatusFilter] = useState<'all' | HistoryStatus>('all')
  const [customers, setCustomers] = useState<CustomerRead[]>([])
  const [items, setItems] = useState<InvoiceListItem[] | null>(null)
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Brand + date filter via FilterBar (URL-persisted).
  const [searchParams, setSearchParams] = useSearchParams()
  const [filter, setFilter] = useFilterFromURL(searchParams, setSearchParams)

  // Load brand list once.
  useEffect(() => {
    api
      .listManagerCustomers()
      .then((rows) =>
        setCustomers([...rows].sort((a, b) => a.name.localeCompare(b.name))),
      )
      .catch(() => {})
  }, [])

  // Reload invoices when filters change.
  useEffect(() => {
    setError(null)
    const { from_date, to_date } = resolveFilterDates(filter)
    const customer_id =
      filter.brand_id === 'all' ? undefined : (filter.brand_id as number)
    // We always need paid + void; pull paid first, then void, then merge.
    // Backend doesn't have a direction filter — we filter client-side
    // via whpo_number vs transfer_order_no (which the row already has).
    Promise.all([
      billingApi.listInvoices({
        status: 'paid',
        customer_id,
        from_date,
        to_date,
        limit: 500,
      }),
      billingApi.listInvoices({
        status: 'void',
        customer_id,
        from_date,
        to_date,
        limit: 500,
      }),
    ])
      .then(([paid, voided]) => {
        // Merge + sort desc by generated_at
        const merged = [...paid, ...voided].sort((a, b) =>
          (b.generated_at || '').localeCompare(a.generated_at || ''),
        )
        setItems(merged)
      })
      .catch((e) => setError(String(e?.detail || e)))
  }, [filter])

  const filtered = useMemo(() => {
    if (!items) return null
    const q = search.trim().toLowerCase()
    return items
      .filter((r) =>
        direction === 'inbound' ? !!r.whpo_number : !!r.transfer_order_no,
      )
      .filter((r) =>
        statusFilter === 'all'
          ? isHistoryStatus(r.status)
          : r.status === statusFilter,
      )
      .filter(
        (r) =>
          !q ||
          r.invoice_number.toLowerCase().includes(q) ||
          (r.customer_name ?? '').toLowerCase().includes(q) ||
          (r.whpo_number ?? '').toLowerCase().includes(q) ||
          (r.transfer_order_no ?? '').toLowerCase().includes(q),
      )
  }, [items, direction, statusFilter, search])

  const counts = useMemo(() => {
    const all = items ?? []
    const inbound = all.filter(
      (r) => !!r.whpo_number && isHistoryStatus(r.status),
    )
    const outbound = all.filter(
      (r) => !!r.transfer_order_no && isHistoryStatus(r.status),
    )
    return {
      inbound: inbound.length,
      outbound: outbound.length,
      inboundPaid: inbound
        .filter((r) => r.status === 'paid')
        .reduce((sum, r) => sum + r.total, 0),
      outboundPaid: outbound
        .filter((r) => r.status === 'paid')
        .reduce((sum, r) => sum + r.total, 0),
    }
  }, [items])

  return (
    <div className="space-y-5">
      <header>
        <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-emerald-100 border border-emerald-300 text-emerald-800 text-[11px] font-semibold tracking-[0.14em] uppercase mb-3">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden />
          Order History
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#1B4676]">
          Closed invoices
        </h1>
        <p className="mt-1.5 text-sm text-slate-600 max-w-2xl">
          Paid + void invoices, segregated by direction. Once an invoice is
          marked paid (after payment verification), it rolls off the active
          Invoices tab and lands here.
        </p>
      </header>

      {/* Direction sub-tabs */}
      <div className="flex items-center gap-2 border-b border-slate-200">
        {(['inbound', 'outbound'] as Direction[]).map((d) => {
          const active = direction === d
          const count = d === 'inbound' ? counts.inbound : counts.outbound
          const paid = d === 'inbound' ? counts.inboundPaid : counts.outboundPaid
          return (
            <button
              key={d}
              type="button"
              onClick={() => setDirection(d)}
              className={`px-4 py-2 text-sm font-semibold border-b-2 transition flex items-center gap-2 ${
                active
                  ? 'border-[#0093D0] text-[#1B4676]'
                  : 'border-transparent text-slate-600 hover:text-[#1B4676]'
              }`}
            >
              <span className="uppercase tracking-[0.12em] text-xs">
                {d === 'inbound' ? 'Inbound (WHPO)' : 'Outbound (TO)'}
              </span>
              <span className="text-[10px] bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded-full font-bold">
                {count}
              </span>
              {paid > 0 && (
                <span className="text-[11px] font-mono text-emerald-700">
                  · {fmtMoney(paid)}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {error && (
        <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-3 py-2">
          <span className="font-semibold">Error:</span> {error}
        </div>
      )}

      {/* Brand + date filter (URL-persisted). */}
      <FilterBar
        brands={customers.map((c) => ({ id: c.id, name: c.name }))}
        value={filter}
        onChange={setFilter}
      />

      {/* Search + status filters */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search invoice #, customer, WHPO, TO…"
          className="w-72 max-w-full border border-slate-200 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-[#0093D0]"
        />
        <div className="flex items-center gap-1 flex-wrap">
          {(['all', 'paid', 'void'] as const).map((s) => (
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
              {s === 'all' ? 'All' : s === 'paid' ? 'Paid' : 'Void'}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {filtered === null ? (
        <div className="bg-white border border-slate-200 rounded-md px-3 py-2.5 text-sm text-slate-500">
          Loading history…
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
          <h3 className="text-lg font-bold text-[#1B4676]">No closed orders</h3>
          <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
            {direction === 'inbound' ? 'Inbound WHPO' : 'Outbound TO'} invoices
            move here once you mark them paid (or void).
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
              {direction === 'inbound' ? 'Inbound history' : 'Outbound history'}
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
                  {direction === 'inbound' ? 'WHPO' : 'TO'}
                </th>
                <th className="text-left px-4 py-2 font-semibold tracking-wider">
                  Status
                </th>
                <th className="text-left px-4 py-2 font-semibold tracking-wider">
                  Issued
                </th>
                <th className="text-left px-4 py-2 font-semibold tracking-wider">
                  Closed
                </th>
                <th className="text-right px-4 py-2 font-semibold tracking-wider">
                  Total
                </th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((inv) => {
                if (!isHistoryStatus(inv.status)) return null
                const pill = STATUS_PILL[inv.status]
                const closedAt = inv.paid_at ?? inv.generated_at
                return (
                  <tr
                    key={inv.id}
                    className="hover:bg-emerald-500/5 transition"
                  >
                    <td className="px-4 py-2.5 font-mono font-bold text-[#1B4676]">
                      {inv.invoice_number}
                    </td>
                    <td className="px-4 py-2.5 text-slate-700">
                      {inv.customer_name ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600 font-mono text-xs">
                      {inv.whpo_number ?? inv.transfer_order_no ?? '—'}
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
                      {fmtDate(closedAt)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono font-bold text-slate-800">
                      {fmtMoney(inv.total)}
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <a
                        href={billingApi.pdfUrl(inv.id, 'customer')}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs font-semibold text-[#0093D0] hover:text-[#1B4676] mr-3"
                      >
                        PDF
                      </a>
                      <a
                        href={billingApi.pdfUrl(inv.id, 'servicelog')}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs font-semibold text-slate-500 hover:text-[#1B4676]"
                        title="AP backup — service log detail"
                      >
                        Log
                      </a>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
