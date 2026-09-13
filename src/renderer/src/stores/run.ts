/**
 * Whether a chat is currently running, and the two actions that change that.
 *
 * The state is **entirely derived from `run.*` events**, never from the local
 * `send()` call: the backend decides when a run starts (a message sent during an
 * active run is queued, and starts no second run), so a store that flipped a flag
 * on send would show a Stop button for a run that does not exist.
 *
 * `sending` is separate for that reason — it covers the round trip of `chat.send`
 * itself, which is what disables the composer for the fraction of a second before
 * `run.started` arrives.
 */
import { create } from 'zustand'
import type { BackendErrorCode } from '@shared/types'
import { BackendClientError } from '../lib/backend'
import { getBackend } from '../lib/backend-provider'

/** The live run of one chat, as the renderer knows it. */
export interface ActiveRun {
  round: number
  /** Agent ids speaking in the current round. Empty until `run.round` arrives. */
  speakers: string[]
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function classify(cause: unknown): BackendErrorCode {
  return cause instanceof BackendClientError ? cause.code : 'internal'
}

export interface RunState {
  /** Backend-owned: the run of each chat, or absent when that chat is idle. */
  activeByChat: Record<string, ActiveRun>
  /** Chats with a `chat.send` in flight. Local, and cleared as soon as it resolves. */
  sendingByChat: Record<string, boolean>
  error?: string | undefined
  errorCode?: BackendErrorCode | undefined

  /** Sends a message. Never rejects; a failure lands in `error`. */
  send: (chatId: string, text: string) => Promise<boolean>
  /**
   * Forgets the last failure.
   *
   * The error is a single field rather than one per chat, so switching chats has
   * to drop it: "this chat has no members" must not follow the user into a chat
   * that does.
   */
  clearError: () => void
  /** Aborts the chat's run. Idempotent, and a no-op when nothing is running. */
  stop: (chatId: string) => Promise<void>

  applyStarted: (chatId: string, round: number) => void
  applyRound: (chatId: string, round: number, speakers: string[]) => void
  applyFinished: (chatId: string) => void
}

export const useRunStore = create<RunState>()((set) => ({
  activeByChat: {},
  sendingByChat: {},
  error: undefined,
  errorCode: undefined,

  clearError() {
    set({ error: undefined, errorCode: undefined })
  },

  async send(chatId, text) {
    const trimmed = text.trim()
    if (trimmed.length === 0) return false

    set((state) => ({
      sendingByChat: { ...state.sendingByChat, [chatId]: true },
      error: undefined,
      errorCode: undefined
    }))
    try {
      // The stored message arrives as `message.created` too, so nothing is done
      // with the return value: one path into the transcript, not two.
      await getBackend().invoke('chat.send', { chatId, text: trimmed })
      return true
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause) })
      return false
    } finally {
      set((state) => {
        const { [chatId]: _sending, ...sendingByChat } = state.sendingByChat
        return { sendingByChat }
      })
    }
  },

  async stop(chatId) {
    try {
      await getBackend().invoke('chat.stop', { chatId })
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause) })
    }
    // The authoritative clear is `run.finished`; this only stops the button from
    // sitting there while the abort unwinds.
  },

  applyStarted(chatId, round) {
    set((state) => ({
      activeByChat: { ...state.activeByChat, [chatId]: { round, speakers: [] } }
    }))
  },

  applyRound(chatId, round, speakers) {
    set((state) => ({
      activeByChat: { ...state.activeByChat, [chatId]: { round, speakers } }
    }))
  },

  applyFinished(chatId) {
    set((state) => {
      const { [chatId]: _finished, ...activeByChat } = state.activeByChat
      return { activeByChat }
    })
  }
}))

/** True while the chat has a run in flight, or a send on its way to starting one. */
export function useIsRunning(chatId: string | null): boolean {
  return useRunStore((state) =>
    chatId ? state.activeByChat[chatId] !== undefined || state.sendingByChat[chatId] === true : false
  )
}
