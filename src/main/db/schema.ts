/**
 * The drizzle schema: one table per domain type in `src/shared/types.ts`.
 *
 * Conventions that hold for every table here:
 *
 * - Column names are `snake_case`, TypeScript property names are `camelCase`.
 * - Every entity table carries `id` (UUID text), `user_id`, `created_at` and
 *   `updated_at`. Timestamps are **epoch milliseconds stored as integers**, never
 *   SQLite `datetime` text, matching the shared types exactly.
 * - Structured values are stored as JSON text and typed with `$type<…>()` against
 *   the shared type, so a schema change in `shared/types.ts` breaks compilation
 *   here rather than silently at runtime.
 * - String unions are declared with `text({ enum: […] })`. On SQLite drizzle uses
 *   this for typing only — it emits no `CHECK` constraint — so the union is
 *   enforced at compile time and by the repositories, not by the database file.
 * - Nothing in this file (or anywhere under `src/main/db/`) imports electron.
 */
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type {
  AgentAvatar,
  AgentParams,
  AppSettings,
  ChatSettings,
  MessagePart,
  Usage
} from '@shared/types'

/* -------------------------------------------------------------------------- */
/* Providers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `api_key_encrypted` holds ciphertext produced by the main process's
 * `SecretStore` and is **never** mapped into a `Provider`: the repository only
 * reports its presence as `hasApiKey`. Plaintext keys never reach this layer.
 */
export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  type: text('type', {
    enum: ['anthropic', 'openai', 'google', 'openai-compatible']
  }).notNull(),
  name: text('name').notNull(),
  baseUrl: text('base_url'),
  presetId: text('preset_id'),
  models: text('models', { mode: 'json' }).$type<string[]>().notNull(),
  apiKeyEncrypted: text('api_key_encrypted'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

/* -------------------------------------------------------------------------- */
/* Agents                                                                      */
/* -------------------------------------------------------------------------- */

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  avatar: text('avatar', { mode: 'json' }).$type<AgentAvatar>().notNull(),
  description: text('description').notNull().default(''),
  systemPrompt: text('system_prompt').notNull().default(''),
  providerId: text('provider_id').notNull(),
  modelId: text('model_id').notNull(),
  params: text('params', { mode: 'json' }).$type<AgentParams>().notNull(),
  skillNames: text('skill_names', { mode: 'json' }).$type<string[]>().notNull(),
  mcpServerIds: text('mcp_server_ids', { mode: 'json' }).$type<string[]>().notNull(),
  memoryEnabled: integer('memory_enabled', { mode: 'boolean' }).notNull().default(false),
  /** `executor` is reserved for the post-MVP executor agent; nothing sets it yet. */
  role: text('role', { enum: ['participant', 'executor'] })
    .notNull()
    .default('participant'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

/* -------------------------------------------------------------------------- */
/* MCP servers                                                                 */
/* -------------------------------------------------------------------------- */

/** `command` / `args` / `env` belong to `stdio`, `url` to `http`; the unused half is null. */
export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  transport: text('transport', { enum: ['stdio', 'http'] }).notNull(),
  command: text('command'),
  args: text('args', { mode: 'json' }).$type<string[]>(),
  env: text('env', { mode: 'json' }).$type<Record<string, string>>(),
  url: text('url'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** Reserved for the permission prompt; the MVP only displays it. */
  sideEffects: integer('side_effects', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

/* -------------------------------------------------------------------------- */
/* Chats and membership                                                        */
/* -------------------------------------------------------------------------- */

export const chats = sqliteTable('chats', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  title: text('title').notNull(),
  /** Reserved for the executor agent's working directory; always null in the MVP. */
  workdir: text('workdir'),
  settings: text('settings', { mode: 'json' }).$type<ChatSettings>().notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

/**
 * Membership is a pure join table: no id, no timestamps, composite primary key.
 * Both foreign keys cascade, so deleting a chat or an agent cleans it up.
 */
export const chatMembers = sqliteTable(
  'chat_members',
  {
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Speaking order in `roundrobin` mode, ascending from 0. */
    position: integer('position').notNull()
  },
  (table) => [primaryKey({ columns: [table.chatId, table.agentId] })]
)

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `seq` is a per-chat monotonic counter assigned by the repository inside the
 * insert transaction. `created_at` alone is not enough: parallel agents in one
 * round can be persisted within the same millisecond, which would leave the
 * transcript order undefined. Ordering and the `before` cursor both use `seq`;
 * `seq` is not part of the shared `Message` type and never crosses IPC.
 */
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    senderType: text('sender_type', { enum: ['user', 'agent', 'system'] }).notNull(),
    senderId: text('sender_id').notNull(),
    parts: text('parts', { mode: 'json' }).$type<MessagePart[]>().notNull(),
    status: text('status', {
      enum: ['streaming', 'done', 'error', 'passed', 'skipped']
    }).notNull(),
    /** 1-based round this message belongs to; 0 for messages outside a run. */
    round: integer('round').notNull().default(0),
    mentions: text('mentions', { mode: 'json' }).$type<string[]>().notNull(),
    /**
     * Agent ids (plus the literal `user`) whose messages asked for this reply.
     * Nullable rather than an empty array so a row written before S2.3 — and a
     * user message, which never answers anyone — stores nothing at all.
     */
    inReplyTo: text('in_reply_to', { mode: 'json' }).$type<string[]>(),
    usage: text('usage', { mode: 'json' }).$type<Usage>(),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    index('messages_chat_created_idx').on(table.chatId, table.createdAt),
    index('messages_chat_seq_idx').on(table.chatId, table.seq)
  ]
)

/* -------------------------------------------------------------------------- */
/* Application settings                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One row per user holding the whole `AppSettings` object. A single JSON blob
 * rather than a column per setting: the repository merges what it reads over
 * `DEFAULT_APP_SETTINGS`, so adding a setting needs no migration.
 */
export const settings = sqliteTable('settings', {
  userId: text('user_id').primaryKey(),
  data: text('data', { mode: 'json' }).$type<AppSettings>().notNull(),
  updatedAt: integer('updated_at').notNull()
})

/* -------------------------------------------------------------------------- */
/* Row types                                                                   */
/* -------------------------------------------------------------------------- */

export type ProviderRow = typeof providers.$inferSelect
export type AgentRow = typeof agents.$inferSelect
export type McpServerRow = typeof mcpServers.$inferSelect
export type ChatRow = typeof chats.$inferSelect
export type ChatMemberRow = typeof chatMembers.$inferSelect
export type MessageRow = typeof messages.$inferSelect
export type SettingsRow = typeof settings.$inferSelect
