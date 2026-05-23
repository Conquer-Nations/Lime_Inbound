import { useMemo } from 'react'
import type { VendorContainerSubmission, VendorLineItem } from '../types/api'

/**
 * Structured per-container / per-line editor for vendor shipment intake.
 *
 * Used in place of the legacy paste textarea when a TQL account is submitting
 * on behalf of Lime. Other vendor + brand combinations keep the textarea.
 *
 * Owns no state — parent (`VendorIntakePage`) keeps the canonical
 * `containers` array; this component renders + edits it through callbacks.
 */

export interface StructuredWHPO {
  /** 8-digit WHPO/Load number. */
  whpo_number: string
  /** YYYY-MM-DD. Used as the order-level expected arrival date. */
  expected_arrival_date: string
  containers: VendorContainerSubmission[]
}

interface FieldError {
  /** Container index in containers[]. -1 means whpo_number / order-level. */
  container_idx: number
  /** Line index inside the container; -1 if the error is on the container itself. */
  line_idx: number
  /** Which field on that row. */
  field: 'whpo_number' | 'order_date' | 'container_no' | 'arrival_date' | 'arrival_time' | 'sku' | 'qty' | 'product_type'
  message: string
}

function validate(whpo: StructuredWHPO): FieldError[] {
  const errs: FieldError[] = []
  if (!/^\d{8}$/.test(whpo.whpo_number)) {
    errs.push({ container_idx: -1, line_idx: -1, field: 'whpo_number', message: 'WHPO must be exactly 8 digits' })
  }
  if (!whpo.expected_arrival_date) {
    errs.push({ container_idx: -1, line_idx: -1, field: 'order_date', message: 'Order date is required' })
  }
  whpo.containers.forEach((c, ci) => {
    if (!/^[A-Z]{4}\d{7}$/.test(c.container_no)) {
      errs.push({ container_idx: ci, line_idx: -1, field: 'container_no', message: 'ISO 6346: 4 letters + 7 digits' })
    }
    if (c.lines.length === 0) {
      errs.push({ container_idx: ci, line_idx: -1, field: 'sku', message: 'Add at least one line' })
    }
    c.lines.forEach((l, li) => {
      if (!l.sku.trim()) {
        errs.push({ container_idx: ci, line_idx: li, field: 'sku', message: 'SKU required' })
      }
      if (!Number.isFinite(l.qty) || l.qty <= 0) {
        errs.push({ container_idx: ci, line_idx: li, field: 'qty', message: 'Qty must be > 0' })
      }
    })
  })
  return errs
}

function emptyLine(): VendorLineItem {
  return { sku: '', qty: 1, product_type: null }
}

function emptyContainer(): VendorContainerSubmission {
  return {
    container_no: '',
    expected_arrival_date: null,
    expected_arrival_time: null,
    lines: [emptyLine()],
  }
}

export function makeEmptyWHPO(): StructuredWHPO {
  return {
    whpo_number: '',
    expected_arrival_date: '',
    containers: [emptyContainer()],
  }
}

interface Props {
  whpo: StructuredWHPO
  onChange: (next: StructuredWHPO) => void
  /** Show the "Quick import from paste" button at top-right. */
  onQuickImport?: () => void
}

