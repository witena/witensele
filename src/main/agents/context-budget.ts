/**
 * Making a transcript fit in the model's context window.
 *
 * PLAN ("One agent turn", "Context overflow") fixes the MVP's policy in one
 * sentence: *estimate tokens by character count and drop the oldest messages
 * first, keeping the system prompt; summarization comes later.* This module is
 * that sentence, and nothing more — no summariser, no embedding, no provider
 * round trip to count tokens exactly.
 *
 * ## Why estimate at all
 *
 * The alternative is to send the request and let the provider refuse it. That
 * costs a round trip, produces an error message in the user's face instead of an
 * answer, and — in a group chat where every agent rebuilds its view of the same
 * growing transcript — happens to *every* member at once, on the same round, for
 * the rest of the conversation. Dropping the oldest few messages is worse than
 * summarising them and much better than the chat simply stopping.
 *
 * ## The estimator
 *
 * `estimateTokens` is a two-bucket character count: **CJK and other wide scripts
 * count as one token each, everything else as a quarter of a token**, rounded up.
 * That is the rule of thumb every tokenizer's documentation states, and it is
 * accurate to roughly ±20% across the models this app talks to — which is all the
 * precision a "drop the oldest" policy can use, because the answer only has to be
 * right about *how many* messages go, not about the exact boundary.
 *
 * It is deliberately not a real tokenizer. `tiktoken` is a WASM blob per encoding
 * and covers OpenAI only; Anthropic, Gemini and every OpenAI-compatible Chinese
 * endpoint all tokenize differently, so the honest choices are "one approximation
 * for everyone" or "an exact count for one vendor and a wrong one for the rest".
 *
 * ## The budget
 *
 * ```
 * available = contextWindow - reserveForOutput - estimate(system)
 * ```
 *
 * `reserveForOutput` is the room the completion needs; the caller passes the
 * agent's own `params.maxTokens` and falls back to `DEFAULT_OUTPUT_RESERVE`,
 * because a prompt that fills the window exactly leaves the model no room to
 * answer and the provider rejects it just the same.
 *
 * Two rules protect the parts of the history that carry the question:
 *
 * - **The last user-role message is never dropped.** It is what the agent was
 *   asked; a turn that answers the round before it is worse than a turn with no
 *   history at all. (`toModelMessages` merges consecutive same-role messages, so
 *   the last `user` entry usually already *contains* the most recent question
 *   plus whatever the other members just said.)
 * - **Something dropped is said out loud.** When anything went, a one-line note
 *   is prepended to the first message that survived, so the model knows its view
 *   starts mid-conversation rather than at the beginning — and `ChatRunner` turns
 *   the same fact into a `contextTruncated` system notice for the user.
 *
 * No electron, no database, no `AppContext`: pure functions of their arguments,
 * which is how `context-budget.test.ts` pins every rule down.
 */
import type { ModelMessage } from 'ai'

/**
 * Completion budget assumed for an agent that sets no `maxTokens`.
 *
 * Generous on purpose. Reserving too little means the *prompt* fits and the
 * answer is cut off mid-sentence, which looks like a bug; reserving too much
 * costs a few of the oldest messages, which looks like nothing.
 */
export const DEFAULT_OUTPUT_RESERVE = 4096

/** The line prepended to the first surviving message when anything was dropped. */
export const TRUNCATION_NOTE = '[Earlier messages were omitted to fit the context window.]'

/**
 * Characters that are worth about one token each: CJK ideographs and kana, Hangul,
 * and the full-width punctuation that comes with them.
 */
