/**
 * The three questions the conclusion card, the header chip and the chat list ask
 * about a transcript (S5.16), as pure functions.
 *
 * S5.14 made a discussion stop by itself and hand back an answer; S5.16 makes
 * that answer findable. Everything the UI needs to do so is decided here rather
 * than in the components, because the renderer test suite runs in `node` with no
 * DOM: a rule in a `.ts` module is a unit test, the same rule inside a `.tsx`
 * component is only an end-to-end assertion.
 *
 * - `latestConclusion` — which message is *the* answer. The **latest**, because
 *   a long chat can agree more than once: the user asks, the group closes, the
 *   user asks something else and it closes again. The chip and the preview both
 *   mean "the one that is current", and an earlier conclusion is still in the
 *   transcript with its own card.
 * - `conclusionPreview` — its first line, which is what the chat list shows in
 *   place of the member count. The first line only: a conclusion is several
 *   paragraphs and the row is one line high.
 * - `deliverableBlocker` — whether "Write to the deliverable" can be offered on
 *   the card, which is **exactly** the Actions card's rule (`handoffBlocker`
 *   with `intent: 'deliver'`) rather than a second opinion about it. Two
 *   controls that start the same run must be refused by the same rule, in the
 *   same order, with the same sentence.
 */
import type { Message, ValidationReason } from '@shared/types'
import { messageText } from '../../lib/message-view'
import { handoffBlocker, type HandoffInput } from './handoff'
import { isConclusion } from './transcript-rows'

/** How much of the first line the chat-list preview keeps. */
export const PREVIEW_MAX_CHARS = 120

/**
 * First lines of conclusions, keyed by chat id, as the chat list takes them.
 *
 * A named alias rather than the inline `Record<…>` at the prop, because the
 * i18n guard's JSX heuristic reads a generic argument in a `.tsx` file as a tag
 * and the text after it as a hard-coded string (see `used-keys.test.ts`).
 */
export type ConclusionPreviews = Record<string, string>

/**
 * The most recent conclusion in a transcript, or `null`.
 *
 * Only an **agent** message counts, which is not defensive: the flag is written
 * by `runAgentTurn` and nothing else can produce one, so the check is the same
 * statement the backend makes, kept on both sides of the wire for the day
 * something else tries.
 */
export function latestConclusion(messages: readonly Message[]): Message | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.senderType !== 'agent') continue
    if (isConclusion(message.parts)) return message
  }
  return null
}

/**
 * The first line of the latest conclusion, or `null` when there is none.
 *
 * Blank lines and a leading markdown heading marker are skipped rather than
 * shown: a conclusion that opens with `## What we decided` would otherwise
 * preview as the punctuation. Everything else is left exactly as the model wrote
 * it — it is content, not copy, and the label in front of it is the translated
 * part (`chat.conclusion`).
 */
export function conclusionPreview(messages: readonly Message[]): string | null {
  const conclusion = latestConclusion(messages)
  if (conclusion === null) return null

  const line = messageText(conclusion)
    .split('\n')
    .map((candidate) => candidate.replace(/^#{1,6}\s+/, '').trim())
    .find((candidate) => candidate.length > 0)
  if (line === undefined) return null
  return line.length > PREVIEW_MAX_CHARS ? `${line.slice(0, PREVIEW_MAX_CHARS)}…` : line
}

/**
 * Why the conclusion card cannot offer "Write to the deliverable", or `null`.
 *
 * A wrapper of one line, and the line is the point: the card asks the **same**
 * question the Actions card does, so the two can never disagree about whether a
 * chat can deliver — or about which of the four rules is the reason.
 */
export function deliverableBlocker(input: Omit<HandoffInput, 'intent'>): ValidationReason | null {
  return handoffBlocker({ ...input, intent: 'deliver' })
}
