import { useEffect, useRef, useState, type ReactNode } from 'react'
import { API_BASE } from '../api/client'
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

/**
 * Operator's camera/photo flow.
 * Operator picks (or takes) a photo of the container plate. The image is sent
 * to the backend OCR endpoint (EasyOCR / PyTorch) which extracts the BIC code
 * candidates. Operator confirms or picks one.
 */
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
      const res = await fetch(`${API_BASE}/ocr/container-photo`, {
        method: 'POST',
        body: form,
      })
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
      setRawText(data.raw_text)
      setCandidates(data.candidates)
      setStatus('done')
      if (data.candidates.length > 0) {
        onAccept(data.candidates[0].value)
      }
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
