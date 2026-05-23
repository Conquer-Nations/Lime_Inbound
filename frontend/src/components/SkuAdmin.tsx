import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../api/client'
import type { CustomerRead, SKURead, SKUAdminCreate, SKUAdminUpdate } from '../api/client'

// Vernon facility lot footprint (17 ft × 23 ft). Calculator preview
// uses this by default — backend's /skus/calculator falls back to the
// same value when no override is sent.
const DEFAULT_LOT_SQFT = 391

/**
 * SKU master admin — manager-facing CRUD for the product catalogue.
 *
 * One row per (customer, SKU). Editing or creating here is what flips a
 * pending_master_data DO to ready, because the new SKU master row is
 * auto-attached to any container_lines that referenced it raw.
 *
 * Product type (Scooters / eBikes / Gliders / Batteries / Helmets / Solar
 * Panels / Other) drives the scan-sheet IMEI + box-number logic. The
 * scan-sheet code falls back to the SKU master's product_type when the
 * vendor doesn't set it at the line level — so feeding master data here
 * is enough to enable IMEI capture on a new container type.
 */
export default function SkuAdmin() {
  const [customers, setCustomers] = useState<CustomerRead[] | null>(null)
  const [skus, setSkus] = useState<SKURead[] | null>(null)
  const [customerFilter, setCustomerFilter] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<SKURead | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  function reloadCustomers() {
    api.listManagerCustomers().then(setCustomers).catch((e) => setError(String(e?.detail || e)))
  }

  function reloadSkus() {
    api
      .listSkus({
        customer_id: customerFilter ?? undefined,
        q: search.trim() || undefined,
      })
      .then(setSkus)
      .catch((e) => setError(String(e?.detail || e)))
  }

  useEffect(reloadCustomers, [])
  useEffect(reloadSkus, [customerFilter, search])

  async function handleDelete(s: SKURead) {
    if (
      !confirm(
        `Delete SKU "${s.sku}" for ${s.customer_name}?\nThis can only succeed if no containers reference it.`,
      )
    )
      return
    try {
      await api.deleteSku(s.id)
      setToast(`Deleted ${s.sku}`)
      setTimeout(() => setToast(null), 3000)
      reloadSkus()
    } catch (e: unknown) {
      const detail = (e as { detail?: string })?.detail
      setError(String(detail ?? e))
    }
  }

  return (
    <div className="space-y-4">
      {/* Header / controls */}
      <div
        className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5"
        style={{
          boxShadow:
            '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
        }}
      >
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0]">
              Master data
            </div>
            <h2 className="text-xl font-bold text-[#1B4676] mt-0.5">
              SKU catalogue
            </h2>
          </div>
          <span className="text-xs text-slate-500 font-mono">
            {skus ? `${skus.length} SKU${skus.length === 1 ? '' : 's'}` : ''}
          </span>
          <div className="flex-1" />
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={customerFilter ?? ''}
              onChange={(e) =>
                setCustomerFilter(e.target.value ? Number(e.target.value) : null)
              }
              className="border border-slate-300 rounded-md px-3 py-1.5 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
            >
              <option value="">All customers</option>
              {customers?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Search SKU / description / type…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="border border-slate-300 rounded-md px-3 py-1.5 text-sm w-64 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => {
                setEditing(null)
                setShowForm(true)
              }}
              className="inline-flex items-center gap-1.5 bg-[#0093D0] hover:bg-[#00A8E8] text-white text-sm font-semibold rounded-full px-4 py-1.5 transition shadow-[0_6px_18px_-4px_rgba(0,147,208,0.4)]"
            >
              <span>+</span>
              <span>New SKU</span>
            </button>
          </div>
        </div>
        <p className="text-xs text-slate-500 mt-3">
          One row per (customer × SKU). Product type drives IMEI / box-number
          capture on the scan sheet: <strong>N-E-BIKE</strong> and{' '}
          <strong>Gliders</strong> require IMEI; <strong>Scooters</strong> ship
          10-per-box and get the box # column.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5"
        >
          <span className="font-semibold">Error:</span> {error}
        </div>
      )}

      {/* Table */}
      {!skus ? (
        <LoadingHint />
      ) : skus.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-slate-400 italic">
          {search || customerFilter
            ? 'No SKUs match these filters.'
            : 'No SKUs in the catalogue yet — click "New SKU" to add the first one.'}
        </div>
      ) : (
        <div
          className="bg-white rounded-xl border border-slate-200 overflow-x-auto"
          style={{
            boxShadow:
              '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
          }}
        >
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[10.5px] uppercase text-slate-500 border-b border-slate-200">
              <tr>
                <Th>Customer</Th>
                <Th>SKU</Th>
                <Th>Product type</Th>
                <Th>Description</Th>
                <Th align="right">Items / pallet</Th>
                <Th align="right">Sqft / pallet</Th>
                <Th align="right">Sqft / unit</Th>
                <Th>Pallet mode</Th>
                <Th>Unit</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {skus.map((s) => (
                <tr key={s.id} className="hover:bg-[#0093D0]/5 transition">
                  <td className="px-3 py-2 text-slate-700">{s.customer_name}</td>
                  <td className="px-3 py-2 font-mono font-bold text-[#1B4676]">
                    {s.sku}
                  </td>
                  <td className="px-3 py-2">
                    {s.product_type ? (
                      <ProductTypePill type={s.product_type} />
                    ) : (
                      <span className="text-slate-300 italic">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-600 max-w-xs truncate">
                    {s.description ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-700">
                    {s.items_per_pallet != null
                      ? formatNumber(s.items_per_pallet)
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-700">
                    {s.pallet_sqft != null
                      ? formatNumber(s.pallet_sqft)
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-700">
                    {s.sqft_per_unit != null
                      ? formatNumber(s.sqft_per_unit)
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-slate-600 capitalize">
                    {s.pallet_mode}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{s.unit}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(s)
                          setShowForm(true)
                        }}
                        className="text-xs font-bold text-[#1B4676] hover:text-[#0093D0]"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(s)}
                        className="text-xs font-bold text-red-600 hover:text-red-800"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <SkuFormModal
          customers={customers ?? []}
          initial={editing}
          onClose={() => setShowForm(false)}
          onSaved={(savedSku, action) => {
            setShowForm(false)
            setToast(
              action === 'created'
                ? `Created ${savedSku.sku} (${savedSku.customer_name})`
                : `Updated ${savedSku.sku}`,
            )
            setTimeout(() => setToast(null), 3500)
            reloadSkus()
          }}
          onCustomerCreated={() => reloadCustomers()}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 bg-emerald-700 text-white px-4 py-2 rounded-md shadow-lg z-50 flex items-center gap-2">
          <span aria-hidden>✓</span>
          <span>{toast}</span>
        </div>
      )}
    </div>
  )
}

// ─── Form modal ────────────────────────────────────────────────────────

// Product type labels are what gets persisted to SKU.product_type and
// drives the scan-sheet IMEI / box-number logic. "N-E-BIKE" still
// contains "bike" (case-insensitive) so the IMEI requirement still
// fires correctly on the operator side.
const PRODUCT_TYPE_OPTIONS = [
  'Scooters',
  'N-E-BIKE',
  'Gliders',
  'Batteries',
  'Helmets',
  'Solar Panels',
  'Other',
]

function SkuFormModal({
  customers,
  initial,
  onClose,
  onSaved,
  onCustomerCreated,
}: {
  customers: CustomerRead[]
  initial: SKURead | null
  onClose: () => void
  onSaved: (s: SKURead, action: 'created' | 'updated') => void
  onCustomerCreated: () => void
}) {
  const isEdit = initial !== null
  const [customerId, setCustomerId] = useState<number | ''>(
    initial?.customer_id ?? (customers[0]?.id ?? ''),
  )
  const [sku, setSku] = useState(initial?.sku ?? '')
  const [productType, setProductType] = useState(initial?.product_type ?? '')
  const [productTypeCustom, setProductTypeCustom] = useState(
    initial?.product_type && !PRODUCT_TYPE_OPTIONS.includes(initial.product_type)
      ? initial.product_type
      : '',
  )
  const [description, setDescription] = useState(initial?.description ?? '')
  const [sqftPerUnit, setSqftPerUnit] = useState(
    initial?.sqft_per_unit?.toString() ?? '',
  )
  const [itemsPerPallet, setItemsPerPallet] = useState(
    initial?.items_per_pallet?.toString() ?? '',
  )
  const [palletSqft, setPalletSqft] = useState(
    initial?.pallet_sqft?.toString() ?? '',
  )
  const [palletMode, setPalletMode] = useState(initial?.pallet_mode ?? 'logical')
  const [stackable, setStackable] = useState(initial?.stackable ?? false)
  const [unit, setUnit] = useState(initial?.unit ?? 'each')
  const [forecastQty, setForecastQty] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [showNewCustomer, setShowNewCustomer] = useState(false)
  const [newCustomerName, setNewCustomerName] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Live preview — pure client-side math (no API call). Same epsilon-aware
  // ceil the backend uses so the numbers match exactly.
  const preview = useMemo(() => {
    const qty = Number(forecastQty)
    const ipp = Number(itemsPerPallet)
    const psqft = Number(palletSqft)
    if (!qty || !ipp || qty <= 0 || ipp <= 0) return null
    const raw = qty / ipp
    const pallets = Math.max(0, Math.ceil(raw - 1e-3))
    const totalSqft = pallets * (psqft || 0)
    const lotsRaw = totalSqft / DEFAULT_LOT_SQFT
    const lotsNeeded = lotsRaw > 0 ? Math.ceil(lotsRaw) : 0
    return { pallets, totalSqft, lotsRaw, lotsNeeded }
  }, [forecastQty, itemsPerPallet, palletSqft])

  async function handleCreateCustomer() {
    const name = newCustomerName.trim()
    if (!name) return
    try {
      const c = await api.createCustomer({ name })
      setCustomerId(c.id)
      setShowNewCustomer(false)
      setNewCustomerName('')
      onCustomerCreated()
    } catch (e: unknown) {
      setError(String((e as { detail?: string })?.detail ?? e))
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!customerId) {
      setError('Pick a customer')
      return
    }
    if (!sku.trim()) {
      setError('SKU code is required')
      return
    }
    const resolvedProductType =
      productType === 'Other' ? productTypeCustom.trim() : productType.trim()

    setSubmitting(true)
    try {
      if (isEdit && initial) {
        const newCustomerId = Number(customerId)
        const payload: SKUAdminUpdate = {
          sku: sku.trim() !== initial.sku ? sku.trim() : undefined,
          // Only include customer_id when it actually changed — server
          // returns 409 if the SKU is already in use (container lines / lot
          // assignments) and we tried to move it.
          customer_id:
            newCustomerId && newCustomerId !== initial.customer_id
              ? newCustomerId
              : undefined,
          description: description.trim() || null,
          product_type: resolvedProductType || null,
          sqft_per_unit: sqftPerUnit ? Number(sqftPerUnit) : null,
          items_per_pallet: itemsPerPallet ? Number(itemsPerPallet) : null,
          pallet_sqft: palletSqft ? Number(palletSqft) : null,
          pallet_mode: palletMode,
          stackable,
          unit: unit.trim() || 'each',
        }
        const saved = await api.updateSku(initial.id, payload)
        onSaved(saved, 'updated')
      } else {
        const payload: SKUAdminCreate = {
          customer_id: Number(customerId),
          sku: sku.trim(),
          description: description.trim() || null,
          product_type: resolvedProductType || null,
          sqft_per_unit: sqftPerUnit ? Number(sqftPerUnit) : null,
          items_per_pallet: itemsPerPallet ? Number(itemsPerPallet) : null,
          pallet_sqft: palletSqft ? Number(palletSqft) : null,
          pallet_mode: palletMode,
          stackable,
          unit: unit.trim() || 'each',
        }
        const saved = await api.createSku(payload)
        onSaved(saved, 'created')
      }
    } catch (e: unknown) {
      setError(String((e as { detail?: string })?.detail ?? e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center overflow-y-auto p-4">
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xl w-full max-w-2xl mt-12">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0]">
              {isEdit ? 'Edit SKU' : 'New SKU'}
            </div>
            <h3 className="text-lg font-bold text-[#1B4676] mt-0.5">
              {isEdit ? initial!.sku : 'Add to catalogue'}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 text-xl px-2"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              {error}
            </div>
          )}

          {/* Customer (Brand). Editable on both create and edit; the server
              rejects re-pointing when the SKU is already referenced by
              container lines / lot assignments. */}
          <div>
            <Label>Customer *</Label>
            {!showNewCustomer ? (
              <div className="flex gap-2 items-center">
                <select
                  value={customerId}
                  onChange={(e) => setCustomerId(Number(e.target.value))}
                  className="flex-1 border border-slate-300 rounded-md px-3 py-2 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
                  required
                >
                  <option value="">— pick customer —</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setShowNewCustomer(true)}
                  className="text-xs font-bold text-[#1B4676] hover:text-[#0093D0] whitespace-nowrap"
                >
                  + New customer
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newCustomerName}
                  onChange={(e) => setNewCustomerName(e.target.value)}
                  placeholder="New customer name"
                  className="flex-1 border border-slate-300 rounded-md px-3 py-2 text-sm"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={handleCreateCustomer}
                  className="bg-[#1B4676] text-white text-sm font-bold rounded-md px-3 py-2 hover:bg-[#224E72]"
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => setShowNewCustomer(false)}
                  className="text-sm text-slate-500 hover:text-slate-700 px-2"
                >
                  Cancel
                </button>
              </div>
            )}
            {isEdit && (
              <p className="text-[11px] text-slate-500 mt-1">
                Moving a SKU to a different brand is only allowed if it isn't
                yet referenced by any container line or lot assignment.
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label>SKU code *</Label>
              <input
                type="text"
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                placeholder="e.g. LPN-003174"
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm font-mono focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
                required
              />
            </div>
            <div>
              <Label>Product type</Label>
              <select
                value={productType}
                onChange={(e) => setProductType(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
              >
                <option value="">— none —</option>
                {PRODUCT_TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              {productType === 'Other' && (
                <input
                  type="text"
                  value={productTypeCustom}
                  onChange={(e) => setProductTypeCustom(e.target.value)}
                  placeholder="Custom type"
                  className="mt-2 w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
                />
              )}
              <p className="text-[11px] text-slate-500 mt-1">
                N-E-BIKE / Gliders → IMEI required. Scooters → 10-per-box.
              </p>
            </div>
          </div>

          <div>
            <Label>Description</Label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Lime Gen3 e-Scooter"
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
            />
          </div>

          {/* Pallet specs — the values that drive the receiving space calculation */}
          <div className="rounded-md border border-slate-200 bg-slate-50/40 px-4 py-3 space-y-3">
            <div className="text-[10.5px] uppercase tracking-[0.15em] font-bold text-[#0093D0]">
              Pallet specs
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <Label>Items / pallet</Label>
                <input
                  type="number"
                  step="0.0001"
                  min="0"
                  value={itemsPerPallet}
                  onChange={(e) => setItemsPerPallet(e.target.value)}
                  placeholder="e.g. 1.9655"
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm font-mono focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  How many units fit on one pallet. Decimal OK.
                </p>
              </div>
              <div>
                <Label>Sqft / pallet</Label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={palletSqft}
                  onChange={(e) => setPalletSqft(e.target.value)}
                  placeholder="e.g. 20"
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm font-mono focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Floor footprint of one full pallet.
                </p>
              </div>
              <div>
                <Label>Sqft / unit (optional)</Label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={sqftPerUnit}
                  onChange={(e) => setSqftPerUnit(e.target.value)}
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Fallback if pallet specs are missing.
                </p>
              </div>
            </div>

            {/* Live calculator preview */}
            <div className="border-t border-slate-200 pt-3 mt-1">
              <div className="text-[10.5px] uppercase tracking-[0.15em] font-bold text-slate-500 mb-2">
                Space calculator
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex-1 min-w-[10rem]">
                  <Label>Forecast qty</Label>
                  <input
                    type="number"
                    min="0"
                    value={forecastQty}
                    onChange={(e) => setForecastQty(e.target.value)}
                    placeholder="e.g. 114"
                    className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm font-mono focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
                  />
                </div>
                <div className="flex-[2] min-w-[15rem]">
                  {preview ? (
                    <div className="rounded-md bg-white border border-[#0093D0]/30 px-3 py-2 text-sm flex items-center gap-3 flex-wrap">
                      <CalcStat
                        n={preview.pallets}
                        label={preview.pallets === 1 ? 'pallet' : 'pallets'}
                      />
                      <span className="text-slate-300">→</span>
                      <CalcStat n={preview.totalSqft} label="sqft total" />
                      <span className="text-slate-300">→</span>
                      <CalcStat
                        n={preview.lotsNeeded}
                        label={preview.lotsNeeded === 1 ? 'lot' : 'lots'}
                        sub={`(${preview.lotsRaw.toFixed(2)} raw)`}
                      />
                    </div>
                  ) : (
                    <div className="text-xs text-slate-400 italic px-3 py-2">
                      Enter a forecast qty + items/pallet + sqft/pallet to see
                      the rollup.
                    </div>
                  )}
                </div>
              </div>
              <p className="text-[11px] text-slate-500 mt-2">
                Assumes one lot = {DEFAULT_LOT_SQFT} sqft (Vernon 17 × 23).
                Rounds qty up to whole pallets (you can't put half a pallet
                on the floor).
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label>Pallet mode</Label>
              <select
                value={palletMode}
                onChange={(e) => setPalletMode(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
              >
                <option value="logical">logical</option>
                <option value="physical">physical</option>
              </select>
            </div>
            <div>
              <Label>Unit</Label>
              <input
                type="text"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="each / case / kg"
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
              />
            </div>
            <div className="flex items-end">
              <label className="inline-flex items-center gap-2 text-sm text-slate-700 px-3 py-2">
                <input
                  type="checkbox"
                  checked={stackable}
                  onChange={(e) => setStackable(e.target.checked)}
                  className="rounded border-slate-300 text-[#0093D0] focus:ring-[#0093D0]"
                />
                <span>Stackable</span>
              </label>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="text-sm font-medium text-slate-600 hover:text-slate-900 px-4 py-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="bg-[#0093D0] hover:bg-[#00A8E8] disabled:bg-slate-300 text-white text-sm font-semibold rounded-full px-5 py-2 shadow-[0_6px_18px_-4px_rgba(0,147,208,0.4)]"
            >
              {submitting
                ? 'Saving…'
                : isEdit
                  ? 'Save changes'
                  : 'Create SKU'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Bits ──────────────────────────────────────────────────────────────

function Label({ children }: { children: ReactNode }) {
  return (
    <label className="block text-[10.5px] uppercase tracking-[0.15em] font-bold text-slate-500 mb-1">
      {children}
    </label>
  )
}

function Th({
  children,
  align = 'left',
}: {
  children: ReactNode
  align?: 'left' | 'right' | 'center'
}) {
  return (
    <th
      className={`px-3 py-2 font-semibold tracking-wider text-${align} whitespace-nowrap`}
    >
      {children}
    </th>
  )
}

function ProductTypePill({ type }: { type: string }) {
  const t = type.toLowerCase()
  let color = 'bg-slate-100 text-slate-700'
  if (t.includes('bike')) color = 'bg-emerald-100 text-emerald-800'
  else if (t.includes('glider')) color = 'bg-purple-100 text-purple-800'
  else if (t.includes('scoot')) color = 'bg-[#0093D0]/15 text-[#1B4676]'
  else if (t.includes('battery')) color = 'bg-amber-100 text-amber-800'
  else if (t.includes('helmet')) color = 'bg-rose-100 text-rose-800'
  else if (t.includes('solar')) color = 'bg-yellow-100 text-yellow-800'
  return (
    <span
      className={`${color} px-2 py-0.5 rounded-full text-[10.5px] uppercase tracking-[0.12em] font-bold`}
    >
      {type}
    </span>
  )
}

function CalcStat({
  n,
  label,
  sub,
}: {
  n: number
  label: string
  sub?: string
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="font-mono font-bold text-base text-[#1B4676]">
        {n.toLocaleString(undefined, {
          maximumFractionDigits: 2,
        })}
      </span>
      <span className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
        {label}
      </span>
      {sub && <span className="text-[10px] text-slate-400">{sub}</span>}
    </span>
  )
}

function formatNumber(n: number): string {
  // Trim trailing zeros but keep 0.0001 precision (items/pallet can be very fine)
  if (Number.isInteger(n)) return n.toString()
  return Number(n.toFixed(4)).toString()
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
