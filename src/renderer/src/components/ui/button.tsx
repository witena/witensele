/**
 * The text button of the shell, in the four tones the mockup uses.
 *
 * Every class here is built from the semantic tokens in `index.css`; no literal
 * colour appears in a component (that is the rule the dark theme depends on, and
 * it is what will make a light theme a token swap rather than a rewrite).
 *
 * `-webkit-app-region: no-drag` is not set here: it belongs to the draggable
 * containers (`NavRail`, `PageHeader`), which mark their own interactive
 * children. A button that is not inside a drag region does not need it.
 */
import clsx from 'clsx'
import type { ButtonHTMLAttributes } from 'react'

/** primary = the accent call to action, ghost = nav-like, danger = destructive. */
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

export type ButtonSize = 'sm' | 'md'

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-bg-base font-semibold hover:bg-accent-hover',
  secondary: 'border border-border-strong bg-bg-elevated text-fg-muted hover:bg-bg-hover',
  danger: 'border border-border-strong bg-bg-elevated text-danger hover:bg-bg-hover',
  ghost: 'text-fg-muted hover:bg-bg-hover hover:text-fg'
}

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-6 gap-1 px-2 text-[11px]',
  md: 'h-7 gap-1.5 px-3 text-xs'
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant | undefined
  size?: ButtonSize | undefined
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      // Never inherit `submit`: the shell has no forms and an accidental submit
      // would reload the renderer.
      type={type}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-md transition-colors',
        'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-inherit',
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        className
      )}
      {...rest}
    />
  )
}
