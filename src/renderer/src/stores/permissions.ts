/**
 * The executor's open permission prompts, and the one call that answers them.
 *
 * The backend suspends a `write_file`, `edit_file`, `run_command` or
 * side-effecting MCP call inside `PermissionGate.ask` and emits
 * `permission.requested`; the turn stays suspended until this store's `reply`
 * reaches `permission.reply`, or until `permission.resolved` says the prompt
 * ended some other way. So this is not a cache of backend state — it is the only
 * thing standing between a model and the user's files, and every rule below
 * exists because of that.
 *
 * - **Keyed by `requestId`**, which is the id the reply has to carry. Several
 *   prompts can be open at once: a parallel round has two executors of two chats
 *   waiting, and each one draws its own card.
 * - **`permission.resolved` is the only way a card disappears**, whatever the
 *   `decision` says. `aborted` is a Stop or a shutdown closing a prompt nobody
 *   answered, and the user must not be left clicking Allow on a call that no
 *   longer exists.
 * - **A failed reply drops the card too.** `permission.reply` rejects with
 *   `not_found` when nothing is waiting on that id — answered twice, or closed
 *   by a stop whose event this window missed. That is not an error to show; it
 *   means the card is stale, and the only correct thing to do with a stale
 *   permission prompt is to stop offering it.
 * - **Nothing is optimistic.** The card is not removed when Allow is clicked,
 *   only when the backend says the prompt is over; `replying` disables the
 *   buttons in between. Removing it early would show the user a chat with no
 *   pending prompt while the tool was still deciding.
 *
 * `seq` rather than `Date.now()` for the ordering: two prompts raised in the same
 * millisecond still have to draw in the order they arrived, and the oldest one is
 * the one that takes the keyboard.
 */
import { create } from 'zustand'
import type { PermissionRequestedEvent } from '@shared/events'
import type { CommandRisk, PermissionDecision, PermissionGrant } from '@shared/types'
import { getBackend } from '../lib/backend-provider'

/** One prompt waiting for an answer, as the card reads it. */
export interface PendingPermission {
  requestId: string
  chatId: string
  agentId: string
  /** The tool's own name: `write_file`, or an MCP tool without its server prefix. */
  toolName: string
  /** The tool arguments exactly as the model produced them. Never summarised. */
  input: unknown
  /**
   * The command policy's verdict for a `run_command` prompt (S5.15).
   *
   * Absent for every other tool and for a command the policy called `normal`.
   * The card draws a warning row and hides "Always allow" when it is
   * `dangerous` — hides rather than disables, because the button would do
   * nothing: the gate ignores a grant for exactly these calls.
   */
  risk?: CommandRisk | undefined
  /** Arrival order, so the oldest card is unambiguous. */
  seq: number
}

export interface PermissionsState {
  /** Open prompts, keyed by the id a reply must carry. */
  pending: Record<string, PendingPermission>
  /** Request ids with a `permission.reply` in flight; their buttons are disabled. */
  replyingById: Record<string, boolean>
  /** Monotonic arrival counter. Exposed only so a test can reset it. */
  seq: number
  /**
   * Each chat's standing "always allow" grants, newest first (S5.15).
   *
   * Keyed by chat and loaded on demand, because the list is drawn in one panel
   * of one chat: loading every chat's grants at startup would be a query per
   * chat for a row almost none of them have.
   */
  grantsByChat: Record<string, PermissionGrant[]>

  /** `permission.requested`, fanned in by `lib/event-bridge.ts`. */
  applyRequested: (event: PermissionRequestedEvent) => void
  /** `permission.resolved`: the prompt is over, however it ended. */
  applyResolved: (requestId: string) => void
  /** Answers one prompt. Never rejects; a refusal drops the stale card. */
  reply: (requestId: string, decision: PermissionDecision) => Promise<void>
  /** Reads one chat's grants from the backend. Never rejects. */
  loadGrants: (chatId: string) => Promise<void>
  /** Forgets one grant and redraws the list from what the backend answers. */
  revokeGrant: (chatId: string, toolName: string) => Promise<void>
  /** Drops a chat's prompts and grants, after that chat is deleted. */
  clear: (chatId: string) => void
}

/** Removes one entry from a record without mutating it. */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record
  return rest
}

