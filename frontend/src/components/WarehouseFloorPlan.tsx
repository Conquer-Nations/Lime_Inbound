import { Link } from 'react-router-dom'
import type { LotMapItem } from '../types/api'

interface Props {
  lots: LotMapItem[]
}

/**
 * Renders all three floors of the warehouse, each with its own visual layout:
 *   • Floor 1 — 16×18 CSS grid with the irregular shape from the WMS spec.
 *   • Floor 2 — placeholder (reserved for picking / pack-out, no lots yet).
 *   • Floor 3 — bulk-storage cards (lots without grid coords).
 *
 * Lots are color-coded by occupancy and clickable to drill into the detail page.
 */
export default function WarehouseFloorPlan({ lots }: Props) {
  const byFloor = groupBy(lots, (l) => l.floor_name)
  const floorNames = Object.keys(byFloor).sort((a, b) => a.localeCompare(b))
  return (
    <div className="space-y-6">
      {floorNames.map((name) => {
        const floorLots = byFloor[name]
        const hasGrid = floorLots.some(
          (l) => l.grid_row != null && l.grid_col != null
        )
        return (
          <FloorSection
            key={name}
            name={name}
            lots={floorLots}
            gridMode={hasGrid}
          />
        )
      })}
      <Legend />
    </div>
  )
}

function FloorSection({
  name,
  lots,
  gridMode,
}: {
  name: string
  lots: LotMapItem[]
  gridMode: boolean
}) {
  const occupancy = aggregateOccupancy(lots)
  const pct =
    occupancy.capacity === 0
      ? 0
      : Math.round((occupancy.used / occupancy.capacity) * 100)
  return (
    <section>
      <header className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0]">
            Floor
          </div>
          <h3 className="text-xl font-bold text-[#1B4676] mt-0.5">{name}</h3>
        </div>
        <div className="text-xs text-slate-500 font-mono flex items-center gap-2">
          <span className="font-bold text-[#1B4676]">
            {occupancy.used}/{occupancy.capacity}
          </span>
          <span>pallets</span>
          <span className="text-slate-300">·</span>
          <span className="font-bold text-[#1B4676]">{pct}%</span>
          <span>occupied</span>
          <span className="text-slate-300">·</span>
          <span>{lots.length} lots</span>
        </div>
      </header>

      {lots.length === 0 ? (
        <EmptyFloor />
      ) : gridMode ? (
        <Floor1Grid lots={lots} />
      ) : (
        <BulkLots lots={lots} />
      )}
    </section>
  )
}

function Floor1Grid({ lots }: { lots: LotMapItem[] }) {
  const colLetters = Array.from({ length: 16 }, (_, i) =>
    String.fromCharCode(65 + i)
  )

  return (
    <div
      className="bg-white rounded-xl border border-slate-200 p-5 overflow-x-auto"
      style={{
        boxShadow:
          '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
      }}
    >
      {/* DOCK strip at top */}
      <div className="mb-3 flex items-center justify-center bg-[#1B4676] text-white text-xs uppercase tracking-[0.22em] font-bold py-2 rounded">
        <span aria-hidden>◀</span>
        <span className="mx-3">Dock</span>
        <span aria-hidden>▶</span>
      </div>

      {/* Column letter header */}
      <div
        className="grid gap-px text-[10px] text-slate-400 text-center mb-1 font-mono"
        style={{ gridTemplateColumns: 'auto repeat(16, minmax(40px, 1fr))' }}
      >
        <div />
        {colLetters.map((c) => (
          <div key={c} className="font-bold">
            {c}
          </div>
        ))}
      </div>

      {/* The grid itself */}
      <div
        className="grid gap-px bg-slate-200 p-1 rounded"
        style={{
          gridTemplateColumns: 'auto repeat(16, minmax(40px, 1fr))',
          gridTemplateRows: 'repeat(18, 48px)',
          gridAutoFlow: 'row',
        }}
      >
        {Array.from({ length: 18 }, (_, i) => i + 1).map((row) => (
          <div
            key={`rowlabel-${row}`}
            className="flex items-center justify-end pr-1.5 text-[10px] text-slate-400 font-mono font-bold"
            style={{ gridColumn: 1, gridRow: row }}
          >
            {row}
          </div>
        ))}

        {lots.map((l) =>
          l.grid_row && l.grid_col ? <LotCell key={l.lot_id} lot={l} /> : null
        )}
      </div>
    </div>
  )
}

