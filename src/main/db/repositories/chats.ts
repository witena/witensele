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
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { Chat, ChatMember, ChatPatch, UserId } from '@shared/types'
import { DEFAULT_CHAT_SETTINGS, LOCAL_USER_ID } from '@shared/types'
import type { DrizzleDb } from '../database'
import type { ChatRow } from '../schema'
import { agents, chatMembers, chats, messages } from '../schema'
import { notFound, validation } from '../../errors'
import { newId, now } from './common'

/**
 * Title a chat starts with. Stored content rather than UI copy, so it is not an
 * i18n key; S1.3 onwards lets the renderer pass its own title on creation and
 * S4.3 replaces it with a generated one.
 */
export const DEFAULT_CHAT_TITLE = 'New chat'

/**
 * How many chats `search` may return.
 *
 * The left column is a list a human scrolls; two hundred rows is already far
 * more than anyone reads, and the cap keeps a one-letter query from loading
 * every chat and every message id in the database into memory at once.
 */
export const CHAT_SEARCH_LIMIT = 200

/** The character `escapeLike` puts in front of a wildcard. */
export const LIKE_ESCAPE_CHAR = '\\'

/**
 * Escapes the two wildcards SQL `LIKE` gives meaning to, plus the escape
 * character itself.
 *
 * Without this, searching for `50%` matches everything and searching for `a_b`
 * matches `axb` — both silently, both looking like the search is broken rather
 * than like the query meant something else. The backslash is declared to SQLite
 * with `ESCAPE`, which is why `escapeLike` and the `sql` fragment in `search`
 * have to stay together.
 */
export function escapeLike(query: string): string {
  return query.replace(/[\\%_]/g, (match) => `${LIKE_ESCAPE_CHAR}${match}`)
}

export interface ChatRepository {
  /** Newest `updatedAt` first. */
  list(userId?: UserId): Chat[]
  get(id: string, userId?: UserId): Chat
  /** Missing fields fall back to `DEFAULT_CHAT_TITLE` and `DEFAULT_CHAT_SETTINGS`. */
  create(input?: ChatPatch, userId?: UserId): Chat
  update(id: string, patch: ChatPatch, userId?: UserId): Chat
  /** Cascades to `chat_members` and `messages`. */
  delete(id: string, userId?: UserId): void
  /** Replaces the whole member list; the array index becomes `position`. */
  setMembers(userId: UserId, chatId: string, agentIds: string[]): ChatMember[]
  /** Members of a chat ordered by `position`. */
  listMembers(chatId: string, userId?: UserId): ChatMember[]
  /**
   * Ids of the chats whose title or any message text contains `query`, newest
   * `updatedAt` first, capped at `CHAT_SEARCH_LIMIT`.
   *
   * Case-insensitive, and `%` / `_` in the query are literals rather than
   * wildcards (see `escapeLike`). A blank query is "no filter" and returns every
   * chat, which is what lets the caller treat an emptied search box as a normal
   * result rather than as a special case.
   */
  search(query: string, userId?: UserId): string[]
  /**
   * Ids of the chats an agent is a member of, newest chat first.
   *
   * Read by `agents.delete`, which has to stop those chats' runs and tell the
   * renderer they changed *before* the cascading foreign key silently drops the
   * membership rows.
   */
  listChatIdsForAgent(agentId: string, userId?: UserId): string[]
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
    },

    search(query, userId = LOCAL_USER_ID) {
      const trimmed = query.trim()
      if (trimmed.length === 0) {
        return db
          .select({ id: chats.id })
          .from(chats)
          .where(eq(chats.userId, userId))
          .orderBy(desc(chats.updatedAt))
          .limit(CHAT_SEARCH_LIMIT)
          .all()
          .map((found) => found.id)
      }

      const pattern = `%${escapeLike(trimmed)}%`
      // `LIKE` is case-insensitive for ASCII in SQLite by default, which is what
      // the column collation gives us; nothing here lowercases the query, so a
      // CJK search matches exactly as typed.
      const escape = sql.raw(`ESCAPE '${LIKE_ESCAPE_CHAR}'`)
      const needle = trimmed.toLowerCase()

      const byTitle = db
        .select({ id: chats.id })
        .from(chats)
        .where(and(eq(chats.userId, userId), sql`${chats.title} LIKE ${pattern} ${escape}`))
        .all()
        .map((found) => found.id)

      // Two stages, on purpose. `parts` is a JSON column, so the only thing SQL
      // can do is `LIKE` over the serialized blob — which is fast and *over*
      // matches: it would also hit the word `text` in every part's own `type`
      // field, or a tool name, or a notice key. So SQL narrows, and JavaScript
      // decides, by looking at `text` parts only. The blob scan is the cheap
      // half and it is what keeps the precise half from having to parse every
      // message in the database.
      const byMessage = db
        .select({ chatId: messages.chatId, parts: messages.parts })
        .from(messages)
        .where(and(eq(messages.userId, userId), sql`${messages.parts} LIKE ${pattern} ${escape}`))
        .all()
        .filter((found) =>
          found.parts.some(
            (part) => part.type === 'text' && part.text.toLowerCase().includes(needle)
          )
        )
        .map((found) => found.chatId)

      const hits = new Set([...byTitle, ...byMessage])
      if (hits.size === 0) return []

      // Re-read through `chats` so the result is ordered exactly like `list`:
      // the left column keeps its Today / Yesterday / Earlier grouping while a
      // search is active, and that grouping is driven by `updatedAt`.
      return db
        .select({ id: chats.id })
        .from(chats)
        .where(eq(chats.userId, userId))
        .orderBy(desc(chats.updatedAt))
        .all()
        .map((found) => found.id)
        .filter((id) => hits.has(id))
        .slice(0, CHAT_SEARCH_LIMIT)
    },

    listChatIdsForAgent(agentId, userId = LOCAL_USER_ID) {
      return db
        .select({ id: chats.id })
        .from(chatMembers)
        .innerJoin(chats, eq(chatMembers.chatId, chats.id))
        .where(and(eq(chatMembers.agentId, agentId), eq(chats.userId, userId)))
        .orderBy(desc(chats.updatedAt))
        .all()
        .map((found) => found.id)
    }
  }
}
