/**
 * A row of mutually exclusive choices inside one bordered pill: "in turn /
 * in parallel" in the member panel, "system / Chinese / English" at the bottom of
 * the settings nav.
 *
 * Generic over the option value so a caller keeps its own union
 * (`SpeakingMode`, `LanguageSetting`) instead of degrading to `string` at the
 * boundary and casting it back.
 *
 * Semantics: real `<button>`s with `aria-pressed`, the same pattern the language
 * switcher has used since S1.4. A radio group would also be defensible; buttons
 * win because the control is an immediate action, not a form field waiting for a
 * submit.
 */
import clsx from 'clsx'

export interface SegmentedOption<T extends string> {
  value: T
  /** Already translated by the caller. */
  label: string
  /** Optional `data-testid`; the language switcher's segments are addressed by it. */
  testId?: string | undefined
  /**
   * Disables this segment alone, on top of the control's own `disabled` (S5.10).
   *
   * The Goal block needs it: "Document" and "Codebase" are impossible until the
   * chat is bound to a folder, and a segment that vanished would leave the user
   * with no way to find out that those kinds exist. Disabled-with-a-hint says it;
   * a missing segment says nothing.
   */
  disabled?: boolean | undefined
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean | undefined
  className?: string | undefined
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  className
}: SegmentedControlProps<T>): React.JSX.Element {
  return (
    <div
      className={clsx(
        'flex overflow-hidden rounded-md border border-border-strong text-xs',
        className
      )}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            disabled={disabled || option.disabled === true}
            data-testid={option.testId}
            onClick={() => onChange(option.value)}
            className={clsx(
              'flex-1 px-2.5 py-1.5 text-center transition-colors',
              'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
              'disabled:cursor-not-allowed disabled:opacity-60',
              active ? 'bg-bg-hover text-fg' : 'text-fg-dim hover:text-fg-secondary'
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
