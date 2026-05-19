import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, API_BASE, ApiError } from '../api/client'
import { useVendorAuth } from '../auth/VendorAuthContext'
import VendorPortalChrome from '../components/VendorPortalChrome'

export default function VendorRegisterPage() {
  const { setSession } = useVendorAuth()
  const nav = useNavigate()

  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [company, setCompany] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 409 → render a dedicated "already registered" callout with a Sign-in CTA.
  const [duplicateAccountMsg, setDuplicateAccountMsg] = useState<string | null>(
    null
  )

  // Warm up the backend while the user fills out the form — avoids the
  // 10-30s App Service cold-start hit when they click Create account.
  useEffect(() => {
    fetch(`${API_BASE}/health`, { method: 'GET', cache: 'no-store' }).catch(
      () => {
        /* warm-up only */
      },
    )
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setDuplicateAccountMsg(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== passwordConfirm) {
      setError('Passwords don’t match.')
      return
    }

    setBusy(true)
    try {
      const r = await api.vendorRegister({
        full_name: fullName.trim(),
        email: email.trim().toLowerCase(),
        company: company.trim(),
        password,
      })
      setSession({
        token: r.access_token,
        user: r.user,
        expiresAt: Date.now() + r.expires_in * 1000,
      })
      nav('/vendor-intake', { replace: true })
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setDuplicateAccountMsg(e.detail)
      } else {
        setError(e instanceof ApiError ? e.detail : String(e))
      }
    } finally {
      setBusy(false)
    }
  }

  function goSignIn() {
    // Pre-fill the email on the login page via location state.
    nav('/vendor/login', {
      replace: false,
      state: { email: email.trim().toLowerCase() },
    })
  }

  return (
    <VendorPortalChrome
      breadcrumbCurrent="Register"
      onBack={() => nav('/vendor-intake')}
    >
      <div className="max-w-xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
        <div className="mb-8">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#0B1828] text-[11px] font-semibold tracking-[0.14em] uppercase mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
            New account
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#0B1828]">
            CREATE VENDOR ACCOUNT
          </h1>
          <p className="mt-3 text-base text-slate-600 leading-relaxed">
            Register once. After that, sign in to submit shipments or attach
            driver details — your company, name, and email pre-fill
            automatically.
          </p>
        </div>

        {duplicateAccountMsg && (
          <div
            role="alert"
            className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-4 sm:p-5"
            style={{ boxShadow: '0 1px 2px 0 rgba(15,23,42,0.04)' }}
          >
            <div className="flex items-start gap-3">
              <div
                className="w-9 h-9 rounded-full bg-amber-100 border border-amber-300 flex items-center justify-center text-amber-700 flex-shrink-0"
                aria-hidden
              >
                <InfoIcon className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[10.5px] uppercase tracking-[0.15em] font-bold text-amber-700 mb-1">
                  Already registered
                </div>
                <p className="text-sm text-amber-900 leading-relaxed">
                  {duplicateAccountMsg}
                </p>
                <button
                  type="button"
                  onClick={goSignIn}
                  className="mt-3 inline-flex items-center gap-2 bg-[#0093D0] hover:bg-[#00A8E8] text-white font-semibold rounded-full px-5 py-2 text-sm transition shadow-[0_6px_18px_-4px_rgba(0,147,208,0.4)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
                >
                  <span>Sign in instead</span>
                  <ArrowRightIcon className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )}

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
          <SectionLabel>Company</SectionLabel>
          <TextField
            label="Vendor company"
            required
            value={company}
            onChange={setCompany}
            placeholder="Your company name"
            autoComplete="organization"
            hint="Exact legal name. If your company isn't on file with us yet, it'll be created automatically."
          />

          <SectionLabel>Your details</SectionLabel>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <TextField
              label="Full name"
              required
              value={fullName}
              onChange={setFullName}
              placeholder="Your full name"
              autoComplete="name"
            />
            <TextField
              label="Work email"
              type="email"
              required
              value={email}
              onChange={setEmail}
              placeholder="Your work email"
              autoComplete="email"
            />
          </div>

          <SectionLabel>Set a password</SectionLabel>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <TextField
              label="Password"
              type="password"
              required
              value={password}
              onChange={setPassword}
              hint="At least 8 characters."
              autoComplete="new-password"
            />
            <TextField
              label="Confirm password"
              type="password"
              required
              value={passwordConfirm}
              onChange={setPasswordConfirm}
              autoComplete="new-password"
            />
          </div>

          <button
            type="submit"
            disabled={busy}
            className="w-full bg-[#0093D0] hover:bg-[#00A8E8] disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-white font-bold rounded-full py-3.5 text-base transition flex items-center justify-center gap-2 shadow-[0_8px_24px_-4px_rgba(0,147,208,0.45)] hover:shadow-[0_8px_28px_-2px_rgba(0,147,208,0.6)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
          >
            {busy ? <span>Creating account…</span> : (
              <>
                <span>Create account</span>
                <ArrowRightIcon className="w-4 h-4" />
              </>
            )}
          </button>

          <p className="text-xs text-slate-500 text-center">
            Already have an account?{' '}
            <Link
              to="/vendor/login"
              className="font-medium text-[#1B4676] hover:text-[#0093D0] transition"
            >
              Sign in
            </Link>
          </p>
        </form>
      </div>
    </VendorPortalChrome>
  )
}

// ─── Form helpers ──────────────────────────────────────────────────────

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#0093D0] pt-1 pb-2 border-b border-slate-200">
      {children}
    </h3>
  )
}

function TextField({
  label,
  value,
  onChange,
  required,
  type = 'text',
  placeholder,
  hint,
  autoComplete,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  required?: boolean
  type?: string
  placeholder?: string
  hint?: string
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
      {hint && <p className="text-xs text-slate-500 mt-1">{hint}</p>}
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

function InfoIcon({ className }: { className?: string }) {
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
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  )
}
