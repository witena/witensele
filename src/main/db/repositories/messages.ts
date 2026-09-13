/**
 * Message persistence — the single source of truth for a conversation.
 *
 * The one design decision worth knowing about is `seq`. Messages are ordered by a
 * per-chat monotonic integer assigned inside the insert transaction, not by
 * `createdAt`: in parallel speaking mode several agents are persisted within the
 * same millisecond, and `ORDER BY created_at` would then return an arbitrary
 * order that can differ between two reads of the same chat. `seq` also gives the
 * `before` cursor a total order, so paging can never skip or repeat a message.
 *
 * `seq` is an internal ordering key: it is not part of the shared `Message` type
 * and never crosses IPC. The renderer's cursor stays a message id, which is
 * resolved to its `seq` here.
 */
import { and, asc, desc, eq, lt, sql } from 'drizzle-orm'
import type {
  EntityBase,
  Message,
  MessagePart,
  MessageStatus,
  Usage,
  UserId
} from '@shared/types'
import { LOCAL_USER_ID } from '@shared/types'
import type { DrizzleDb } from '../database'
import type { MessageRow } from '../schema'
import { chats, messages } from '../schema'
import { notFound } from '../../errors'
import { newId, now, nullable, optional } from './common'

/** Everything needed to store a message; id, `seq` and timestamps are assigned here. */
export type MessageCreateInput = Omit<Message, keyof EntityBase>

/** The fields a running turn rewrites as it streams and finishes. */
export interface MessagePatch {
  parts?: MessagePart[]
  status?: MessageStatus
  usage?: Usage
  mentions?: string[]
  /** `''` clears the stored error. */
  error?: string
}

export interface MessageListQuery {
  chatId: string
  /** Exclusive cursor: the id of the oldest message already displayed. */
  before?: string
  /** Defaults to 50. */
  limit?: number
}

export interface MessageRepository {
  /** Inserts the message and bumps the parent chat's `updatedAt`. */
  create(input: MessageCreateInput, userId?: UserId): Message
  update(id: string, patch: MessagePatch, userId?: UserId): Message
  get(id: string, userId?: UserId): Message
  /** Newest first, for the chat view and its upward paging. */
  list(query: MessageListQuery, userId?: UserId): Message[]
  /** Oldest first, the whole history — what the runner feeds to a model. */
  listForContext(chatId: string, userId?: UserId): Message[]
  /** The `seq` the next message in this chat will get; exposed for tests and tooling. */
  nextSeq(chatId: string): number
}

/** Messages returned by `list` when the caller does not set a limit. */
export const DEFAULT_MESSAGE_PAGE_SIZE = 50

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    userId: row.userId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    chatId: row.chatId,
    senderType: row.senderType,
    senderId: row.senderId,
    parts: row.parts,
    status: row.status,
    round: row.round,
    mentions: row.mentions,
    ...optional('inReplyTo', row.inReplyTo),
    ...optional('usage', row.usage),
    ...optional('error', row.error)
  }
}

export function createMessageRepository(db: DrizzleDb): MessageRepository {
  function row(id: string, userId: UserId): MessageRow {
    const found = db
      .select()
      .from(messages)
      .where(and(eq(messages.id, id), eq(messages.userId, userId)))
      .get()
    if (!found) throw notFound('message', id)
    return found
  }

  /** Highest `seq` used in a chat, or 0 when it has no messages yet. */
  function maxSeq(runner: Pick<DrizzleDb, 'select'>, chatId: string): number {
    const found = runner
      .select({ value: sql<number | null>`max(${messages.seq})` })
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .get()
    return found?.value ?? 0
  }

  return {
    create(input, userId = LOCAL_USER_ID) {
      const chat = db
        .select({ id: chats.id })
        .from(chats)
        .where(and(eq(chats.id, input.chatId), eq(chats.userId, userId)))
        .get()
      if (!chat) throw notFound('chat', input.chatId)

      const timestamp = now()
      // The whole insert runs in one transaction so two concurrent writers cannot
      // read the same max(seq) and produce a duplicate.
      const inserted = db.transaction((tx) => {
        const value: MessageRow = {
          id: newId(),
          userId,
          chatId: input.chatId,
          seq: maxSeq(tx, input.chatId) + 1,
          senderType: input.senderType,
          senderId: input.senderId,
          parts: input.parts,
          status: input.status,
          round: input.round,
          mentions: input.mentions,
          inReplyTo: nullable(input.inReplyTo),
          usage: nullable(input.usage),
          error: nullable(input.error),
          createdAt: timestamp,
          updatedAt: timestamp
        }
        tx.insert(messages).values(value).run()
        tx.update(chats).set({ updatedAt: timestamp }).where(eq(chats.id, input.chatId)).run()
        return value
      })

      return toMessage(inserted)
    },

    update(id, patch, userId = LOCAL_USER_ID) {
      const current = row(id, userId)
      const next: Partial<MessageRow> = { updatedAt: now() }
      if (patch.parts !== undefined) next.parts = patch.parts
      if (patch.status !== undefined) next.status = patch.status
      if (patch.usage !== undefined) next.usage = patch.usage
      if (patch.mentions !== undefined) next.mentions = patch.mentions
      if (patch.error !== undefined) next.error = patch.error === '' ? null : patch.error
      db.update(messages).set(next).where(eq(messages.id, current.id)).run()
      return toMessage(row(id, userId))
    },

    get(id, userId = LOCAL_USER_ID) {
      return toMessage(row(id, userId))
    },

    list(query, userId = LOCAL_USER_ID) {
      const conditions = [eq(messages.chatId, query.chatId), eq(messages.userId, userId)]
      if (query.before !== undefined) {
        const cursor = row(query.before, userId)
        conditions.push(lt(messages.seq, cursor.seq))
      }
      return db
        .select()
        .from(messages)
        .where(and(...conditions))
        .orderBy(desc(messages.seq))
        .limit(query.limit ?? DEFAULT_MESSAGE_PAGE_SIZE)
        .all()
        .map(toMessage)
    },

    listForContext(chatId, userId = LOCAL_USER_ID) {
      return db
        .select()
        .from(messages)
        .where(and(eq(messages.chatId, chatId), eq(messages.userId, userId)))
        .orderBy(asc(messages.seq))
        .all()
        .map(toMessage)
    },

    nextSeq(chatId) {
      return maxSeq(db, chatId) + 1
    }
  }
}
