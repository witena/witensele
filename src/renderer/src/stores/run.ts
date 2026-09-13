/**
 * Whether a chat is currently running, and the three actions that change that:
 * `send`, `handoff` (S5.6) and `stop`.
 *
 * The state is **entirely derived from `run.*` events**, never from the local
 * `send()` call: the backend decides when a run starts (a message sent during an
 * active run joins that run at its next round boundary and starts no second one),
 * so a store that flipped a flag on send would show a Stop button for a run that
 * does not exist.
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
  /** 1-based and monotonic for the whole run; the backend never resets it. */
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

/**
 * The `details` a refusal carried, or `undefined`.
 *
 * Kept beside the code because a `validation` on this store can now be one of
 * three hand-off rules (S5.6), and `translateFailure` needs the identifier in
 * `details` to say which — the generic "the request was rejected as invalid"
 * would be the one sentence that helps nobody here.
 */
function detailsOf(cause: unknown): unknown {
  return cause instanceof BackendClientError ? cause.details : undefined
}

export interface RunState {
  /** Backend-owned: the run of each chat, or absent when that chat is idle. */
  activeByChat: Record<string, ActiveRun>
  /** Chats with a `chat.send` in flight. Local, and cleared as soon as it resolves. */
  sendingByChat: Record<string, boolean>
  error?: string | undefined
  errorCode?: BackendErrorCode | undefined
  /** `BackendError.details` of the last failure; narrowed by `translateFailure`. */
  errorDetails?: unknown

  /**
   * Sends a message. Never rejects; a failure lands in `error`.
   *
   * `mentions` are the agent ids the composer resolved from what was typed. The
   * backend parses the text again with the same function (`@shared/mentions`),
   * so they are a hint rather than the source of truth — but they are what lets
   * a future autocomplete name a member the plain text does not spell out.
   */
  send: (chatId: string, text: string, mentions?: string[]) => Promise<boolean>
  /**
   * Hands the chat to its executor (S5.6). Never rejects; a refusal lands in
   * `error` / `errorCode` / `errorDetails`, which is what the composer prints.
   *
   * It goes through the run store rather than the chats store because what it
   * starts is a **run**: the Stop button, the round status and this call are the
   * same piece of state, and the three refusals are read with the same
   * `translateFailure` the composer already uses for a failed send.
   */
  handoff: (chatId: string) => Promise<boolean>
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
  errorDetails: undefined,

  clearError() {
    set({ error: undefined, errorCode: undefined, errorDetails: undefined })
  },

  async send(chatId, text, mentions) {
    const trimmed = text.trim()
    if (trimmed.length === 0) return false

    set((state) => ({
      sendingByChat: { ...state.sendingByChat, [chatId]: true },
      error: undefined,
      errorCode: undefined,
      errorDetails: undefined
    }))
    try {
      // The stored message arrives as `message.created` too, so nothing is done
      // with the return value: one path into the transcript, not two.
      await getBackend().invoke('chat.send', {
        chatId,
        text: trimmed,
        ...(mentions && mentions.length > 0 ? { mentions } : {})
      })
      return true
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause), errorDetails: detailsOf(cause) })
      return false
    } finally {
      set((state) => {
        const { [chatId]: _sending, ...sendingByChat } = state.sendingByChat
        return { sendingByChat }
      })
    }
  },

  async handoff(chatId) {
    // `sendingByChat` covers this call too: it is what keeps the button (and the
    // composer) from starting a second run in the fraction of a second before
    // `run.started` arrives, and the disabled state is then one rule, not two.
    set((state) => ({
      sendingByChat: { ...state.sendingByChat, [chatId]: true },
      error: undefined,
      errorCode: undefined,
      errorDetails: undefined
    }))
    try {
      // The stored hand-off message arrives as `message.created`, like a sent
      // one, so the return value is deliberately dropped here as well.
      await getBackend().invoke('chat.handoff', { chatId })
      return true
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause), errorDetails: detailsOf(cause) })
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
      set({ error: describe(cause), errorCode: classify(cause), errorDetails: detailsOf(cause) })
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
