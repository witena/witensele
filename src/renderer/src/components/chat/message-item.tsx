/**
 * One message in the transcript: the mockup's `.msg` row.
 *
 * Avatar with its presence dot, then a body column holding the header line
 * (name, model badge, round, "replying to @who", timestamp) and the parts. The
 * layout mirrors the artboard exactly — 28px avatar, 12px gap, 6px between the
 * header and the body, 8px between the header's own items — because this row is
 * repeated dozens of times per screen and is where a few pixels of drift is most
 * visible.
 *
 * The four states the row has to carry, all of them from `Message.status`:
 *
 * | Status | Rendering |
 * |---|---|
 * | `streaming` | a blinking accent cursor after the text |
 * | `done` | plain |
 * | `passed` / `skipped` | the whole row dimmed, with the label instead of the body |
 * | `error` | a red hint under whatever text arrived, saying stopped or failed |
 *
 * The presence dot shows the agent's **current** state, not its state when the
 * message was sent (PLAN, "Presence dots"), which is why it comes from the
 * presence store by agent id rather than from the message. Only *agent* messages
 * carry one: the human is always present, and a system notice has no provider
 * that could be offline.
 *
 * ## System notices
 *
 * A `senderType: 'system'` message is not a participant speaking, so it is not
 * drawn as one: no avatar, no name, no timestamp — a single centred dimmed line
 * across the column, the way every chat client marks "X left the room". It keeps
 * `data-notice-key` so the end-to-end specs can assert on which notice it is
 * without depending on the active language.
 *
 * ## Reasoning
 *
 * Collapsed behind a toggle that shows a one-line preview, because reasoning is
 * context for an answer and not the answer. While it is *streaming* — reasoning
 * has arrived and the text part has not started — it is auto-expanded and
 * pulsing, so the user can see the agent is thinking rather than stuck; the
 * moment the first text token lands it collapses again. A manual toggle wins
 * over both: once the user has said what they want, the stream stops deciding.
 *
 * ## Tool calls
 *
 * `tool-call` and `tool-result` parts render as `ToolCard`, paired by
 * `toolCallId` in `collectToolCalls`. No tool exists until S3.1; the renderer
 * handles the parts now so the first real call is visible on the day it happens.
 *
 * ## Diffs and file references (S5.5, S5.7)
 *
 * A `diff` part is one file the executor changed, drawn as a collapsed
 * `DiffBlock` under the tool cards and above the agent's own summary — the
 * summary is what should be read first, the diffs are what it is about. A
 * `file-ref` part is a `path:line` chip. Both come from `transcript-rows.ts`.
 *
 * Since S5.7 all four surfaces of a row open a file in the editor — the chip, the
 * diff header, a file tool card's "open" icon, and a path the detector found in
 * the body text — and all four need the same two values: the chat's id, which
 * confines the path server-side, and its working directory, which absolutises a
 * relative one. The id is already a prop; the folder is read from the chats store
 * by id, the way the presence dot is, rather than threaded through `MessageList`.
 * A chat with no folder simply draws none of it.
 */
import clsx from 'clsx'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { MentionMember } from '@shared/mentions'
import { estimateCost, formatCost, formatTokens } from '@shared/pricing'
import type {
  Agent,
  Message,
  MessagePart,
  PresenceState,
  Provider,
  ReasoningPart,
  SystemNoticePart
} from '@shared/types'
import { translateNotice } from '../../i18n/notices'
import { messageText, wasStopped } from '../../lib/message-view'
import { useAgent, useAgentsStore } from '../../stores/agents'
import { useChatGoal, useChatWorkdir } from '../../stores/chats'
import { useAgentPresence } from '../../stores/presence'
import { useProvidersStore } from '../../stores/providers'
import { useIsRunning, useRunStore } from '../../stores/run'
import { Avatar, Badge } from '../ui'
import { avatarStyle, isExecutor } from '../agents/agent-display'
import { ConclusionCard } from './conclusion-card'
import { DiffBlock } from './diff-block'
import { FileRefChip } from './file-ref-chip'
import { Markdown } from './markdown'
import { ToolCard } from './tool-card'
import { collectToolCalls } from './tool-call'
import { collectDiffs, collectFileRefs } from './transcript-rows'

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
 * The human's avatar colours, from the mockup's green tile.
 *
 * A pair of tokens rather than a pair of hexes, for the reason every tile is one
 * since S5.17: an avatar has to follow the appearance, and the user's is the one
 * tile with no record to hold a palette index. Agents' tiles come from
 * `avatarStyle`, which resolves their index (or their stored legacy colour) to
 * the same kind of `var(--color-avatar-…)` reference.
 */
const USER_AVATAR_COLOR = 'var(--color-avatar-user)'
const USER_AVATAR_TEXT_COLOR = 'var(--color-avatar-user-fg)'

/** How much reasoning the collapsed toggle previews. One line, never wrapped. */
const REASONING_PREVIEW_CHARS = 90

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
const isNotice = (part: MessagePart): part is SystemNoticePart => part.type === 'system-notice'

