import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { api, API_BASE, ApiError } from '../api/client'
import { useVendorAuth } from '../auth/VendorAuthContext'
import VendorPortalChrome from '../components/VendorPortalChrome'

export default function VendorLoginPage() {
  const { setSession } = useVendorAuth()
  const nav = useNavigate()
  const loc = useLocation()
  // Pre-fill email when navigated from the register page's "already registered" CTA.
  const prefilledEmail =
    (loc.state as { email?: string } | null)?.email ?? ''

  const [email, setEmail] = useState(prefilledEmail)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Warm up the backend while the user types — Azure App Service free/B1 tiers
  // cold-start on the first request after idle, which adds 10-30s to login.
  // Firing this on mount means by the time Sign in is clicked, the dyno is warm.
  useEffect(() => {
    fetch(`${API_BASE}/health`, { method: 'GET', cache: 'no-store' }).catch(
      () => {
        /* warm-up only — failures are not user-visible */
      },
    )
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const r = await api.vendorLogin({
        email: email.trim().toLowerCase(),
        password,
      })
      setSession({
        token: r.access_token,
        user: r.user,
        expiresAt: Date.now() + r.expires_in * 1000,
      })
      nav('/vendor-intake', { replace: true })
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <VendorPortalChrome breadcrumbCurrent="Sign in" onBack={() => nav('/vendor-intake')}>
      <div className="max-w-md mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
        <div className="mb-8">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#0B1828] text-[11px] font-semibold tracking-[0.14em] uppercase mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
            Vendor sign-in
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#0B1828]">
            WELCOME BACK
          </h1>
          <p className="mt-3 text-base text-slate-600 leading-relaxed">
            Submit shipments and driver details for your company without
            re-entering name + email each time.
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-6 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5 flex items-start gap-2"
          >
            <span className="font-semibold">Error:</span>
            <span>{error}</span>
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-xl border border-slate-200 p-6 sm:p-8 space-y-5"
          style={{
            boxShadow:
              '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
          }}
        >
          <Field
            label="Work email"
            type="email"
            required
            value={email}
            onChange={setEmail}
            placeholder="you@yourcompany.com"
            autoComplete="email"
          />
          <Field
            label="Password"
            type="password"
            required
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />

          <button
            type="submit"
            disabled={busy}
            className="w-full bg-[#0093D0] hover:bg-[#00A8E8] disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-white font-bold rounded-full py-3.5 text-base transition flex items-center justify-center gap-2 shadow-[0_8px_24px_-4px_rgba(0,147,208,0.45)] hover:shadow-[0_8px_28px_-2px_rgba(0,147,208,0.6)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
          >
            {busy ? <span>Signing in…</span> : (
              <>
                <span>Sign in</span>
                <ArrowRightIcon className="w-4 h-4" />
              </>
            )}
          </button>

          <div className="text-xs text-slate-500 text-center space-y-1.5">
            <div>
              Don't have an account?{' '}
              <Link
                to="/vendor/register"
                className="font-medium text-[#1B4676] hover:text-[#0093D0] transition"
              >
                Register
              </Link>
            </div>
            <div>
              Forgot your password?{' '}
              <Link
                to="/vendor/forgot-password"
                state={{ email }}
                className="font-medium text-[#1B4676] hover:text-[#0093D0] transition"
              >
                Reset it
              </Link>
            </div>
          </div>
        </form>
      </div>
    </VendorPortalChrome>
  )
}

function Field({
  label,
  value,
  onChange,
  required,
  type = 'text',
  placeholder,
  autoComplete,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  required?: boolean
  type?: string
  placeholder?: string
  autoComplete?: string
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-[#0B1828] mb-1.5">
        {label} {required && <span className="text-[#0093D0]">*</span>}
      </label>
      <input
        type={type}
        className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
        autoComplete={autoComplete}
      />
    </div>
  )
}

function ArrowRightIcon({ className }: { className?: string }) {
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
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}
