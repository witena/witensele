/**
 * A square button whose only content is an icon.
 *
 * `label` is required and translated: an icon alone has no accessible name, and
 * the shell is full of them (new chat, send, nav rail). It becomes both
 * `aria-label` and `title`, so the same string serves the screen reader and the
 * hover tooltip.
 */
import clsx from 'clsx'
import type { ButtonHTMLAttributes } from 'react'
import type { ButtonVariant } from './button'

/** 24 / 28 / 40 px squares — the three sizes the mockup actually uses. */
export type IconButtonSize = 'sm' | 'md' | 'lg'

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-bg-base hover:bg-accent-hover',
  secondary: 'border border-border-strong bg-bg-elevated text-fg-muted hover:bg-bg-hover',
  danger: 'border border-border-strong bg-bg-elevated text-danger hover:bg-bg-hover',
  ghost: 'text-fg-dim hover:bg-bg-hover hover:text-fg'
}

const SIZE_CLASS: Record<IconButtonSize, string> = {
  sm: 'h-6 w-6 rounded-md',
  md: 'h-7 w-7 rounded-md',
  lg: 'h-10 w-10 rounded-[10px]'
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Translated accessible name. Required: an icon has no text of its own. */
  label: string
  variant?: ButtonVariant | undefined
  size?: IconButtonSize | undefined
}

export function IconButton({
  label,
  variant = 'ghost',
  size = 'md',
  className,
  type = 'button',
  children,
  ...rest
}: IconButtonProps): React.JSX.Element {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center transition-colors',
        'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-inherit',
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