/** The first line of the reasoning, short enough to sit beside the toggle. */
function reasoningPreview(reasoning: string): string {
  const line = reasoning.replace(/\s+/g, ' ').trim()
  return line.length > REASONING_PREVIEW_CHARS
    ? `${line.slice(0, REASONING_PREVIEW_CHARS)}…`
    : line
}

/** The literal `Message.inReplyTo` carries for the human. */
const USER_SOURCE = 'user'

/**
 * What this one turn cost, as the model badge's tooltip (S4.1).
 *
 * A tooltip rather than a visible column: the numbers matter when a user is
 * hunting for the expensive agent and are pure noise the rest of the time, and
 * this row is repeated dozens of times per screen. Returns `undefined` for a
 * message the provider reported no usage for — a streaming one, an abstention, a
 * turn that failed before the first token — so the badge keeps no tooltip at all
 * rather than one saying zero.
 */
function usageTooltip(
  t: TFunction,
  message: Message,
  agent: Agent | undefined,
  providers: readonly Provider[]
): string | undefined {
  if (!message.usage) return undefined
  const input = formatTokens(message.usage.inputTokens)
  const output = formatTokens(message.usage.outputTokens)
  const preset = agent
    ? providers.find((candidate) => candidate.id === agent.providerId)?.presetId
    : undefined
  const cost = agent ? estimateCost({ modelId: agent.modelId, presetId: preset }, message.usage) : null
  // A zero is a local model, which costs nothing; saying `$0.00` would be
  // technically true and read as "we could not work it out".
  return cost !== null && cost > 0
    ? t('chat.messageUsageWithCost', { input, output, cost: formatCost(cost) })
    : t('chat.messageUsage', { input, output })
}

export interface MessageItemProps {
  message: Message
  /** The chat the message is in; the presence dot is per (chat, agent). */
  chatId: string
  /** The chat's members; their names are what gets highlighted in the body. */
  members?: readonly Agent[]
  /**
   * True when this message is the group's conclusion (S5.16).
   *
   * Decided by the row model (`transcript-rows.ts`) and passed in, rather than
   * re-read from the parts here: the same value drives the list's own decisions,
   * and one reading of the flag is one place to change.
   */
  conclusion?: boolean
}

