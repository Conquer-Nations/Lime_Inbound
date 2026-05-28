export type Role = 'operator' | 'manager' | 'developer'

export interface Staff {
  id: string
  name: string
  role: Role
  pin: string
}

// All PINs set to 0000 for now — easier testing across roles. Replace
// per-user when Ken's ready to lock down access.
export const STAFF: Record<string, Staff> = {
  ken:      { id: 'ken',      name: 'Ken Chen',  role: 'developer', pin: '0000' },
  jerry:    { id: 'jerry',    name: 'Jerry',     role: 'manager',   pin: '0000' },
  erica:    { id: 'erica',    name: 'Erica',     role: 'manager',   pin: '0000' },
  sonia:    { id: 'sonia',    name: 'Sonia',     role: 'manager',   pin: '0000' },
  lisa:     { id: 'lisa',     name: 'Lisa',      role: 'operator',  pin: '0000' },
  andrew:   { id: 'andrew',   name: 'Andrew',    role: 'operator',  pin: '0000' },
  karen:    { id: 'karen',    name: 'Karen',     role: 'operator',  pin: '0000' },
  giovanni: { id: 'giovanni', name: 'Giovanni',  role: 'operator',  pin: '0000' },
  mike:     { id: 'mike',     name: 'Mike',      role: 'operator',  pin: '0000' },
  deon:     { id: 'deon',     name: 'Deon',      role: 'operator',  pin: '0000' },
  julio:    { id: 'julio',    name: 'Julio',     role: 'operator',  pin: '0000' },
}
