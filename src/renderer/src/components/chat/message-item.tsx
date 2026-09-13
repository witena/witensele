/**
 * One message in the transcript: the mockup's `.msg` row.
 *
 * Avatar with its presence dot, then a body column holding the header line
 * (name, model badge, timestamp) and the parts. The layout mirrors the artboard
 * exactly — 28px avatar, 12px gap, 6px between the header and the body — because
 * this row is repeated dozens of times per screen and is where a few pixels of
 * drift is most visible.
 *
 * The four states the row has to carry, all of them from `Message.status`:
 *
 * | Status | Rendering |
 * |---|---|
 * | `streaming` | a blinking accent cursor after the text |
 * | `done` | plain |
 * | `passed` | the whole row dimmed, with the abstention label instead of the body |
 * | `error` | a red hint under whatever text arrived, saying stopped or failed |
 *
 * `skipped` renders like `passed` (dimmed) and gets its own label; the supervisor
 * that produces it lands in S2.4.
 *
 * The presence dot shows the agent's **current** state, not its state when the
 * message was sent (PLAN, "Presence dots"), which is why it comes from the
 * presence store by agent id rather than from the message.
 *
 * The header line also carries the round and, from S2.3, **who the reply
 * answers**: `Message.inReplyTo` holds the agent ids whose previous-round
 * messages mentioned this agent, plus the literal `user`. The names are resolved
 * against the agents store rather than stored, because an agent can be renamed
 * long after the message was written.
 */
import clsx from 'clsx'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { MentionMember } from '@shared/mentions'
import type { Agent, Message, MessagePart, PresenceState, ReasoningPart } from '@shared/types'
import { translateNotice } from '../../i18n/notices'
import { messageText, wasStopped } from '../../lib/message-view'
import { useAgent, useAgentsStore } from '../../stores/agents'
import { useAgentPresence } from '../../stores/presence'
import { Avatar, Badge } from '../ui'
import { Markdown } from './markdown'

/** Literal `t()` calls so the used-keys guard can see every status label. */
function statusLabel(t: TFunction, message: Message): string | null {
  switch (message.status) {
    case 'passed':
      return t('chat.passed')
    case 'skipped':
      return t('chat.skipped')
    case 'error':
      return wasStopped(message) ? t('chat.stopped') : t('chat.failed')
    default:
      return null
  }
}

/** Literal `t()` calls again, for the same reason. Total over `PresenceState`. */
function presenceLabel(t: TFunction, state: PresenceState): string {
  switch (state) {
    case 'available':
      return t('presence.available')
    case 'working':
      return t('presence.working')
    case 'away':
      return t('presence.away')
    case 'offline':
      return t('presence.offline')
  }
}

/** `10:42` in the viewer's locale, which is what the mockup's header line shows. */
function formatTime(timestamp: number, language: string): string {
  return new Date(timestamp).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
}

/**
 * The human's avatar colours, from the mockup's green tile. Referenced as CSS
 * variables rather than hex because `Avatar` takes a colour *string* — the agent
 * records supply their own — and a literal here would be the one colour in the
 * shell that is not a token.
 */
const USER_AVATAR_COLOR = 'var(--color-avatar-user)'
const USER_AVATAR_TEXT_COLOR = 'var(--color-avatar-user-fg)'

/**
 * One or two characters for a monogram.
 *
 * `You` has to become `Y`, but the Chinese translation of the same word is a
 * single character that is already the whole monogram and must not be cut — so a
 * label of one or two characters is kept as it is and a longer one is reduced to
 * its first character.
 */
function monogram(label: string): string {
  return label.length <= 2 ? label : (label.slice(0, 1).toUpperCase() || '?')
}

const isReasoning = (part: MessagePart): part is ReasoningPart => part.type === 'reasoning'

/** The literal `Message.inReplyTo` carries for the human. */
const USER_SOURCE = 'user'

export interface MessageItemProps {
  message: Message
  /** The chat the message is in; the presence dot is per (chat, agent). */
  chatId: string
  /** The chat's members; their names are what gets highlighted in the body. */
  members?: readonly Agent[]
}

