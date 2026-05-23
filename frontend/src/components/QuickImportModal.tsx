import { useMemo, useState, useEffect, useRef } from 'react'
import { parseShipments, groupByWHPO } from '../lib/parseShipments'
import type { StructuredWHPO } from './StructuredShipmentsEditor'

/**
 * Quick-import modal: vendor pastes the legacy 7-token shipment block,
 * we parse it and pre-fill the structured form. User can review/edit
 * after the modal closes — paste-as-shortcut, structured form remains
 * authoritative.
 *
 * If the paste contains multiple WHPOs, the modal asks the user to pick
 * one (the structured form represents a single WHPO submission).
 */

interface Props {
  open: boolean
  onClose: () => void
  /** Called with the chosen WHPO converted to the editor's shape. */
  onApply: (whpo: StructuredWHPO) => void
}

export default function QuickImportModal({ open, onClose, onApply }: Props) {
  const [text, setText] = useState('')
  const [pickedWhpo, setPickedWhpo] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  const parsed = useMemo(() => parseShipments(text), [text])
  const groups = useMemo(() => groupByWHPO(parsed.lines), [parsed.lines])

  // Auto-select the only WHPO when there's exactly one.
  useEffect(() => {
    if (groups.length === 1) setPickedWhpo(groups[0].whpo)
    else if (groups.length === 0) setPickedWhpo(null)
  }, [groups])

  // Close on Escape.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const apply = () => {
    const group = groups.find((g) => g.whpo === pickedWhpo) ?? groups[0]
    if (!group) return
    onApply({
      whpo_number: group.whpo,
      expected_arrival_date: group.expected_arrival_date,
      containers: group.containers,
    })
    setText('')
    setPickedWhpo(null)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4"
      onClick={(e) => {
        if (e.target === dialogRef.current?.parentElement) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
      >
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-[#1B4676]">Quick import from paste</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Parses the format the team already uses; you can review and edit the
              result in the structured form.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 text-2xl leading-none px-2"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto flex-1 space-y-3">
          <label className="block text-xs font-semibold text-[#1B4676]">
            Paste shipment lines:{' '}
            <code className="bg-slate-100 text-[#1B4676] px-1.5 py-0.5 rounded font-mono text-[10.5px]">
              CONTAINER WHPO DATE TIME QTY TYPE SKU
            </code>
          </label>
          <textarea
            className="w-full border border-slate-300 rounded-md px-3 py-2 font-mono text-sm h-44 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
            placeholder={`HPCU4492096   36648912   5/15   8am   320   Scooters       LPN-003743
ABCU1234567   36648912   5/15   9am   500   Bikes          LPN-001234`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            autoFocus
          />

          {parsed.errors.length > 0 && (
            <div className="border border-rose-200 bg-rose-50 rounded-md p-3 text-xs space-y-1">
              <div className="font-semibold text-rose-800">
                {parsed.errors.length} unparseable line{parsed.errors.length === 1 ? '' : 's'}:
              </div>
              {parsed.errors.slice(0, 5).map((e, i) => (
                <div key={i} className="text-rose-700 font-mono">
                  <span className="opacity-60">{e.raw.slice(0, 50)}</span> — {e.message}
                </div>
              ))}
              {parsed.errors.length > 5 && (
                <div className="text-rose-700">… and {parsed.errors.length - 5} more.</div>
              )}
            </div>
          )}

          {groups.length > 1 && (
            <div>
              <label className="block text-xs font-semibold text-[#1B4676] mb-1">
                Multiple WHPOs found — pick which one to import:
              </label>
              <div className="space-y-1.5">
                {groups.map((g) => (
                  <label
                    key={g.whpo}
                    className="flex items-center gap-3 border border-slate-200 rounded-md px-3 py-2 cursor-pointer hover:bg-slate-50"
                  >
                    <input
                      type="radio"
                      name="whpo"
                      checked={pickedWhpo === g.whpo}
                      onChange={() => setPickedWhpo(g.whpo)}
                    />
                    <span className="font-mono text-sm">{g.whpo}</span>
                    <span className="text-xs text-slate-500">
                      {g.containers.length} container{g.containers.length === 1 ? '' : 's'} ·{' '}
                      {g.containers.reduce((s, c) => s + c.lines.length, 0)} lines · arrival{' '}
                      {g.expected_arrival_date}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {groups.length === 1 && (
            <div className="text-xs text-slate-600 border border-emerald-200 bg-emerald-50 rounded-md px-3 py-2">
              <span className="font-semibold text-emerald-700">Ready to import:</span>{' '}
              WHPO {groups[0].whpo} · {groups[0].containers.length} container
              {groups[0].containers.length === 1 ? '' : 's'} ·{' '}
              {groups[0].containers.reduce((s, c) => s + c.lines.length, 0)} lines
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 flex items-center justify-end gap-2 bg-slate-50">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-semibold text-slate-600 hover:text-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={!pickedWhpo || groups.length === 0}
            className="px-4 py-2 text-sm font-bold rounded-full bg-[#0093D0] text-white hover:bg-[#00A8E8] disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed transition shadow-[0_4px_14px_-4px_rgba(0,147,208,0.45)]"
          >
            Import & review
          </button>
        </div>
      </div>
    </div>
  )
}
