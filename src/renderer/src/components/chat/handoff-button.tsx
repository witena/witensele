/**
 * "Hand to executor" — the click that ends the discussion and starts the work
 * (S5.6, PLAN.md's *discuss → hand to executor → implement → review* loop).
 *
 * It sits **directly above the composer**, in the same column as the permission
 * cards, and not in the right column's Actions card. That card's two actions are
 * deliberately ordinary messages — it says so in its own header comment: nothing
 * there bypasses `chat.send`, so the user can read, edit and repeat the exact
 * sentence that produced the result. A hand-off is the opposite kind of thing:
 * it is a backend path of its own (`chat.handoff`) that schedules two rounds the
 * chat's `mode` does not describe. Putting it next to Send keeps the two classes
 * apart, and puts the button where the user already is when they decide the
 * talking is over.
 *
 * It is always drawn for a selected chat and **disabled** rather than hidden
 * when it cannot be taken: a control that vanishes teaches nothing, and the
 * tooltip on the disabled button is the sentence that explains what is missing —
 * the same sentence the backend's refusal would produce, because both come from
 * `handoffBlocker`'s `ValidationReason` (see `handoff.ts`).
 */
import { HardHat } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Agent } from '@shared/types'
import { validationReasonMessage } from '../../i18n/errors'
import { Button } from '../ui'
import { handoffBlocker } from './handoff'

export interface HandoffButtonProps {
  /** `null` when no chat is selected; nothing is drawn at all. */
  chatId: string | null
  /** The chat's working directory, or `null` when it has none. */
  workdir?: string | null | undefined
  /** The chat's members, in `position` order. */
  members: readonly Agent[]
  /** True while a run is in flight; a hand-off cannot join one. */
  running: boolean
  /** Calls `chat.handoff` for this chat. Failures land in the run store. */
  onHandoff: (chatId: string) => void
}

export function HandoffButton({
  chatId,
  workdir,
  members,
  running,
  onHandoff
}: HandoffButtonProps): React.JSX.Element | null {
  const { t } = useTranslation()
  if (chatId === null) return null

  const blocker = handoffBlocker({ workdir, members, running })
  const title = blocker === null ? t('chat.handoffTitle') : validationReasonMessage(t, blocker)

  return (
    <div className="flex shrink-0 justify-end px-7 pt-3">
      <Button
        size="sm"
        data-testid="chat-handoff"
        // The reason is on the element as well as in the tooltip: an end-to-end
        // spec can then assert *why* the button is off without reading copy.
        data-blocked={blocker ?? ''}
        disabled={blocker !== null}
        title={title}
        onClick={() => onHandoff(chatId)}
      >
        <HardHat aria-hidden="true" className="h-3 w-3" />
        {t('chat.handoff')}
      </Button>
    </div>
  )
}
