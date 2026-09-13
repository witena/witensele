/**
 * Live presence, keyed by (chat, agent).
 *
 * Runtime only and deliberately never persisted: presence is a fact about *now*,
 * so a restart starts everyone at the default rather than restoring a green dot
 * for a provider that has since gone down.
 *
 * Two ways in, and they are not redundant:
 *
 * - **`load(chatId)`** seeds the store when a chat is opened. The backend's
 *   supervisor has been running since the app started, so a member may already be
 *   offline before this window ever heard an event about it. One read closes that
 *   gap; without it the panel would show green until the next transition.
 * - **`apply(presence)`** is the `presence.changed` event, fanned in by
 *   `lib/event-bridge.ts`. From the first seed onwards this is the only writer.
 *
 * `retry` is the third: the manual half of the recovery loop behind the offline
 * member's "Retry" button. It resolves with the presence the probe produced, and
 * the backend has emitted the same value as an event — applying the answer as
 * well is harmless and makes the button work even if the event is dropped.
 */
import { create } from 'zustand'
import type { AgentPresence, PresenceState } from '@shared/types'
import { getBackend } from '../lib/backend-provider'

/** What an agent with no presence event yet is shown as. */
export const DEFAULT_PRESENCE: PresenceState = 'available'

/** The composite key; exported so tests and selectors agree on the spelling. */
export function presenceKey(chatId: string, agentId: string): string {
  return `${chatId}:${agentId}`
}

export interface PresenceStoreState {
  byChatAgent: Record<string, AgentPresence>
  /** Agents with a `presence.retry` in flight, keyed the same way. */
  retryingByChatAgent: Record<string, boolean>
  /** Seeds every member of a chat from `presence.list`. Never rejects. */
  load: (chatId: string) => Promise<void>
  apply: (presence: AgentPresence) => void
  /** Probes an offline agent's provider once. Never rejects. */
  retry: (chatId: string, agentId: string) => Promise<void>
  /** Drops a chat's presences, after the chat is deleted. */
  clear: (chatId: string) => void
}

export const usePresenceStore = create<PresenceStoreState>()((set) => ({
  byChatAgent: {},
  retryingByChatAgent: {},

  async load(chatId) {
    try {
      const presences = await getBackend().invoke('presence.list', { chatId })
      set((state) => ({
        byChatAgent: {
          ...state.byChatAgent,
          ...Object.fromEntries(
            presences.map((presence) => [
              presenceKey(presence.chatId, presence.agentId),
              presence
            ])
          )
        }
      }))
    } catch {
      // A dot that stayed at its default is a cosmetic loss; it must never stop
      // the chat from rendering, and the next event repairs it anyway.
    }
  },

  apply(presence) {
    set((state) => ({
      byChatAgent: {
        ...state.byChatAgent,
        [presenceKey(presence.chatId, presence.agentId)]: presence
      }
    }))
  },

  async retry(chatId, agentId) {
    const key = presenceKey(chatId, agentId)
    set((state) => ({ retryingByChatAgent: { ...state.retryingByChatAgent, [key]: true } }))
    try {
      const presence = await getBackend().invoke('presence.retry', { chatId, agentId })
      set((state) => ({ byChatAgent: { ...state.byChatAgent, [key]: presence } }))
    } catch {
      // A failed probe is not an error — the backend answers with the unchanged
      // offline presence — so a rejection here means the call itself failed and
      // the dot simply stays where it was.
    } finally {
      set((state) => {
        const { [key]: _done, ...retryingByChatAgent } = state.retryingByChatAgent
        return { retryingByChatAgent }
      })
    }
  },

  clear(chatId) {
    set((state) => ({
      byChatAgent: Object.fromEntries(
        Object.entries(state.byChatAgent).filter(([, presence]) => presence.chatId !== chatId)
      )
    }))
  }
}))

/** The full presence record for one agent in one chat, or `undefined`. */
export function usePresence(chatId: string | null, agentId: string): AgentPresence | undefined {
  return usePresenceStore((state) =>
    chatId ? state.byChatAgent[presenceKey(chatId, agentId)] : undefined
  )
}

/** The dot colour for one agent in one chat. */
export function useAgentPresence(chatId: string | null, agentId: string): PresenceState {
  return usePresenceStore((state) =>
    chatId
      ? (state.byChatAgent[presenceKey(chatId, agentId)]?.state ?? DEFAULT_PRESENCE)
      : DEFAULT_PRESENCE
  )
}

/** True while this agent's "Retry" button is waiting for its probe. */
export function useIsRetrying(chatId: string | null, agentId: string): boolean {
  return usePresenceStore((state) =>
    chatId ? state.retryingByChatAgent[presenceKey(chatId, agentId)] === true : false
  )
}
