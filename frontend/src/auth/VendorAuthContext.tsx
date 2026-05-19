import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export interface VendorUser {
  email: string
  full_name: string
  company: string
}

interface VendorSession {
  token: string
  user: VendorUser
  expiresAt: number // epoch ms
}

interface VendorAuthValue {
  session: VendorSession | null
  user: VendorUser | null
  token: string | null
  isLoggedIn: boolean
  setSession: (s: VendorSession) => void
  signOut: () => void
}

const Ctx = createContext<VendorAuthValue | null>(null)

// Module-level token cache. Mirrors React state so non-React callers (the API
// client) can attach the bearer header. Cleared on any sign-out or page reload
// (since this module re-loads on hard refresh).
let _currentToken: string | null = null

export function VendorAuthProvider({ children }: { children: ReactNode }) {
  // Intentionally NOT seeded from any storage — vendor sessions are intra-tab
  // only. Refreshing the page logs the vendor out (matches the requirement
  // that every refresh forces re-auth).
  const [session, setSessionState] = useState<VendorSession | null>(null)

  const setSession = useCallback((s: VendorSession) => {
    _currentToken = s.token
    setSessionState(s)
  }, [])

  const signOut = useCallback(() => {
    _currentToken = null
    setSessionState(null)
  }, [])

  const value = useMemo<VendorAuthValue>(
    () => ({
      session,
      user: session?.user ?? null,
      token: session?.token ?? null,
      isLoggedIn: Boolean(session && session.expiresAt > Date.now()),
      setSession,
      signOut,
    }),
    [session, setSession, signOut]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useVendorAuth(): VendorAuthValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useVendorAuth must be used inside <VendorAuthProvider>')
  return v
}

/** Read token directly. Use from non-React contexts (e.g. the API client). */
export function readVendorToken(): string | null {
  return _currentToken
}
