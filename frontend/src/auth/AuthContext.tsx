import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { STAFF, type Staff } from './staff'

interface AuthValue {
  user: Staff | null
  signIn: (id: string, pin: string) => { ok: true } | { ok: false; error: string }
  signOut: () => void
}

const AuthCtx = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Staff | null>(null)

  const value = useMemo<AuthValue>(
    () => ({
      user,
      signIn(id, pin) {
        const s = STAFF[id]
        if (!s) return { ok: false, error: 'Unknown user' }
        if (s.pin !== pin) return { ok: false, error: 'Wrong PIN' }
        setUser(s)
        return { ok: true }
      },
      signOut() { setUser(null) },
    }),
    [user]
  )
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}

export function useAuth(): AuthValue {
  const v = useContext(AuthCtx)
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>')
  return v
}
