/**
 * The small rounded tag the mockup uses for a model id, with an optional remove
 * affordance.
 *
 * Close cousin of `Badge`, and deliberately not the same component: a `Badge` is
 * a *label* (the model next to a message author, the orchestration summary) and
 * is never interactive, while a `Chip` is an *item in an editable set* — the
 * provider editor's model list — and can be removed or act as a button. Merging
 * them would mean a primitive whose props contradict each other.
 */
import clsx from 'clsx'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

/** `default` is a value; `accent` is the "+ add manually" style affordance. */
export type ChipTone = 'default' | 'accent'

export interface ChipProps {
  children: ReactNode
  tone?: ChipTone | undefined
  font?: 'mono' | 'sans' | undefined
  /** Renders a remove button on the right. Already-translated `removeLabel` required. */
  onRemove?: (() => void) | undefined
  /** Translated accessible name for the remove button. */
  removeLabel?: string | undefined
  /** Makes the whole chip a button. Mutually exclusive with `onRemove` in practice. */
  onClick?: (() => void) | undefined
  className?: string | undefined
  'data-testid'?: string | undefined
}

const TONE_CLASS: Record<ChipTone, string> = {
  default: 'bg-bg-muted text-fg-muted',
  accent: 'bg-bg-muted text-accent hover:bg-bg-hover'
}

export function Chip({
  children,
  tone = 'default',
  font = 'mono',
  onRemove,
  removeLabel,
  onClick,
  className,
  'data-testid': testId
}: ChipProps): React.JSX.Element {
  const content = (
    <>
      <span className="truncate">{children}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={(event) => {
            // The chip itself may be clickable; removing must not also select.
            event.stopPropagation()
            onRemove()
          }}
          className="-mr-0.5 shrink-0 rounded-sm text-fg-faint transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
        >
          <X aria-hidden="true" className="h-3 w-3" />
        </button>
      ) : null}
    </>
  )

  const shared = clsx(
    // `whitespace-nowrap` because a chip is one token: an action chip with an
    // icon would otherwise break between the icon and its label inside a
    // wrapping flex row.
    'inline-flex max-w-full shrink-0 items-center gap-1 rounded px-2 py-[3px] text-[11px] leading-4 whitespace-nowrap',
    font === 'mono' ? 'font-mono' : 'font-sans',
    TONE_CLASS[tone],
    className
  )

  if (onClick) {
    return (
      <button
        type="button"
        data-testid={testId}
        onClick={onClick}
        className={clsx(
          shared,
          'transition-colors focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none'
        )}
      >
        {content}
      </button>
    )
  }

  return (
    <span data-testid={testId} className={shared}>
      {content}
    </span>
  )
}
