import { useEffect, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useVendorAuth } from '../auth/VendorAuthContext'

/**
 * Default vendor landing. Public, unauthenticated. Two tiles: register / sign in.
 * Any vendor refresh lands here (the intake page redirects here when not signed in).
 * If a vendor is already authenticated (intra-session), skip to /vendor-intake.
 */
export default function VendorWelcomePage() {
  const { isLoggedIn } = useVendorAuth()
  const nav = useNavigate()

  useEffect(() => {
    if (isLoggedIn) nav('/vendor-intake', { replace: true })
  }, [isLoggedIn, nav])

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 antialiased relative">
      {/* ─── Dark navy hero — mirrors the conquernation.com landing ─── */}
      <section
        className="relative text-white overflow-hidden"
        style={{
          background:
            'linear-gradient(180deg, #0B1828 0%, #14233A 60%, #1B2F4D 100%)',
        }}
      >
        {/* Faint warehouse-rack grid */}
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none opacity-40"
          style={{
            backgroundImage:
              'linear-gradient(rgba(0,147,208,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(0,147,208,0.08) 1px, transparent 1px)',
            backgroundSize: '64px 64px',
            maskImage:
              'radial-gradient(ellipse at 70% 50%, black 30%, transparent 75%)',
            WebkitMaskImage:
              'radial-gradient(ellipse at 70% 50%, black 30%, transparent 75%)',
          }}
        />
        {/* Cyan glow */}
        <div
          aria-hidden
          className="absolute -top-40 -right-40 w-[600px] h-[600px] rounded-full pointer-events-none"
          style={{
            background:
              'radial-gradient(circle, rgba(0,147,208,0.35) 0%, transparent 60%)',
            filter: 'blur(40px)',
          }}
        />

        {/* Top bar */}
        <header className="relative z-20">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <BrandMark className="w-9 h-9 text-white" />
              <div className="leading-tight">
                <div className="text-base font-extrabold tracking-[0.16em]">
                  CONQUER NATION
                </div>
                <div className="text-[10px] uppercase tracking-[0.28em] text-[#0093D0]">
                  Vendor Portal
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 sm:gap-4">
              <div className="hidden sm:flex items-center gap-2 text-xs text-white/80">
                <span
                  className="inline-flex w-2 h-2 rounded-full bg-emerald-400"
                  style={{ boxShadow: '0 0 10px rgba(110,231,183,0.8)' }}
                  aria-hidden
                />
                <span>Systems operational</span>
              </div>
              <a
                href="mailto:developer@conquernation.com"
                className="inline-flex items-center gap-2 rounded-full bg-white/8 hover:bg-white/15 border border-white/15 hover:border-white/30 px-4 py-1.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B1828]"
              >
                <MailIcon className="w-4 h-4" />
                <span className="hidden sm:inline">Contact ops</span>
              </a>
            </div>
          </div>
          <div
            className="h-px"
            style={{
              background:
                'linear-gradient(90deg, transparent, rgba(0,147,208,0.65) 30%, rgba(0,147,208,0.65) 70%, transparent)',
            }}
            aria-hidden
          />
        </header>

        {/* Hero copy */}
        <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-16 sm:pt-24 pb-12 sm:pb-20">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/8 border border-white/15 text-white/90 text-[11px] font-semibold tracking-[0.18em] uppercase mb-6">
              <span
                className="w-1.5 h-1.5 rounded-full bg-[#0093D0]"
                style={{ boxShadow: '0 0 8px rgba(0,147,208,0.9)' }}
                aria-hidden
              />
              Live across America
            </div>
            <h1 className="text-4xl sm:text-5xl lg:text-[3.5rem] font-bold tracking-tight leading-[1.05]">
              Logistics that{' '}
              <span className="text-[#0093D0]">moves</span>
              <br />
              with you.
            </h1>
            <p className="mt-6 text-base sm:text-lg text-white/70 max-w-2xl leading-relaxed">
              Submit Warehouse Purchase Orders, container manifests, and driver
              details for inbound deliveries to our Los Angeles dock — under one
              clean portal. Engineered for clarity, built for speed.
            </p>

            {/* Hero CTAs */}
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link
                to="/vendor/register"
                className="inline-flex items-center gap-2 rounded-full bg-[#0093D0] hover:bg-[#00A8E8] text-white font-semibold px-7 py-3.5 text-sm transition shadow-[0_8px_24px_-4px_rgba(0,147,208,0.6)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B1828]"
              >
                <span>Create account</span>
                <ArrowRightIcon className="w-4 h-4" />
              </Link>
              <Link
                to="/vendor/login"
                className="inline-flex items-center gap-2 rounded-full bg-white/8 hover:bg-white/15 border border-white/20 hover:border-white/40 text-white font-semibold px-7 py-3.5 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B1828]"
              >
                <span>Sign in</span>
                <ArrowRightIcon className="w-4 h-4" />
              </Link>
            </div>
          </div>

          {/* Stats row */}
          <div className="mt-14 sm:mt-20 grid grid-cols-2 sm:grid-cols-4 gap-px rounded-2xl overflow-hidden border border-white/10 bg-white/[0.02]">
            <Stat value="25+" label="Years moving freight" />
            <Stat value="98.7%" label="On-time delivery" />
            <Stat value="1.2M" label="Shipments handled" />
            <Stat value="48" label="States served" />
          </div>
        </div>
      </section>

      {/* ─── Choice cards on light bg ─── */}
      <main className="relative z-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-14 pb-16 sm:pt-20 sm:pb-24">
          <div className="text-center max-w-2xl mx-auto mb-10">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#0B1828] text-[11px] font-semibold tracking-[0.14em] uppercase mb-4">
              <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
              Get started
            </div>
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#0B1828]">
              Pick how you're coming in
            </h2>
            <p className="mt-3 text-slate-600 text-base leading-relaxed">
              Brand new to the portal, or signing in for your next shipment?
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-stretch">
            <ChoiceCard
              icon={<UserPlusIcon className="w-6 h-6" />}
              eyebrow="New account"
              title="Register"
              description="First time submitting to Conquer Nation? Create your vendor account in under a minute — your company is added on the fly."
              metaLeft={{
                icon: <ClockIcon className="w-3.5 h-3.5" />,
                label: '~1 min',
              }}
              metaRight={{
                icon: <BadgeCheckIcon className="w-3.5 h-3.5" />,
                label: 'No invite needed',
              }}
              ctaLabel="Create account"
              to="/vendor/register"
            />
            <ChoiceCard
              icon={<LogInIcon className="w-6 h-6" />}
              eyebrow="Returning"
              title="Sign in"
              description="Already have an account? Sign in to submit a new shipment, attach driver details, or review documents on file."
              metaLeft={{
                icon: <ClockIcon className="w-3.5 h-3.5" />,
                label: '~10 sec',
              }}
              metaRight={{
                icon: <KeyIcon className="w-3.5 h-3.5" />,
                label: 'Email + password',
              }}
              ctaLabel="Sign in"
              to="/vendor/login"
            />
          </div>

          {/* What you can do here */}
          <section
            aria-label="What the portal does"
            className="mt-14 rounded-xl border border-slate-200 bg-white p-6 sm:p-8"
            style={{
              boxShadow:
                '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
            }}
          >
            <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0] mb-4">
              What you can do here
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
              <Feature
                icon={<PackagePlusIcon className="w-5 h-5" />}
                title="Submit shipments"
                body="Paste container + SKU lines and we'll issue a Delivery Order automatically."
              />
              <Feature
                icon={<TruckIcon className="w-5 h-5" />}
                title="Add driver details"
                body="Attach driver, plate, insurance, and documents closer to delivery — updates the dock in real time."
              />
              <Feature
                icon={<ShieldCheckIcon className="w-5 h-5" />}
                title="One account, many users"
                body="Each person at your company can have their own login. Submissions are tracked by submitter."
              />
            </div>
          </section>

          {/* Support strip */}
          <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-slate-500">
            <span className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0]">
              Need help?
            </span>
            <a
              href="mailto:developer@conquernation.com"
              className="inline-flex items-center gap-2 text-[#0B1828] font-medium hover:text-[#0093D0] transition"
            >
              <MailIcon className="w-4 h-4 text-[#0093D0]" />
              <span>developer@conquernation.com</span>
            </a>
            <a
              href="tel:+13106786768"
              className="inline-flex items-center gap-2 text-[#0B1828] font-medium hover:text-[#0093D0] transition"
            >
              <PhoneIcon className="w-4 h-4 text-[#0093D0]" />
              <span>(310) 678-6768</span>
            </a>
            <span className="text-slate-400">
              Mon–Fri, 6:00 AM – 4:00 PM PT
            </span>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer
        className="relative z-10 text-white/80"
        style={{
          background:
            'linear-gradient(180deg, #0B1828 0%, #060F1B 100%)',
        }}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <BrandMark className="w-8 h-8 text-white" />
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