function LotCell({ lot }: { lot: LotMapItem }) {
  const bg = bgClass(lot)
  return (
    <Link
      to={`/manager/lots/${lot.lot_id}`}
      title={`${lot.lot_code} · ${lot.pallets_used}/${lot.pallet_capacity} pallets · ${
        lot.blocked ? 'BLOCKED' : `${Math.round(lot.occupancy_pct)}% full`
      }`}
      className={`group relative flex flex-col items-center justify-center text-[9px] font-mono font-bold text-[#1B4676] ${bg} hover:ring-2 hover:ring-[#0093D0] hover:z-10 transition rounded-sm`}
      style={{
        gridColumn: (lot.grid_col ?? 0) + 1,
        gridRow: lot.grid_row ?? 0,
      }}
    >
      <span className="text-[10px]">{lot.lot_code}</span>
      <span className="text-[8px] text-slate-600 leading-none mt-0.5">
        {lot.pallets_used}/{lot.pallet_capacity}
      </span>
      <span
        className="absolute bottom-0 left-0 right-0 h-1 bg-[#0093D0] rounded-b-sm"
        style={{
          width: `${Math.min(100, lot.occupancy_pct)}%`,
          opacity: lot.pallets_used + lot.pallets_reserved > 0 ? 0.85 : 0,
        }}
        aria-hidden
      />
    </Link>
  )
}

function BulkLots({ lots }: { lots: LotMapItem[] }) {
  return (
    <div
      className="bg-white rounded-xl border border-slate-200 p-5"
      style={{
        boxShadow:
          '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
      }}
    >
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {lots.map((l) => (
          <Link
            key={l.lot_id}
            to={`/manager/lots/${l.lot_id}`}
            className={`block rounded-lg border p-3.5 transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2 ${
              l.blocked
                ? 'bg-red-50 border-red-200 hover:border-red-400'
                : l.occupancy_pct >= 90
                ? 'bg-amber-50 border-amber-300 hover:border-amber-500'
                : 'bg-white border-slate-200 hover:border-[#0093D0]/40'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="font-mono font-bold text-sm text-[#1B4676]">
                {l.lot_code}
              </div>
              <span className="text-[10.5px] uppercase tracking-[0.12em] font-bold text-slate-500 capitalize">
                {l.type}
              </span>
            </div>
            <div className="mt-2 text-sm">
              <span className="font-bold text-[#1B4676]">{l.pallets_used}</span>
              <span className="text-slate-500">/{l.pallet_capacity} used</span>
            </div>
            <div className="text-xs text-slate-500">
              {l.pallets_reserved} reserved · {l.pallets_free} free
            </div>
            <div className="mt-2 w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
              <div
                className={`h-1.5 transition-all duration-200 ${
                  l.occupancy_pct >= 90 ? 'bg-amber-500' : 'bg-[#0093D0]'
                }`}
                style={{ width: `${Math.min(100, l.occupancy_pct)}%` }}
              />
            </div>
            {l.blocked && (
              <div className="mt-2 text-[10.5px] uppercase tracking-[0.12em] text-red-700 font-bold">
                Blocked
              </div>
            )}
          </Link>
        ))}
      </div>
    </div>
  )
}

function EmptyFloor() {
  return (
    <div className="bg-slate-50 border-2 border-dashed border-slate-300 rounded-xl p-10 text-center text-slate-400 text-sm italic">
      No lots defined on this floor.
    </div>
  )
}

function Legend() {
  return (
    <div className="flex items-center gap-4 text-xs text-slate-600 pt-3 border-t border-slate-200 flex-wrap">
      <span className="font-bold text-[#1B4676] uppercase tracking-[0.12em] text-[10.5px]">
        Legend
      </span>
      <LegendSwatch
        className="bg-white border border-slate-300"
        label="empty"
      />
      <LegendSwatch
        className="bg-[#0093D0]/10 border border-[#0093D0]/30"
        label="some pallets"
      />
      <LegendSwatch
        className="bg-amber-50 border border-amber-300"
        label="≥ 75% full"
      />
      <LegendSwatch
        className="bg-red-50 border border-red-300"
        label="full or blocked"
      />
    </div>
  )
}

function LegendSwatch({
  className,
  label,
}: {
  className: string
  label: string
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`inline-block w-3 h-3 rounded-sm ${className}`}
        aria-hidden
      />
      <span>{label}</span>
    </span>
  )
}

// ─── utils ──────────────────────────────────────────────────────────────

function bgClass(l: LotMapItem): string {
  if (l.blocked) return 'bg-red-100 border border-red-300'
  if (l.pallets_free === 0) return 'bg-red-50 border border-red-200'
  if (l.occupancy_pct >= 75) return 'bg-amber-50 border border-amber-300'
  if (l.pallets_used + l.pallets_reserved > 0)
    return 'bg-[#0093D0]/10 border border-[#0093D0]/30'
  return 'bg-white border border-slate-300'
}

function aggregateOccupancy(lots: LotMapItem[]) {
  return lots.reduce(
    (acc, l) => ({
      capacity: acc.capacity + l.pallet_capacity,
      used: acc.used + l.pallets_used,
    }),
    { capacity: 0, used: 0 }
  )
}

function groupBy<T>(items: T[], key: (t: T) => string): Record<string, T[]> {
  const acc: Record<string, T[]> = {}
  for (const item of items) {
    const k = key(item)
    ;(acc[k] ??= []).push(item)
  }
  return acc
}
