/**
 * One vertical strip of the three-column layout: a fixed pixel width, one border
 * on the side that faces the next column, and its own scroll context.
 *
 * The widths come straight from the mockup (264px chat list, 288px member panel,
 * 220px settings nav) and are props rather than variants because they are layout
 * data, not a design system decision.
 *
 * `shrink-0` matters more than it looks: without it a long chat title inside the
 * column would push the fixed width open and the whole layout would drift.
 */
import clsx from 'clsx'
import type { CSSProperties, ReactNode } from 'react'

export interface ColumnProps {
  /** Fixed width in pixels. Omitted, the column takes the remaining space. */
  width?: number | undefined
  /** Which edge carries the 1px divider. */
  border?: 'left' | 'right' | 'none' | undefined
  /** Scrolls the column as a whole. Leave off when it has a pinned header. */
  scroll?: boolean | undefined
  className?: string | undefined
  children: ReactNode
}

const BORDER_CLASS = {
  left: 'border-l border-border',
  right: 'border-r border-border',
  none: ''
} as const

export function Column({
  width,
  border = 'right',
  scroll = false,
  className,
  children
}: ColumnProps): React.JSX.Element {
  const style: CSSProperties | undefined = width === undefined ? undefined : { width }
  return (
    <div
      style={style}
      className={clsx(
        'flex h-full flex-col',
        width === undefined ? 'min-w-0 flex-1' : 'shrink-0',
        scroll ? 'overflow-y-auto' : 'overflow-hidden',
        BORDER_CLASS[border],
        className
      )}
    >
      {children}
    </div>
  )
}
