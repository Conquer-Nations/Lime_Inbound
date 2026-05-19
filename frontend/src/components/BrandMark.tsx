interface Props {
  className?: string
}

/**
 * The Conquer Nation brand mark — interlocking C/N loops with a small wordmark
 * underneath. Served from /public/cn-logo.png (white, transparent background),
 * designed to sit on dark navy or navy-gradient chrome.
 *
 * Pass a height-only Tailwind class (e.g. `h-9`, `h-12`) — the component
 * forces `width: auto` so the logo's natural ~3:2 ratio is preserved and the
 * image never gets squished into a square box.
 */
export default function BrandMark({ className }: Props) {
  return (
    <img
      src="/cn-logo.png"
      alt="Conquer Nation"
      className={className}
      style={{ width: 'auto', objectFit: 'contain' }}
      draggable={false}
    />
  )
}
