import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { PipelineContainer, ReceivingPipelineResponse } from '../types/api'

/**
 * Manager worklist: in-flight containers that haven't finished receiving.
 *
 * Two cohorts, surfaced as separate cards:
 *   1. Awaiting Tally — vendor submitted the container in their portal but
 *      we haven't filed a tally (POD) yet, and it isn't scanned. The
 *      operator can't start offloading until a tally is on file, so these
 *      need a manager to file one.
 *   2. Tallied · Awaiting Scan — tally filed ("received"), but the operator
 *      hasn't finished scanning the container yet.
 *
 * Both exclude containers already fully received.
 */

export default function ReceivingPipeline() {
  const [data, setData] = useState<ReceivingPipelineResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  function reload() {
    setError(null)
    api
      .getReceivingPipeline()
      .then(setData)
      .catch((e) => setError(String(e?.detail ?? e)))
  }

  useEffect(reload, [])

  const awaitingTally = data?.awaiting_tally ?? []
  const awaitingScan = data?.awaiting_scan ?? []

  return (
    <div className="space-y-6">
      <header>
        <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#1B4676] text-[11px] font-semibold tracking-[0.14em] uppercase mb-3">
          <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
          Receiving Pipeline
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#1B4676]">
          In-flight containers
        </h1>
        <p className="mt-1.5 text-sm text-slate-600 max-w-2xl">
          Containers that have arrived (or are about to) but haven't finished
          receiving. File a tally to unlock scanning, then track which tallied
          containers still need to be scanned.
        </p>
      </header>

      {error && (
        <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-3 py-2">
          <span className="font-semibold">Error:</span> {error}
        </div>
      )}

      <PipelineSection
        title="Awaiting Tally"
        subtitle="Vendor submitted these, but no tally (POD) is on file yet. File one in Tally Sheets to unlock scanning."
        accent="amber"
        loading={data === null}
        rows={awaitingTally}
        showScanStatus={false}
      />

      <PipelineSection
        title="Tallied · Awaiting Scan"
        subtitle="Tally filed (received), but the operator hasn't finished scanning yet."
        accent="sky"
        loading={data === null}
        rows={awaitingScan}
        showScanStatus
      />
    </div>
  )
}

function PipelineSection({
  title,
  subtitle,
  accent,
  loading,
  rows,
  showScanStatus,
}: {
  title: string
  subtitle: string
  accent: 'amber' | 'sky'
  loading: boolean
  rows: PipelineContainer[]
  showScanStatus: boolean
}) {
  const accentText = accent === 'amber' ? 'text-amber-700' : 'text-[#0093D0]'
  const accentDot = accent === 'amber' ? 'bg-amber-500' : 'bg-[#0093D0]'

  return (
    <section className="bg-white border border-slate-200 rounded-xl shadow-sm">
      <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-slate-200">
        <div>
          <h2 className="text-sm font-bold text-[#1B4676] flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${accentDot}`} aria-hidden />
            {title}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5 max-w-xl">{subtitle}</p>
        </div>
        <span
          className={`text-[11px] font-bold uppercase tracking-wider ${accentText} shrink-0`}
        >
          {loading ? '…' : `${rows.length} container${rows.length === 1 ? '' : 's'}`}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            <tr>
              <th className="text-left px-4 py-2">Container</th>
              <th className="text-left px-4 py-2">Customer</th>
              <th className="text-left px-4 py-2">WHPO / Load</th>
              <th className="text-left px-4 py-2">DO #</th>
              <th className="text-left px-4 py-2">Expected</th>
              <th className="text-right px-4 py-2">Units</th>
              {showScanStatus ? (
                <th className="text-left px-4 py-2">Scan</th>
              ) : (
                <th className="text-left px-4 py-2">Driver info</th>
              )}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className="text-center px-4 py-8 text-sm text-slate-400">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center px-4 py-8 text-sm text-slate-400">
                  Nothing here right now.
                </td>
              </tr>
            )}
            {rows.map((c) => (
              <tr
                key={c.container_id}
                className="border-t border-slate-100 hover:bg-[#0093D0]/5 transition"
              >
                <td className="px-4 py-2.5 font-mono font-semibold text-[#1B4676]">
                  {c.container_no}
                </td>
                <td className="px-4 py-2.5 text-slate-700">{c.customer_name}</td>
                <td className="px-4 py-2.5 font-mono text-slate-600">
                  {c.whpo_number || <span className="text-slate-300">—</span>}
                </td>
                <td className="px-4 py-2.5 font-mono text-slate-600">
                  {c.do_number || <span className="text-slate-300">—</span>}
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-500">
                  {c.expected_arrival_date ? (
                    new Date(c.expected_arrival_date).toLocaleDateString()
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-slate-700">
                  {c.total_expected}
                </td>
                {showScanStatus ? (
                  <td className="px-4 py-2.5">
                    <ScanStatusPill status={c.scan_status} />
                  </td>
                ) : (
                  <td className="px-4 py-2.5">
                    {c.driver_info_received ? (
                      <span className="text-[10.5px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border bg-emerald-100 text-emerald-800 border-emerald-200">
                        Received
                      </span>
                    ) : (
                      <span className="text-[10.5px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border bg-slate-100 text-slate-500 border-slate-200">
                        Pending
                      </span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ScanStatusPill({ status }: { status: 'none' | 'in_progress' }) {
  if (status === 'in_progress') {
    return (
      <span className="text-[10.5px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border bg-[#0093D0]/10 text-[#1B4676] border-[#0093D0]/25">
        In progress
      </span>
    )
  }
  return (
    <span className="text-[10.5px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border bg-slate-100 text-slate-500 border-slate-200">
      Not started
    </span>
  )
}
