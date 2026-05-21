import { useEffect, useRef, useState, type ReactNode } from 'react'
import Tesseract from 'tesseract.js'
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
  // Standard ISO 6346 alphabet weights: A=10 B=12 C=13 D=14 E=15 F=16 G=17 H=18
  // I=19 J=20 K=21 L=23 M=24 N=25 O=26 P=27 Q=28 R=29 S=30 T=31 U=32 V=34 W=35
  // X=36 Y=37 Z=38 (no 11, 22, 33 — those are excluded)
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

function buildCandidates(rawText: string): Candidate[] {
  const upper = rawText.toUpperCase().replace(/\s+/g, '')
  const seen = new Set<string>()
  const out: Candidate[] = []
  // Direct matches (4 letters + 7 digits anywhere in the text)
  const matches = upper.match(BIC_REGEX) || []
  for (const m of matches) {
    if (seen.has(m)) continue
    seen.add(m)
    const expected = computeCheckDigit(m.slice(0, 10))
    const actual = parseInt(m.slice(10, 11), 10)
    out.push({
      value: m,
      check_digit_valid: expected !== null && expected === actual,
      source: 'ocr',
    })
  }
  // Try to fix check-digit by recomputing for any 4-letter-6-digit prefix
  if (out.length === 0) {
    const prefixes = upper.match(/[A-Z]{4}\d{6}/g) || []
    for (const p of prefixes) {
      const expected = computeCheckDigit(p)
      if (expected !== null) {
        const corrected = p + expected
        if (!seen.has(corrected)) {
          seen.add(corrected)
          out.push({
            value: corrected,
            check_digit_valid: true,
            source: 'ocr_check_digit_corrected',
          })
        }
      }
    }
  }
  // Prefer check-digit-valid matches first
  out.sort((a, b) => Number(b.check_digit_valid) - Number(a.check_digit_valid))
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

    try {
      // Client-side OCR via Tesseract.js — restricted to uppercase letters +
      // digits to bias the recognizer toward BIC codes and skip distractor text.
      const result = await Tesseract.recognize(file, 'eng', {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        // tessedit_char_whitelist is the canonical Tesseract knob for this.
      })
      const text = result.data.text || ''
      setRawText(text)
      const cands = buildCandidates(text)
      setCandidates(cands)
      setStatus('done')
      if (cands.length > 0) onAccept(cands[0].value)
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
