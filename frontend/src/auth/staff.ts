export type Role = 'operator' | 'manager' | 'developer'

export interface Staff {
  id: string
  name: string
  role: Role
  pin: string
}

export const STAFF: Record<string, Staff> = {
  ken:      { id: 'ken',      name: 'Ken Chen',  role: 'developer', pin: '0000' },
  jerry:    { id: 'jerry',    name: 'Jerry',     role: 'manager',   pin: '1111' },
  erica:    { id: 'erica',    name: 'Erica',     role: 'manager',   pin: '2222' },
  sonia:    { id: 'sonia',    name: 'Sonia',     role: 'manager',   pin: '3333' },
  lisa:     { id: 'lisa',     name: 'Lisa',      role: 'operator',  pin: '1234' },
  andrew:   { id: 'andrew',   name: 'Andrew',    role: 'operator',  pin: '1234' },
  karen:    { id: 'karen',    name: 'Karen',     role: 'operator',  pin: '1234' },
  giovanni: { id: 'giovanni', name: 'Giovanni',  role: 'operator',  pin: '1234' },
  mike:     { id: 'mike',     name: 'Mike',      role: 'operator',  pin: '1234' },
  deon:     { id: 'deon',     name: 'Deon',      role: 'operator',  pin: '1234' },
}
