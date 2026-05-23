/**
 * Vendor shipment paste parser.
 *
 * Originally lived inline in `VendorIntakePage.tsx`. Extracted so the
 * Quick-Import modal can reuse it when pre-filling the structured form
 * (TQL → Lime path). Behavior preserved exactly — same regex, same
 * 7+ token format, same error messages.
 */
import type { VendorContainerSubmission, VendorLineItem } from '../types/api'

export interface ParsedLine {
  raw: string
  container_no: string
  whpo: string
  date: string // ISO YYYY-MM-DD
  time: string // HH:MM (24h)
  qty: number
  product_type: string
  sku: string
}

export interface ParseError {
  raw: string
  message: string
}

export interface ParseResult {
  lines: ParsedLine[]
  errors: ParseError[]
}

export interface WHPOGroup {
  whpo: string
  expected_arrival_date: string
  containers: VendorContainerSubmission[]
}

function todaysYear() {
  return new Date().getFullYear()
}

export function parseDate(token: string): string | null {
  const m = token.match(/^(\d{1,2})[/\-](\d{1,2})(?:[/\-](\d{2,4}))?$/)
  if (!m) return null
  const month = parseInt(m[1], 10)
  const day = parseInt(m[2], 10)
  let year = m[3] ? parseInt(m[3], 10) : todaysYear()
  if (year < 100) year += 2000
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function parseTime(token: string): string | null {
  const m = token.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM)?$/)
  if (!m) return null
  let hour = parseInt(m[1], 10)
  const minute = m[2] ? parseInt(m[2], 10) : 0
  const ampm = m[3]?.toLowerCase()
  if (ampm === 'pm' && hour < 12) hour += 12
  if (ampm === 'am' && hour === 12) hour = 0
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function parseShipmentLine(raw: string): ParsedLine | ParseError {
  const tokens = raw.trim().split(/\s+/)
  if (tokens.length < 7) {
    return { raw, message: 'Expected 7+ tokens: container WHPO/Load No date time qty type SKU' }
  }
  const [container_no, whpo, dateTok, timeTok, qtyTok, ...rest] = tokens
  if (!/^[A-Z]{4}\d{7}$/.test(container_no)) {
    return { raw, message: `Container "${container_no}" — expected ISO 6346 (4 letters + 7 digits)` }
  }
  if (!/^\d{8}$/.test(whpo)) {
    return { raw, message: `WHPO/Load No "${whpo}" — must be 8 digits` }
  }
  const date = parseDate(dateTok)
  if (!date) return { raw, message: `Date "${dateTok}" — expected M/D or M/D/YYYY` }
  const time = parseTime(timeTok)
  if (!time) return { raw, message: `Time "${timeTok}" — expected 8am, 8:30am, or 14:30` }
  const qty = parseInt(qtyTok, 10)
  if (!Number.isFinite(qty) || qty <= 0) {
    return { raw, message: `Qty "${qtyTok}" — must be a positive integer` }
  }
  const sku = rest[rest.length - 1]
  if (!sku || !/^[\w\-./]+$/.test(sku)) {
    return { raw, message: `SKU "${sku}" — letters/digits/dashes only` }
  }
  const product_type = rest.slice(0, -1).join(' ').trim() || ''
  if (!product_type) {
    return { raw, message: 'Missing product type between qty and SKU' }
  }
  return { raw, container_no, whpo, date, time, qty, product_type, sku }
}

export function parseShipments(text: string): ParseResult {
  const out: ParseResult = { lines: [], errors: [] }
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue
    const parsed = parseShipmentLine(trimmed)
    if ('message' in parsed) {
      out.errors.push(parsed)
    } else {
      out.lines.push(parsed)
    }
  }
  return out
}

export function groupByWHPO(lines: ParsedLine[]): WHPOGroup[] {
  const byWhpo = new Map<string, ParsedLine[]>()
  for (const line of lines) {
    if (!byWhpo.has(line.whpo)) byWhpo.set(line.whpo, [])
    byWhpo.get(line.whpo)!.push(line)
  }

  const groups: WHPOGroup[] = []
  for (const [whpo, whpoLines] of byWhpo.entries()) {
    const byContainer = new Map<string, ParsedLine[]>()
    for (const line of whpoLines) {
      if (!byContainer.has(line.container_no)) byContainer.set(line.container_no, [])
      byContainer.get(line.container_no)!.push(line)
    }
    const containers: VendorContainerSubmission[] = []
    for (const [containerNo, containerLines] of byContainer.entries()) {
      const lineItems: VendorLineItem[] = containerLines.map((l) => ({
        sku: l.sku,
        qty: l.qty,
        product_type: l.product_type || null,
      }))
      containers.push({
        container_no: containerNo,
        expected_arrival_date: containerLines[0].date,
        expected_arrival_time: containerLines[0].time + ':00',
        lines: lineItems,
      })
    }
    const earliestDate = whpoLines.map((l) => l.date).sort()[0]
    groups.push({ whpo, expected_arrival_date: earliestDate, containers })
  }
  return groups
}
