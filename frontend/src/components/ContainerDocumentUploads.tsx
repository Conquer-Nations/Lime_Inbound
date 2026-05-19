import { useEffect, useRef, useState } from 'react'
import {
  api,
  ApiError,
  type ContainerDocumentItem,
  type DocumentKindOption,
} from '../api/client'

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

const UploadIcon = ({ className = '' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
)

const ReplaceIcon = ({ className = '' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" className={className}>
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
    <path d="M20.49 15A9 9 0 0 1 5.64 18.36L1 14" />
  </svg>
)

const TrashIcon = ({ className = '' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" className={className}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
    <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
  </svg>
)

const DocIcon = ({ className = '' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="13" x2="15" y2="13" />
    <line x1="9" y1="17" x2="15" y2="17" />
  </svg>
)

const CheckIcon = ({ className = '' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
    strokeLinecap="round" strokeLinejoin="round" className={className}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
)

interface SlotProps {
  containerNo: string
  kind: string
  label: string
  existing: ContainerDocumentItem | undefined
  onChange: (next: ContainerDocumentItem | null) => void
}

function DocumentSlot({ containerNo, kind, label, existing, onChange }: SlotProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Authenticated blob URL for previews + click-through. Re-fetched whenever
  // the underlying document id changes (i.e. on replace).
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [blobLoading, setBlobLoading] = useState(false)
  const [blobErr, setBlobErr] = useState<string | null>(null)

  useEffect(() => {
    if (!existing) {
      setBlobUrl(null)
      return
    }
    let cancelled = false
    let urlToRevoke: string | null = null
    setBlobLoading(true)
    setBlobErr(null)
    api
      .fetchContainerDocumentBlob(containerNo, existing.kind)
      .then((blob) => {
        if (cancelled) return
        const u = URL.createObjectURL(blob)
        urlToRevoke = u
        setBlobUrl(u)
      })
      .catch((e) => {
        if (cancelled) return
        setBlobErr(e instanceof ApiError ? e.detail : String(e))
        setBlobUrl(null)
      })
      .finally(() => {
        if (!cancelled) setBlobLoading(false)
      })
    return () => {
      cancelled = true
      if (urlToRevoke) URL.revokeObjectURL(urlToRevoke)
    }
  }, [containerNo, existing?.id, existing?.kind])

  async function handleFile(file: File) {
    setErr(null)
    setBusy(true)
    try {
      const doc = await api.uploadContainerDocument(containerNo, kind, file)
      onChange(doc)
    } catch (e) {
      setErr(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function handleDelete() {
    if (!existing) return
    if (!confirm(`Remove the uploaded ${label}?`)) return
    setBusy(true)
    setErr(null)
    try {
      await api.deleteContainerDocument(containerNo, kind)
      onChange(null)
    } catch (e) {
      setErr(e instanceof ApiError ? e.detail : String(e))
    } finally {
      setBusy(false)
    }
  }

  const isImage = existing && existing.content_type.startsWith('image/')
  const hasFile = Boolean(existing)

  return (
    <div
      className={`rounded-lg border p-4 bg-white transition flex flex-col h-full min-h-[10rem] ${
        hasFile
          ? 'border-emerald-300 bg-emerald-50/30'
          : 'border-dashed border-slate-300 hover:border-[#0093D0]'
      }`}
    >
      {/* Header: label on left, status pill on right. Min-height keeps the
          row identical whether the pill is present or not. */}
      <div className="flex items-center justify-between gap-2 mb-3 min-h-[1.25rem]">
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#1B4676] truncate">
          {label}
        </span>
        {hasFile ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-emerald-700 flex-shrink-0">
            <CheckIcon className="w-3 h-3" />
            On file
          </span>
        ) : (
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex-shrink-0">
            Pending
          </span>
        )}
      </div>

      {/* Body fills the remaining vertical space so empty/filled slots line
          up on the same baseline across the grid. */}
      <div className="flex-1 flex flex-col">
        {existing ? (
          <div className="flex gap-3 items-start flex-1">
            <div className="w-20 h-20 rounded-md border border-slate-200 bg-slate-50 overflow-hidden flex items-center justify-center flex-shrink-0">
              {blobLoading ? (
                <span className="text-[10px] text-slate-400">Loading…</span>
              ) : blobErr ? (
                <span
                  className="text-[10px] text-red-500 px-1 text-center"
                  title={blobErr}
                >
                  Preview failed
                </span>
              ) : isImage && blobUrl ? (
                <img src={blobUrl} alt={label} className="w-full h-full object-cover" />
              ) : blobUrl ? (
                <a
                  href={blobUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-slate-400 hover:text-[#0093D0]"
                  title="Open file"
                >
                  <DocIcon className="w-8 h-8" />
                </a>
              ) : (
                <DocIcon className="w-8 h-8 text-slate-300" />
              )}
            </div>
            <div className="min-w-0 flex-1 flex flex-col">
              {blobUrl ? (
                <a
                  href={blobUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-xs font-medium text-[#1B4676] hover:text-[#0093D0] truncate"
                  title={existing.filename}
                >
                  {existing.filename}
                </a>
              ) : (
                <span
                  className="block text-xs font-medium text-slate-600 truncate"
                  title={existing.filename}
                >
                  {existing.filename}
                </span>
              )}
              <div className="text-[10.5px] text-slate-500 mt-0.5">
                {formatBytes(existing.file_size)}
              </div>
              <div className="text-[10.5px] text-slate-400">
                {new Date(existing.uploaded_at).toLocaleDateString()}{' '}
                {new Date(existing.uploaded_at).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
              <div className="mt-auto pt-2 flex flex-wrap gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => inputRef.current?.click()}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#1B4676] hover:text-[#0093D0] disabled:opacity-50"
                >
                  <ReplaceIcon className="w-3.5 h-3.5" />
                  Replace
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleDelete}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-600 hover:text-red-700 disabled:opacity-50"
                >
                  <TrashIcon className="w-3.5 h-3.5" />
                  Remove
                </button>
              </div>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="w-full flex-1 inline-flex flex-col items-center justify-center gap-1.5 px-3 py-4 rounded-md text-xs font-semibold text-[#1B4676] bg-slate-50 hover:bg-[#0093D0]/5 border border-slate-200 hover:border-[#0093D0] transition disabled:opacity-50"
          >
            <UploadIcon className="w-5 h-5" />
            <span>{busy ? 'Uploading…' : 'Upload photo / PDF'}</span>
            <span className="text-[10px] text-slate-500 font-normal">
              JPEG · PNG · HEIC · PDF · max 15 MB
            </span>
          </button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handleFile(f)
        }}
      />

      {err && (
        <div className="mt-2 text-[10.5px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
          {err}
        </div>
      )}
    </div>
  )
}

interface ContainerDocumentUploadsProps {
  containerNo: string
  /** Optional — if not passed, the component fetches the list of kinds itself. */
  kinds?: DocumentKindOption[]
  /** Optional title override. Defaults to "Driver / truck documents". */
  title?: string
  /** Optional helper text under the title. */
  description?: string
}

/** Renders all 7 document-upload slots for a single container.
 *  Drops into both the initial driver-info form and the update flow —
 *  identical behavior, since uploads always target an existing container. */
export function ContainerDocumentUploads({
  containerNo,
  kinds: kindsProp,
  title = 'Driver / truck documents',
  description = 'Upload a clear photo or PDF of each item. Re-upload anytime — the newest replaces the prior one.',
}: ContainerDocumentUploadsProps) {
  const [kinds, setKinds] = useState<DocumentKindOption[] | null>(kindsProp ?? null)
  const [docs, setDocs] = useState<ContainerDocumentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setErr(null)
      try {
        const [kindsResp, docsResp] = await Promise.all([
          kindsProp ? Promise.resolve({ kinds: kindsProp }) : api.listDocumentKinds(),
          api.listContainerDocuments(containerNo),
        ])
        if (cancelled) return
        if (!kindsProp) setKinds(kindsResp.kinds)
        setDocs(docsResp.documents)
      } catch (e) {
        if (cancelled) return
        setErr(e instanceof ApiError ? e.detail : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [containerNo, kindsProp])

  function replaceDoc(kind: string, next: ContainerDocumentItem | null) {
    setDocs((prev) => {
      const without = prev.filter((d) => d.kind !== kind)
      return next ? [...without, next] : without
    })
  }

  if (loading) {
    return (
      <div className="text-xs text-slate-500 py-4">Loading documents…</div>
    )
  }

  if (err) {
    return (
      <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
        Couldn't load documents: {err}
      </div>
    )
  }

  const docsByKind = new Map(docs.map((d) => [d.kind, d]))

  return (
    <div>
      <div className="mb-3">
        <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0] mb-1">
          {title}
        </div>
        <p className="text-xs text-slate-600">{description}</p>
      </div>
      {/* auto-fill keeps each slot >= 260px wide and grows the column count
          to match the container — so the same component looks balanced inside
          a max-w-2xl form and a max-w-4xl card alike. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3 items-stretch auto-rows-fr">
        {(kinds ?? []).map((k) => (
          <DocumentSlot
            key={k.kind}
            containerNo={containerNo}
            kind={k.kind}
            label={k.label}
            existing={docsByKind.get(k.kind)}
            onChange={(next) => replaceDoc(k.kind, next)}
          />
        ))}
      </div>
    </div>
  )
}
