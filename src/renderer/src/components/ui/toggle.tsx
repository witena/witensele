/**
 * An on/off switch: the 34×20 pill from the agent configuration mockup.
 *
 * A `<button role="switch">` rather than a styled checkbox, because the visual
 * is a track and a knob rather than a box, and `aria-checked` on a switch is what
 * assistive technology expects for "memory on / memory off".
 */
import clsx from 'clsx'

export interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** Translated accessible name; the switch has no visible text of its own. */
  label: string
  disabled?: boolean | undefined
  className?: string | undefined
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  className
}: ToggleProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative h-5 w-[34px] shrink-0 rounded-full transition-colors',
        'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-45',
        checked ? 'bg-accent' : 'bg-bg-hover',
        className
      )}
    >
      <span
        className={clsx(
          'absolute top-0.5 h-4 w-4 rounded-full transition-all',
          checked ? 'right-0.5 bg-bg-base' : 'left-0.5 bg-fg-dim'
        )}
      />
    </button>
  )
}
