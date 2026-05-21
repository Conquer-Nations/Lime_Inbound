import { useEffect, useRef, useState, type ReactNode } from 'react'
import { OCR_ENDPOINT } from '../api/client'
import Spinner from './Spinner'

type Status = 'idle' | 'reading' | 'done' | 'error'

interface Candidate {
  value: string
  check_digit_valid: boolean
  source: 'ocr' | 'ocr_check_digit_corrected'
}

interface Props {
  onAccept: (containerNo: string) => void
}

/** ISO 6346 BIC code regex: 4 uppercase letters + 7 digits. */
const BIC_REGEX = /[A-Z]{4}\d{7}/g

/** Compute the ISO 6346 check digit for the first 10 chars (4 letters + 6 digits).
 *  Returns the expected last digit, or null if the input is malformed. */
function computeCheckDigit(first10: string): number | null {
  if (!/^[A-Z]{4}\d{6}$/.test(first10)) return null
  const letterVal: Record<string, number> = {}
  const skip = new Set([11, 22, 33])
  let v = 10
  for (let c = 65; c <= 90; c++) {
    while (skip.has(v)) v++
    letterVal[String.fromCharCode(c)] = v
    v++
  }
  let sum = 0
  for (let i = 0; i < 10; i++) {
    const ch = first10[i]
    const numeric = i < 4 ? letterVal[ch] : parseInt(ch, 10)
    sum += numeric * Math.pow(2, i)
  }
  return (sum % 11) % 10
}

/** Common letter↔digit OCR confusions. Position-aware: positions 0-3 should be
 *  letters, positions 4-10 should be digits. We "snap" each char to its expected
 *  class to recover from minor OCR errors. */
const LETTER_TO_DIGIT: Record<string, string> = {
  O: '0', Q: '0', D: '0',
  I: '1', L: '1',
  Z: '2',
  E: '3',
  A: '4',
  S: '5',
  G: '6',
  T: '7',
  B: '8',
  P: '9',
}
const DIGIT_TO_LETTER: Record<string, string> = {
  '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '6': 'G', '8': 'B',
}

function snapToBicClass(s: string): string | null {
  if (s.length < 10) return null
  let out = ''
  for (let i = 0; i < 11 && i < s.length; i++) {
    const ch = s[i]
    if (i < 4) {
      // Position should be a letter
      if (/[A-Z]/.test(ch)) out += ch
      else if (DIGIT_TO_LETTER[ch]) out += DIGIT_TO_LETTER[ch]
      else return null
    } else {
      // Position should be a digit
      if (/\d/.test(ch)) out += ch
      else if (LETTER_TO_DIGIT[ch]) out += LETTER_TO_DIGIT[ch]
      else return null
    }
  }
  return out
}

function buildCandidates(rawText: string): Candidate[] {
  // Look at every line independently, in addition to the whole-text flattened
  // form, so the BIC line wins over noise like the "45G1" type code below it.
  const lines = rawText.split(/[\n\r]+/).map((l) => l.toUpperCase().replace(/[^A-Z0-9]/g, ''))
  const flattened = rawText.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const haystacks = [...lines, flattened].filter((h) => h.length >= 10)

  const seen = new Set<string>()
  const out: Candidate[] = []

  function addCandidate(value: string, source: Candidate['source']) {
    if (value.length !== 11 || seen.has(value)) return
    seen.add(value)
    const expected = computeCheckDigit(value.slice(0, 10))
    const actual = parseInt(value.slice(10, 11), 10)
    out.push({
      value,
      check_digit_valid: expected !== null && expected === actual,
      source,
    })
  }

  for (const hay of haystacks) {
    // 1. Direct regex match (perfect OCR)
    const direct = hay.match(BIC_REGEX) || []
    for (const m of direct) addCandidate(m, 'ocr')

    // 2. Position-aware snap: try every 11-char window
    for (let i = 0; i <= hay.length - 11; i++) {
      const window = hay.slice(i, i + 11)
      const snapped = snapToBicClass(window)
      if (snapped) addCandidate(snapped, 'ocr_check_digit_corrected')
    }

    // 3. 4-letter + 6-digit pattern: recompute check digit
    const prefixes = hay.match(/[A-Z]{4}\d{6}/g) || []
    for (const p of prefixes) {
      const expected = computeCheckDigit(p)
      if (expected !== null) {
        addCandidate(p + expected, 'ocr_check_digit_corrected')
      }
    }
    // 4. Snap a 10-char window to 4L+6D and recompute check digit
    for (let i = 0; i <= hay.length - 10; i++) {
      const window = hay.slice(i, i + 10)
      const snapped10 = snapToBicClass(window)
      if (!snapped10) continue
      const prefix = snapped10.slice(0, 10)
      if (/^[A-Z]{4}\d{6}$/.test(prefix)) {
        const expected = computeCheckDigit(prefix)
        if (expected !== null) {
          addCandidate(prefix + expected, 'ocr_check_digit_corrected')
        }
      }
    }
  }

  // Prefer: check-digit-valid > direct ocr > corrected
  out.sort((a, b) => {
    if (a.check_digit_valid !== b.check_digit_valid) {
      return Number(b.check_digit_valid) - Number(a.check_digit_valid)
    }
    const rank = { ocr: 0, ocr_check_digit_corrected: 1 } as const
    return rank[a.source] - rank[b.source]
  })
  return out
}

