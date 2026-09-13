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
}

const TONE_CLASS: Record<BadgeTone, string> = {
  default: 'bg-bg-muted text-fg-dim',
  accent: 'bg-bg-muted text-accent'
}

export function Badge({
  children,
  tone = 'default',
  font = 'mono',
  className
}: BadgeProps): React.JSX.Element {
  return (
    <span
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
