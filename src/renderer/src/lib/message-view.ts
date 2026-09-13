/**
 * The few pure helpers the message list needs, kept out of the components so
 * they can be unit tested and so the same rule is not written twice.
 */
import { stripTrailingPass } from '@shared/pass'
import type { Message } from '@shared/types'

/**
 * The value the backend stores in `Message.error` when the user pressed Stop.
 *
 * Mirrors `ABORTED_ERROR` in `src/main/agents/agent-turn.ts`. It is duplicated
 * rather than imported because `src/main` is not importable from the renderer —
 * the two halves only share `src/shared` — and it is a stored value, so it is
 * part of the data contract rather than of the backend's internals.
 */
export const ABORTED_MESSAGE_ERROR = 'aborted'

/** True when this message ended because the run was stopped, not because it failed. */
export function wasStopped(message: Message): boolean {
  return message.status === 'error' && message.error === ABORTED_MESSAGE_ERROR
}

/**
 * The concatenated text of every `text` part; the body a message renders.
 *
 * A **trailing `[PASS]`** is stripped when there is real content in front of it
 * (S4.3). Small models routinely sign a perfectly good answer off with the
 * protocol token because the briefing taught them it exists; the message is
 * still `done`, it still drives the next round, and the marker is noise in the
 * transcript. A message that is *only* the token is untouched — that one is a
 * real abstention, its status is `passed`, and the row renders the label instead
 * of the body anyway. The stored parts keep what the model actually wrote; see
 * `@shared/pass`.
 */
export function messageText(message: Message): string {
  return stripTrailingPass(
    message.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
  )
}
