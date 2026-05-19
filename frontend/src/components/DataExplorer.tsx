import { useEffect, useState } from 'react'
import { api } from '../api/client'

interface TableMeta {
  name: string
  rows: number
}

interface Props {
  initialTable?: string
}

/**
 * Read-only browser for every Postgres table the warehouse cares about.
 * Lets the manager actually see what's in the database — the same data the
 * scan / vendor / put-away flows are reading and writing.
 */
export default function DataExplorer({ initialTable }: Props = {}) {
  const [tables, setTables] = useState<TableMeta[] | null>(null)
  const [active, setActive] = useState<string | null>(initialTable ?? null)
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null)
  const [loadingRows, setLoadingRows] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.listDatabaseTables().then((t) => {
      setTables(t)
      if (t.length > 0 && !active) setActive(t[0].name)
    }).catch((e) => setError(String(e)))
  }, [])

  // Allow parent to change initialTable later (e.g. via drilldown navigation)
  useEffect(() => {
    if (initialTable && initialTable !== active) setActive(initialTable)
  }, [initialTable])

  useEffect(() => {
    if (!active) return
    setLoadingRows(true)
    setRows(null)
    setError(null)
    api.getTableRows(active)
      .then(setRows)
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingRows(false))
  }, [active])

  function refresh() {
    if (active) {
      setLoadingRows(true)
      api.getTableRows(active).then(setRows).finally(() => setLoadingRows(false))
      api.listDatabaseTables().then(setTables)
    }
  }

  if (tables === null) {
    return <div className="text-sm text-slate-500">Loading tables…</div>
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4">
      {/* Sidebar */}
      <aside className="bg-white rounded-xl shadow-md border border-slate-200 overflow-hidden">
        <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-xs font-semibold uppercase text-slate-500">
          Tables
        </div>
        <ul>
          {tables.map((t) => (
            <li key={t.name}>
              <button
                onClick={() => setActive(t.name)}
                className={`w-full text-left px-3 py-2 flex items-center justify-between text-sm transition ${
                  active === t.name
                    ? 'bg-blue-50 text-blue-700 border-l-2 border-blue-600'
                    : 'hover:bg-slate-50 border-l-2 border-transparent'
                }`}
              >
                <span className="font-mono">{t.name}</span>
                <span className="text-xs text-slate-400 tabular-nums">{t.rows}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* Main content */}
      <section className="bg-white rounded-xl shadow-md border border-slate-200 overflow-hidden">
        <header className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-sm font-semibold font-mono">{active ?? '—'}</h3>
          <div className="flex items-center gap-3 text-xs text-slate-500">
            {rows && <span>{rows.length} row{rows.length === 1 ? '' : 's'}</span>}
            <button
              onClick={refresh}
              className="text-blue-600 hover:underline"
            >
              ↻ refresh
            </button>
          </div>
        </header>

        {error && (
          <div className="m-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        {loadingRows && (
          <div className="p-5 text-sm text-slate-500">Loading rows…</div>
        )}

        {!loadingRows && rows && rows.length === 0 && (
          <div className="p-10 text-center text-sm text-slate-400 italic">
            No rows yet.
          </div>
        )}

        {!loadingRows && rows && rows.length > 0 && (
          <DataTable rows={rows} />
        )}
      </section>
    </div>
  )
}

function DataTable({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = Object.keys(rows[0])
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-[10px] uppercase text-slate-500 sticky top-0">
          <tr>
            {cols.map((c) => (
              <th
                key={c}
                className="text-left px-3 py-2 font-medium whitespace-nowrap border-b border-slate-200"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
              {cols.map((c) => (
                <td key={c} className="px-3 py-1.5 align-top whitespace-nowrap">
                  {formatValue(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function formatValue(v: unknown): React.ReactNode {
  if (v === null || v === undefined)
    return <span className="text-slate-300 italic">—</span>
  if (typeof v === 'boolean')
    return v ? <span className="text-green-700">true</span> : <span className="text-slate-400">false</span>
  if (typeof v === 'object') return <code className="text-slate-600">{JSON.stringify(v)}</code>
  const s = String(v)
  // Render timestamps a bit more readable
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    try {
      return new Date(s).toLocaleString()
    } catch {
      return s
    }
  }
  // Long strings — truncate visually but keep title for full
  if (s.length > 80)
    return (
      <span title={s} className="font-mono">
        {s.slice(0, 80)}…
      </span>
    )
  return <span className="font-mono">{s}</span>
}
