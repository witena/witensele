/**
 * Single-line text input, optionally with a leading icon (the chat search box in
 * the mockup).
 *
 * The icon lives in a wrapper rather than as a background image so it inherits
 * the text colour and can be any lucide component.
 */
import clsx from 'clsx'
import type { InputHTMLAttributes, ReactNode } from 'react'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Rendered to the left of the field, inside the border. */
  icon?: ReactNode | undefined
  /** Applied to the bordered wrapper, not to the `<input>` itself. */
  wrapperClassName?: string | undefined
}

const FIELD_CLASS =
  'w-full bg-transparent text-fg placeholder:text-fg-faint focus:outline-none disabled:cursor-not-allowed'

export function Input({
  icon,
  className,
  wrapperClassName,
  ...rest
}: InputProps): React.JSX.Element {
  return (
    <div
      className={clsx(
        'flex items-center gap-2 rounded-md border border-border-strong bg-bg-elevated px-2.5 py-1.5 text-xs',
        'focus-within:border-accent/60',
        wrapperClassName
      )}
    >
      {icon ? <span className="shrink-0 text-fg-faint">{icon}</span> : null}
      <input className={clsx(FIELD_CLASS, className)} {...rest} />
    </div>
  )
}
