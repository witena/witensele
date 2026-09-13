/**
 * The 52px bar at the top of a content area: title, an optional badge next to it,
 * and right-aligned actions.
 *
 * It is a window drag region (see `window-chrome.ts`), which is why `actions`
 * are wrapped in `NO_DRAG`: a button inside a drag region does not receive
 * clicks otherwise.
 *
 * `testId` goes on the title, not on the bar, because that is the element whose
 * *text* the end-to-end specs read — the bar would give them a container whose
 * text also contains the badge.
 */
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { DRAG_REGION, NO_DRAG } from './window-chrome'

export interface PageHeaderProps {
  /** Already translated. */
  title: string
  badge?: ReactNode | undefined
  actions?: ReactNode | undefined
  testId?: string | undefined
  className?: string | undefined
}

export function PageHeader({
  title,
  badge,
  actions,
  testId,
  className
}: PageHeaderProps): React.JSX.Element {
  return (
    <header
      className={clsx(
        'flex h-[52px] shrink-0 items-center justify-between gap-3 border-b border-border px-5',
        DRAG_REGION,
        className
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <h1 data-testid={testId} className="truncate text-sm font-semibold text-fg">
          {title}
        </h1>
        {badge}
      </div>
      {actions ? <div className={clsx('flex items-center gap-2', NO_DRAG)}>{actions}</div> : null}
    </header>
  )
}
