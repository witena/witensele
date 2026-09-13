/**
 * The Teams-style presence dot: green available, red working, orange away, grey
 * offline.
 *
 * `presenceColorClass` is exported as a **pure function** on purpose. It is the
 * one piece of this file with real logic — the mapping from a domain state to a
 * design token — and keeping it separate means `presence-dot.test.ts` can assert
 * the mapping in plain Node without rendering anything, which is the cheapest
 * possible guard against a fifth `PresenceState` being added later and silently
 * rendering transparent.
 *
 * The classes are written out in full rather than composed
 * (`` `bg-presence-${state}` ``) because Tailwind scans source text: an
 * interpolated class name is invisible to it and would be dropped from the
 * stylesheet.
 */
import clsx from 'clsx'
import type { PresenceState } from '@shared/types'

/** The background utility for one presence state. Total over `PresenceState`. */
export function presenceColorClass(state: PresenceState): string {
  switch (state) {
    case 'available':
      return 'bg-presence-available'
    case 'working':
      return 'bg-presence-working'
    case 'away':
      return 'bg-presence-away'
    case 'offline':
      return 'bg-presence-offline'
  }
}

export interface PresenceDotProps {
  state: PresenceState
  /**
   * Translated state name (`presence.*`). Given, the dot becomes an image with
   * that accessible name; omitted, it is decorative and hidden from readers —
   * which is right when the same word is already printed next to it.
   */
  label?: string | undefined
  /**
   * Overlays the bottom-right corner of a `relative` parent (an `Avatar`) with a
   * 2px ring in the panel background, so the dot reads as separate from the
   * avatar it sits on.
   */
  overlay?: boolean | undefined
  className?: string | undefined
  /** Forwarded to the dot; the member panel addresses its rows' dots by it. */
  'data-testid'?: string | undefined
}

export function PresenceDot({
  state,
  label,
  overlay = false,
  className,
  'data-testid': testId
}: PresenceDotProps): React.JSX.Element {
  return (
    <span
      data-testid={testId}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={clsx(
        'shrink-0 rounded-full',
        overlay
          ? 'absolute -right-[3px] -bottom-[3px] h-2.5 w-2.5 border-2 border-bg-panel'
          : 'h-2 w-2',
        presenceColorClass(state),
        className
      )}
    />
  )
}
