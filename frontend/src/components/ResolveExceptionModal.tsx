import { useState, type ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import type { ExceptionItem, ResolveExceptionResponse } from '../types/api'

interface Props {
  exception: ExceptionItem
  resolvedBy: string
  onClose: () => void
  onResolved: (result: ResolveExceptionResponse) => void
}

export default function ResolveExceptionModal({
  exception,
  resolvedBy,
  onClose,
  onResolved,
}: Props) {
  const skuRaw = (exception.payload?.sku_raw ?? exception.payload?.sku) as
    | string
    | undefined
  const customer = exception.payload?.customer as string | undefined

  const [description, setDescription] = useState('')
  const [sqftPerUnit, setSqftPerUnit] = useState<string>('')
  const [itemsPerPallet, setItemsPerPallet] = useState<string>('')
  const [palletMode, setPalletMode] = useState<'logical' | 'physical'>('logical')
  const [stackable, setStackable] = useState(false)
  const [unit] = useState('each')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const ipp = parseInt(itemsPerPallet, 10)
    if (!Number.isFinite(ipp) || ipp <= 0) {
      setError('Items per pallet must be a positive integer.')
      return
    }
    const sqft = sqftPerUnit.trim() === '' ? null : parseFloat(sqftPerUnit)
    if (sqft !== null && (!Number.isFinite(sqft) || sqft <= 0)) {
      setError('Sqft per unit must be a positive number (or blank).')
      return
    }

    setSubmitting(true)
    try {
      const isUnknown = exception.kind === 'unknown_sku'
      const result = await api.resolveException(exception.exception_id, {
        ...(isUnknown
          ? {
              sku_data: {
                description: description || null,
                sqft_per_unit: sqft,
                items_per_pallet: ipp,
                pallet_mode: palletMode,
                stackable,
                unit,
              },
            }
          : {
              patch: {
                ...(description ? { description } : {}),
                ...(sqft !== null ? { sqft_per_unit: sqft } : {}),
                items_per_pallet: ipp,
                pallet_mode: palletMode,
                stackable,
              },
            }),
        notes: notes || null,
        resolved_by: resolvedBy,
      })
      onResolved(result)
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-[#1B4676]/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="resolve-exception-title"
    >
      <div
        className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-auto"
        style={{
          boxShadow:
            '0 1px 2px 0 rgba(15,23,42,0.04), 0 24px 64px -12px rgba(15,23,42,0.4)',
        }}
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-slate-200">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0] mb-1">
                Resolve exception
              </div>
              <h2
                id="resolve-exception-title"
                className="text-xl font-bold text-[#1B4676]"
              >
                #{exception.exception_id}
              </h2>
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <span className="bg-amber-100 text-amber-900 px-2 py-0.5 rounded-full text-[10.5px] uppercase tracking-[0.15em] font-bold">
                  {exception.kind.replace(/_/g, ' ')}
                </span>
                {skuRaw && (
                  <span className="font-mono text-sm font-bold text-[#1B4676]">
                    {skuRaw}
                  </span>
                )}
                {customer && (
                  <span className="text-sm text-slate-600">· {customer}</span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-[#1B4676] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] rounded p-1"
              aria-label="Close"
            >
              <XIcon className="w-5 h-5" />
            </button>
          </div>

          <p className="text-sm text-slate-600 mt-3">
            {exception.kind === 'unknown_sku'
              ? 'This SKU has never been seen before. Fill in master data to create it.'
              : 'This SKU is in master data but missing required fields. Fill them in below.'}
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-6 pb-6 pt-4 space-y-4">
          <NumField
            label="Items per pallet"
            required
            value={itemsPerPallet}
            onChange={setItemsPerPallet}
            hint="Vendor-confirmed number. Don't guess."
          />
          <NumField
            label="Sqft per unit (optional)"
            value={sqftPerUnit}
            onChange={setSqftPerUnit}
            step="0.1"
          />
          <Field label="Description (optional)">
            <input
              type="text"
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm text-slate-800 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field label="Pallet mode">
            <select
              className="w-full border border-slate-300 rounded-md px-3 py-2 bg-white text-sm text-slate-800 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
              value={palletMode}
              onChange={(e) =>
                setPalletMode(e.target.value as 'logical' | 'physical')
              }
            >
              <option value="logical">
                Logical (we count items into pallets)
              </option>
              <option value="physical">
                Physical (product arrives on pallets)
              </option>
            </select>
          </Field>
          <Field label="Stackable">
            <label className="inline-flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={stackable}
                onChange={(e) => setStackable(e.target.checked)}
                className="rounded border-slate-300 text-[#0093D0] focus:ring-[#0093D0]/40"
              />
              <span>Can stack vertically in a lot</span>
            </label>
          </Field>
          <Field label="Resolution notes (optional)">
            <textarea
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition h-16"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Confirmed with vendor on 2026-05-15"
            />
          </Field>

          {error && (
            <div
              role="alert"
              className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5 flex items-start gap-2"
            >
              <span className="font-semibold">Error:</span>
              <span>{error}</span>
            </div>
          )}

          <div className="flex gap-2 justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-md border border-slate-300 hover:bg-slate-50 text-sm font-medium text-slate-700 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-full bg-[#0093D0] hover:bg-[#00A8E8] disabled:bg-slate-200 disabled:text-slate-400 text-white text-sm font-semibold transition shadow-[0_6px_18px_-4px_rgba(0,147,208,0.4)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
            >
              <span>{submitting ? 'Resolving…' : 'Resolve & create SKU'}</span>
              {!submitting && <CheckIcon className="w-4 h-4" />}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-[#1B4676] mb-1.5">
        {label}
      </label>
      {children}
    </div>
  )
}

function NumField({
  label,
  value,
  onChange,
  required,
  hint,
  step = '1',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  required?: boolean
  hint?: string
  step?: string
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-[#0B1828] mb-1.5">
        {label} {required && <span className="text-[#0093D0]">*</span>}
      </label>
      <input
        type="number"
        step={step}
        min="0"
        className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm text-slate-800 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
      />
      {hint && <p className="text-xs text-slate-500 mt-1">{hint}</p>}
    </div>
  )
}

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

function XIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
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
