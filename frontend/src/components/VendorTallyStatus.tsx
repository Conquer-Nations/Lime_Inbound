import { useEffect, useState } from 'react'
import { tallyApi } from '../api/client'
import type { VendorTallyView } from '../api/client'

/**
 * Read-only tally status block on the vendor's container view.
 *
 * Fetches /vendor/container/{container_no}/tally. The endpoint is
 * vendor-scoped (JWT.company → Customer.name) so 403s on other brands.
 * Excludes billing fields by design.
 *
 * Three render states:
 *   - loading             — silent (caller already shows the container card)
 *   - tallied: false      — amber pill, "Awaiting POD"
 *   - tallied: true       — emerald pill + OCR/from-to/truck details
 *   - error               — caller's container card still renders; we go silent
 */
export default function VendorTallyStatus({ containerNo }: { containerNo: string }) {
  const [data, setData] = useState<VendorTallyView | null>(null)
  const [errored, setErrored] = useState(false)

  useEffect(() => {
    let cancelled = false
    tallyApi
      .vendorView(containerNo)
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch(() => {
        if (!cancelled) setErrored(true)
      })
    return () => {
      cancelled = true
    }
  }, [containerNo])

  if (errored || data === null) return null

  if (!data.tallied) {
    return (
      <div>
        <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0] mb-2">
          Proof of Delivery
        </div>
        <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5 flex items-center gap-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden />
          <span>
            <span className="font-semibold">Awaiting POD.</span> The warehouse will
            file this once the driver arrives. Offloading starts after.
          </span>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0] mb-2 flex items-center gap-2">
        <span>Proof of Delivery</span>
        <span className="text-[9.5px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-200">
          on file
        </span>
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
        <div className="flex items-baseline gap-2 min-w-0">
          <dt className="text-[10.5px] uppercase tracking-wider text-slate-500 font-semibold flex-shrink-0">
            Filed
          </dt>
          <dd className="text-[#1B4676] font-medium">
            {data.tallied_at ? new Date(data.tallied_at).toLocaleString() : '—'}
          </dd>
        </div>
        <div className="flex items-baseline gap-2 min-w-0">
          <dt className="text-[10.5px] uppercase tracking-wider text-slate-500 font-semibold flex-shrink-0">
            Carrier
          </dt>
          <dd className="text-[#1B4676] font-medium truncate" title={data.matched_carrier ?? ''}>
            {data.matched_carrier || '—'}
          </dd>
        </div>
        <div className="flex items-baseline gap-2 min-w-0">
          <dt className="text-[10.5px] uppercase tracking-wider text-slate-500 font-semibold flex-shrink-0">
            Truck
          </dt>
          <dd className="text-[#1B4676] font-medium truncate" title={data.matched_truck_plate ?? ''}>
            {data.matched_truck_plate || '—'}
          </dd>
        </div>
        <div className="flex items-baseline gap-2 min-w-0">
          <dt className="text-[10.5px] uppercase tracking-wider text-slate-500 font-semibold flex-shrink-0">
            From
          </dt>
          <dd className="text-[#1B4676] font-medium truncate" title={data.ocr_from_location ?? ''}>
            {data.ocr_from_location || '—'}
          </dd>
        </div>
      </dl>
    </div>
  )
}
