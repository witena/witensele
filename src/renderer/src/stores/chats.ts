/**
 * The chat list: the left column's data, plus the one chat the middle column is
 * showing.
 *
 * Backend-owned, like every other store here: `chats` mirrors `chats.list` and is
 * patched by the `chat.updated` / `chat.deleted` events the handlers emit, never
 * by a local guess. `selectedId` is the exception — it is pure UI state and is
 * deliberately not persisted, so a restart opens on "no chat selected" rather
 * than on whatever was open when the app crashed.
 *
 * `groupChats` lives here rather than in the component because it is the one
 * piece of the column with logic worth testing, and because the search results
 * (S4.3) reuse it: filtering hides rows, it never regroups them, so a filtered
 * column still reads Today / Yesterday / Earlier.
 */
import { create } from 'zustand'
import type {
  BackendErrorCode,
  Chat,
  ChatGoal,
  ChatGoalStatus,
  ChatSettings,
  ValidationReason
} from '@shared/types'
import { BackendClientError } from '../lib/backend'
import { getBackend } from '../lib/backend-provider'
import { relativeToWorkdir } from '../lib/workdir'
import { useAgentsStore } from './agents'

export type ChatsStatus = 'idle' | 'loading' | 'ready' | 'error'

/** The three buckets the mockup's left column is divided into. */
export type ChatGroupId = 'today' | 'yesterday' | 'earlier'

export interface ChatGroup {
  id: ChatGroupId
  chats: Chat[]
}

/** Group order, which is also display order: newest bucket first. */
export const CHAT_GROUP_ORDER: ChatGroupId[] = ['today', 'yesterday', 'earlier']

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function classify(cause: unknown): BackendErrorCode {
  return cause instanceof BackendClientError ? cause.code : 'internal'
}

/**
 * The failing handler's own `details`, when the rejection carried any.
 *
 * Kept beside the code because a `validation` refusal may name *which* rule it
 * broke (`ValidationReason`), and "that folder no longer exists" is a far better
 * line than "the request was rejected as invalid". `i18n/errors.ts` narrows it;
 * the store stores it unread, exactly as it stores `message`.
 */
function detailsOf(cause: unknown): unknown {
  return cause instanceof BackendClientError ? cause.details : undefined
}

/** Local midnight of the day `timestamp` falls in. */
function startOfDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * Buckets chats by `updatedAt` into Today / Yesterday / Earlier.
 *
 * Calendar days in the **viewer's** local timezone, not "within 24 hours": a
 * message sent at 23:50 has to read as yesterday the next morning, not as "23
 * hours ago". Empty groups are omitted so the column never renders a heading
 * with nothing under it, and the order inside a group is the order it was given,
 * which `chats.list` already sorts newest first.
 */
export function groupChats(chats: Chat[], now: number = Date.now()): ChatGroup[] {
  const today = startOfDay(now)
  const yesterday = today - 24 * 60 * 60 * 1000

  const buckets: Record<ChatGroupId, Chat[]> = { today: [], yesterday: [], earlier: [] }
  for (const chat of chats) {
    // A clock change can leave a record stamped slightly in the future; it still
    // belongs at the top rather than in "earlier".
    if (chat.updatedAt >= today) buckets.today.push(chat)
    else if (chat.updatedAt >= yesterday) buckets.yesterday.push(chat)
    else buckets.earlier.push(chat)
  }

  return CHAT_GROUP_ORDER.map((id) => ({ id, chats: buckets[id] })).filter(
    (group) => group.chats.length > 0
  )
}

/**
 * One dialog result as a relative path, or `null` with the refusal recorded.
 *
 * The dialogs cannot be confined to a directory, so "you picked something
 * outside this chat's folder" is a **renderer-side** refusal — there is no
 * backend call to reject it. It is nevertheless reported exactly like one: the
 * same three store fields, carrying a `ValidationReason` the same
 * `translateFailure` turns into the same kind of sentence, in the same
 * `chats-error` line. One failure surface, whoever noticed the failure.
 */
