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
import { usePermissionsStore } from '../stores/permissions'
import { usePresenceStore } from '../stores/presence'
import { useRunStore } from '../stores/run'
import { useUsageStore } from '../stores/usage'
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
      // The authoritative status *and usage* of a turn arrive here, so this is
      // the one event that can change what the header and the member rows say
      // about tokens. Recomputed locally from the store rather than re-asked of
      // the backend; see `stores/usage.ts`.
      useUsageStore.getState().recompute(event.message.chatId)
      break
    case 'chat.updated':
      useChatsStore.getState().applyUpdated(event.chat)
      break
    case 'chat.deleted':
      useChatsStore.getState().applyDeleted(event.chatId)
      useMessagesStore.getState().clear(event.chatId)
      usePresenceStore.getState().clear(event.chatId)
      usePermissionsStore.getState().clear(event.chatId)
      useRunStore.getState().applyFinished(event.chatId)
      useUsageStore.getState().clear(event.chatId)
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
    // The executor's permission prompt (S5.4), drawn as a card above the
    // composer (S5.5). `resolved` arrives exactly once per `requested`, on every
    // path, which is what lets the card be dismissed without knowing why.
    case 'permission.requested':
      usePermissionsStore.getState().applyRequested(event)
      break
    case 'permission.resolved':
      usePermissionsStore.getState().applyResolved(event.requestId)
      // An `allowAlways` wrote a `permission_grants` row (S5.15), and the
      // "Always allowed" list in Group settings has to show it without the user
      // reopening the chat. Refreshed from the backend rather than appended
      // locally: the row carries a `createdAt` this side did not choose, and a
      // repeat grant keeps its original one.
      if (event.decision === 'allowAlways') {
        void usePermissionsStore.getState().loadGrants(event.chatId)
      }
      break
    // `system.test` belongs to the Developer section, which subscribes itself.
    default:
      break
  }
}

/** Subscribes to the backend and returns the unsubscribe function. */
export function startEventBridge(): () => void {
  return getBackend().subscribe(applyBackendEvent)
}