// ─── Sub-components ────────────────────────────────────────────────────

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="bg-white/[0.02] backdrop-blur px-4 sm:px-6 py-5 sm:py-7">
      <div className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
        {value}
      </div>
      <div className="mt-1 text-[10px] sm:text-[10.5px] uppercase tracking-[0.18em] text-white/55 font-semibold">
        {label}
      </div>
    </div>
  )
}

function ChoiceCard({
  icon,
  eyebrow,
  title,
  description,
  metaLeft,
  metaRight,
  ctaLabel,
  to,
}: {
  icon: ReactNode
  eyebrow: string
  title: string
  description: string
  metaLeft: { icon: ReactNode; label: string }
  metaRight: { icon: ReactNode; label: string }
  ctaLabel: string
  to: string
}) {
  return (
    <Link
      to={to}
      className="group relative h-full flex flex-col text-left rounded-2xl bg-white border border-slate-200 hover:border-[#0093D0]/40 hover:-translate-y-0.5 transition-all overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
      style={{
        boxShadow:
          '0 1px 2px 0 rgba(15,23,42,0.04), 0 12px 32px -12px rgba(15,23,42,0.12)',
      }}
    >
      <div className="p-6 sm:p-8 flex-1 flex flex-col">
        <div className="flex items-start justify-between gap-3">
          <div
            className="w-12 h-12 rounded-xl bg-[#0093D0] flex items-center justify-center text-white group-hover:bg-[#0B1828] transition flex-shrink-0"
            aria-hidden
          >
            {icon}
          </div>
          <span className="text-[10.5px] uppercase tracking-[0.18em] text-slate-500 font-semibold text-right">
            {eyebrow}
          </span>
        </div>
        <h2 className="mt-6 text-2xl font-bold text-[#0B1828] leading-tight">{title}</h2>
        <p className="mt-2 text-sm text-slate-600 leading-relaxed flex-1">
          {description}
        </p>
        <div className="mt-6 flex items-center gap-3 text-xs text-slate-500 flex-wrap">
          <span className="inline-flex items-center gap-1.5">
            {metaLeft.icon}
            <span className="whitespace-nowrap">{metaLeft.label}</span>
          </span>
          <span className="w-px h-3 bg-slate-200" aria-hidden />
          <span className="inline-flex items-center gap-1.5">
            {metaRight.icon}
            <span className="whitespace-nowrap">{metaRight.label}</span>
          </span>
        </div>
      </div>
      <div
        className="px-6 sm:px-8 py-4 flex items-center justify-between transition text-white"
        style={{
          background:
            'linear-gradient(90deg, #0093D0 0%, #00A8E8 100%)',
        }}
      >
        <span className="font-bold text-sm">{ctaLabel}</span>
        <ArrowRightIcon className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
      </div>
    </Link>
  )
}

