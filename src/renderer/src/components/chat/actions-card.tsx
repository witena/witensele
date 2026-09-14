/**
 * The mockup's "Actions" card at the foot of the right column, made real.
 *
 * The first two actions are **ordinary messages**. "Summarise" opens a small
 * picker and sends `@Name` plus a localized request; "Start a vote" sends `@all`
 * plus its own. Neither bypasses `chat.send`: the orchestrator schedules the
 * reply, the transcript records what was asked, and the user can see — and edit,
 * next time — exactly the sentence that produced the summary. A dedicated
 * backend path would have been a second way to start a run, and a summary nobody
 * can trace.
 *
 * **"Write the deliverable" (S5.12) is the exception, and it is a deliberate
 * one.** It is a `chat.handoff` with `intent: 'deliver'`, so it schedules the
 * executor alone and then a review round, which no typed message can do — the
 * same backend path "Hand to executor" above the composer takes, with a
 * different instruction. It sits here rather than beside that button because it
 * belongs to the *goal*, which the user sets two blocks up this column, and
 * because a second button of the same weight next to Send would make the moment
 * the discussion ends a choice between two controls. Its refusals are therefore
 * the hand-off's refusals, computed by the same `handoffBlocker` with the same
 * order, and its disabled reason is on the element exactly as that button's is.
 *
 * The prompts are locale keys rather than English constants because the agents
 * answer in the language they are addressed in: a Chinese UI has to ask in
 * Chinese, or the summary comes back in the wrong language.
 *
 * The picker is deliberately a one-level popover and not a dialog: it has at
 * most a handful of rows and it is the same interaction the member panel's "Add"
 * already uses, three centimetres above it.
 */
import { FileDown, ListChecks, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MENTION_ALL_KEYWORDS } from '@shared/mentions'
import type { Agent, ChatGoal } from '@shared/types'
import { validationReasonMessage } from '../../i18n/errors'
import { Avatar, SectionTitle } from '../ui'
import { handoffBlocker } from './handoff'

export interface ActionsCardProps {
  /** `null` disables every action: there is no chat to send into. */
  chatId: string | null
  /** The chat's members; the picker lists them and the vote mentions all of them. */
  members: readonly Agent[]
  /** Sends one composed message through the composer's own send path. */
  onSend: (text: string) => void
  /** The chat's working directory, for the hand-off rules (S5.12). */
  workdir?: string | null | undefined
  /** The chat's goal; "Write the deliverable" needs a `document` one. */
  goal?: ChatGoal | null | undefined
  /** True while a run is in flight; a hand-off cannot join one. */
  running?: boolean
  /** Calls `chat.handoff` with `intent: 'deliver'`. Failures land in the run store. */
  onWriteDeliverable?: (chatId: string) => void
}

export function ActionsCard({
  chatId,
  members,
  onSend,
  workdir,
  goal,
  running = false,
  onWriteDeliverable
}: ActionsCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const [picking, setPicking] = useState(false)
  const card = useRef<HTMLDivElement>(null)

  const enabled = chatId !== null && members.length > 0

  // The same four rules as `chat-handoff`, in the same order, plus the goal:
  // `handoffBlocker` is one function precisely so the two controls cannot
  // disagree about why the executor is unreachable. A chat that is not selected
  // has no rule to fail, so it is reported as the first one that is true of it.
  const deliverBlocker =
    chatId === null
      ? 'handoff_no_workdir'
      : handoffBlocker({ workdir, members, running, intent: 'deliver', goal })

  // Closes on a chat switch and on an outside click, like every other popover
  // on this screen.
  useEffect(() => setPicking(false), [chatId])
  useEffect(() => {
    if (!picking) return undefined
    const close = (event: MouseEvent): void => {
      if (!card.current?.contains(event.target as Node)) setPicking(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [picking])

  const summarize = (agent: Agent): void => {
    setPicking(false)
    onSend(`@${agent.name} ${t('chat.actions.summarizePrompt')}`)
  }

  const vote = (): void => {
    const [everyone] = MENTION_ALL_KEYWORDS
    onSend(`@${everyone as string} ${t('chat.actions.votePrompt')}`)
  }

  return (
    <div
      ref={card}
      className="relative flex flex-col gap-1.5 rounded-lg border border-border-strong p-2.5"
    >
      <SectionTitle level={3}>{t('chat.actions.title')}</SectionTitle>

      {picking ? (
        <div
          data-testid="action-member-picker"
          className="absolute right-2 bottom-full z-10 mb-1 flex w-[248px] flex-col gap-0.5 rounded-lg border border-border-strong bg-bg-elevated p-1.5 shadow-lg"
        >
          {members.map((agent) => (
            <button
              key={agent.id}
              type="button"
              data-testid="action-member"
              data-agent-id={agent.id}
              onClick={() => summarize(agent)}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-bg-hover"
            >
              <Avatar
                text={agent.avatar.text}
                color={agent.avatar.color}
                {...(agent.avatar.textColor ? { textColor: agent.avatar.textColor } : {})}
                size="md"
              />
              <span className="min-w-0 truncate text-[13px] text-fg">{agent.name}</span>
            </button>
          ))}
        </div>
      ) : null}

      <button
        type="button"
        data-testid="action-summarize"
        disabled={!enabled}
        onClick={() => setPicking((open) => !open)}
        className="flex items-center gap-2 rounded px-0.5 py-0.5 text-left text-xs text-fg-dim transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:text-fg-dim focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
      >
        <Sparkles aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0">{t('chat.actions.summarize')}</span>
      </button>

      <button
        type="button"
        data-testid="action-vote"
        disabled={!enabled}
        onClick={vote}
        className="flex items-center gap-2 rounded px-0.5 py-0.5 text-left text-xs text-fg-dim transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:text-fg-dim focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
      >
        <ListChecks aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0">{t('chat.actions.vote')}</span>
      </button>

      {/* S5.12. Disabled, never hidden, and carrying the reason in `data-blocked`
          for the same reason the hand-off button does: a control that vanishes
          teaches nothing, and an end-to-end spec can assert *which* rule applies
          without reading copy. */}
      <button
        type="button"
        data-testid="chat-write-deliverable"
        data-blocked={deliverBlocker ?? ''}
        disabled={deliverBlocker !== null}
        title={
          deliverBlocker === null
            ? t('chat.writeDeliverableTitle')
            : validationReasonMessage(t, deliverBlocker)
        }
        onClick={() => {
          if (chatId !== null) onWriteDeliverable?.(chatId)
        }}
        className="flex items-center gap-2 rounded px-0.5 py-0.5 text-left text-xs text-fg-dim transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:text-fg-dim focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
      >
        <FileDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0">{t('chat.writeDeliverable')}</span>
      </button>
    </div>
  )
}
