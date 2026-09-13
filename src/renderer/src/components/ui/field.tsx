/**
 * A label and its control.
 *
 * Two layouts, both from the mockup: `row` is the member panel's "label on the
 * left, control on the right" line, `column` is the settings form's stacked
 * label-over-control.
 *
 * `htmlFor` is a plain prop rather than a generated id because every current
 * call site already owns the control's id; a generated one would be a second
 * mechanism for the same thing.
 */
import clsx from 'clsx'
import type { ReactNode } from 'react'

export interface FieldProps {
  /** Already translated. */
  label: string
  /** Already translated secondary line, dimmed. */
  hint?: string | undefined
  layout?: 'row' | 'column' | undefined
  htmlFor?: string | undefined
  children: ReactNode
  className?: string | undefined
}

export function Field({
  label,
  hint,
  layout = 'row',
  htmlFor,
  children,
  className
}: FieldProps): React.JSX.Element {
  const row = layout === 'row'
  return (
    <div
      className={clsx(
        row ? 'flex items-center justify-between gap-3' : 'flex flex-col gap-1.5',
        className
      )}
    >
      <label htmlFor={htmlFor} className="text-xs text-fg-muted">
        {label}
        {hint ? <span className="ml-1.5 text-[11px] text-fg-faint">{hint}</span> : null}
      </label>
      {children}
    </div>
  )
}
