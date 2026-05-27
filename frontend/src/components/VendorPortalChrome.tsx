import { type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useVendorAuth } from '../auth/VendorAuthContext'
import { isAuditor } from '../pages/AuditPage'
import BrandMark from './BrandMark'
import VendorSidebar, {
  BoxIcon,
  FileTextIcon,
  GridIcon,
  HistoryIcon,
  HomeIcon,
} from './VendorSidebar'

interface Props {
  breadcrumbCurrent: string
  onBack?: () => void
  children: ReactNode
}

export default function VendorPortalChrome({
  breadcrumbCurrent,
  onBack,
  children,
}: Props) {
  const { user, isLoggedIn, signOut } = useVendorAuth()
  const nav = useNavigate()
  const initial = user?.full_name?.[0]?.toUpperCase() ?? '?'

  function handleSignOut() {
    signOut()
    nav('/vendor', { replace: true })
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 antialiased relative overflow-hidden">
      {/* Faint industrial grid */}
      <div
        aria-hidden
        className="fixed inset-0 pointer-events-none"
        style={{
          backgroundImage:
            'linear-gradient(rgba(11,24,40,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(11,24,40,0.04) 1px, transparent 1px)',
          backgroundSize: '56px 56px',
          maskImage: 'radial-gradient(ellipse at top, black 35%, transparent 80%)',
          WebkitMaskImage:
            'radial-gradient(ellipse at top, black 35%, transparent 80%)',
        }}
      />
      <div
        aria-hidden
        className="fixed inset-x-0 top-0 h-80 pointer-events-none"
        style={{
          background:
            'linear-gradient(to bottom, rgba(0,147,208,0.07), transparent)',
        }}
      />

      {/* Top bar — deep navy with cyan accent, matching conquernation.com */}
      <header
        className="relative z-20 text-white"
        style={{
          background:
            'linear-gradient(180deg, #0B1828 0%, #14233A 100%)',
        }}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <Link to="/vendor-intake" className="flex items-center gap-3 group">
            <BrandMark className="h-12 text-white" />
            <div className="leading-tight">
              <div className="text-base font-extrabold tracking-[0.16em]">
                CONQUER NATION
              </div>
              <div className="text-[10px] uppercase tracking-[0.28em] text-[#0093D0]">
                Vendor Portal
              </div>
            </div>
          </Link>

          <div className="flex items-center gap-3 sm:gap-4">
            <div className="hidden sm:flex items-center gap-2 text-xs text-white/80">
              <span
                className="inline-flex w-2 h-2 rounded-full bg-emerald-400"
                style={{ boxShadow: '0 0 10px rgba(110,231,183,0.8)' }}
                aria-hidden
              />
              <span>Systems operational</span>
            </div>

            {isLoggedIn && user ? (
              <>
                <div className="hidden md:flex items-center gap-2 text-sm text-white/95">
                  <span
                    className="w-8 h-8 rounded-full bg-white/10 ring-1 ring-white/20 flex items-center justify-center text-xs font-bold uppercase"
                    aria-hidden
                  >
                    {initial}
                  </span>
                  <div className="leading-tight">
                    <div className="text-sm font-semibold">{user.full_name}</div>
                    <div className="text-[10.5px] uppercase tracking-wider text-white/60">
                      {user.company}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="inline-flex items-center gap-2 rounded-full bg-white/8 hover:bg-white/15 border border-white/15 hover:border-white/30 px-4 py-1.5 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B1828]"
                  title="Sign out of your vendor account"
                >
                  <LogOutIcon className="w-4 h-4" />
                  <span>Sign out</span>
                </button>
              </>
            ) : (
              <>
                <Link
                  to="/vendor/login"
                  className="hidden sm:inline-flex items-center gap-2 rounded-full bg-white/8 hover:bg-white/15 border border-white/15 hover:border-white/30 px-4 py-1.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B1828]"
                >
                  <span>Sign in</span>
                </Link>
                <Link
                  to="/vendor/register"
                  className="inline-flex items-center gap-2 rounded-full bg-[#0093D0] hover:bg-[#00A8E8] text-white font-semibold px-4 py-1.5 text-sm transition shadow-[0_4px_14px_-2px_rgba(0,147,208,0.6)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B1828]"
                >
                  <span>Register</span>
                  <ArrowRightIcon className="w-3.5 h-3.5" />
                </Link>
              </>
            )}
          </div>
        </div>
        {/* Thin cyan accent line — replaces the prior yellow strip */}
        <div
          className="h-px"
          style={{
            background:
              'linear-gradient(90deg, transparent, rgba(0,147,208,0.65) 30%, rgba(0,147,208,0.65) 70%, transparent)',
          }}
          aria-hidden
        />
      </header>

      {/* Breadcrumb */}
      <nav
        aria-label="Breadcrumb"
        className="relative z-10 border-b border-slate-200 bg-white/80 backdrop-blur"
      >
        <ol className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center gap-2 text-sm text-slate-500">
          <li className="flex items-center gap-2">
            {onBack ? (
              <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center gap-2 hover:text-[#0B1828] transition group focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] rounded-sm"
              >
                <LayoutDashboardIcon className="w-4 h-4 text-[#0093D0]" />
                <span className="group-hover:underline">Vendor Portal</span>
              </button>
            ) : (
              <span className="inline-flex items-center gap-2">
                <LayoutDashboardIcon className="w-4 h-4 text-[#0093D0]" />
                <span>Vendor Portal</span>
              </span>
            )}
          </li>
          <li aria-hidden>
            <ChevronRightIcon className="w-4 h-4 text-slate-300" />
          </li>
          <li aria-current="page" className="text-[#0B1828] font-semibold">
            {breadcrumbCurrent}
          </li>
        </ol>
      </nav>

      {isLoggedIn ? (
        <div className="relative z-10 flex min-h-[calc(100vh-13rem)]">
          <VendorSidebar
            links={[
              {
                label: 'Home',
                to: '/vendor-intake',
                icon: <HomeIcon className="w-5 h-5" />,
              },
              {
                label: 'Container inventory',
                to: '/vendor-intake?mode=out_inventory',
                icon: <BoxIcon className="w-5 h-5" />,
              },
              {
                label: 'Master inventory',
                to: '/vendor/master-list',
                icon: <GridIcon className="w-5 h-5" />,
              },
              {
                label: 'Invoices',
                to: '/vendor/invoices',
                icon: <FileTextIcon className="w-5 h-5" />,
              },
              {
                label: 'Audit log',
                to: '/vendor/audit',
                icon: <HistoryIcon className="w-5 h-5" />,
                visible: () => isAuditor(user?.email),
              },
            ]}
          />
          <main className="flex-1 min-w-0">{children}</main>
        </div>
      ) : (
        <main className="relative z-10">{children}</main>
      )}

      <footer
        className="relative z-10 text-white/80 mt-12"
        style={{
          background:
            'linear-gradient(180deg, #0B1828 0%, #060F1B 100%)',
        }}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <BrandMark className="h-10 text-white" />
            <div className="leading-tight">
              <div className="text-sm font-bold tracking-[0.16em] text-white">
                CONQUER NATION
              </div>
              <div className="text-[10px] uppercase tracking-[0.28em] text-[#0093D0] mt-0.5">
                Logistics Simplified
              </div>
            </div>
          </div>
          <div className="flex flex-col sm:items-end gap-2 text-xs text-white/60">
            <div>© 2026 Conquer Nation Inc. · 2651 E. 12th St., Los Angeles, CA 90023</div>
            <a
              href="https://www.conquernation.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-white/80 hover:text-[#0093D0] transition font-medium tracking-wide"
            >
              conquernation.com →
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}

// ─── Brand mark ────────────────────────────────────────────────────────
//
// Approximation of the Conquer Nation double-loop "CN" mark in white
// strokes. Drop-in replacement for an actual logo file — swap with an
// <img src="/conquer-nation-logo.svg" /> once you've added the SVG to
// /public.

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

function LayoutDashboardIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect width="7" height="9" x="3" y="3" rx="1" />
      <rect width="7" height="5" x="14" y="3" rx="1" />
      <rect width="7" height="9" x="14" y="12" rx="1" />
      <rect width="7" height="5" x="3" y="16" rx="1" />
    </Icon>
  )
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="m9 18 6-6-6-6" />
    </Icon>
  )
}

function LogOutIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" x2="9" y1="12" y2="12" />
    </Icon>
  )
}

function ArrowRightIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </Icon>
  )
}