function relativeOrRefuse(
  set: (partial: Partial<ChatsState>) => void,
  workdir: string,
  absolute: string,
  reason: ValidationReason
): string | null {
  const relative = relativeToWorkdir(workdir, absolute)
  if (relative !== null) return relative
  set({
    error: `picked outside the working directory: ${absolute}`,
    errorCode: 'validation',
    errorDetails: { reason }
  })
  return null
}

/** Newest `updatedAt` first, which is the order the backend list arrives in. */
function sortChats(chats: Chat[]): Chat[] {
  return [...chats].sort((a, b) => b.updatedAt - a.updatedAt)
}

export interface ChatsState {
  /** Backend-owned mirror, newest `updatedAt` first. */
  chats: Chat[]
  /**
   * Member agent ids per chat, in speaking order.
   *
   * Kept here rather than in `stores/agents.ts` because membership belongs to the
   * chat: the left column prints "N members" for every row and the right column
   * needs the ids of the selected one. `setMembers` is the only thing that
   * changes it, and it writes through the backend first.
   */
  membersByChat: Record<string, string[]>
  /**
   * Whether each chat's `document` deliverable is on disk, keyed by chat id.
   *
   * Backend-owned and deliberately **not** part of `Chat`: it is a fact about the
   * filesystem, so it is asked for (`chats.goalStatus`) rather than stored, and a
   * chat that has not been asked about simply has no entry — the chip then draws
   * its "not delivered yet" state, which is what it is far more often.
   */
  goalStatusByChat: Record<string, ChatGoalStatus>
  status: ChatsStatus
  /** Developer-facing detail of the last failure; the UI shows translated copy. */
  error?: string | undefined
  errorCode?: BackendErrorCode | undefined
  /** The rejection's `details`, which may name a `ValidationReason`. */
  errorDetails?: unknown
  /** The chat the conversation column is showing. Local UI state. */
  selectedId: string | null
  /** What the left column's search box holds, trimmed. `''` means no filter. */
  searchQuery: string
  /**
   * Ids the current query matched, or `null` when there is no query.
   *
   * `null` rather than "every id" so the list can tell "not filtered" from
   * "filtered, and everything happens to match" — the second needs the empty
   * state when it turns up nothing, the first never does.
   */
  matchIds: string[] | null

