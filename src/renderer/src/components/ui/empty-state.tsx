/**
 * The placeholder a column shows when it has nothing to list.
 *
 * S1.5 is *made* of these: no chats, no members, no agents, no settings section
 * built yet. Every one of them takes an icon, a title and a description from the
 * locale files, so the shell reads as a finished product with empty data rather
 * than as an unfinished screen.
 */
import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export type EmptyStateSize = 'sm' | 'md'

export interface EmptyStateProps {
  icon: LucideIcon
  /** Already translated. */
  title: string
  /** Already translated. */
  description?: string | undefined
  /** A button that fixes the emptiness, rendered under the description. */
  action?: ReactNode | undefined
  size?: EmptyStateSize | undefined
  className?: string | undefined
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  size = 'md',
  className
}: EmptyStateProps): React.JSX.Element {
  const compact = size === 'sm'
  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-1.5 px-3 py-6' : 'gap-2 px-6 py-10',
        className
      )}
    >
      <Icon
        aria-hidden="true"
        strokeWidth={1.5}
        className={clsx('text-fg-faint', compact ? 'h-5 w-5' : 'h-7 w-7')}
      />
      <p className={clsx('font-medium text-fg-muted', compact ? 'text-xs' : 'text-sm')}>{title}</p>
      {description ? (
        <p className={clsx('max-w-[34ch] leading-relaxed text-fg-faint', 'text-xs')}>
          {description}
        </p>
      ) : null}
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  )
}
