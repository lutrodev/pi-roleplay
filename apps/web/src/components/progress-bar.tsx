/** The same determinate/unknown progress appearance on every browser. */
export function ProgressBar({ label, value, maximum, className = '' }: { label: string; value: number; maximum: number; className?: string }) {
  const known = Number.isFinite(value) && Number.isFinite(maximum) && maximum > 0
  const current = known ? Math.max(0, Math.min(value, maximum)) : undefined
  return <div className={`progress-bar ${className}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={known ? maximum : undefined} aria-valuenow={current} data-indeterminate={!known || undefined}><span style={known ? { width: `${current! / maximum * 100}%` } : undefined} /></div>
}