function Feature({
  icon,
  title,
  body,
}: {
  icon: ReactNode
  title: string
  body: string
}) {
  return (
    <div className="flex items-start gap-3">
      <div
        className="w-10 h-10 rounded-lg bg-[#0093D0]/10 ring-1 ring-[#0093D0]/15 flex items-center justify-center text-[#0093D0] flex-shrink-0"
        aria-hidden
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold text-[#0B1828]">{title}</div>
        <div className="text-xs text-slate-500 mt-0.5 leading-relaxed">
          {body}
        </div>
      </div>
    </div>
  )
}

// ─── Brand mark ────────────────────────────────────────────────────────

function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="3.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M30 16c-9 0-16 7-16 16s7 16 16 16" />
      <path d="M30 22c-6 0-10 5-10 10s4 10 10 10" />
      <path d="M34 16c9 0 16 7 16 16s-7 16-16 16" />
      <path d="M34 22c6 0 10 5 10 10s-4 10-10 10" />
    </svg>
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

function UserPlusIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <line x1="19" x2="19" y1="8" y2="14" />
      <line x1="22" x2="16" y1="11" y2="11" />
    </Icon>
  )
}

function LogInIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <polyline points="10 17 15 12 10 7" />
      <line x1="15" x2="3" y1="12" y2="12" />
    </Icon>
  )
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </Icon>
  )
}

function BadgeCheckIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z" />
      <path d="m9 12 2 2 4-4" />
    </Icon>
  )
}

function KeyIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4" />
      <path d="m21 2-9.6 9.6" />
      <circle cx="7.5" cy="15.5" r="5.5" />
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

function MailIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </Icon>
  )
}

function PhoneIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </Icon>
  )
}

function PackagePlusIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M16 16h6" />
      <path d="M19 13v6" />
      <path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0" />
      <path d="M3.3 7 12 12l8.7-5" />
      <path d="M12 22V12" />
    </Icon>
  )
}

function TruckIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
      <path d="M15 18H9" />
      <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
      <circle cx="17" cy="18" r="2" />
      <circle cx="7" cy="18" r="2" />
    </Icon>
  )
}

function ShieldCheckIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </Icon>
  )
}