const WIDE_SCRIPT =
  /[\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/

/** How many Latin-ish characters make up one token, as every vendor's doc puts it. */
const CHARS_PER_TOKEN = 4

/**
 * Roughly how many tokens a string costs.
 *
 * Never returns 0 for a non-empty string: a message that estimates to nothing
 * would be free to keep, and a thousand of them would blow the budget the loop
 * believes it is enforcing.
 */
export function estimateTokens(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  let wide = 0
  let narrow = 0
  for (const char of text) {
    if (WIDE_SCRIPT.test(char)) wide += 1
    else narrow += 1
  }
  return Math.max(1, wide + Math.ceil(narrow / CHARS_PER_TOKEN))
}

/**
 * The text of a `ModelMessage`, whatever shape its content is in.
 *
 * `toModelMessages` only ever produces string content, but the type allows parts
 * and a future caller may hand us some; serialising them is a worse estimate than
 * counting a string and a far better one than counting zero.
 */
function messageText(message: ModelMessage): string {
  const content: unknown = message.content
  if (typeof content === 'string') return content
  try {
    return JSON.stringify(content) ?? ''
  } catch {
    return ''
  }
}

/** Estimated tokens of one message, plus a small per-message envelope. */
function messageTokens(message: ModelMessage): number {
  // Roles and delimiters cost a handful of tokens per message on every provider;
  // ignoring them makes a long history of short messages read far cheaper than
  // it is.
  return estimateTokens(messageText(message)) + MESSAGE_OVERHEAD_TOKENS
}

/** Per-message envelope (role marker, separators) every chat format adds. */
const MESSAGE_OVERHEAD_TOKENS = 4

export interface FitHistoryInput {
  /** The assembled system prompt. Never dropped, only counted. */
  system: string
  /** The agent's view of the transcript, oldest first. */
  messages: ModelMessage[]
  /** Total tokens the model accepts; see `contextWindowFor` in `@shared/pricing`. */
  contextWindow: number
  /** Room left for the completion. Defaults to `DEFAULT_OUTPUT_RESERVE`. */
  reserveForOutput?: number
}

export interface FitHistoryResult {
  /** What to send, oldest first; the first entry may carry `TRUNCATION_NOTE`. */
  messages: ModelMessage[]
  /** How many messages were removed. `0` means the history fitted as it was. */
  droppedCount: number
  /** Estimated prompt size of the result, system prompt included. */
  estimatedTokens: number
}

/** Index of the last `user` message, or `-1`. That one is never dropped. */
function lastUserIndex(messages: ModelMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index
  }
  return -1
}

/** The note prepended to a message, without losing what it already said. */
function withNote(message: ModelMessage): ModelMessage {
  const content: unknown = message.content
  if (typeof content !== 'string') return message
  return { ...message, content: `${TRUNCATION_NOTE}\n\n${content}` } as ModelMessage
}

/**
 * Drops the oldest messages until the prompt fits, and says so when it had to.
 *
 * Returns the input untouched (`droppedCount: 0`) when it already fitted, which
 * is the overwhelmingly common case — the whole function is a no-op for every
 * chat short enough not to need it.
 */
export function fitHistory(input: FitHistoryInput): FitHistoryResult {
  const reserve = input.reserveForOutput ?? DEFAULT_OUTPUT_RESERVE
  const systemTokens = estimateTokens(input.system)
  // A window smaller than its own system prompt plus reserve leaves no budget at
  // all; clamping at zero makes the loop drop everything it is allowed to drop
  // rather than loop on a negative target.
  const available = Math.max(0, input.contextWindow - reserve - systemTokens)

  const costs = input.messages.map(messageTokens)
  let used = costs.reduce((sum, cost) => sum + cost, 0)

  if (used <= available) {
    return {
      messages: input.messages,
      droppedCount: 0,
      estimatedTokens: systemTokens + used
    }
  }

  const keep = input.messages.slice()
  const keepCosts = costs.slice()
  const protectedIndex = lastUserIndex(input.messages)
  let dropped = 0

  // Oldest first, and never the message the turn is answering.
  for (let index = 0; index < input.messages.length && used > available; index += 1) {
    if (index === protectedIndex) continue
    used -= costs[index] as number
    // Marked rather than spliced, so `protectedIndex` stays meaningful.
    keep[index] = null as unknown as ModelMessage
    keepCosts[index] = 0
    dropped += 1
  }

  const survivors = keep.filter((message): message is ModelMessage => message !== null)
  if (dropped > 0 && survivors.length > 0) {
    const first = survivors[0] as ModelMessage
    const annotated = withNote(first)
    survivors[0] = annotated
    used += estimateTokens(TRUNCATION_NOTE)
  }

  return { messages: survivors, droppedCount: dropped, estimatedTokens: systemTokens + used }
}
