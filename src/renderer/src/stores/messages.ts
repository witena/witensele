/**
 * The transcript, one array per chat, oldest first.
 *
 * This is the store where the event contract actually bites. `message.delta`
 * carries an **increment**, never the whole message, and the append rules in
 * `src/shared/events.ts` have to be followed exactly or a streaming reply comes
 * out duplicated or truncated:
 *
 * - `text` / `reasoning`: append to the last part **of that kind**; if the last
 *   part is of a different kind, start a new one.
 * - `part`: push a whole new part (a tool call, a result, a notice).
 *
 * `message.updated` then replaces the message wholesale and is authoritative for
 * status, usage and error — which is what makes a dropped delta a cosmetic
 * problem rather than a wrong transcript.
 *
 * Every update is immutable (new arrays, new objects) because zustand hands the
 * same reference back to React otherwise and the list does not re-render.
 */
import { create } from 'zustand'
import type { MessageDelta } from '@shared/events'
import type { BackendErrorCode, Message, MessagePart } from '@shared/types'
import { BackendClientError } from '../lib/backend'
import { getBackend } from '../lib/backend-provider'

export type MessagesStatus = 'idle' | 'loading' | 'ready' | 'error'

/** How many messages the first page asks for; paging upwards arrives in S2.5. */
export const MESSAGE_PAGE_SIZE = 100

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function classify(cause: unknown): BackendErrorCode {
  return cause instanceof BackendClientError ? cause.code : 'internal'
}

/**
 * Applies one delta to a parts array, returning a new array.
 *
 * Exported so `messages.test.ts` can assert the append rules without a store.
 */
export function applyDeltaToParts(parts: MessagePart[], delta: MessageDelta): MessagePart[] {
  if (delta.kind === 'part') return [...parts, delta.part]

  const last = parts[parts.length - 1]
  if (last && last.type === delta.kind) {
    const merged: MessagePart = { type: delta.kind, text: last.text + delta.text }
    return [...parts.slice(0, -1), merged]
  }
  return [...parts, { type: delta.kind, text: delta.text }]
}

export interface MessagesState {
  /** Backend-owned mirror, oldest first, keyed by chat id. */
  byChat: Record<string, Message[]>
  /**
   * True when `byChat[chatId]` is the **whole** transcript rather than a page of
   * it — the first page came back shorter than `MESSAGE_PAGE_SIZE`.
   *
   * `stores/usage.ts` is what needs it: a chat total recomputed from a page
   * would silently report only the recent half of a long conversation, so the
   * usage store recomputes locally when this is true and asks the backend again
   * when it is not.
   */
  complete: Record<string, boolean>
  status: Record<string, MessagesStatus>
  error?: string | undefined
  errorCode?: BackendErrorCode | undefined

  /** Reads the first page for a chat. Never rejects. */
  load: (chatId: string) => Promise<void>
  /** Forgets a chat's transcript, after the chat itself is deleted. */
  clear: (chatId: string) => void

  applyCreated: (message: Message) => void
  applyDelta: (chatId: string, messageId: string, delta: MessageDelta) => void
  applyUpdated: (message: Message) => void
}

/** Replaces the message with the same id, or appends it. Order is preserved. */
function upsert(messages: Message[], message: Message): Message[] {
  const index = messages.findIndex((candidate) => candidate.id === message.id)
  if (index === -1) return [...messages, message]
  return messages.map((candidate, at) => (at === index ? message : candidate))
}

export const useMessagesStore = create<MessagesState>()((set) => ({
  byChat: {},
  complete: {},
  status: {},
  error: undefined,
  errorCode: undefined,

  async load(chatId) {
    set((state) => ({ status: { ...state.status, [chatId]: 'loading' } }))
    try {
      const page = await getBackend().invoke('messages.list', {
        chatId,
        limit: MESSAGE_PAGE_SIZE
      })
      // The contract is newest first (it is a paging cursor API); the view reads
      // oldest first, so the reversal happens once, here.
      set((state) => ({
        byChat: { ...state.byChat, [chatId]: [...page].reverse() },
        // A full page means there may be older messages behind the cursor.
        complete: { ...state.complete, [chatId]: page.length < MESSAGE_PAGE_SIZE },
        status: { ...state.status, [chatId]: 'ready' },
        error: undefined,
        errorCode: undefined
      }))
    } catch (cause) {
      set((state) => ({
        status: { ...state.status, [chatId]: 'error' },
        error: describe(cause),
        errorCode: classify(cause)
      }))
    }
  },

  clear(chatId) {
    set((state) => {
      const { [chatId]: _messages, ...byChat } = state.byChat
      const { [chatId]: _status, ...status } = state.status
      const { [chatId]: _complete, ...complete } = state.complete
      return { byChat, complete, status }
    })
  },

  applyCreated(message) {
    set((state) => ({
      byChat: {
        ...state.byChat,
        // Upsert rather than push: `chat.send` resolves with the same message the
        // event carries, and the two can arrive in either order.
        [message.chatId]: upsert(state.byChat[message.chatId] ?? [], message)
      }
    }))
  },

  applyDelta(chatId, messageId, delta) {
    set((state) => {
      const messages = state.byChat[chatId]
      if (!messages) return {}
      let changed = false
      const next = messages.map((message) => {
        if (message.id !== messageId) return message
        changed = true
        return { ...message, parts: applyDeltaToParts(message.parts, delta) }
      })
      // A delta for a message this renderer never saw created: ignore it and wait
      // for `message.updated`, which is authoritative anyway.
      return changed ? { byChat: { ...state.byChat, [chatId]: next } } : {}
    })
  },

  applyUpdated(message) {
    set((state) => ({
      byChat: {
        ...state.byChat,
        [message.chatId]: upsert(state.byChat[message.chatId] ?? [], message)
      }
    }))
  }
}))

/** The transcript of one chat, or an empty array. Stable enough for a selector. */
const EMPTY: Message[] = []

export function useChatMessages(chatId: string | null): Message[] {
  return useMessagesStore((state) => (chatId ? (state.byChat[chatId] ?? EMPTY) : EMPTY))
}