  /** Reads the list and every chat's members. Never rejects. */
  load: () => Promise<void>
  /** Reads one chat's members. Never rejects. */
  loadMembers: (chatId: string) => Promise<void>
  /**
   * Creates a chat and selects it. Returns `null` and sets `error` on failure.
   *
   * `memberAgentIds` is what the first-run card passes (S7.5). Without it the
   * backend decides: an empty chat, unless the agent library is empty too, in
   * which case the bootstrap agent is written and added. Once the user owns
   * agents, picking who is in a chat is theirs — which is exactly why the card
   * has to name the agent it just created rather than hope.
   */
  create: (memberAgentIds?: readonly string[]) => Promise<Chat | null>
  rename: (id: string, title: string) => Promise<void>
  /**
   * Replaces a chat's member list, order included.
   *
   * One method for add, remove and reorder because `chats.members.set` replaces
   * the whole list: three actions that each read the current order and write a
   * new one would be three chances to write a stale one.
   */
  setMembers: (chatId: string, agentIds: string[]) => Promise<void>
  /** Merges a patch into a chat's orchestration settings. Persists immediately. */
  updateSettings: (chatId: string, patch: Partial<ChatSettings>) => Promise<void>
  /**
   * Binds the chat to a local folder, or unbinds it with `null`.
   *
   * The backend checks the path against the filesystem, so a folder that has
   * been deleted since it was picked lands in `error` with a `ValidationReason`
   * saying which of the three rules it broke.
   */
  setWorkdir: (chatId: string, workdir: string | null) => Promise<void>
  /**
   * Replaces the chat's goal, or removes it with `null`.
   *
   * The whole object every time, not a field patch: `materials` is a list the
   * user removes from, and a merge could never delete its last entry. The panel
   * therefore composes the new goal from its draft and sends it here.
   */
  setGoal: (chatId: string, goal: ChatGoal | null) => Promise<void>
  /**
   * Opens the native save dialog and returns the picked file **relative to
   * `workdir`**, or `null`.
   *
   * `null` covers both a cancelled dialog and a file the user saved outside the
   * chat's folder; the second also leaves a translated reason in `error`, the
   * first leaves nothing at all. Returning the path rather than writing it is
   * what lets the panel put it in the field the user can still edit before it
   * is saved.
   */
  pickDeliverable: (workdir: string) => Promise<string | null>
  /**
   * Opens the native multi-select dialog and returns the picks relative to
   * `workdir`, dropping — and reporting — any that fell outside it.
   */
  pickMaterials: (workdir: string) => Promise<string[]>
  /** Reads `chats.goalStatus` for one chat. Never rejects. */
  loadGoalStatus: (chatId: string) => Promise<void>
  /**
   * Opens the native folder picker and binds the chat to what came back.
   *
   * Two calls rather than one backend method, for the same reason
   * `stores/skills.ts` imports a folder this way: the dialog is the one thing
   * the backend cannot do without electron, and a cancelled dialog must leave
   * no error behind — it is an answer, not a failure.
   */
  chooseWorkdir: (chatId: string) => Promise<void>
  remove: (id: string) => Promise<void>
  select: (id: string | null) => void
  /**
   * Runs `chats.search` and stores what it matched. Never rejects.
   *
   * The **debounce lives in the page**, not here: the store is a mirror of the
   * backend and a timer inside it would be state the tests cannot see. A blank
   * query short-circuits without an IPC call, because clearing the box is the
   * most common keystroke of all.
   */
  search: (query: string) => Promise<void>

  /** Event handlers, called by `lib/event-bridge.ts`. Upserts by id. */
  applyUpdated: (chat: Chat) => void
  applyDeleted: (chatId: string) => void
}

