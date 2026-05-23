import type { ContainerStatusTimeline } from '../api/client'

/**
 * Horizontal stepper showing per-container progress.
 * Completed steps glow navy/cyan; pending steps are slate.
 * The current step gets a pulsing ring.
 *
 * `accent` lets the caller pick the brand colour:
 *   - 'cyan'  → inbound (matches the vendor portal's cyan top bar)
 *   - 'navy'  → outbound (matches the navy "OUTBOUND" tile)
 */
export function StatusTimeline({
  container,
  accent = 'cyan',
}: {
  container: ContainerStatusTimeline
  accent?: 'cyan' | 'navy'
}) {
  const activeColor = accent === 'navy' ? '#1B4676' : '#0093D0'
  const pendingColor = '#cbd5e1' // slate-300

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="font-mono font-bold text-[#1B4676]">
          {container.container_no}
        </div>
        <span
          className="text-[10.5px] uppercase tracking-wider font-bold px-2 py-0.5 rounded"
          style={{ background: `${activeColor}1A`, color: activeColor }}
        >
          {labelForStage(container.timeline, container.current_stage)}
        </span>
      </div>

      <ol className="relative flex items-start justify-between gap-2">
        {container.timeline.map((ev, idx) => {
          const done = ev.at != null
          const isCurrent = ev.stage === container.current_stage
          const next = container.timeline[idx + 1]
          const connectorDone = done && next && next.at != null
          return (
            <li
              key={ev.stage}
              className="relative flex-1 flex flex-col items-center text-center"
            >
              {/* Connector line to the next step */}
              {idx < container.timeline.length - 1 && (
                <span
                  aria-hidden
                  className="absolute top-3 left-1/2 right-0 -translate-x-0 h-0.5 -z-0"
                  style={{
                    width: '100%',
                    transform: 'translateX(50%)',
                    background: connectorDone ? activeColor : pendingColor,
                  }}
                />
              )}
              <span
                className="relative z-10 w-6 h-6 rounded-full grid place-items-center text-[10px] font-bold text-white"
                style={{
                  background: done ? activeColor : pendingColor,
                  boxShadow: isCurrent
                    ? `0 0 0 4px ${activeColor}33`
                    : 'none',
                }}
              >
                {done ? '✓' : idx + 1}
              </span>
              <div className="mt-1.5 text-[10.5px] font-semibold text-slate-700 leading-tight max-w-[8rem]">
                {ev.label}
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">
                {ev.at ? formatStamp(ev.at) : '—'}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function labelForStage(events: { stage: string; label: string }[], stage: string) {
  const found = events.find((e) => e.stage === stage)
  return found ? found.label : stage
}

function formatStamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'short',
      timeStyle: 'short',
    })
  } catch {
    return iso
  }
}