export function MessageItem({ message, chatId, members = [] }: MessageItemProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [reasoningOpen, setReasoningOpen] = useState(false)

  const isUser = message.senderType === 'user'
  const agent = useAgent(isUser ? undefined : message.senderId)
  const agents = useAgentsStore((state) => state.agents)
  const presence = useAgentPresence(chatId, message.senderId)

  const mentionMembers: MentionMember[] = members.map((member) => ({
    agentId: member.id,
    name: member.name
  }))
  // "@Ada, @Bob" — one string, so the sentence stays translatable as a whole.
  const replyingTo = (message.inReplyTo ?? [])
    .map((id) =>
      id === USER_SOURCE
        ? `@${t('common.you')}`
        : `@${agents.find((candidate) => candidate.id === id)?.name ?? id}`
    )
    .join(', ')

  const you = t('common.you')
  const name = isUser ? you : (agent?.name ?? message.senderId)
  const avatarText = isUser ? monogram(you) : (agent?.avatar.text ?? monogram(name))

  const text = messageText(message)
  const reasoning = message.parts.filter(isReasoning).map((part) => part.text).join('')
  const notices = message.parts.filter((part) => part.type === 'system-notice')
  const label = statusLabel(t, message)
  const dimmed = message.status === 'passed' || message.status === 'skipped'

  return (
    <article
      data-testid="message-item"
      data-sender={message.senderType}
      data-status={message.status}
      // `data-*` rather than rendered copy, so the end-to-end specs can assert on
      // the round and the author without depending on the active language.
      data-round={message.round}
      data-author={name}
      className={clsx('flex gap-3', dimmed && 'opacity-50')}
    >
      <Avatar
        text={avatarText}
        {...(isUser
          ? { color: USER_AVATAR_COLOR, textColor: USER_AVATAR_TEXT_COLOR }
          : agent
            ? { color: agent.avatar.color }
            : {})}
        size="md"
        // `self-start`: the row is a flex container, so without it the avatar
        // stretches to the full height of the message and the overlaid presence
        // dot — positioned against the wrapper's bottom edge — floats away from it.
        className="self-start"
        // Only agents carry a presence dot: the user is always here.
        {...(isUser ? {} : { presence, presenceLabel: presenceLabel(t, presence) })}
      />

      <div className="flex min-w-0 grow flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold text-fg">{name}</span>
          {agent ? <Badge>{agent.modelId}</Badge> : null}
          {message.round > 0 ? (
            <span className="text-fg-faint">{t('chat.round', { round: message.round })}</span>
          ) : null}
          {replyingTo.length > 0 ? (
            <span data-testid="message-replying-to" className="text-fg-faint">
              {t('chat.replyingTo', { names: replyingTo })}
            </span>
          ) : null}
          <span className="text-fg-faint">{formatTime(message.createdAt, i18n.language)}</span>
        </div>

        {reasoning.length > 0 ? (
          <div className="flex flex-col gap-1">
            <button
              type="button"
              data-testid="message-reasoning-toggle"
              aria-expanded={reasoningOpen}
              onClick={() => setReasoningOpen((open) => !open)}
              className="flex w-fit items-center gap-1 rounded text-[11px] text-fg-dim hover:text-fg"
            >
              <ChevronRight
                aria-hidden="true"
                className={clsx('h-3 w-3 transition-transform', reasoningOpen && 'rotate-90')}
              />
              {t('chat.reasoning')}
            </button>
            {reasoningOpen ? (
              <pre
                data-testid="message-reasoning"
                className="overflow-x-auto rounded-lg border border-border-strong bg-bg-elevated p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-dim"
              >
                {reasoning}
              </pre>
            ) : null}
          </div>
        ) : null}

        {notices.map((part, index) => (
          <p
            key={index}
            data-testid="message-notice"
            // The key, not the sentence: an end-to-end spec asserting on copy
            // would break the moment a translation is reworded.
            data-notice-key={part.type === 'system-notice' ? part.key : undefined}
            className="text-xs text-fg-dim"
          >
            {part.type === 'system-notice' ? translateNotice(t, part) : null}
          </p>
        ))}

        {text.length > 0 && !dimmed ? (
          <div data-testid="message-text">
            <Markdown mentions={mentionMembers}>{text}</Markdown>
            {message.status === 'streaming' ? (
              <span
                data-testid="message-cursor"
                aria-hidden="true"
                className="ml-0.5 inline-block h-3.5 w-[7px] -mb-0.5 animate-pulse bg-accent align-text-bottom"
              />
            ) : null}
          </div>
        ) : null}

        {/* A streaming message with nothing in it yet still needs the cursor, or
            the row looks like it failed for the first second of every reply. */}
        {text.length === 0 && message.status === 'streaming' ? (
          <span
            data-testid="message-cursor"
            aria-hidden="true"
            className="inline-block h-3.5 w-[7px] animate-pulse bg-accent"
          />
        ) : null}

        {label ? (
          <p
            data-testid="message-status-label"
            className={clsx('text-xs', message.status === 'error' ? 'text-danger' : 'text-fg-dim')}
          >
            {label}
          </p>
        ) : null}
      </div>
    </article>
  )
}
