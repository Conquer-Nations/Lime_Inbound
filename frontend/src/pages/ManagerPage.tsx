import { useEffect, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import FilterBar, {
  resolveFilterDates,
  useFilterFromURL,
} from '../components/FilterBar'
import { useAuth } from '../auth/AuthContext'
import { api } from '../api/client'
import AccountAdmin from '../components/AccountAdmin'
import BillingInvoices from '../components/BillingInvoices'
import BillingOrderHistory from '../components/BillingOrderHistory'
import BillingRateCard from '../components/BillingRateCard'
import DashboardTab from '../components/DashboardTab'
import InboundView from '../components/InboundView'
import ManagerSidebar from '../components/ManagerSidebar'
import type { NavCategory } from '../components/ManagerSidebar'
import ResolveExceptionModal from '../components/ResolveExceptionModal'
import MasterList from '../components/MasterList'
import ReceivingPipeline from '../components/ReceivingPipeline'
import SkuAdmin from '../components/SkuAdmin'
import TallySheetsAdmin from '../components/TallySheetsAdmin'
import WarehouseInventory from '../components/WarehouseInventory'
import WarehouseFloorPlan from '../components/WarehouseFloorPlan'
import { CalendarView } from '../components/CalendarView'
import type { DOListItem, ExceptionItem, LotMapItem } from '../types/api'
import type { OutboundOrderListRow } from '../api/client'
import BrandMark from '../components/BrandMark'

type Tab =
  | 'dashboard'
  | 'calendar'
  | 'dos'
  | 'tos'
  | 'lots'
  | 'exceptions'
  | 'inbound'
  | 'pipeline'
  | 'skus'
  | 'accounts'
  | 'tally'
  | 'master_list'
  | 'warehouse_inventory'
  | 'invoices'
  | 'order_history'
  | 'rate_card'

// ERP module structure — mirrors how Dynamics / SAP / Odoo group screens.
// Each category collapses in the sidebar. Add new top-level groups
// (Invoicing, Reports, Settings) by extending NAV_CATEGORIES and adding
// the corresponding case in the main switch below.
const NAV_CATEGORIES: NavCategory[] = [
  {
    key: 'home',
    label: 'Home',
    icon: 'home',
    items: [
      { key: 'dashboard', label: 'Dashboard' },
      { key: 'calendar', label: 'Calendar' },
    ],
  },
  {
    key: 'customer',
    label: 'Customer',
    icon: 'customer',
    items: [
      { key: 'accounts', label: 'Accounts & Brands' },
      { key: 'skus', label: 'Product Specification' },
    ],
  },
  {
    key: 'receiving',
    label: 'Receiving',
    icon: 'receiving',
    items: [
      { key: 'dos', label: 'Delivery Orders' },
      { key: 'pipeline', label: 'Receiving Pipeline' },
      { key: 'inbound', label: 'Inbound Data' },
      { key: 'tally', label: 'Tally Sheets' },
      { key: 'exceptions', label: 'Exceptions' },
    ],
  },
  {
    key: 'shipping',
    label: 'Shipping',
    icon: 'shipping',
    items: [{ key: 'tos', label: 'Transfer Orders' }],
  },
  {
    key: 'warehouse',
    label: 'Warehouse',
    icon: 'warehouse',
    items: [
      { key: 'warehouse_inventory', label: 'Inventory & Aging' },
      { key: 'lots', label: 'Floor Map' },
    ],
  },
  {
    key: 'invoicing',
    label: 'Invoicing',
    icon: 'invoicing',
    items: [
      { key: 'invoices', label: 'Invoices' },
      { key: 'order_history', label: 'Order History' },
      { key: 'rate_card', label: 'Rate Card' },
    ],
  },
  {
    key: 'reports',
    label: 'Reports',
    icon: 'reports',
    items: [{ key: 'master_list', label: 'Master List' }],
  },
]

export default function ManagerPage() {
  const { user } = useAuth()
  const [tab, setTab] = useState<Tab>('dashboard')
  // dos + tos are self-managed (URL-state + FilterBar).
  const [lots, setLots] = useState<LotMapItem[] | null>(null)
  const [exceptions, setExceptions] = useState<ExceptionItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  function refresh(t: Tab = tab) {
    setError(null)
    // DOs + TOs handled internally.
    if (t === 'lots') api.listLots().then(setLots).catch((e) => setError(String(e)))
    if (t === 'exceptions')
      api.listExceptions().then(setExceptions).catch((e) => setError(String(e)))
  }

  useEffect(() => {
    if (tab === 'lots' && lots === null) refresh('lots')
    else if (tab === 'exceptions' && exceptions === null) refresh('exceptions')
  }, [tab, lots, exceptions])

  return (
    <ManagerChrome activeTab={tab} onTabChange={(k) => setTab(k as Tab)}>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        {error && (
          <div
            role="alert"
            className="mb-5 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5 flex items-start gap-2"
          >
            <span className="font-semibold">Error:</span>
            <span>{error}</span>
          </div>
        )}

        {tab === 'dashboard' && (
          <DashboardTab
            onNavigate={(target) => {
              // 'data' was the old data explorer — fold into inbound for any back-link.
              setTab(target.tab === 'data' ? 'inbound' : target.tab)
            }}
          />
        )}
        {tab === 'calendar' && (
          <div className="space-y-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg sm:text-xl font-bold tracking-tight text-[#1B4676]">
                Container activity calendar
              </h2>
              <span className="text-[11px] uppercase tracking-[0.18em] text-slate-400 font-semibold">
                All customers
              </span>
            </div>
            <CalendarView
              fetcher={(d) => api.managerCalendar(d)}
              defaultDays={14}
              showWindowSelector
              drilldown
              emptyHint="No inbound or outbound activity in this window."
            />
          </div>
        )}
        {tab === 'dos' && <DOsTab />}
        {tab === 'tos' && <TOsTab />}
        {tab === 'lots' && <LotsTab data={lots} />}
        {tab === 'inbound' && <InboundView />}
        {tab === 'pipeline' && <ReceivingPipeline />}
        {tab === 'accounts' && <AccountAdmin />}
        {tab === 'skus' && <SkuAdmin />}
        {tab === 'tally' && <TallySheetsAdmin />}
        {tab === 'master_list' && <MasterList />}
        {tab === 'warehouse_inventory' && <WarehouseInventory />}
        {tab === 'invoices' && <BillingInvoices />}
        {tab === 'order_history' && <BillingOrderHistory />}
        {tab === 'rate_card' && <BillingRateCard />}
        {tab === 'exceptions' && (
          <ExceptionsTab
            data={exceptions}
            resolvedBy={user?.id ?? 'manager'}
            onResolved={() => {
              setExceptions(null)
              refresh('exceptions')
            }}
          />
        )}
      </main>
    </ManagerChrome>
  )
}

// ─── Chrome ────────────────────────────────────────────────────────────

function ManagerChrome({
  activeTab,
  onTabChange,
  children,
}: {
  activeTab: Tab
  onTabChange: (t: string) => void
  children: ReactNode
}) {
  const { user, signOut } = useAuth()
  const initial = user?.name?.[0]?.toUpperCase() ?? '?'

  // Active-tab label for the breadcrumb in the top bar
  let activeLabel = ''
  let activeCategoryLabel = ''
  for (const c of NAV_CATEGORIES) {
    const found = c.items.find((it) => it.key === activeTab)
    if (found) {
      activeLabel = found.label
      activeCategoryLabel = c.label
      break
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 antialiased flex">
      {/* Left rail */}
      <ManagerSidebar
        categories={NAV_CATEGORIES}
        activeTab={activeTab}
        onTabChange={onTabChange}
      />

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0">
        <header
          className="text-white"
          style={{
            background: 'linear-gradient(180deg, #0B1828 0%, #14233A 100%)',
          }}
        >
          <div className="px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <BrandMark className="h-10 text-white shrink-0" />
              <div className="leading-tight min-w-0">
                <div className="text-sm font-extrabold tracking-[0.16em] truncate">
                  CONQUER NATION
                </div>
                <div className="text-[10px] uppercase tracking-[0.22em] text-[#0093D0] flex items-center gap-1.5">
                  <span>Manager ERP</span>
                  {activeCategoryLabel && (
                    <>
                      <span className="text-white/30">›</span>
                      <span className="text-white/70">{activeCategoryLabel}</span>
                      {activeLabel && activeLabel !== activeCategoryLabel && (
                        <>
                          <span className="text-white/30">›</span>
                          <span className="text-white">{activeLabel}</span>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 sm:gap-4 shrink-0">
              <div className="hidden md:flex items-center gap-2 text-sm text-white/90">
                <span
                  className="w-8 h-8 rounded-full bg-white/10 ring-1 ring-white/20 flex items-center justify-center text-xs font-bold uppercase"
                  aria-hidden
                >
                  {initial}
                </span>
                <div className="leading-tight">
                  <div className="text-sm">{user?.name}</div>
                  <div className="text-[10.5px] uppercase tracking-wider text-white/60">
                    {user?.role}
                  </div>
                </div>
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
          <div
            className="h-px"
            style={{
              background:
                'linear-gradient(90deg, transparent, rgba(0,147,208,0.65) 30%, rgba(0,147,208,0.65) 70%, transparent)',
            }}
            aria-hidden
          />
        </header>

        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  )
}

// ─── Delivery Orders tab ───────────────────────────────────────────────

function DOsTab() {
  // Self-managed tab: fetches brands + DOs based on filter state held
  // in URL params. Survives refresh + is shareable. FilterBar handles
  // brand + date dimensions; we map them to the listDOs query.
  const [searchParams, setSearchParams] = useSearchParams()
  const [filter, setFilter] = useFilterFromURL(searchParams, setSearchParams)

  const [data, setData] = useState<DOListItem[] | null>(null)
  const [brands, setBrands] = useState<{ id: number; name: string }[]>([])
  const [err, setErr] = useState<string | null>(null)

  // Load brands once.
  useEffect(() => {
    api
      .listManagerCustomers()
      .then((cs) =>
        setBrands(cs.map((c: { id: number; name: string }) => ({ id: c.id, name: c.name }))),
      )
      .catch(() => setBrands([]))
  }, [])

  // Reload DOs whenever filter changes.
  useEffect(() => {
    setData(null)
    setErr(null)
    const { from_date, to_date } = resolveFilterDates(filter)
    api
      .listDOs({
        customer_id:
          filter.brand_id === 'all' ? undefined : (filter.brand_id as number),
        from_date,
        to_date,
        limit: 500,
      })
      .then(setData)
      .catch((e) => setErr(String(e?.detail ?? e)))
  }, [filter])

  return (
    <>
      <FilterBar brands={brands} value={filter} onChange={setFilter} />
      {err && (
        <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          <span className="font-semibold">Error:</span> {err}
        </div>
      )}
      {data === null && <LoadingHint />}
      {data !== null && data.length === 0 && (
        <EmptyHint
          title="No Delivery Orders match the filter"
          body="Widen the date range or pick a different brand to see more results."
        />
      )}
      {data !== null && data.length > 0 && (
        <DOsTabTable data={data} />
      )}
    </>
  )
}

function DOsTabTable({ data }: { data: DOListItem[] }) {
  return (
    <div
      className="bg-white rounded-xl border border-slate-200 overflow-hidden"
      style={{
        boxShadow:
          '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
      }}
    >
      <div className="bg-slate-50 border-b border-slate-200 px-4 py-2.5 flex items-center justify-between">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#0093D0]">
          Delivery Orders
        </h3>
        <span className="text-[11px] text-slate-500 font-mono">
          {data.length} {data.length === 1 ? 'row' : 'rows'}
        </span>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-white text-[10.5px] uppercase text-slate-500 border-b border-slate-200">
          <tr>
            <th className="text-left px-4 py-2 font-semibold tracking-wider">DO #</th>
            <th className="text-left px-4 py-2 font-semibold tracking-wider">WHPO/Load No</th>
            <th className="text-left px-4 py-2 font-semibold tracking-wider">Customer</th>
            <th className="text-left px-4 py-2 font-semibold tracking-wider">Status</th>
            <th className="text-right px-4 py-2 font-semibold tracking-wider">Containers</th>
            <th className="text-right px-4 py-2 font-semibold tracking-wider">Exceptions</th>
            <th className="text-left px-4 py-2 font-semibold tracking-wider">Expected</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.map((d) => (
            <tr
              key={d.do_id}
              className="hover:bg-[#0093D0]/5 transition cursor-pointer"
            >
              <td className="px-4 py-2 font-mono font-bold">
                <Link
                  to={`/manager/dos/${d.do_id}`}
                  className="text-[#1B4676] hover:text-[#0093D0]"
                >
                  {d.do_number}
                </Link>
              </td>
              <td className="px-4 py-2 font-mono text-slate-600">{d.whpo_number}</td>
              <td className="px-4 py-2 text-slate-700">{d.customer_name}</td>
              <td className="px-4 py-2">
                <StatusPill status={d.status} />
              </td>
              <td className="px-4 py-2 text-right text-slate-700 font-mono">
                {d.container_count}
              </td>
              <td className="px-4 py-2 text-right">
                {d.open_exceptions > 0 ? (
                  <span className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full text-xs font-semibold">
                    {d.open_exceptions}
                  </span>
                ) : (
                  <span className="text-slate-300">—</span>
                )}
              </td>
              <td className="px-4 py-2 text-slate-600 font-mono">
                {d.expected_arrival_date ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Outbound Transfer Orders tab ──────────────────────────────────────

function TOsTab() {
  // Self-managed tab: fetches brands + TOs based on filter state held in
  // URL params. Mirrors DOsTab pattern.
  const [searchParams, setSearchParams] = useSearchParams()
  const [filter, setFilter] = useFilterFromURL(searchParams, setSearchParams)

  const [data, setData] = useState<OutboundOrderListRow[] | null>(null)
  const [brands, setBrands] = useState<{ id: number; name: string }[]>([])
  const [err, setErr] = useState<string | null>(null)

  const { user } = useAuth()
  // Delete only for developer or manager. Operators never see the column.
  const canDelete = user?.role === 'developer' || user?.role === 'manager'
  const [pendingDelete, setPendingDelete] = useState<OutboundOrderListRow | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Load brands once.
  useEffect(() => {
    api
      .listManagerCustomers()
      .then((cs) =>
        setBrands(cs.map((c: { id: number; name: string }) => ({ id: c.id, name: c.name }))),
      )
      .catch(() => setBrands([]))
  }, [])

  function refresh() {
    setData(null)
    setErr(null)
    const { from_date, to_date } = resolveFilterDates(filter)
    api
      .listAllOutboundOrders({
        customer_id:
          filter.brand_id === 'all' ? undefined : (filter.brand_id as number),
        from_date,
        to_date,
      })
      .then(setData)
      .catch((e) => setErr(String(e?.detail ?? e)))
  }

  // Reload TOs whenever filter changes.
  useEffect(refresh, [filter])

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    setErrorMsg(null)
    try {
      await api.deleteOutboundOrder(pendingDelete.transfer_order_no)
      setPendingDelete(null)
      refresh()
    } catch (e: unknown) {
      // Surface server-side detail (e.g. invoice-attached 409) inline.
      const msg = (e as { detail?: string; message?: string })?.detail
        ?? (e as { message?: string })?.message
        ?? String(e)
      setErrorMsg(msg)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <FilterBar brands={brands} value={filter} onChange={setFilter} />
      {err && (
        <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          <span className="font-semibold">Error:</span> {err}
        </div>
      )}
      {data === null && <LoadingHint />}
      {data !== null && data.length === 0 && (
        <EmptyHint
          title="No Transfer Orders match the filter"
          body="Widen the date range or pick a different brand to see more results."
        />
      )}
      {data !== null && data.length > 0 && (
        <TOsTabTable
          data={data}
          canDelete={canDelete}
          onDeleteClick={(t) => {
            setErrorMsg(null)
            setPendingDelete(t)
          }}
        />
      )}
      {pendingDelete && (
        <DeleteTOModal
          pending={pendingDelete}
          deleting={deleting}
          errorMsg={errorMsg}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </>
  )
}

function TOsTabTable({
  data,
  canDelete,
  onDeleteClick,
}: {
  data: OutboundOrderListRow[]
  canDelete: boolean
  onDeleteClick: (t: OutboundOrderListRow) => void
}) {
  return (
    <>
      <div
        className="bg-white rounded-xl border border-slate-200 overflow-hidden"
        style={{
          boxShadow:
            '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
        }}
      >
        <div className="bg-slate-50 border-b border-slate-200 px-4 py-2.5">
          <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#1B4676]">
            Outbound Transfer Orders
          </h3>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-white text-[10.5px] uppercase text-slate-500 border-b border-slate-200">
            <tr>
              <th className="text-left px-4 py-2 font-semibold tracking-wider">TO #</th>
              <th className="text-left px-4 py-2 font-semibold tracking-wider">PO #</th>
              <th className="text-left px-4 py-2 font-semibold tracking-wider">Customer</th>
              <th className="text-left px-4 py-2 font-semibold tracking-wider">Status</th>
              <th className="text-left px-4 py-2 font-semibold tracking-wider">Priority</th>
              <th className="text-right px-4 py-2 font-semibold tracking-wider">Lines</th>
              <th className="text-right px-4 py-2 font-semibold tracking-wider">Trucks</th>
              <th className="text-right px-4 py-2 font-semibold tracking-wider">Picked</th>
              <th className="text-left px-4 py-2 font-semibold tracking-wider">Order date</th>
              {canDelete && (
                <th className="text-right px-4 py-2 font-semibold tracking-wider w-12">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.map((t) => (
              <tr
                key={t.order_id}
                className="hover:bg-[#1B4676]/5 transition"
              >
                <td className="px-4 py-2 font-mono font-bold">
                  <Link
                    to={`/manager/outbound-orders/${encodeURIComponent(t.transfer_order_no)}`}
                    className="text-[#1B4676] hover:text-[#0093D0]"
                  >
                    {t.transfer_order_no}
                  </Link>
                </td>
                <td className="px-4 py-2 font-mono text-slate-600">
                  {t.po_number ?? '—'}
                </td>
                <td className="px-4 py-2 text-slate-700">{t.customer_name}</td>
                <td className="px-4 py-2">
                  <StatusPill status={t.status} />
                </td>
                <td className="px-4 py-2 text-slate-700 capitalize">{t.priority}</td>
                <td className="px-4 py-2 text-right text-slate-700 font-mono">
                  {t.line_count}
                </td>
                <td className="px-4 py-2 text-right text-slate-700 font-mono">
                  {t.truck_count}
                </td>
                <td className="px-4 py-2 text-right text-slate-700 font-mono">
                  {t.picked_qty}
                </td>
                <td className="px-4 py-2 text-slate-600 font-mono">
                  {t.order_date ?? '—'}
                </td>
                {canDelete && (
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => onDeleteClick(t)}
                      title={`Delete ${t.transfer_order_no}`}
                      aria-label={`Delete TO ${t.transfer_order_no}`}
                      className="inline-flex items-center justify-center w-8 h-8 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 border border-transparent hover:border-red-200 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                    >
                      <svg
                        className="w-4 h-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                        <path d="M10 11v6M14 11v6" />
                        <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function DeleteTOModal({
  pending,
  deleting,
  errorMsg,
  onCancel,
  onConfirm,
}: {
  pending: OutboundOrderListRow
  deleting: boolean
  errorMsg: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4"
      onClick={() => !deleting && onCancel()}
    >
      <div
        className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold text-[#1B4676] mb-2">
          Delete Transfer Order?
        </h2>
        <p className="text-sm text-slate-600 mb-1">
          <span className="font-mono font-bold text-[#1B4676]">
            {pending.transfer_order_no}
          </span>
          <span className="text-slate-500"> · {pending.customer_name}</span>
        </p>
        <p className="text-sm text-slate-600 mt-3">
          This permanently removes the TO and every child row
          (lines, containers, scans, serials) from the database AND
          clears the matching row from the OneDrive outbound mirror.
        </p>
        <p className="text-xs text-slate-500 mt-2">
          Blocked if any invoice references this TO — void the
          invoice first if so.
        </p>
        {errorMsg && (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMsg}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-bold disabled:opacity-50"
          >
            {deleting ? 'Deleting…' : 'Delete TO'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Warehouse map tab ─────────────────────────────────────────────────

function LotsTab({ data }: { data: LotMapItem[] | null }) {
  if (data === null) return <LoadingHint />
  return <WarehouseFloorPlan lots={data} />
}

// ─── Exceptions tab ────────────────────────────────────────────────────

function ExceptionsTab({
  data,
  resolvedBy,
  onResolved,
}: {
  data: ExceptionItem[] | null
  resolvedBy: string
  onResolved: () => void
}) {
  const [resolving, setResolving] = useState<ExceptionItem | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  if (data === null) return <LoadingHint />
  if (data.length === 0)
    return (
      <div
        className="bg-white rounded-xl border border-slate-200 p-8 text-center"
        style={{
          boxShadow:
            '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
        }}
      >
        <div className="w-12 h-12 mx-auto rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-600 mb-3">
          <CheckIcon className="w-6 h-6" />
        </div>
        <h3 className="text-lg font-bold text-[#1B4676]">No open exceptions</h3>
        <p className="text-sm text-slate-500 mt-1">
          Everything submitted is clean. New unknown-SKU events will appear here.
        </p>
      </div>
    )

  return (
    <>
      <div className="space-y-3">
        {data.map((e) => {
          const skuRaw = (e.payload?.sku_raw ?? e.payload?.sku) as string | undefined
          const customer = e.payload?.customer as string | undefined
          const doNumber = e.payload?.do_number as string | undefined
          const resolvable =
            e.kind === 'unknown_sku' || e.kind === 'missing_master_data'
          return (
            <div
              key={e.exception_id}
              className="bg-white rounded-xl border border-amber-200 p-4 sm:p-5"
              style={{ boxShadow: '0 1px 2px 0 rgba(15,23,42,0.04)' }}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="bg-amber-100 text-amber-900 px-2 py-0.5 rounded-full text-[10.5px] uppercase tracking-[0.15em] font-bold">
                  {e.kind.replace(/_/g, ' ')}
                </span>
                <span className="text-xs text-slate-500 font-mono">
                  #{e.exception_id}
                </span>
                {skuRaw && (
                  <span className="font-mono text-sm text-[#1B4676] font-bold">
                    {skuRaw}
                  </span>
                )}
                {customer && (
                  <span className="text-sm text-slate-600">· {customer}</span>
                )}
                {doNumber && (
                  <span className="font-mono text-sm text-slate-500">
                    · {doNumber}
                  </span>
                )}
                <div className="flex-1" />
                <span className="text-xs text-slate-400">
                  {new Date(e.opened_at).toLocaleString()}
                </span>
              </div>
              {resolvable && (
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setResolving(e)}
                    className="inline-flex items-center gap-2 bg-[#0093D0] hover:bg-[#00A8E8] text-white text-sm font-semibold px-5 py-2 rounded-full transition shadow-[0_6px_18px_-4px_rgba(0,147,208,0.4)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
                  >
                    <span>Resolve</span>
                    <ArrowRightIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {resolving && (
        <ResolveExceptionModal
          exception={resolving}
          resolvedBy={resolvedBy}
          onClose={() => setResolving(null)}
          onResolved={(result) => {
            setResolving(null)
            setToast(
              result.do_status_changed
                ? `Resolved · DO is now ${result.do_status?.replace(/_/g, ' ')}`
                : 'Resolved'
            )
            setTimeout(() => setToast(null), 3500)
            onResolved()
          }}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 bg-emerald-700 text-white px-4 py-2 rounded-md shadow-lg z-50 flex items-center gap-2">
          <CheckIcon className="w-4 h-4" />
          <span>{toast}</span>
        </div>
      )}
    </>
  )
}

// ─── Small helpers ─────────────────────────────────────────────────────

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    ready: 'bg-emerald-100 text-emerald-800',
    pending_master_data: 'bg-amber-100 text-amber-800',
    invoiced: 'bg-[#0093D0]/15 text-[#1B4676]',
  }
  const color = map[status] ?? 'bg-slate-100 text-slate-700'
  return (
    <span
      className={`${color} px-2 py-0.5 rounded-full text-[10.5px] uppercase tracking-[0.12em] font-bold`}
    >
      {status.replace(/_/g, ' ')}
    </span>
  )
}

function LoadingHint() {
  return (
    <div className="bg-white rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-500 flex items-center gap-2">
      <span
        className="inline-block w-2 h-2 rounded-full bg-[#0093D0] animate-pulse"
        aria-hidden
      />
      <span>Loading…</span>
    </div>
  )
}

function EmptyHint({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
      <h3 className="text-lg font-bold text-[#1B4676]">{title}</h3>
      <p className="text-sm text-slate-500 mt-1">{body}</p>
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