export const useChatsStore = create<ChatsState>()((set, get) => ({
  chats: [],
  membersByChat: {},
  goalStatusByChat: {},
  status: 'idle',
  error: undefined,
  errorCode: undefined,
  errorDetails: undefined,
  selectedId: null,
  searchQuery: '',
  matchIds: null,

  async load() {
    set({ status: 'loading', error: undefined, errorCode: undefined, errorDetails: undefined })
    try {
      const chats = await getBackend().invoke('chats.list')
      set({
        chats: sortChats(chats),
        status: 'ready',
        error: undefined,
        errorCode: undefined,
        errorDetails: undefined
      })
      // One call per chat. Cheap over local IPC for a desktop-sized list, and the
      // alternative — a member count on `Chat` — would put a derived field in the
      // domain type. S2.2 revisits it if a list ever gets long enough to notice.
      await Promise.all(chats.map((chat) => get().loadMembers(chat.id)))
    } catch (cause) {
      set({ status: 'error', error: describe(cause), errorCode: classify(cause), errorDetails: detailsOf(cause) })
    }
  },

  async loadMembers(chatId) {
    try {
      const members = await getBackend().invoke('chats.members.list', { chatId })
      set((state) => ({
        membersByChat: {
          ...state.membersByChat,
          [chatId]: members.map((member) => member.agentId)
        }
      }))
    } catch {
      // A chat deleted between the list and this call is not an error worth
      // showing: the `chat.deleted` event removes the row a moment later.
    }
  },

  async create(memberAgentIds) {
    try {
      // No title, and members only when the caller named them: `chats.create`
      // fills in both otherwise (see `src/main/handlers/chats.ts`). It rejects
      // with `validation` when no provider has a model, which is the first-run
      // path.
      const chat = await getBackend().invoke('chats.create', {
        input: memberAgentIds ? { memberAgentIds: [...memberAgentIds] } : {}
      })
      get().applyUpdated(chat)
      set({ selectedId: chat.id, error: undefined, errorCode: undefined, errorDetails: undefined })
      await get().loadMembers(chat.id)
      // `chats.create` may have created the bootstrap agent on the way (see
      // `src/main/agents/default-agent.ts`), and the member panel and every
      // message header read the agent list. There is no `agent.created` event —
      // S2.1 gives agents their own UI and their own reload path — so the list is
      // re-read here rather than left a step behind on the very first chat.
      await useAgentsStore.getState().load()
      return chat
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause), errorDetails: detailsOf(cause) })
      return null
    }
  },

  async setMembers(chatId, agentIds) {
    try {
      const members = await getBackend().invoke('chats.members.set', { chatId, agentIds })
      set((state) => ({
        membersByChat: {
          ...state.membersByChat,
          [chatId]: members.map((member) => member.agentId)
        },
        error: undefined,
        errorCode: undefined,
        errorDetails: undefined
      }))
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause), errorDetails: detailsOf(cause) })
      // Re-read rather than keep an optimistic order the backend refused.
      await get().loadMembers(chatId)
    }
  },

  async updateSettings(chatId, patch) {
    try {
      // The handler merges field by field, so a patch of one field is enough and
      // two controls changed in quick succession cannot overwrite each other.
      get().applyUpdated(
        await getBackend().invoke('chats.update', { id: chatId, patch: { settings: patch } })
      )
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause), errorDetails: detailsOf(cause) })
    }
  },

  async setWorkdir(chatId, workdir) {
    try {
      get().applyUpdated(
        await getBackend().invoke('chats.update', { id: chatId, patch: { workdir } })
      )
      set({ error: undefined, errorCode: undefined, errorDetails: undefined })
    } catch (cause) {
      set({
        error: describe(cause),
        errorCode: classify(cause),
        errorDetails: detailsOf(cause)
      })
    }
  },

  async setGoal(chatId, goal) {
    try {
      get().applyUpdated(await getBackend().invoke('chats.update', { id: chatId, patch: { goal } }))
      set({ error: undefined, errorCode: undefined, errorDetails: undefined })
      // The deliverable may have changed, or the goal may have stopped being a
      // document; either way the chip's answer is now stale.
      await get().loadGoalStatus(chatId)
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause), errorDetails: detailsOf(cause) })
    }
  },

  async pickDeliverable(workdir) {
    try {
      const picked = await getBackend().invoke('system.pickSavePath', { defaultDir: workdir })
      // Cancelling is an answer, not a failure, and must leave no error behind.
      if (!picked) return null
      return relativeOrRefuse(set, workdir, picked, 'goal_deliverable_outside_workdir')
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause), errorDetails: detailsOf(cause) })
      return null
    }
  },

  async pickMaterials(workdir) {
    try {
      const picked = await getBackend().invoke('system.pickPaths', { defaultDir: workdir })
      const inside: string[] = []
      for (const absolute of picked) {
        const relative = relativeOrRefuse(set, workdir, absolute, 'goal_material_outside_workdir')
        if (relative !== null) inside.push(relative)
      }
      // The ones that were inside are kept rather than the whole pick being
      // thrown away: a user who selected six files and one of them from another
      // folder meant the six.
      return inside
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause), errorDetails: detailsOf(cause) })
      return []
    }
  },

  async loadGoalStatus(chatId) {
    try {
      const status = await getBackend().invoke('chats.goalStatus', { chatId })
      set((state) => {
        // An answer identical to the one already held writes **nothing** (S5.12).
        // The query is asked far more often since an executor turn became one of
        // its moments — twice per hand-off round, and almost always with the same
        // answer — and a `set` with a fresh object for an unchanged fact would
        // re-render the whole chat page, message list included, in the middle of
        // a reply that is still streaming.
        const held = state.goalStatusByChat[chatId]
        if (held && held.deliverable === status.deliverable && held.delivered === status.delivered) {
          return {}
        }
        return { goalStatusByChat: { ...state.goalStatusByChat, [chatId]: status } }
      })
    } catch {
      // A chat that has just been deleted is the usual case here, and the chip
      // it would have fed is already gone. Nothing to tell the user.
    }
  },

  async chooseWorkdir(chatId) {
    try {
      const picked = await getBackend().invoke('system.pickFolder')
      // Cancelling the dialog is not a decision to unbind: `null` here means
      // "never mind", while `setWorkdir(chatId, null)` is the Clear button.
      if (!picked) return
      await get().setWorkdir(chatId, picked)
    } catch (cause) {
      set({
        error: describe(cause),
        errorCode: classify(cause),
        errorDetails: detailsOf(cause)
      })
    }
  },

  async rename(id, title) {
    const trimmed = title.trim()
    if (trimmed.length === 0) return
    try {
      get().applyUpdated(await getBackend().invoke('chats.update', { id, patch: { title: trimmed } }))
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause), errorDetails: detailsOf(cause) })
    }
  },

  async remove(id) {
    try {
      await getBackend().invoke('chats.delete', { id })
      get().applyDeleted(id)
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause), errorDetails: detailsOf(cause) })
    }
  },

  select(id) {
    set({ selectedId: id })
  },

  async search(query) {
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      set({ searchQuery: '', matchIds: null })
      return
    }
    set({ searchQuery: trimmed })
    try {
      const matchIds = await getBackend().invoke('chats.search', { query: trimmed })
      // A slower answer to an earlier query must not overwrite a newer one.
      if (get().searchQuery === trimmed) set({ matchIds })
    } catch (cause) {
      set({
        error: describe(cause),
        errorCode: classify(cause),
        errorDetails: detailsOf(cause),
        matchIds: []
      })
    }
  },

  applyUpdated(chat) {
    set((state) => {
      const without = state.chats.filter((candidate) => candidate.id !== chat.id)
      return { chats: sortChats([...without, chat]) }
    })
  },

  applyDeleted(chatId) {
    set((state) => {
      const { [chatId]: _members, ...membersByChat } = state.membersByChat
      const { [chatId]: _goalStatus, ...goalStatusByChat } = state.goalStatusByChat
      return {
        chats: state.chats.filter((chat) => chat.id !== chatId),
        membersByChat,
        goalStatusByChat,
        ...(state.selectedId === chatId ? { selectedId: null } : {})
      }
    })
  }
}))

