interface Props {
  size?: number
  className?: string
  /** Accessible label announced by screen readers. */
  ariaLabel?: string
}

/**
 * Aesthetic loading spinner — two-stroke ring that inherits text color.
 * Drop it inline beside a label inside a button:
 *   <Spinner size={16} className="text-white" />
 * Or larger as a page-level indicator. The `currentColor` strokes mean it
 * picks up whatever text color you wrap it in.
 */
export default function Spinner({
  size = 16,
  className = '',
  ariaLabel = 'Loading',
}: Props) {
  return (
    <svg
      role="status"
      aria-label={ariaLabel}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={`animate-spin ${className}`}
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        opacity="0.25"
      />
      <path
        d="M4 12a8 8 0 018-8"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}
