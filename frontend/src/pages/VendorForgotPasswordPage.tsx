import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { api, ApiError } from '../api/client'
import { useVendorAuth } from '../auth/VendorAuthContext'
import VendorPortalChrome from '../components/VendorPortalChrome'

export default function VendorForgotPasswordPage() {
  const { setSession } = useVendorAuth()
  const nav = useNavigate()
  const loc = useLocation()
  const prefilledEmail =
    (loc.state as { email?: string } | null)?.email ?? ''

  const [email, setEmail] = useState(prefilledEmail)
  const [newPassword, setNewPassword] = useState('')
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notFoundEmail, setNotFoundEmail] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setNotFoundEmail(null)

    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.')
      return
    }
    if (newPassword !== newPasswordConfirm) {
      setError('Passwords don’t match.')
      return
    }

    setBusy(true)
    try {
      const r = await api.vendorResetPassword({
        email: email.trim().toLowerCase(),
        new_password: newPassword,
      })
      setSession({
        token: r.access_token,
        user: r.user,
        expiresAt: Date.now() + r.expires_in * 1000,
      })
      // Auto-login → land back on the intake page like a fresh login.
      nav('/vendor-intake', { replace: true })
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setNotFoundEmail(email.trim().toLowerCase())
      } else {
        setError(e instanceof ApiError ? e.detail : String(e))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <VendorPortalChrome
      breadcrumbCurrent="Reset password"
      onBack={() => nav('/vendor-intake')}
    >
      <div className="max-w-md mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
        <div className="mb-8">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#0B1828] text-[11px] font-semibold tracking-[0.14em] uppercase mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
            Forgot password
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#0B1828]">
            RESET PASSWORD
          </h1>
          <p className="mt-3 text-base text-slate-600 leading-relaxed">
            Enter your email and pick a new password. You'll be signed in once
            the new password is set.
          </p>
        </div>

        {notFoundEmail && (
          <div
            role="alert"
            className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-4 sm:p-5"
          >
            <div className="text-[10.5px] uppercase tracking-[0.15em] font-bold text-amber-700 mb-1">
              No account found
            </div>
            <p className="text-sm text-amber-900">
              We don't have an account for{' '}
              <span className="font-mono font-semibold">{notFoundEmail}</span>.
              Double-check the spelling or{' '}
              <Link
                to="/vendor/register"
                state={{ email: notFoundEmail }}
                className="font-semibold underline"
              >
                register a new account
              </Link>
              .
            </p>
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
            label="New password"
            type="password"
            required
            value={newPassword}
            onChange={setNewPassword}
            hint="At least 8 characters."
            autoComplete="new-password"
          />
          <Field
            label="Confirm new password"
            type="password"
            required
            value={newPasswordConfirm}
            onChange={setNewPasswordConfirm}
            autoComplete="new-password"
          />

          <button
            type="submit"
            disabled={busy}
            className="w-full bg-[#0093D0] hover:bg-[#00A8E8] disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-white font-bold rounded-full py-3.5 text-base transition flex items-center justify-center gap-2 shadow-[0_8px_24px_-4px_rgba(0,147,208,0.45)] hover:shadow-[0_8px_28px_-2px_rgba(0,147,208,0.6)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
          >
            {busy ? <span>Resetting…</span> : (
              <>
                <span>Reset password &amp; sign in</span>
                <ArrowRightIcon className="w-4 h-4" />
              </>
            )}
          </button>

          <p className="text-xs text-slate-500 text-center">
            Remembered it?{' '}
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

function Field({
  label,
  value,
  onChange,
  required,
  type = 'text',
  placeholder,
  autoComplete,
  hint,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  required?: boolean
  type?: string
  placeholder?: string
  autoComplete?: string
  hint?: string
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