/** Stable empty array, so a selector never hands React a fresh reference. */
const NO_MEMBERS: string[] = []

/**
 * Whether any chat has at least one member — the fact that ends the first-run
 * card (S7.5).
 *
 * A boolean, so the card re-renders when the answer changes rather than on
 * every write that replaced the members map.
 */
export function useHasChatWithMembers(): boolean {
  return useChatsStore((state) =>
    Object.values(state.membersByChat).some((members) => members.length > 0)
  )
}

/** The member agent ids of one chat, in speaking order. */
export function useChatMemberIds(chatId: string | null): string[] {
  return useChatsStore((state) => (chatId ? (state.membersByChat[chatId] ?? NO_MEMBERS) : NO_MEMBERS))
}

/**
 * The folder one chat is bound to, or `null`.
 *
 * A selector rather than a prop threaded down the transcript (S5.7): every
 * message row needs it — for the file chips, the diff headers and the file tool
 * cards — and `MessageItem` already reads the presence store by `chatId` for
 * exactly the same reason. A string is a stable value, so this re-renders a row
 * only when the binding really changes.
 */
export function useChatWorkdir(chatId: string | null): string | null {
  return useChatsStore(
    (state) => (chatId ? (state.chats.find((chat) => chat.id === chatId)?.workdir ?? null) : null)
  )
}

/**
 * Whether one chat's deliverable is on disk, as the header chip needs it.
 *
 * `undefined` until `chats.goalStatus` has answered, which the chip reads as
 * "not delivered" rather than as a third state to draw.
 */
export function useChatGoalStatus(chatId: string | null): ChatGoalStatus | undefined {
  return useChatsStore((state) => (chatId ? state.goalStatusByChat[chatId] : undefined))
}
