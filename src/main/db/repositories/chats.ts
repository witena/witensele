/**
 * Chat records and their membership list.
 *
 * Two things beyond CRUD live here:
 *
 * - **Ordering.** `list` returns newest `updatedAt` first, which is the order the
 *   left column shows. `updatedAt` is bumped by the message repository whenever a
 *   message lands, so an active chat floats to the top on its own.
 * - **Membership.** `setMembers` replaces the whole list in one transaction and
 *   derives `position` from the array index, so the speaking order is exactly the
 *   order the caller passed and can never end up with gaps or duplicates.
 */
import { and, asc, desc, eq } from 'drizzle-orm'
import type { Chat, ChatInput, ChatMember, UserId } from '@shared/types'
import { DEFAULT_CHAT_SETTINGS, LOCAL_USER_ID } from '@shared/types'
import type { DrizzleDb } from '../database'
import type { ChatRow } from '../schema'
import { agents, chatMembers, chats } from '../schema'
import { notFound, validation } from '../../errors'
import { newId, now } from './common'

/**
 * Title a chat starts with. Stored content rather than UI copy, so it is not an
 * i18n key; S1.3 onwards lets the renderer pass its own title on creation and
 * S4.3 replaces it with a generated one.
 */
export const DEFAULT_CHAT_TITLE = 'New chat'

export interface ChatRepository {
  /** Newest `updatedAt` first. */
  list(userId?: UserId): Chat[]
  get(id: string, userId?: UserId): Chat
  /** Missing fields fall back to `DEFAULT_CHAT_TITLE` and `DEFAULT_CHAT_SETTINGS`. */
  create(input?: Partial<ChatInput>, userId?: UserId): Chat
  update(id: string, patch: Partial<ChatInput>, userId?: UserId): Chat
  /** Cascades to `chat_members` and `messages`. */
  delete(id: string, userId?: UserId): void
  /** Replaces the whole member list; the array index becomes `position`. */
  setMembers(userId: UserId, chatId: string, agentIds: string[]): ChatMember[]
  /** Members of a chat ordered by `position`. */
  listMembers(chatId: string, userId?: UserId): ChatMember[]
}

function toChat(row: ChatRow): Chat {
  return {
    id: row.id,
    userId: row.userId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    title: row.title,
    workdir: row.workdir,
    settings: row.settings
  }
}

export function createChatRepository(db: DrizzleDb): ChatRepository {
  function row(id: string, userId: UserId): ChatRow {
    const found = db
      .select()
      .from(chats)
      .where(and(eq(chats.id, id), eq(chats.userId, userId)))
      .get()
    if (!found) throw notFound('chat', id)
    return found
  }

  function members(chatId: string): ChatMember[] {
    return db
      .select()
      .from(chatMembers)
      .where(eq(chatMembers.chatId, chatId))
      .orderBy(asc(chatMembers.position))
      .all()
  }

  return {
    list(userId = LOCAL_USER_ID) {
      return db
        .select()
        .from(chats)
        .where(eq(chats.userId, userId))
        .orderBy(desc(chats.updatedAt))
        .all()
        .map(toChat)
    },

    get(id, userId = LOCAL_USER_ID) {
      return toChat(row(id, userId))
    },

    create(input = {}, userId = LOCAL_USER_ID) {
      const timestamp = now()
      const inserted: ChatRow = {
        id: newId(),
        userId,
        title: input.title ?? DEFAULT_CHAT_TITLE,
        workdir: input.workdir ?? null,
        settings: { ...DEFAULT_CHAT_SETTINGS, ...input.settings },
        createdAt: timestamp,
        updatedAt: timestamp
      }
      db.insert(chats).values(inserted).run()
      return toChat(inserted)
    },

    update(id, patch, userId = LOCAL_USER_ID) {
      const current = row(id, userId)
      const next: Partial<ChatRow> = { updatedAt: now() }
      if (patch.title !== undefined) next.title = patch.title
      if (patch.workdir !== undefined) next.workdir = patch.workdir
      if (patch.settings !== undefined) next.settings = { ...current.settings, ...patch.settings }
      db.update(chats).set(next).where(eq(chats.id, current.id)).run()
      return toChat(row(id, userId))
    },

    delete(id, userId = LOCAL_USER_ID) {
      const current = row(id, userId)
      db.delete(chats).where(eq(chats.id, current.id)).run()
    },

    setMembers(userId, chatId, agentIds) {
      const chat = row(chatId, userId)
      if (new Set(agentIds).size !== agentIds.length) {
        throw validation('an agent cannot be added to the same chat twice', { chatId, agentIds })
      }
      for (const agentId of agentIds) {
        const agent = db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
          .get()
        if (!agent) throw notFound('agent', agentId)
      }

      db.transaction((tx) => {
        tx.delete(chatMembers).where(eq(chatMembers.chatId, chat.id)).run()
        if (agentIds.length > 0) {
          tx.insert(chatMembers)
            .values(agentIds.map((agentId, position) => ({ chatId: chat.id, agentId, position })))
            .run()
        }
        tx.update(chats).set({ updatedAt: now() }).where(eq(chats.id, chat.id)).run()
      })

      return members(chat.id)
    },

    listMembers(chatId, userId = LOCAL_USER_ID) {
      const chat = row(chatId, userId)
      return members(chat.id)
    }
  }
}
