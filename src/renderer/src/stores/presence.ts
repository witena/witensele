/**
 * Live presence, keyed by (chat, agent).
 *
 * Runtime only and deliberately never persisted: presence is a fact about *now*,
 * so a restart starts everyone at the default rather than restoring a green dot
 * for a provider that has since gone down.
 *
 * S1.7 emits only `working` and `available`, around each turn. S2.4 adds the
 * supervisor that drives `away` and `offline` from its heartbeat; nothing in this
 * store or in the components that read it changes when it does.
 */
import { create } from 'zustand'
import type { AgentPresence, PresenceState } from '@shared/types'

/** What an agent with no presence event yet is shown as. */
export const DEFAULT_PRESENCE: PresenceState = 'available'

/** The composite key; exported so tests and selectors agree on the spelling. */
export function presenceKey(chatId: string, agentId: string): string {
  return `${chatId}:${agentId}`
}

export interface PresenceStoreState {
  byChatAgent: Record<string, AgentPresence>
  apply: (presence: AgentPresence) => void
  /** Drops a chat's presences, after the chat is deleted. */
  clear: (chatId: string) => void
}

export const usePresenceStore = create<PresenceStoreState>()((set) => ({
  byChatAgent: {},

  apply(presence) {
    set((state) => ({
      byChatAgent: {
        ...state.byChatAgent,
        [presenceKey(presence.chatId, presence.agentId)]: presence
      }
    }))
  },

  clear(chatId) {
    set((state) => ({
      byChatAgent: Object.fromEntries(
        Object.entries(state.byChatAgent).filter(([, presence]) => presence.chatId !== chatId)
      )
    }))
  }
}))

/** The dot colour for one agent in one chat. */
export function useAgentPresence(chatId: string | null, agentId: string): PresenceState {
  return usePresenceStore((state) =>
    chatId ? (state.byChatAgent[presenceKey(chatId, agentId)]?.state ?? DEFAULT_PRESENCE) : DEFAULT_PRESENCE
  )
}