export function MessageItem({
  message,
  chatId,
  members = [],
  conclusion = false
}: MessageItemProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  // `null` means "the stream decides"; a boolean means the user has decided.
  const [reasoningOverride, setReasoningOverride] = useState<boolean | null>(null)

  const isUser = message.senderType === 'user'
  const isSystem = message.senderType === 'system'
  // Only an agent has presence. The human is always here, and a system notice is
  // written by the app itself — a dot on either would be claiming something.
  const isAgent = message.senderType === 'agent'
  const agent = useAgent(isUser || isSystem ? undefined : message.senderId)
  const agents = useAgentsStore((state) => state.agents)
  const providers = useProvidersStore((state) => state.providers)
  const presence = useAgentPresence(chatId, message.senderId)
  const workdir = useChatWorkdir(chatId)
  // Read by the conclusion card's hand-off rule only, and by the same route the
  // folder already takes: a selector by chat id rather than a prop threaded
  // through the virtualized list (S5.16).
  const goal = useChatGoal(chatId)
  const running = useIsRunning(chatId)

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
  const notices = message.parts.filter(isNotice)
  const toolCalls = collectToolCalls(message.parts)
  const diffs = collectDiffs(message.parts)
  const fileRefs = collectFileRefs(message.parts)
  const label = statusLabel(t, message)
  const dimmed = message.status === 'passed' || message.status === 'skipped'
  const usageHint = usageTooltip(t, message, agent, providers)

  // Reasoning is arriving and the answer has not started: show it, pulsing.
  const reasoningStreaming =
    message.status === 'streaming' && reasoning.length > 0 && text.length === 0
  const reasoningOpen = reasoningOverride ?? reasoningStreaming

  if (isSystem) {
    return (
      <article
        data-testid="message-item"
        data-sender={message.senderType}
        data-status={message.status}
        data-round={message.round}
        className="flex flex-col items-center gap-1 py-0.5"
      >
        {notices.map((part, index) => (
          <p
            key={index}
            data-testid="message-notice"
            // The notice key, not the sentence: an end-to-end spec asserting on
            // copy would break the moment a translation is reworded. It lives on
            // this one element only — a second copy on the `<article>` would make
            // every `[data-notice-key=…]` selector match twice.
            data-notice-key={part.key}
            className="max-w-[80%] text-center text-[11px] text-fg-faint"
          >
            {translateNotice(t, part)}
          </p>
        ))}
        {notices.length === 0 && text.length > 0 ? (
          <p data-testid="message-notice" className="max-w-[80%] text-center text-[11px] text-fg-faint">
            {text}
          </p>
        ) : null}
      </article>
    )
  }

  return (
    <article
      data-testid="message-item"
      data-sender={message.senderType}
      data-status={message.status}
      // `data-*` rather than rendered copy, so the end-to-end specs can assert on
      // the round and the author without depending on the active language.
      data-round={message.round}
      data-author={name}
      // `opacity-70`, not the `opacity-50` S2.x shipped: at half strength a
      // passed row's name measured 3.26:1 in the light theme and its model line
      // 2.17:1 — under the floor for *any* meaningful pixel, in both themes
      // (S5.17). Dimming is still unmistakable at 70% because a normal row is
      // 13:1 or better; it just no longer crosses into unreadable.
      className={clsx('flex gap-3', dimmed && 'opacity-70')}
    >
      <Avatar
        text={avatarText}
        {...(isUser
          ? { color: USER_AVATAR_COLOR, textColor: USER_AVATAR_TEXT_COLOR }
          : agent
            ? avatarStyle(agent.avatar)
            : {})}
        size="md"
        // `self-start`: the row is a flex container, so without it the avatar
        // stretches to the full height of the message and the overlaid presence
        // dot — positioned against the wrapper's bottom edge — floats away from it.
        className="self-start"
        {...(isAgent
          ? {
              presence,
              presenceLabel: presenceLabel(t, presence),
              presenceTestId: 'message-presence'
            }
          : {})}
      />

      <div className="flex min-w-0 grow flex-col gap-1.5">
        <div
          data-testid="message-header"
          className="flex flex-wrap items-center gap-2 text-xs leading-4"
        >
          <span className="font-semibold text-fg">{name}</span>
          {agent ? (
            <Badge
              data-testid="message-model"
              {...(usageHint ? { title: usageHint } : {})}
            >
              {agent.modelId}
            </Badge>
          ) : null}
          {/* The one member allowed to change things (S5.2). It belongs on every
              message rather than only in the member panel: reading a transcript
              afterwards, "who wrote to the disk" is the first question. */}
          {agent && isExecutor(agent) ? (
            <Badge
              tone="accent"
              font="sans"
              data-testid="message-executor"
              title={t('agents.executorBadgeTitle')}
            >
              {t('agents.executorBadge')}
            </Badge>
          ) : null}
          {message.round > 0 ? (
            <span data-testid="message-round" className="text-fg-faint">
              {t('chat.round', { round: message.round })}
            </span>
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
              onClick={() => setReasoningOverride(!reasoningOpen)}
              className={clsx(
                'flex w-full items-center gap-1 rounded text-left text-[11px] text-fg-dim hover:text-fg',
                reasoningStreaming && 'animate-pulse'
              )}
            >
              <ChevronRight
                aria-hidden="true"
                className={clsx(
                  'h-3 w-3 shrink-0 transition-transform',
                  reasoningOpen && 'rotate-90'
                )}
              />
              <span className="shrink-0">{t('chat.reasoning')}</span>
              {!reasoningOpen ? (
                <span data-testid="message-reasoning-preview" className="truncate text-fg-faint">
                  {reasoningPreview(reasoning)}
                </span>
              ) : null}
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

        {toolCalls.map((call) => (
          <ToolCard key={call.toolCallId} call={call} chatId={chatId} workdir={workdir} />
        ))}

        {diffs.map((part, index) => (
          <DiffBlock key={`${part.path}-${index}`} part={part} chatId={chatId} workdir={workdir} />
        ))}

        {fileRefs.length > 0 ? (
          <div data-testid="message-file-refs" className="flex flex-wrap items-center gap-1.5">
            {fileRefs.map((part, index) => (
              <FileRefChip
                key={`${part.path}-${part.line ?? ''}-${index}`}
                part={part}
                chatId={chatId}
                workdir={workdir}
              />
            ))}
          </div>
        ) : null}

        {notices.map((part, index) => (
          <p
            key={index}
            data-testid="message-notice"
            data-notice-key={part.key}
            className="text-xs text-fg-dim"
          >
            {translateNotice(t, part)}
          </p>
        ))}

        {text.length > 0 && !dimmed ? (
          conclusion ? (
            // S5.16: the same body, inside the card that says it is the answer.
            // The `message-text` node stays exactly where it was, so everything
            // written against it keeps working.
            <ConclusionCard
              chatId={chatId}
              speaker={name}
              text={text}
              members={members}
              workdir={workdir}
              goal={goal}
              running={running}
              onWriteDeliverable={(id) => void useRunStore.getState().handoff(id, 'deliver')}
            >
              <div data-testid="message-text">
                <Markdown mentions={mentionMembers} workdir={workdir} chatId={chatId}>
                  {text}
                </Markdown>
              </div>
            </ConclusionCard>
          ) : (
            <div data-testid="message-text">
              <Markdown mentions={mentionMembers} workdir={workdir} chatId={chatId}>
                {text}
              </Markdown>
              {message.status === 'streaming' ? (
                <span
                  data-testid="message-cursor"
                  aria-hidden="true"
                  className="ml-0.5 inline-block h-3.5 w-[7px] -mb-0.5 animate-pulse bg-accent align-text-bottom"
                />
              ) : null}
            </div>
          )
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

        {/* The operator-facing detail behind a failure. Not translated: it is the
            provider's own words, and a translated HTTP error helps nobody. */}
        {message.status === 'error' && !wasStopped(message) && message.error ? (
          <p data-testid="message-error-detail" className="text-[11px] text-danger">
            {message.error}
          </p>
        ) : null}
      </div>
    </article>
  )
}
