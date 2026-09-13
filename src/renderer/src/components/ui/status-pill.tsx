/**
 * The dot-and-label pill on a provider card: "Connected", "Probe failed",
 * "No key".
 *
 * Not the same thing as `PresenceDot`, which is about an *agent* inside a chat
 * and has the four Teams states. This is about a *configured service* and has
 * three tones — it answered, it did not, nothing has been tried — which is also
 * what an MCP server needs in S3.1, so the component is generic over the tone and
 * takes its label already translated.
 *
 * `statusToneClass` is exported as a pure function for the same reason
 * `presenceColorClass` is: the tone → token mapping is the only logic here, and
 * it is cheaper to unit test than to render.
 */
import clsx from 'clsx'

/** `ok` answered, `warn` failed its probe, `idle` has not been tried. */
export type StatusTone = 'ok' | 'warn' | 'idle'

/** Surface and foreground utilities for one tone. Total over `StatusTone`. */
export function statusToneClass(tone: StatusTone): string {
  // Written out rather than composed: Tailwind scans source text, so an
  // interpolated class name would be dropped from the stylesheet.
  switch (tone) {
    case 'ok':
      return 'bg-status-ok-surface text-status-ok'
    case 'warn':
      return 'bg-status-warn-surface text-status-warn'
    case 'idle':
      return 'bg-status-idle-surface text-status-idle'
  }
}

/** The dot utility for one tone. Total over `StatusTone`. */
export function statusDotClass(tone: StatusTone): string {
  switch (tone) {
    case 'ok':
      return 'bg-presence-available'
    case 'warn':
      return 'bg-presence-away'
    case 'idle':
      return 'bg-presence-offline'
  }
}

export interface StatusPillProps {
  tone: StatusTone
  /** Already translated. */
  label: string
  className?: string | undefined
  'data-testid'?: string | undefined
  /** Machine-readable tone for the end-to-end specs, which must not read copy. */
  'data-status'?: string | undefined
}

export function StatusPill({
  tone,
  label,
  className,
  'data-testid': testId,
  'data-status': status
}: StatusPillProps): React.JSX.Element {
  return (
    <span
      data-testid={testId}
      data-status={status}
      className={clsx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] leading-4',
        statusToneClass(tone),
        className
      )}
    >
      <span aria-hidden="true" className={clsx('h-1.5 w-1.5 rounded-full', statusDotClass(tone))} />
      {label}
    </span>
  )
}
