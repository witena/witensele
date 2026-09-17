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
 * - **Tool results are replayed, capped at `MAX_TOOL_RESULT_CHARS`.** What a tool
 *   said is part of what the group knows; the whole blob it said it in is not.
 *
 * Nothing here reaches a database, electron or the event bus: it is a pure
 * function of the messages handed to it, which is why the rules above are pinned
 * down by `history.test.ts` rather than by a live run.
 */
import type { ModelMessage } from 'ai'
import { stripTrailingMarkers } from '@shared/markers'
import type { Agent, Message, MessagePart, SystemNoticePart, ToolResultPart } from '@shared/types'

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
  providerError: (params) => `A provider error occurred: ${String(params['message'] ?? 'unknown')}`,
  contextTruncated: (params) =>
    `${String(params['agent'] ?? 'An agent')} could not fit the whole conversation in its context ` +
    `window, so the ${String(params['dropped'] ?? 'oldest')} oldest messages were left out of its view.`,
  toolsUnsupported: (params) =>
    `${String(params['agent'] ?? 'An agent')}'s model cannot use tools, so it answered without them.`,
  allOffline: () => 'Every member of this chat was offline, so nobody answered.',
  // The one notice that is a *request* rather than a report (S5.6): it is the
  // whole content of the message the hand-off button stores, so a key with no
  // rendering here would leave the executor with an empty turn to answer.
  handoff: (params) =>
    `The user handed the discussion to ${String(params['agent'] ?? 'the executor')}: ` +
    'implement the conclusion reached above in the working directory, then report what changed.',
  // The same request for the other hand-off intent (S5.12), and needed here for
  // exactly the same reason: it is the whole content of the message the executor
  // is replying to, so a key with no rendering would hand it an empty turn.
  handoffDeliver: (params) =>
    `The user asked ${String(params['agent'] ?? 'the executor')} to write the deliverable of ` +
    `this chat, ${String(params['path'] ?? 'the goal file')}, now: write the file itself from ` +
    'the conclusion reached above, then report the path.'
}

/**
 * How much of one stored tool result may reach the prompt, in characters.
 *
 * An MCP tool can return a whole file, a directory listing or a JSON blob of
 * thousands of rows. Inside the turn that called it the AI SDK hands the model
 * the full thing, which is correct — that is the answer it asked for. On every
 * **later** turn the same blob would be replayed as history to every member of
 * the chat, on every round, for the rest of the conversation, and would push out
 * the discussion it was gathered for.
 *
 * 4 KB keeps what a result is *about* (the first rows, the shape, the error) and
 * drops the bulk. The database keeps the whole output untouched: the transcript's
 * tool card still expands to everything the server actually said.
 */
export const MAX_TOOL_RESULT_CHARS = 4096

/** Marker appended to a tool result the budget above had to cut. */
const TOOL_RESULT_TRUNCATED = '… [truncated]'

/** A stored tool result as prompt text, capped at `MAX_TOOL_RESULT_CHARS`. */
function toolResultToText(part: ToolResultPart): string {
  const raw =
    typeof part.output === 'string' ? part.output : safeStringify(part.output)
  if (raw.trim().length === 0) return ''
  const body =
    raw.length > MAX_TOOL_RESULT_CHARS
      ? `${raw.slice(0, MAX_TOOL_RESULT_CHARS)}${TOOL_RESULT_TRUNCATED}`
      : raw
  return part.isError ? `[tool error] ${body}` : `[tool result] ${body}`
}

/** `JSON.stringify` that cannot throw on a cycle written by a misbehaving tool. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

/** One notice as prompt text, or `null` when the key has no rendering. */
function renderNotice(part: SystemNoticePart): string | null {
  const render = NOTICE_TEXT[part.key]
  return render ? render(part.params ?? {}) : null
}

/**
 * The prompt text of one message's parts.
 *
 * `text`, `system-notice` and `tool-result` contribute. `reasoning` is
 * deliberately left out — it is the model's scratch pad, it is not part of what
 * the group heard, and feeding it back inflates every later prompt. A
 * `tool-call` is left out too: its *result* is the fact worth replaying, and
 * repeating the arguments doubles the cost of every tool the chat ever used.
 * A `conclusion` (S5.16) is left out because it is a **flag**: the model reads
 * the conclusion's text like any other message and must never be shown the mark
 * the UI puts on it, or it learns to write one.
 *
 * Two rules applied while rendering:
 *
 * - A **trailing `[PASS]`** is stripped from text that has real content in front
 *   of it (S4.3, `@shared/markers`). Replaying the marker teaches every later
 *   speaker that signing off with it is how a normal answer ends.
 * - A **tool result is capped** at `MAX_TOOL_RESULT_CHARS`; see that constant.
 */
function partsToText(parts: MessagePart[]): string {
  const chunks: string[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      const text = stripTrailingMarkers(part.text).trim()
      if (text.length > 0) chunks.push(text)
      continue
    }
    if (part.type === 'tool-result') {
      const rendered = toolResultToText(part)
      if (rendered.length > 0) chunks.push(rendered)
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
