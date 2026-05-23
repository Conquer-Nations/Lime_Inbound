import { useEffect, useState, type ReactNode } from 'react'

/**
 * Manager ERP left-rail navigation.
 *
 * Hierarchical menu: top-level categories collapse/expand, items inside
 * are flat selectable rows. The whole rail can collapse to icon-only mode
 * (saves screen space without losing context). Persists collapse state +
 * which categories are open in localStorage.
 *
 * Categories mirror standard ERP module groupings:
 *   Home          — dashboard, calendar
 *   Customer      — customers list, product specification (SKUs)
 *   Receiving     — DOs, inbound data, exceptions
 *   Shipping      — TOs, outbound shipments
 *   Warehouse     — floor map, lots
 *   (future)      — Invoicing, Reports, Settings
 *
 * The parent ManagerPage owns the active-tab state; this component just
 * renders the rail and emits clicks.
 */

export interface NavItem {
  key: string
  label: string
}

export interface NavCategory {
  key: string
  label: string
  icon: IconKey
  items: NavItem[]
}

export type IconKey =
  | 'home'
  | 'customer'
  | 'receiving'
  | 'shipping'
  | 'warehouse'
  | 'invoicing'
  | 'reports'
  | 'settings'

const COLLAPSE_KEY = 'cn-manager-sidebar-collapsed'
const OPEN_CATS_KEY = 'cn-manager-sidebar-open-cats'

