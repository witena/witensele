/**
 * The 13–14px semibold heading that opens a column or a settings block, with the
 * dimmed count the mockup puts next to "Agents" and "Members".
 *
 * It renders a real heading element so the shell has a document outline; the
 * level is a prop because the same visual appears both as a column heading and
 * as a block heading inside one.
 */
import clsx from 'clsx'
import type { ReactNode } from 'react'

export interface SectionTitleProps {
  children: ReactNode
  /** Rendered dimmed after the title, like "Agents 5" in the mockup. */
  count?: number | undefined
  level?: 2 | 3 | undefined
  className?: string | undefined
  /** Forwarded to the heading element; the pages mark their own with it. */
  'data-testid'?: string | undefined
}

export function SectionTitle({
  children,
  count,
  level = 2,
  className,
  'data-testid': testId
}: SectionTitleProps): React.JSX.Element {
  const Heading = level === 2 ? 'h2' : 'h3'
  return (
    <Heading
      data-testid={testId}
      className={clsx('text-sm leading-5 font-semibold text-fg', className)}
    >
      {children}
      {count === undefined ? null : <span className="ml-1.5 font-normal text-fg-faint">{count}</span>}
    </Heading>
  )
}
