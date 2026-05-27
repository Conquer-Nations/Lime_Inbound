import { useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'

/**
 * Vendor portal left-rail nav. Mirrors the visual language of
 * ManagerSidebar (deep navy rail, cyan highlights, collapse-to-icon-only)
 * but uses react-router <Link> instead of tab callbacks — every entry
 * is a real route. Highlighted by URL match.
 *
 * Persists collapsed state in localStorage so the choice survives across
 * sessions / browser refreshes the same way the manager rail does.
 *
 * Items are flat (no categories) — the vendor surface is small enough
 * that grouping just adds visual noise.
 */

interface NavLink {
  /** Display label. */
  label: string
  /** Destination route. */
  to: string
  /** Icon. */
  icon: ReactNode
  /** When given, sidebar marks the item active if location.pathname +
   *  search is exactly equal. Otherwise it matches by pathname prefix. */
  exact?: boolean
  /** Optional predicate — render this link only when it returns true.
   *  Used for the auditor-only Audit link. */
  visible?: () => boolean
}

interface Props {
  links: NavLink[]
}

const COLLAPSE_KEY = 'cn-vendor-sidebar-collapsed'

export default function VendorSidebar({ links }: Props) {
  const loc = useLocation()
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem(COLLAPSE_KEY) === '1'
  })

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
  }, [collapsed])

  function isActive(link: NavLink): boolean {
    const here = loc.pathname + loc.search
    if (link.exact) return here === link.to || loc.pathname === link.to
    // Pathname-prefix match. Special case: the intake hub link (/vendor-intake)
    // should match only the bare path so it doesn't claim every
    // mode-specific URL. Treat any link with a query string as exact.
    if (link.to.includes('?')) return here === link.to
    return loc.pathname === link.to || loc.pathname.startsWith(link.to + '/')
  }

  const visibleLinks = links.filter((l) => (l.visible ? l.visible() : true))

  return (
    <aside
      aria-label="Vendor navigation"
      className={`bg-[#0B1828] text-white border-r border-white/5 flex flex-col transition-[width] duration-200 ease-out shrink-0 ${
        collapsed ? 'w-16' : 'w-60'
      }`}
    >
      <div className="flex items-center justify-between px-3 py-3 border-b border-white/5">
        {!collapsed && (
          <div className="text-[10px] uppercase tracking-[0.18em] font-bold text-white/40">
            Menu
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

      <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
        {visibleLinks.map((link) => {
          const active = isActive(link)
          return (
            <Link
              key={link.to + link.label}
              to={link.to}
              title={collapsed ? link.label : undefined}
              className={`flex items-center gap-3 px-2.5 py-2 rounded-md transition group ${
                active
                  ? 'bg-[#0093D0]/20 text-white'
                  : 'text-white/70 hover:text-white hover:bg-white/5'
              }`}
            >
              <span
                className={`shrink-0 w-5 h-5 inline-flex items-center justify-center ${
                  active ? 'text-[#0093D0]' : 'text-white/60 group-hover:text-white'
                }`}
                aria-hidden
              >
                {link.icon}
              </span>
              {!collapsed && (
                <span
                  className={`flex-1 text-left text-[13px] font-semibold ${
                    active ? 'text-white' : ''
                  }`}
                >
                  {link.label}
                </span>
              )}
              {active && !collapsed && (
                <span
                  className="w-1 h-5 bg-[#0093D0] rounded-l"
                  aria-hidden
                />
              )}
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}

// ─── Icons ─────────────────────────────────────────────────────────────

function Icon({ children, className }: { children: ReactNode; className?: string }) {
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

function ChevronLeftIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="m15 18-6-6 6-6" />
    </Icon>
  )
}

export function HomeIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2h-4a1 1 0 0 1-1-1v-6h-4v6a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2z" />
    </Icon>
  )
}

export function GridIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M3 3h18v18H3z" />
      <path d="M3 9h18" />
      <path d="M3 15h18" />
      <path d="M9 3v18" />
      <path d="M15 3v18" />
    </Icon>
  )
}

export function BoxIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M21 8v13H3V8" />
      <path d="M1 3h22v5H1z" />
      <path d="M10 12h4" />
    </Icon>
  )
}

export function FileTextIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <line x1="10" y1="9" x2="8" y2="9" />
    </Icon>
  )
}

export function CalendarIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </Icon>
  )
}

export function HistoryIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </Icon>
  )
}
