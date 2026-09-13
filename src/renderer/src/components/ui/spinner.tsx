/**
 * The indeterminate "something is in flight" ring.
 *
 * A bordered element with `animate-spin` rather than a lucide icon: the icon set
 * has no spinner that reads correctly at 12px, and a CSS-only ring has no SVG to
 * download and no stroke to fight.
 *
 * `label` is optional because the spinner is usually *inside* a control that
 * already says what is happening ("Testing…"), where a second announcement would
 * be noise. Given, the element becomes a live status with that accessible name.
 */
import clsx from 'clsx'

export type SpinnerSize = 'sm' | 'md'

const SIZE_CLASS: Record<SpinnerSize, string> = {
  sm: 'h-3 w-3 border',
  md: 'h-4 w-4 border-2'
}

export interface SpinnerProps {
  size?: SpinnerSize | undefined
  /** Translated accessible name, e.g. "Testing the connection". */
  label?: string | undefined
  className?: string | undefined
}

export function Spinner({ size = 'sm', label, className }: SpinnerProps): React.JSX.Element {
  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={clsx(
        'inline-block shrink-0 animate-spin rounded-full',
        // Three sides in the current colour, one transparent: that gap is what
        // makes the rotation visible.
        'border-current border-t-transparent',
        SIZE_CLASS[size],
        className
      )}
    />
  )
}
