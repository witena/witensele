/**
 * The mockup's "Actions" card at the foot of the right column, made real.
 *
 * Both actions are **ordinary messages**. "Summarise" opens a small picker and
 * sends `@Name` plus a localized request; "Start a vote" sends `@all` plus its
 * own. Nothing bypasses `chat.send`: the orchestrator schedules the reply, the
 * transcript records what was asked, and the user can see — and edit, next time —
 * exactly the sentence that produced the summary. A dedicated backend path would
 * have been a second way to start a run, and a summary nobody can trace.
 *
 * The prompts are locale keys rather than English constants because the agents
 * answer in the language they are addressed in: a Chinese UI has to ask in
 * Chinese, or the summary comes back in the wrong language.
 *
 * The picker is deliberately a one-level popover and not a dialog: it has at
 * most a handful of rows and it is the same interaction the member panel's "Add"
 * already uses, three centimetres above it.
 */
import { ListChecks, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MENTION_ALL_KEYWORDS } from '@shared/mentions'
import type { Agent } from '@shared/types'
import { Avatar, SectionTitle } from '../ui'

export interface ActionsCardProps {
  /** `null` disables both actions: there is no chat to send into. */
  chatId: string | null
  /** The chat's members; the picker lists them and the vote mentions all of them. */
  members: readonly Agent[]
  /** Sends one composed message through the composer's own send path. */
  onSend: (text: string) => void
}

export function ActionsCard({ chatId, members, onSend }: ActionsCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const [picking, setPicking] = useState(false)
  const card = useRef<HTMLDivElement>(null)

  const enabled = chatId !== null && members.length > 0

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
    </div>
  )
}
