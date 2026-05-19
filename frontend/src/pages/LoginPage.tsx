import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { STAFF } from '../auth/staff'
import { useAuth } from '../auth/AuthContext'

export default function LoginPage() {
  const [id, setId] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { signIn } = useAuth()
  const nav = useNavigate()

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const result = signIn(id, pin)
    if (!result.ok) {
      setError(result.error)
      return
    }
    const role = STAFF[id].role
    nav(role === 'operator' ? '/operator' : '/manager', { replace: true })
  }

  return (
    <div
      className="min-h-screen relative text-white overflow-hidden"
      style={{
        background:
          'linear-gradient(180deg, #0B1828 0%, #14233A 60%, #1B2F4D 100%)',
      }}
    >
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
      <div
        aria-hidden
        className="absolute -bottom-40 -left-40 w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{
          background:
            'radial-gradient(circle, rgba(0,147,208,0.2) 0%, transparent 60%)',
          filter: 'blur(40px)',
        }}
      />
      {/* Industrial grid */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none opacity-40"
        style={{
          backgroundImage:
            'linear-gradient(rgba(0,147,208,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(0,147,208,0.08) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
          maskImage:
            'radial-gradient(ellipse at center, black 35%, transparent 75%)',
          WebkitMaskImage:
            'radial-gradient(ellipse at center, black 35%, transparent 75%)',
        }}
      />

      <div className="relative z-10 min-h-screen flex flex-col items-center justify-center p-4">
        {/* Brand mark */}
        <div className="flex items-center gap-3 mb-8">
          <BrandMark className="w-12 h-12 text-white" />
          <div className="leading-tight">
            <div className="text-lg font-extrabold tracking-[0.16em] text-white">
              CONQUER NATION
            </div>
            <div className="text-[10px] uppercase tracking-[0.28em] text-[#0093D0] mt-1">
              Warehouse Management
            </div>
          </div>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-2xl border border-white/10 w-full max-w-md p-7 text-slate-800"
          style={{
            boxShadow:
              '0 1px 2px 0 rgba(0,0,0,0.1), 0 24px 60px -12px rgba(0,0,0,0.45)',
          }}
        >
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#0093D0]/10 border border-[#0093D0]/25 text-[#0B1828] text-[11px] font-semibold tracking-[0.14em] uppercase mb-3">
            <span className="w-1.5 h-1.5 rounded-full bg-[#0093D0]" aria-hidden />
            Staff sign-in
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[#0B1828]">
            Welcome back
          </h1>
          <p className="text-sm text-slate-500 mt-1.5 mb-5">
            Pick your name and enter your PIN.
          </p>

          <label className="block text-xs font-semibold text-[#0B1828] mb-1.5">
            Name
          </label>
          <select
            className="w-full border border-slate-300 rounded-md px-3 py-2 mb-4 text-sm text-slate-800 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition bg-white"
            value={id}
            onChange={(e) => setId(e.target.value)}
            required
          >
            <option value="">— pick your name —</option>
            {Object.values(STAFF).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.role})
              </option>
            ))}
          </select>

          <label className="block text-xs font-semibold text-[#0B1828] mb-1.5">
            PIN
          </label>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="one-time-code"
            className="w-full border border-slate-300 rounded-md px-3 py-2 mb-4 tracking-widest text-lg text-[#0B1828] placeholder:text-slate-300 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none transition"
            placeholder="••••"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            required
          />

          {error && (
            <div
              role="alert"
              className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5"
            >
              <span className="font-semibold">Error:</span> {error}
            </div>
          )}

          <button
            type="submit"
            className="w-full bg-[#0093D0] hover:bg-[#00A8E8] text-white font-bold rounded-full py-3 transition shadow-[0_8px_24px_-4px_rgba(0,147,208,0.5)] hover:shadow-[0_8px_28px_-2px_rgba(0,147,208,0.65)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
          >
            Sign in
          </button>
          <p className="text-xs text-slate-400 mt-3 text-center">
            Microsoft 365 SSO for managers will be wired in v0.2.
          </p>
        </form>

        <Link
          to="/vendor"
          className="mt-8 text-sm font-medium text-white/80 hover:text-[#0093D0] transition inline-flex items-center gap-1.5"
        >
          <span>Vendor? Submit a delivery notification</span>
          <span aria-hidden>→</span>
        </Link>

        <div className="absolute bottom-4 left-0 right-0 text-center text-xs text-white/40 tracking-wide">
          © 2026 Conquer Nation Inc. · Logistics Simplified.
        </div>
      </div>
    </div>
  )
}

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
