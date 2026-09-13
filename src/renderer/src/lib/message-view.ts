/**
 * The few pure helpers the message list needs, kept out of the components so
 * they can be unit tested and so the same rule is not written twice.
 */
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

/** The concatenated text of every `text` part; the body a message renders. */
export function messageText(message: Message): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
}