export default function ManagerSidebar({
  categories,
  activeTab,
  onTabChange,
}: {
  categories: NavCategory[]
  activeTab: string
  onTabChange: (key: string) => void
}) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem(COLLAPSE_KEY) === '1'
  })
  const [openCats, setOpenCats] = useState<Set<string>>(() => {
    if (typeof window === 'undefined')
      return new Set(categories.map((c) => c.key))
    try {
      const raw = localStorage.getItem(OPEN_CATS_KEY)
      if (raw) return new Set(JSON.parse(raw) as string[])
    } catch {
      /* ignore */
    }
    // Default: every category open so first-time users see everything.
    return new Set(categories.map((c) => c.key))
  })

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
  }, [collapsed])

  useEffect(() => {
    localStorage.setItem(OPEN_CATS_KEY, JSON.stringify([...openCats]))
  }, [openCats])

  function toggleCategory(key: string) {
    setOpenCats((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Make sure the category containing the active tab is open after a click.
  useEffect(() => {
    for (const c of categories) {
      if (c.items.some((it) => it.key === activeTab)) {
        setOpenCats((prev) => {
          if (prev.has(c.key)) return prev
          const next = new Set(prev)
          next.add(c.key)
          return next
        })
        break
      }
    }
  }, [activeTab, categories])

  return (
    <aside
      aria-label="Manager navigation"
      className={`bg-[#0B1828] text-white border-r border-white/5 flex flex-col transition-[width] duration-200 ease-out ${
        collapsed ? 'w-16' : 'w-60'
      }`}
    >
      {/* Collapse toggle */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-white/5">
        {!collapsed && (
          <div className="text-[10px] uppercase tracking-[0.18em] font-bold text-white/40">
            Modules
          </div>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="inline-flex items-center justify-center w-7 h-7 rounded-md hover:bg-white/10 text-white/60 hover:text-white transition"
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        >
          <ChevronLeftIcon
            className={`w-4 h-4 transition-transform ${
              collapsed ? 'rotate-180' : ''
            }`}
          />
        </button>
      </div>

      {/* Categories */}
      <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-1">
        {categories.map((cat) => {
          const isOpen = openCats.has(cat.key) || collapsed
          const hasActive = cat.items.some((it) => it.key === activeTab)
          return (
            <div key={cat.key}>
              {/* Category header */}
              <button
                type="button"
                onClick={() => !collapsed && toggleCategory(cat.key)}
                className={`w-full flex items-center gap-3 px-2.5 py-2 rounded-md transition group ${
                  hasActive
                    ? 'text-white'
                    : 'text-white/70 hover:text-white hover:bg-white/5'
                }`}
                aria-expanded={isOpen}
                title={collapsed ? cat.label : undefined}
              >
                <CategoryIcon
                  k={cat.icon}
                  className={`w-5 h-5 shrink-0 ${
                    hasActive ? 'text-[#0093D0]' : 'text-white/60 group-hover:text-white'
                  }`}
                />
                {!collapsed && (
                  <>
                    <span className="flex-1 text-left text-[12px] font-bold uppercase tracking-[0.12em]">
                      {cat.label}
                    </span>
                    <ChevronDownIcon
                      className={`w-3.5 h-3.5 transition-transform text-white/40 group-hover:text-white/70 ${
                        isOpen ? '' : '-rotate-90'
                      }`}
                    />
                  </>
                )}
              </button>

              {/* Category items */}
              {isOpen && !collapsed && (
                <ul className="ml-2 my-1 border-l border-white/10 pl-3 space-y-0.5">
                  {cat.items.map((it) => {
                    const active = activeTab === it.key
                    return (
                      <li key={it.key}>
                        <button
                          type="button"
                          onClick={() => onTabChange(it.key)}
                          aria-current={active ? 'page' : undefined}
                          className={`w-full text-left text-sm px-2.5 py-1.5 rounded transition relative ${
                            active
                              ? 'bg-white/10 text-white font-semibold'
                              : 'text-white/65 hover:text-white hover:bg-white/5'
                          }`}
                        >
                          {active && (
                            <span
                              className="absolute -left-3 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-[#0093D0] rounded-r"
                              aria-hidden
                            />
                          )}
                          {it.label}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}

              {/* Collapsed-rail items: render as bare icons stacked below the category */}
              {isOpen && collapsed && (
                <ul className="space-y-0.5 mt-0.5">
                  {cat.items.map((it) => {
                    const active = activeTab === it.key
                    return (
                      <li key={it.key} className="flex justify-center">
                        <button
                          type="button"
                          onClick={() => onTabChange(it.key)}
                          aria-current={active ? 'page' : undefined}
                          title={`${cat.label} · ${it.label}`}
                          className={`w-9 h-7 rounded-md text-[10px] font-bold uppercase tracking-wider transition ${
                            active
                              ? 'bg-white/10 text-[#0093D0]'
                              : 'text-white/40 hover:text-white hover:bg-white/5'
                          }`}
                        >
                          {it.label.slice(0, 3)}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
      </nav>

      {/* Footer hint */}
      {!collapsed && (
        <div className="px-3 py-3 border-t border-white/5 text-[10px] uppercase tracking-[0.18em] text-white/30">
          Manager ERP
        </div>
      )}
    </aside>
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
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

function CategoryIcon({ k, className }: { k: IconKey; className?: string }) {
  switch (k) {
    case 'home':
      return (
        <Icon className={className}>
          <path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1V9.5Z" />
        </Icon>
      )
    case 'customer':
      return (
        <Icon className={className}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </Icon>
      )
    case 'receiving':
      return (
        <Icon className={className}>
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <path d="m3.27 6.96 8.73 5.05 8.73-5.05" />
          <line x1="12" x2="12" y1="22.08" y2="12" />
        </Icon>
      )
    case 'shipping':
      return (
        <Icon className={className}>
          <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
        </Icon>
      )
    case 'warehouse':
      return (
        <Icon className={className}>
          <path d="M22 8.35V20a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8.35a1 1 0 0 1 .54-.89l9-4.5a1 1 0 0 1 .92 0l9 4.5a1 1 0 0 1 .54.89Z" />
          <path d="M6 18h12" />
          <path d="M6 14h12" />
          <path d="M6 10h12" />
        </Icon>
      )
    case 'invoicing':
      return (
        <Icon className={className}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="9" x2="15" y1="13" y2="13" />
          <line x1="9" x2="15" y1="17" y2="17" />
        </Icon>
      )
    case 'reports':
      return (
        <Icon className={className}>
          <line x1="18" x2="18" y1="20" y2="10" />
          <line x1="12" x2="12" y1="20" y2="4" />
          <line x1="6" x2="6" y1="20" y2="14" />
        </Icon>
      )
    case 'settings':
      return (
        <Icon className={className}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </Icon>
      )
  }
}

function ChevronLeftIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <polyline points="15 18 9 12 15 6" />
    </Icon>
  )
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <polyline points="6 9 12 15 18 9" />
    </Icon>
  )
}
