/**
 * The shared transcript → one agent's private view of it.
 *
 * This is the transform "Round barrier and agent sessions" in `docs/PLAN.md`
 * rests on. An agent has **no long-lived conversation object**: before every turn
 * it rebuilds its view from the one message stream, which is what guarantees it
 * has seen every other member's answer so far. The rules:
 *
 * | Source | Becomes |
 * |---|---|
 * | The user's messages | role `user`, prefixed `[User]: ` |
 * | Another agent's messages | role `user`, prefixed `[Name]: ` |
 * | **This** agent's messages | role `assistant`, no prefix |
 * | System notices | role `user`, prefixed `[system]: `, rendered from the key |
 *
 * Two details that look like implementation but are contract:
 *
 * - **Consecutive messages of the same role are merged**, separated by a blank
 *   line. Several providers reject or silently collapse two adjacent user
 *   messages, and three agents answering in one round produce exactly that.
 * - **Empty, `passed` and `skipped` messages are dropped.** A `[PASS]` is a
 *   procedural fact about the round, not content; replaying it teaches the next
 *   speaker that abstaining is normal. The round bookkeeping that needs it lives
 *   in `ChatRunner`, not in the prompt.
 *
 * Nothing here reaches a database, electron or the event bus: it is a pure
 * function of the messages handed to it, which is why the rules above are pinned
 * down by `history.test.ts` rather than by a live run.
 */
import type { ModelMessage } from 'ai'
import type { Agent, Message, MessagePart, SystemNoticePart } from '@shared/types'

/** Name used for the human in the `[name]: ` prefix when the caller has none. */
export const DEFAULT_USER_NAME = 'User'

/** Name backend-authored notices are attributed to. */
export const SYSTEM_SENDER_NAME = 'system'

/** Separator between two merged messages of the same role. */
const MERGE_SEPARATOR = '\n\n'

export interface ToModelMessagesInput {
  /** The agent whose view is being built; its own messages become `assistant`. */
  self: Agent
  /** Every agent that has ever spoken in this chat, by id, for the prefixes. */
  agentsById: Record<string, Agent>
  /** Display name of the human. Defaults to `DEFAULT_USER_NAME`. */
  userName?: string
  /** The whole transcript, oldest first (`MessageRepository.listForContext`). */
  messages: Message[]
}

/**
 * English renderings of the notice keys the backend can store.
 *
 * Deliberately **not** the locale files: those are UI copy owned by the renderer
 * and translated at display time, while this is prompt text that must be stable
 * and is never shown to a human. A key with no rendering here is skipped rather
 * than guessed — an untranslated key in a prompt is worse than a missing line.
 */
const NOTICE_TEXT: Record<string, (params: Record<string, string | number>) => string> = {
  agentSkipped: (params) => `${String(params['agent'] ?? 'An agent')} did not respond and was skipped this round.`,
  runStopped: () => 'The user stopped the previous run.',
  maxRoundsReached: () => 'The automatic round limit was reached; the user has the floor.',
  noMentions: () => 'Nobody was mentioned, so no one answered that message.',
  runFailed: (params) => `The previous run stopped after an error: ${String(params['message'] ?? 'unknown')}`,
  providerError: (params) => `A provider error occurred: ${String(params['message'] ?? 'unknown')}`
}

/** One notice as prompt text, or `null` when the key has no rendering. */
function renderNotice(part: SystemNoticePart): string | null {
  const render = NOTICE_TEXT[part.key]
  return render ? render(part.params ?? {}) : null
}

/**
 * The prompt text of one message's parts.
 *
 * Only `text` and `system-notice` contribute. `reasoning` is deliberately left
 * out — it is the model's scratch pad, it is not part of what the group heard,
 * and feeding it back inflates every later prompt. Tool calls and results become
 * prompt content in S3.1, where the tool loop that produces them lives.
 */
function partsToText(parts: MessagePart[]): string {
  const chunks: string[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text.trim().length > 0) chunks.push(part.text.trim())
      continue
    }
    if (part.type === 'system-notice') {
      const rendered = renderNotice(part)
      if (rendered) chunks.push(rendered)
    }
  }
  return chunks.join(MERGE_SEPARATOR)
}

/** The name a message is attributed to in the `[name]: ` prefix. */
function senderName(message: Message, input: ToModelMessagesInput): string {
  if (message.senderType === 'user') return input.userName ?? DEFAULT_USER_NAME
  if (message.senderType === 'system') return SYSTEM_SENDER_NAME
  return input.agentsById[message.senderId]?.name ?? message.senderId
}

/**
 * Builds the agent's view of the transcript.
 *
 * Returns only `user` and `assistant` messages; the system prompt is assembled
 * separately by `agent-turn.ts` and passed to `streamText` as `system`, because
 * a system message in the `messages` array is not portable across providers.
 */
export function toModelMessages(input: ToModelMessagesInput): ModelMessage[] {
  const { self, messages } = input
  const result: ModelMessage[] = []

  for (const message of messages) {
    // A round's bookkeeping, not its content: see the header.
    if (message.status === 'passed' || message.status === 'skipped') continue

    const text = partsToText(message.parts)
    if (text.length === 0) continue

    const isSelf = message.senderType === 'agent' && message.senderId === self.id
    const role = isSelf ? 'assistant' : 'user'
    const content = isSelf ? text : `[${senderName(message, input)}]: ${text}`

    const previous = result[result.length - 1]
    if (previous && previous.role === role && typeof previous.content === 'string') {
      previous.content = `${previous.content}${MERGE_SEPARATOR}${content}`
      continue
    }

    result.push(role === 'assistant' ? { role, content } : { role, content })
  }

  return result
}
