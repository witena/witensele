/**
 * The one place the renderer subscribes to the backend.
 *
 * Every `BackendEvent` arrives on a single channel (`src/shared/events.ts`), so
 * fanning it out is one `switch` in one module rather than a subscription per
 * store. That matters for three reasons:
 *
 * - **Ordering.** `message.created` for the agent and the `message.delta` that
 *   follows it must reach the store in the order the backend sent them; N
 *   independent subscriptions make that a coincidence.
 * - **Lifetime.** One subscription is started once at bootstrap and lives as long
 *   as the window, so no component can leak one by forgetting a cleanup.
 * - **Testability.** A store is a pure reducer over the events this module hands
 *   it, and can be driven directly (see `stores/messages.test.ts`).
 *
 * It is started from `main.tsx` *before* the first render, so an event that lands
 * while the initial `chats.list` is still resolving is not lost.
 */
import type { BackendEvent } from '@shared/events'
import { useChatsStore } from '../stores/chats'
import { useMessagesStore } from '../stores/messages'
import { usePresenceStore } from '../stores/presence'
import { useRunStore } from '../stores/run'
import { getBackend } from './backend-provider'

/** Applies one event to the stores. Exported for the store tests. */
export function applyBackendEvent(event: BackendEvent): void {
  switch (event.type) {
    case 'message.created':
      useMessagesStore.getState().applyCreated(event.message)
      break
    case 'message.delta':
      useMessagesStore.getState().applyDelta(event.chatId, event.messageId, event.delta)
      break
    case 'message.updated':
      useMessagesStore.getState().applyUpdated(event.message)
      break
    case 'chat.updated':
      useChatsStore.getState().applyUpdated(event.chat)
      break
    case 'chat.deleted':
      useChatsStore.getState().applyDeleted(event.chatId)
      useMessagesStore.getState().clear(event.chatId)
      usePresenceStore.getState().clear(event.chatId)
      useRunStore.getState().applyFinished(event.chatId)
      break
    case 'presence.changed':
      usePresenceStore.getState().apply(event.presence)
      break
    case 'run.started':
      useRunStore.getState().applyStarted(event.chatId, event.round)
      break
    case 'run.round':
      useRunStore.getState().applyRound(event.chatId, event.round, event.speakers)
      break
    case 'run.finished':
      useRunStore.getState().applyFinished(event.chatId)
      break
    // `permission.requested` is reserved for the executor agent and `system.test`
    // belongs to the Developer section, which subscribes to it itself.
    default:
      break
  }
}

/** Subscribes to the backend and returns the unsubscribe function. */
export function startEventBridge(): () => void {
  return getBackend().subscribe(applyBackendEvent)
}
