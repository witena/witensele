/**
 * A monogram avatar: one or two characters on a solid colour, matching
 * `InitialAvatar` in `@shared/types`.
 *
 * The colour arrives as a CSS colour string because it is *data* — each agent
 * stores its own `avatar.color` — and data cannot be a Tailwind class (the
 * scanner would never see it). Everything that is not data still comes from
 * tokens: `DEFAULT_AVATAR_COLOR` is the neutral surface an agent falls back to
 * before it has picked one.
 *
 * `presence` renders the overlaid dot from `PresenceDot`, which is why the
 * wrapper is `relative`.
 */
import clsx from 'clsx'
import type { PresenceState } from '@shared/types'
import { PresenceDot } from './presence-dot'

export type AvatarSize = 'sm' | 'md' | 'lg'

const SIZE_CLASS: Record<AvatarSize, string> = {
  sm: 'h-5 w-5 rounded-md text-[10px]',
  md: 'h-7 w-7 rounded-lg text-xs',
  lg: 'h-8 w-8 rounded-lg text-[13px]'
}

/** Neutral fallback, used until an agent record supplies its own colour. */
export const DEFAULT_AVATAR_COLOR = '#3a3a3a'

/** Fallback foreground, paired with `DEFAULT_AVATAR_COLOR`. */
export const DEFAULT_AVATAR_TEXT_COLOR = '#b0aca4'

export interface AvatarProps {
  /** One or two characters. Comes from `InitialAvatar.text`, never translated. */
  text: string
  /** Background, a CSS colour from the agent record. */
  color?: string | undefined
  /** Foreground, a CSS colour from the agent record. */
  textColor?: string | undefined
  size?: AvatarSize | undefined
  /** When given, an overlaid presence dot is rendered on the bottom-right. */
  presence?: PresenceState | undefined
  /** Translated presence name for the overlaid dot. */
  presenceLabel?: string | undefined
  /** Forwarded to the overlaid dot, so a row's presence stays addressable. */
  presenceTestId?: string | undefined
  className?: string | undefined
}

export function Avatar({
  text,
  color = DEFAULT_AVATAR_COLOR,
  textColor = DEFAULT_AVATAR_TEXT_COLOR,
  size = 'md',
  presence,
  presenceLabel,
  presenceTestId,
  className
}: AvatarProps): React.JSX.Element {
  return (
    <span className={clsx('relative inline-flex shrink-0', className)}>
      <span
        aria-hidden="true"
        style={{ backgroundColor: color, color: textColor }}
        className={clsx(
          'flex items-center justify-center font-semibold select-none',
          SIZE_CLASS[size]
        )}
      >
        {text}
      </span>
      {presence ? (
        <PresenceDot
          state={presence}
          label={presenceLabel}
          overlay
          data-testid={presenceTestId}
        />
      ) : null}
    </span>
  )
}
