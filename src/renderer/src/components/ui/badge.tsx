/**
 * The small monospaced tag from the mockup: the model id next to a message
 * author, the orchestration summary in the chat header, an `@name` mention chip.
 *
 * Monospace by default because almost everything it holds is an identifier
 * (`claude-sonnet-4-5`, `qwen2.5:14b`); `font="sans"` is for the few chips that
 * hold prose.
 */
import clsx from 'clsx'
import type { ReactNode } from 'react'

export type BadgeTone = 'default' | 'accent'

export interface BadgeProps {
  children: ReactNode
  tone?: BadgeTone | undefined
  font?: 'mono' | 'sans' | undefined
  className?: string | undefined
  /**
   * Native tooltip text. The message header hangs the turn's token counts and
   * cost off the model badge with it (S4.1): the numbers belong to that model,
   * and a row repeated dozens of times per screen has no room for them inline.
   */
  title?: string | undefined
  /** Forwarded to the tag; the chat header addresses its summary badge by it. */
  'data-testid'?: string | undefined
}

const TONE_CLASS: Record<BadgeTone, string> = {
  default: 'bg-bg-muted text-fg-dim',
  accent: 'bg-bg-muted text-accent'
}

export function Badge({
  children,
  tone = 'default',
  font = 'mono',
  className,
  title,
  'data-testid': testId
}: BadgeProps): React.JSX.Element {
  return (
    <span
      data-testid={testId}
      {...(title ? { title } : {})}
      className={clsx(
        'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] leading-4',
        font === 'mono' ? 'font-mono' : 'font-sans',
        TONE_CLASS[tone],
        className
      )}
    >
      {children}
    </span>
  )
}