export default function CameraOcr({ onAccept }: Props) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [rawText, setRawText] = useState('')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  async function handleFile(file: File) {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    setRawText('')
    setCandidates([])
    setError(null)
    setStatus('reading')

    const form = new FormData()
    form.append('photo', file)
    try {
      const res = await fetch(OCR_ENDPOINT, { method: 'POST', body: form })
      if (!res.ok) {
        let detail = res.statusText
        try {
          const body = await res.json()
          detail =
            typeof body.detail === 'string'
              ? body.detail
              : JSON.stringify(body.detail)
        } catch {
          /* ignore */
        }
        throw new Error(detail)
      }
      const data = (await res.json()) as {
        candidates: Candidate[]
        raw_text: string
      }
      setRawText(data.raw_text || '')
      setCandidates(data.candidates || [])
      setStatus('done')
      if (data.candidates?.length > 0) onAccept(data.candidates[0].value)
    } catch (e) {
      setError(String(e))
      setStatus('error')
    }
  }

  function reset() {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(null)
    setStatus('idle')
    setRawText('')
    setCandidates([])
    setError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <div className="space-y-3">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handleFile(f)
        }}
      />

      {!previewUrl && (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="w-full bg-[#1B4676] hover:bg-[#224E72] text-white font-bold rounded-md py-3.5 flex items-center justify-center gap-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0093D0] focus-visible:ring-offset-2"
        >
          <CameraIcon className="w-5 h-5" />
          <span>Take container photo</span>
        </button>
      )}

      {previewUrl && (
        <div className="space-y-3">
          <div className="relative bg-slate-100 rounded-md overflow-hidden border border-slate-200">
            <img
              src={previewUrl}
              alt="Container plate"
              className="w-full max-h-72 object-contain"
            />
            <button
              type="button"
              onClick={reset}
              className="absolute top-2 right-2 bg-black/70 hover:bg-black text-white rounded-full w-8 h-8 flex items-center justify-center transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
              aria-label="Remove photo"
            >
              <XIcon className="w-4 h-4" />
            </button>
          </div>

          {status === 'reading' && (
            <div className="text-sm bg-[#0093D0]/5 border border-[#0093D0]/25 text-[#1B4676] rounded-md px-3 py-2.5 flex items-center gap-2">
              <Spinner size={16} className="text-[#0093D0]" />
              <span>
                Reading container number on server… first request may take 10–30s
                while the OCR model loads.
              </span>
            </div>
          )}

          {status === 'error' && (
            <div
              role="alert"
              className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5 flex items-start gap-2"
            >
              <span className="font-semibold flex-shrink-0">OCR failed:</span>
              <span>{error}</span>
            </div>
          )}

          {status === 'done' && candidates.length === 0 && (
            <div className="text-sm bg-amber-50 border border-amber-200 text-amber-900 rounded-md px-3 py-2.5">
              <div className="font-semibold flex items-center gap-2">
                <AlertTriangleIcon className="w-4 h-4" />
                <span>No container number detected in this photo.</span>
              </div>
              <p className="mt-1.5 text-amber-800">
                Type it manually below, or retake the photo. OCR works best when:
              </p>
              <ul className="list-disc list-inside text-xs mt-1 space-y-0.5 text-amber-800">
                <li>BIC code (4 letters + 7 digits) fills most of the frame</li>
                <li>Camera is head-on — not angled from above or below</li>
                <li>Nothing obscures the characters (door rods, dirt, shadows)</li>
                <li>Lighting is even, no glare on the plate</li>
              </ul>
              {rawText && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-amber-700 font-medium">
                    Show raw OCR output
                  </summary>
                  <pre className="mt-1 text-xs bg-amber-100/60 p-2 rounded font-mono whitespace-pre-wrap max-h-48 overflow-auto">
                    {rawText}
                  </pre>
                </details>
              )}
            </div>
          )}

          {status === 'done' && candidates.length > 0 && (
            <div className="text-sm bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-md px-3 py-2.5 flex items-center gap-3">
              <CheckIcon className="w-5 h-5 text-emerald-600 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[10.5px] uppercase tracking-[0.15em] font-bold text-emerald-700">
                  Detected
                </div>
                <span className="font-mono text-base font-bold tracking-wider text-[#1B4676]">
                  {candidates[0].value}
                </span>
                {candidates[0].source === 'ocr_check_digit_corrected' && (
                  <span className="ml-2 text-[10.5px] uppercase tracking-[0.15em] font-bold text-amber-700">
                    check-digit auto-corrected
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
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

function CameraIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </Icon>
  )
}

function XIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Icon>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <polyline points="20 6 9 17 4 12" />
    </Icon>
  )
}

function AlertTriangleIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Icon>
  )
}
