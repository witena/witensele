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
import type { BackendErrorCode, Chat, ChatSettings } from '@shared/types'
import { BackendClientError } from '../lib/backend'
import { getBackend } from '../lib/backend-provider'
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
  status: ChatsStatus
  /** Developer-facing detail of the last failure; the UI shows translated copy. */
  error?: string | undefined
  errorCode?: BackendErrorCode | undefined
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
  /** Creates a chat and selects it. Returns `null` and sets `error` on failure. */
  create: () => Promise<Chat | null>
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
  status: 'idle',
  error: undefined,
  errorCode: undefined,
  selectedId: null,
  searchQuery: '',
  matchIds: null,

  async load() {
    set({ status: 'loading', error: undefined, errorCode: undefined })
    try {
      const chats = await getBackend().invoke('chats.list')
      set({ chats: sortChats(chats), status: 'ready', error: undefined, errorCode: undefined })
      // One call per chat. Cheap over local IPC for a desktop-sized list, and the
      // alternative — a member count on `Chat` — would put a derived field in the
      // domain type. S2.2 revisits it if a list ever gets long enough to notice.
      await Promise.all(chats.map((chat) => get().loadMembers(chat.id)))
    } catch (cause) {
      set({ status: 'error', error: describe(cause), errorCode: classify(cause) })
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

  async create() {
    try {
      // No title and no members: `chats.create` fills in both (see
      // `src/main/handlers/chats.ts`). It rejects with `validation` when no
      // provider has a model, which is the first-run path.
      const chat = await getBackend().invoke('chats.create', { input: {} })
      get().applyUpdated(chat)
      set({ selectedId: chat.id, error: undefined, errorCode: undefined })
      await get().loadMembers(chat.id)
      // `chats.create` may have created the bootstrap agent on the way (see
      // `src/main/agents/default-agent.ts`), and the member panel and every
      // message header read the agent list. There is no `agent.created` event —
      // S2.1 gives agents their own UI and their own reload path — so the list is
      // re-read here rather than left a step behind on the very first chat.
      await useAgentsStore.getState().load()
      return chat
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause) })
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
        errorCode: undefined
      }))
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause) })
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
      set({ error: describe(cause), errorCode: classify(cause) })
    }
  },

  async rename(id, title) {
    const trimmed = title.trim()
    if (trimmed.length === 0) return
    try {
      get().applyUpdated(await getBackend().invoke('chats.update', { id, patch: { title: trimmed } }))
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause) })
    }
  },

  async remove(id) {
    try {
      await getBackend().invoke('chats.delete', { id })
      get().applyDeleted(id)
    } catch (cause) {
      set({ error: describe(cause), errorCode: classify(cause) })
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
      set({ error: describe(cause), errorCode: classify(cause), matchIds: [] })
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
      return {
        chats: state.chats.filter((chat) => chat.id !== chatId),
        membersByChat,
        ...(state.selectedId === chatId ? { selectedId: null } : {})
      }
    })
  }
}))

/** Stable empty array, so a selector never hands React a fresh reference. */
const NO_MEMBERS: string[] = []

/** The member agent ids of one chat, in speaking order. */
export function useChatMemberIds(chatId: string | null): string[] {
  return useChatsStore((state) => (chatId ? (state.membersByChat[chatId] ?? NO_MEMBERS) : NO_MEMBERS))
}
