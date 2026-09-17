/**
 * The group's answer, drawn as the one thing in the transcript that is not just
 * another turn (S5.16).
 *
 * S5.14 already ran a closing turn whose whole job is to state what the group
 * decided, and then drew it as an ordinary message: the same avatar, the same
 * round label, indistinguishable from the four replies above it. This card is
 * the difference — an accent edge, the word "Conclusion", the speaker named
 * underneath, and the two things a user actually wants to do with an answer:
 * take it somewhere else, or have it written to the file this chat exists for.
 *
 * ## What it is not
 *
 * It is **not a second copy** of the conclusion pinned to the top of the chat.
 * The message stays where it happened, in the order it happened, because the
 * transcript is the record and a floating duplicate would be a second thing to
 * keep in step with it. Finding it from the top of a long chat is the header
 * chip's job, which scrolls to this card rather than repeating it.
 *
 * ## The two actions
 *
 * **Copy** writes the message's markdown source — what the model wrote, not what
 * the renderer drew — through the browser clipboard API. That is deliberately
 * not a backend call: the clipboard belongs to the window the user is in, and
 * routing it through `BackendClient` would put a desktop-only capability in the
 * contract a server build has to implement (CLAUDE.md rule #6 is about reaching
 * the *backend* only through that client, and the clipboard is not the backend).
 *
 * **Write to the deliverable** is the S5.12 `deliver` hand-off, offered under
 * exactly the rules the Actions card offers it under (`deliverableBlocker` →
 * `handoffBlocker`), and hidden rather than disabled when the chat has no
 * document goal: a card in a discussion chat should not carry a permanently dead
 * control explaining a feature that chat is not using. When the goal *is* a
 * document and something else is in the way — no folder, no executor, a run in
 * flight — the button is there and disabled with the reason, which is the state
 * the user can act on.
 */
import clsx from 'clsx'
import { Check, Copy, FileDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent, ChatGoal } from '@shared/types'
import { validationReasonMessage } from '../../i18n/errors'
import { deliverableBlocker } from './conclusion'

/** How long the Copy button stays in its "copied" state. */
export const COPIED_FEEDBACK_MS = 2_000

export interface ConclusionCardProps {
  /** The chat this conclusion is in; the hand-off needs it. */
  chatId: string
  /** The member that wrote it, already resolved to a display name. */
  speaker: string
  /** The markdown source, which is what Copy puts on the clipboard. */
  text: string
  /** The chat's members, for the hand-off rule. */
  members: readonly Agent[]
  /** The chat's folder and goal, also for the hand-off rule. */
  workdir?: string | null | undefined
  goal?: ChatGoal | null | undefined
  /** True while a run is in flight; a hand-off cannot join one. */
  running?: boolean
  /** Starts the `deliver` hand-off. Absent means the action is not offered. */
  onWriteDeliverable?: ((chatId: string) => void) | undefined
  /** The conclusion itself, already rendered as markdown by the caller. */
  children: React.ReactNode
}

export function ConclusionCard({
  chatId,
  speaker,
  text,
  members,
  workdir,
  goal,
  running = false,
  onWriteDeliverable,
  children
}: ConclusionCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The row can scroll out of the virtualized list while the feedback is up.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const copy = (): void => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
      },
      // A clipboard the window is not allowed to write to is not worth a red
      // state of its own: nothing was lost, the text is selectable, and the
      // button simply does not say it copied.
      () => setCopied(false)
    )
  }

  const blocker = deliverableBlocker({ workdir, members, running, goal })
  // `handoff_no_deliverable` is the "this chat is not a document" case, and it
  // is the one refusal that makes the action meaningless rather than blocked.
  const offerDeliverable = onWriteDeliverable !== undefined && blocker !== 'handoff_no_deliverable'

  return (
    <section
      data-testid="message-conclusion"
      className="flex flex-col gap-2 rounded-r-lg border-l-2 border-accent bg-bg-elevated py-2.5 pr-3 pl-3"
    >
      <span
        data-testid="conclusion-label"
        className="text-[11px] font-semibold tracking-[0.06em] text-accent uppercase"
      >
        {t('chat.conclusion')}
      </span>

      {children}

      <div className="flex flex-wrap items-center gap-2">
        <span data-testid="conclusion-speaker" className="mr-auto text-[11px] text-fg-faint">
          {t('chat.conclusionBy', { name: speaker })}
        </span>

        <button
          type="button"
          data-testid="conclusion-copy"
          data-copied={copied}
          onClick={copy}
          className={clsx(
            'flex items-center gap-1 rounded border border-border-strong px-1.5 py-0.5 text-[11px]',
            'transition-colors focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
            copied ? 'text-accent' : 'text-fg-dim hover:text-fg'
          )}
        >
          {copied ? (
            <Check aria-hidden="true" className="h-3 w-3 shrink-0" />
          ) : (
            <Copy aria-hidden="true" className="h-3 w-3 shrink-0" />
          )}
          <span>{copied ? t('chat.conclusionCopied') : t('chat.conclusionCopy')}</span>
        </button>

        {offerDeliverable ? (
          <button
            type="button"
            data-testid="conclusion-deliver"
            data-blocked={blocker ?? ''}
            disabled={blocker !== null}
            title={
              blocker === null
                ? t('chat.conclusionDeliverTitle')
                : validationReasonMessage(t, blocker)
            }
            onClick={() => onWriteDeliverable?.(chatId)}
            className="flex items-center gap-1 rounded border border-border-strong px-1.5 py-0.5 text-[11px] text-fg-dim transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:text-fg-dim focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          >
            <FileDown aria-hidden="true" className="h-3 w-3 shrink-0" />
            <span>{t('chat.conclusionDeliver')}</span>
          </button>
        ) : null}
      </div>
    </section>
  )
}
