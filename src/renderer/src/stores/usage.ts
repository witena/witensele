/**
 * Token totals and estimated cost, per chat.
 *
 * The header prints `12.4k tokens · $0.04` and every member row prints that
 * agent's share of it, both of which have to be correct **while a run is going**
 * — three agents over three rounds is nine numbers changing. Asking the backend
 * after each of them would be nine IPC round trips for arithmetic the renderer
 * can already do, so:
 *
 * | When | Where the number comes from |
 * |---|---|
 * | A chat is opened | `messages.usageSummary`, over the **whole** transcript |
 * | A message finishes (`message.updated`) | recomputed here, from the messages store |
 *
 * The seed exists because the messages store holds a *page* (`MESSAGE_PAGE_SIZE`),
 * and a chat older than that page would otherwise report only its recent half.
 * `recompute` therefore only recomputes when the store is known to hold the whole
 * transcript (`useMessagesStore.complete`); when it does not, it asks the backend
 * again rather than quietly undercounting.
 *
 * The arithmetic itself is `summarizeUsage` from `@shared/usage` — the same
 * function the handler runs — so the two answers cannot drift.
 */
import { create } from 'zustand'
import type { Agent, BackendErrorCode, Provider } from '@shared/types'
import {
  emptyUsageSummary,
  summarizeUsage,
  type ChatUsageSummary,
  type ResolvePricedModel
} from '@shared/usage'
import { BackendClientError } from '../lib/backend'
import { getBackend } from '../lib/backend-provider'
import { useAgentsStore } from './agents'
import { useMessagesStore } from './messages'
import { useProvidersStore } from './providers'

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function classify(cause: unknown): BackendErrorCode {
  return cause instanceof BackendClientError ? cause.code : 'internal'
}

/**
 * Agent id → the (model, preset) pair `estimateCost` prices.
 *
 * The preset comes from the agent's **provider**, which is what makes an Ollama
 * model free and the same weights behind a hosted endpoint not. An agent or
 * provider that has since been deleted resolves to `undefined`: its tokens still
 * count, its cost is simply unknown.
 */
export function pricedModels(
  agents: readonly Agent[],
  providers: readonly Provider[]
): ResolvePricedModel {
  return (agentId) => {
    const agent = agents.find((candidate) => candidate.id === agentId)
    if (!agent) return undefined
    const provider = providers.find((candidate) => candidate.id === agent.providerId)
    return { modelId: agent.modelId, presetId: provider?.presetId }
  }
}

export interface UsageState {
  /** The latest summary per chat id. Absent means "not read yet". */
  byChat: Record<string, ChatUsageSummary>
  error?: string | undefined
  errorCode?: BackendErrorCode | undefined

  /** Reads the authoritative summary for a chat. Never rejects. */
  load: (chatId: string) => Promise<void>
  /**
   * Recomputes a chat's summary from the transcript the messages store holds,
   * falling back to `load` when that transcript is only a page of a longer one.
   */
  recompute: (chatId: string) => void
  /** Forgets a chat's summary, after the chat itself is deleted. */
  clear: (chatId: string) => void
}

export const useUsageStore = create<UsageState>()((set, get) => ({
  byChat: {},
  error: undefined,
  errorCode: undefined,

  async load(chatId) {
    try {
      const summary = await getBackend().invoke('messages.usageSummary', { chatId })
      set((state) => ({
        byChat: { ...state.byChat, [chatId]: summary },
        error: undefined,
        errorCode: undefined
      }))
    } catch (cause) {
      // A chat deleted between the click and this call is not worth a red line:
      // `chat.deleted` removes the column a moment later.
      set({ error: describe(cause), errorCode: classify(cause) })
    }
  },

  recompute(chatId) {
    const messages = useMessagesStore.getState().byChat[chatId]
    if (!messages) return
    if (!useMessagesStore.getState().complete[chatId]) {
      void get().load(chatId)
      return
    }
    const resolve = pricedModels(
      useAgentsStore.getState().agents,
      useProvidersStore.getState().providers
    )
    set((state) => ({ byChat: { ...state.byChat, [chatId]: summarizeUsage(messages, resolve) } }))
  },

  clear(chatId) {
    set((state) => {
      const { [chatId]: _summary, ...byChat } = state.byChat
      return { byChat }
    })
  }
}))

/** Stable empty summary, so a selector never hands React a fresh reference. */
const EMPTY = emptyUsageSummary()

/** One chat's usage summary, or an empty one. */
export function useChatUsage(chatId: string | null): ChatUsageSummary {
  return useUsageStore((state) => (chatId ? (state.byChat[chatId] ?? EMPTY) : EMPTY))
}
