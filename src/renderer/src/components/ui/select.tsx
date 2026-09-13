/**
 * A native `<select>` wearing the mockup's clothes.
 *
 * Native on purpose: the dropdown list itself is drawn by macOS, so it gets
 * keyboard navigation, type-ahead, VoiceOver support and correct behaviour near
 * the window edge for free. A custom listbox would have to reimplement all of
 * that, and the mockup's control is a plain "value + chevron" pill anyway.
 *
 * `appearance-none` removes the platform arrow so the lucide chevron can sit
 * where the mockup puts it; the chevron is `pointer-events-none` so clicking it
 * still opens the select underneath.
 */
import clsx from 'clsx'
import { ChevronDown } from 'lucide-react'
import type { SelectHTMLAttributes } from 'react'

export interface SelectOption {
  value: string
  /** Already translated by the caller. */
  label: string
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: readonly SelectOption[]
  /** Applied to the positioning wrapper; use it to make the control full width. */
  wrapperClassName?: string | undefined
}

export function Select({
  options,
  className,
  wrapperClassName,
  ...rest
}: SelectProps): React.JSX.Element {
  return (
    <div className={clsx('relative inline-flex items-center', wrapperClassName)}>
      <select
        className={clsx(
          'appearance-none rounded-md border border-border-strong bg-bg-elevated',
          'py-1 pr-6 pl-2 text-xs text-fg',
          'focus-visible:border-accent focus-visible:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-60',
          className
        )}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-1.5 h-3 w-3 text-fg-dim"
      />
    </div>
  )
}