export default function StructuredShipmentsEditor({ whpo, onChange, onQuickImport }: Props) {
  const errs = useMemo(() => validate(whpo), [whpo])
  const errFor = (ci: number, li: number, field: FieldError['field']) =>
    errs.find((e) => e.container_idx === ci && e.line_idx === li && e.field === field)?.message

  const updateContainer = (idx: number, patch: Partial<VendorContainerSubmission>) => {
    const next = { ...whpo, containers: whpo.containers.map((c, i) => (i === idx ? { ...c, ...patch } : c)) }
    onChange(next)
  }
  const updateLine = (ci: number, li: number, patch: Partial<VendorLineItem>) => {
    const next = {
      ...whpo,
      containers: whpo.containers.map((c, i) =>
        i === ci ? { ...c, lines: c.lines.map((l, j) => (j === li ? { ...l, ...patch } : l)) } : c
      ),
    }
    onChange(next)
  }
  const addContainer = () => onChange({ ...whpo, containers: [...whpo.containers, emptyContainer()] })
  const removeContainer = (idx: number) =>
    onChange({ ...whpo, containers: whpo.containers.filter((_, i) => i !== idx) })
  const addLine = (ci: number) =>
    updateContainer(ci, { lines: [...whpo.containers[ci].lines, emptyLine()] })
  const removeLine = (ci: number, li: number) =>
    updateContainer(ci, { lines: whpo.containers[ci].lines.filter((_, j) => j !== li) })

  const fieldClass = (hasErr: boolean) =>
    `w-full border rounded-md px-2.5 py-1.5 text-sm focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition ${
      hasErr
        ? 'border-rose-400 bg-rose-50/30 focus:border-rose-500'
        : 'border-slate-300 focus:border-[#0093D0]'
    }`

  return (
    <div className="space-y-4">
      {/* Order-level (WHPO + date) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-[#1B4676] mb-1">
            WHPO / Load # <span className="text-[#0093D0]">*</span>
          </label>
          <input
            type="text"
            inputMode="numeric"
            maxLength={8}
            placeholder="12345678"
            value={whpo.whpo_number}
            onChange={(e) => onChange({ ...whpo, whpo_number: e.target.value.replace(/\D/g, '').slice(0, 8) })}
            className={fieldClass(Boolean(errFor(-1, -1, 'whpo_number')))}
          />
          {errFor(-1, -1, 'whpo_number') && (
            <p className="text-[11px] text-rose-600 mt-0.5">{errFor(-1, -1, 'whpo_number')}</p>
          )}
        </div>
        <div>
          <label className="block text-xs font-semibold text-[#1B4676] mb-1">
            Expected arrival date <span className="text-[#0093D0]">*</span>
          </label>
          <input
            type="date"
            value={whpo.expected_arrival_date}
            onChange={(e) => onChange({ ...whpo, expected_arrival_date: e.target.value })}
            className={fieldClass(Boolean(errFor(-1, -1, 'order_date')))}
          />
        </div>
      </div>

      {/* Header row above containers */}
      <div className="flex items-center justify-between pt-1">
        <div className="text-xs font-semibold text-[#1B4676] uppercase tracking-wider">
          Containers ({whpo.containers.length})
        </div>
        {onQuickImport && (
          <button
            type="button"
            onClick={onQuickImport}
            className="text-xs font-semibold text-[#1B4676] hover:text-[#0093D0] underline-offset-2 hover:underline focus:outline-none"
          >
            Quick import from paste…
          </button>
        )}
      </div>

      {/* Container cards */}
      <div className="space-y-3">
        {whpo.containers.map((c, ci) => (
          <div
            key={ci}
            className="border border-slate-200 rounded-lg p-3 bg-slate-50/40"
          >
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 mb-3">
              <div className="sm:col-span-2">
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                  Container # <span className="text-[#0093D0]">*</span>
                </label>
                <input
                  type="text"
                  placeholder="HLXU9005263"
                  value={c.container_no}
                  onChange={(e) => updateContainer(ci, { container_no: e.target.value.toUpperCase() })}
                  maxLength={11}
                  className={`font-mono ${fieldClass(Boolean(errFor(ci, -1, 'container_no')))}`}
                />
                {errFor(ci, -1, 'container_no') && (
                  <p className="text-[11px] text-rose-600 mt-0.5">{errFor(ci, -1, 'container_no')}</p>
                )}
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">Arrival date</label>
                <input
                  type="date"
                  value={c.expected_arrival_date ? String(c.expected_arrival_date) : ''}
                  onChange={(e) => updateContainer(ci, { expected_arrival_date: e.target.value || null })}
                  className={fieldClass(false)}
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">Arrival time</label>
                <input
                  type="time"
                  value={c.expected_arrival_time ? String(c.expected_arrival_time).slice(0, 5) : ''}
                  onChange={(e) =>
                    updateContainer(ci, {
                      expected_arrival_time: e.target.value ? `${e.target.value}:00` : null,
                    })
                  }
                  className={fieldClass(false)}
                />
              </div>
            </div>

            {/* Lines table */}
            <div className="border-t border-slate-200 pt-3">
              <div className="grid grid-cols-[1.6fr_0.6fr_1.4fr_auto] gap-2 text-[11px] font-semibold text-slate-500 uppercase tracking-wider px-1 mb-1">
                <div>SKU</div>
                <div>Qty</div>
                <div>Product type</div>
                <div className="sr-only">Actions</div>
              </div>
              <div className="space-y-1.5">
                {c.lines.map((l, li) => (
                  <div key={li} className="grid grid-cols-[1.6fr_0.6fr_1.4fr_auto] gap-2 items-start">
                    <div>
                      <input
                        type="text"
                        placeholder="LPN-003743"
                        value={l.sku}
                        onChange={(e) => updateLine(ci, li, { sku: e.target.value })}
                        className={`font-mono ${fieldClass(Boolean(errFor(ci, li, 'sku')))}`}
                      />
                    </div>
                    <div>
                      <input
                        type="number"
                        min={1}
                        value={l.qty}
                        onChange={(e) => updateLine(ci, li, { qty: parseInt(e.target.value, 10) || 0 })}
                        className={fieldClass(Boolean(errFor(ci, li, 'qty')))}
                      />
                    </div>
                    <div>
                      <input
                        type="text"
                        placeholder="E-BIKE, Scooter, Solar Panel…"
                        value={l.product_type ?? ''}
                        onChange={(e) =>
                          updateLine(ci, li, { product_type: e.target.value || null })
                        }
                        className={fieldClass(false)}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeLine(ci, li)}
                      disabled={c.lines.length === 1}
                      title={c.lines.length === 1 ? 'At least one line required' : 'Remove line'}
                      className="px-2 py-1.5 text-rose-500 hover:text-rose-700 disabled:text-slate-300 disabled:cursor-not-allowed focus:outline-none"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => addLine(ci)}
                className="mt-2 text-xs font-semibold text-[#1B4676] hover:text-[#0093D0]"
              >
                + Add line
              </button>
            </div>

            {whpo.containers.length > 1 && (
              <div className="border-t border-slate-200 pt-2 mt-3 text-right">
                <button
                  type="button"
                  onClick={() => removeContainer(ci)}
                  className="text-xs font-semibold text-rose-500 hover:text-rose-700"
                >
                  Remove container
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={addContainer}
        className="w-full border-2 border-dashed border-[#0093D0]/30 rounded-lg py-3 text-sm font-semibold text-[#1B4676] hover:border-[#0093D0]/60 hover:bg-[#0093D0]/5 transition"
      >
        + Add container
      </button>

      {errs.length > 0 && (
        <div className="text-xs text-rose-600">
          {errs.length} field{errs.length === 1 ? '' : 's'} need attention before submit.
        </div>
      )}
    </div>
  )
}

/** Export the validator for the parent's submit gate. */
export function validateStructuredWHPO(whpo: StructuredWHPO): string[] {
  return validate(whpo).map((e) => e.message)
}