export const usePermissionsStore = create<PermissionsState>()((set, get) => ({
  pending: {},
  replyingById: {},
  seq: 0,
  grantsByChat: {},

  applyRequested(event) {
    set((state) => ({
      seq: state.seq + 1,
      pending: {
        ...state.pending,
        [event.requestId]: {
          requestId: event.requestId,
          chatId: event.chatId,
          agentId: event.agentId,
          toolName: event.toolName,
          input: event.input,
          ...(event.risk ? { risk: event.risk } : {}),
          seq: state.seq + 1
        }
      }
    }))
  },

  applyResolved(requestId) {
    set((state) => ({
      pending: without(state.pending, requestId),
      replyingById: without(state.replyingById, requestId)
    }))
  },

  async reply(requestId, decision) {
    if (get().replyingById[requestId] === true) return
    set((state) => ({ replyingById: { ...state.replyingById, [requestId]: true } }))
    try {
      await getBackend().invoke('permission.reply', { requestId, decision })
      // The card goes away on `permission.resolved`, which the gate emits before
      // this call returns. Nothing to do here on success.
    } catch {
      // `not_found`: nothing is waiting on this id any more. The card is stale,
      // and a stale permission prompt must stop being offered rather than sit
      // there with an error under it.
      set((state) => ({
        pending: without(state.pending, requestId),
        replyingById: without(state.replyingById, requestId)
      }))
    } finally {
      set((state) => ({ replyingById: without(state.replyingById, requestId) }))
    }
  },

  async loadGrants(chatId) {
    try {
      const grants = await getBackend().invoke('permissions.grants.list', { chatId })
      set((state) => ({ grantsByChat: { ...state.grantsByChat, [chatId]: grants } }))
    } catch {
      // A chat that was deleted while the panel was open. An empty list is the
      // honest answer and the panel's own empty state says the rest.
      set((state) => ({ grantsByChat: { ...state.grantsByChat, [chatId]: [] } }))
    }
  },

  async revokeGrant(chatId, toolName) {
    try {
      const grants = await getBackend().invoke('permissions.grants.revoke', { chatId, toolName })
      // The backend's remaining list, never an optimistic splice: a grant the
      // user believes they revoked and did not is the exact failure this step
      // exists to remove.
      set((state) => ({ grantsByChat: { ...state.grantsByChat, [chatId]: grants } }))
    } catch {
      await get().loadGrants(chatId)
    }
  },

  clear(chatId) {
    set((state) => {
      const dropped = Object.values(state.pending)
        .filter((request) => request.chatId === chatId)
        .map((request) => request.requestId)
      const hadGrants = chatId in state.grantsByChat
      if (dropped.length === 0 && !hadGrants) return {}
      return {
        pending: Object.fromEntries(
          Object.entries(state.pending).filter(([, request]) => request.chatId !== chatId)
        ),
        replyingById: Object.fromEntries(
          Object.entries(state.replyingById).filter(([id]) => !dropped.includes(id))
        ),
        // The rows themselves are gone by then — `chat_id` cascades — so keeping
        // the cache would be the one place in the app claiming otherwise.
        grantsByChat: Object.fromEntries(
          Object.entries(state.grantsByChat).filter(([id]) => id !== chatId)
        )
      }
    })
  }
}))

/** One chat's open prompts, oldest first — the order the cards are stacked in. */
export function pendingForChat(
  pending: Record<string, PendingPermission>,
  chatId: string | null
): PendingPermission[] {
  if (!chatId) return []
  return Object.values(pending)
    .filter((request) => request.chatId === chatId)
    .sort((left, right) => left.seq - right.seq)
}

/** The hook form of `pendingForChat`, for the page that draws the cards. */
export function usePendingPermissions(chatId: string | null): PendingPermission[] {
  const pending = usePermissionsStore((state) => state.pending)
  return pendingForChat(pending, chatId)
}

/** True while this prompt's answer is on its way to the backend. */
export function useIsReplying(requestId: string): boolean {
  return usePermissionsStore((state) => state.replyingById[requestId] === true)
}

/** One empty array for every chat that has no grants, so the selector is stable. */
const NO_GRANTS: PermissionGrant[] = []

/** One chat's standing grants, newest first (S5.15). */
export function useGrants(chatId: string | null): PermissionGrant[] {
  return usePermissionsStore((state) =>
    chatId ? (state.grantsByChat[chatId] ?? NO_GRANTS) : NO_GRANTS
  )
}
