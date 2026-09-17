/**
 * The Postgres schema: the same seven tables as `../schema.ts`, in the dialect
 * the server version stores them in.
 *
 * **Two files, kept in step by a test**, rather than one description that emits
 * both — see `docs/features/database/context.md` for the decision and its
 * alternatives. `schema-drift.test.ts` compares the two through drizzle's own
 * table metadata: same tables, same columns, same nullability, same primary keys.
 * A column added to one and forgotten in the other fails `npm test`.
 *
 * Where the dialects genuinely differ, and why the SQL cannot simply be shared:
 *
 * | Value | SQLite | Postgres |
 * |---|---|---|
 * | Epoch-millisecond timestamps | `integer` (dynamically typed, holds any int) | `bigint` — `integer` is 4 bytes and `Date.now()` overflowed it in 1970 + 25 days |
 * | Booleans | `integer` with drizzle's `{ mode: 'boolean' }` | `boolean`, a real type |
 * | JSON documents | `text` with `{ mode: 'json' }` | `jsonb`, which is indexable and validated |
 *
 * That table is the whole reason migrations are generated per dialect rather
 * than written once in "neutral" SQL: there is no spelling of `created_at` that
 * is correct in both.
 *
 * Nothing here imports electron, exactly as in the SQLite half.
 */
import { bigint, boolean, index, jsonb, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import type {
  AgentAvatar,
  AgentParams,
  AppSettings,
  ChatGoal,
  ChatSettings,
  MessagePart,
  Usage
} from '@shared/types'

/**
 * An epoch-millisecond timestamp column.
 *
 * `mode: 'number'` because every timestamp in `shared/types.ts` is a `number`,
 * and a column that handed out `bigint` or a string would move the conversion
 * into every repository instead of stating it once here. The range is safe: ms
 * since the epoch stays inside `Number.MAX_SAFE_INTEGER` until the year 287396.
 */
const epochMs = (name: string) => bigint(name, { mode: 'number' })

/* -------------------------------------------------------------------------- */
/* Providers                                                                   */
/* -------------------------------------------------------------------------- */

export const providers = pgTable('providers', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  type: text('type', {
    enum: ['anthropic', 'openai', 'google', 'openai-compatible']
  }).notNull(),
  name: text('name').notNull(),
  baseUrl: text('base_url'),
  presetId: text('preset_id'),
  models: jsonb('models').$type<string[]>().notNull(),
  apiKeyEncrypted: text('api_key_encrypted'),
  auth: text('auth', { enum: ['apiKey', 'oauth'] }),
  createdAt: epochMs('created_at').notNull(),
  updatedAt: epochMs('updated_at').notNull()
})

/* -------------------------------------------------------------------------- */
/* Agents                                                                      */
/* -------------------------------------------------------------------------- */

export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  avatar: jsonb('avatar').$type<AgentAvatar>().notNull(),
  description: text('description').notNull().default(''),
  systemPrompt: text('system_prompt').notNull().default(''),
  providerId: text('provider_id').notNull(),
  modelId: text('model_id').notNull(),
  params: jsonb('params').$type<AgentParams>().notNull(),
  skillNames: jsonb('skill_names').$type<string[]>().notNull(),
  mcpServerIds: jsonb('mcp_server_ids').$type<string[]>().notNull(),
  memoryEnabled: boolean('memory_enabled').notNull().default(false),
  role: text('role', { enum: ['participant', 'executor'] })
    .notNull()
    .default('participant'),
  createdAt: epochMs('created_at').notNull(),
  updatedAt: epochMs('updated_at').notNull()
})

/* -------------------------------------------------------------------------- */
/* MCP servers                                                                 */
/* -------------------------------------------------------------------------- */

export const mcpServers = pgTable('mcp_servers', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  transport: text('transport', { enum: ['stdio', 'http'] }).notNull(),
  command: text('command'),
  args: jsonb('args').$type<string[]>(),
  env: jsonb('env').$type<Record<string, string>>(),
  url: text('url'),
  enabled: boolean('enabled').notNull().default(true),
  sideEffects: boolean('side_effects').notNull().default(false),
  createdAt: epochMs('created_at').notNull(),
  updatedAt: epochMs('updated_at').notNull()
})

/* -------------------------------------------------------------------------- */
/* Chats and membership                                                        */
/* -------------------------------------------------------------------------- */

export const chats = pgTable('chats', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  title: text('title').notNull(),
  workdir: text('workdir'),
  goal: jsonb('goal').$type<ChatGoal>(),
  settings: jsonb('settings').$type<ChatSettings>().notNull(),
  createdAt: epochMs('created_at').notNull(),
  updatedAt: epochMs('updated_at').notNull()
})

export const chatMembers = pgTable(
  'chat_members',
  {
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    position: integer('position').notNull()
  },
  (table) => [primaryKey({ columns: [table.chatId, table.agentId] })]
)

/**
 * "Always allow in this chat" grants (S5.15). One row per chat and tool; the
 * chat's deletion removes them. Mirrors `permissionGrants` in `../schema.ts`.
 */
export const permissionGrants = pgTable(
  'permission_grants',
  {
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    createdAt: epochMs('created_at').notNull()
  },
  (table) => [primaryKey({ columns: [table.chatId, table.toolName] })]
)

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    // `integer` rather than `epochMs`: `seq` is a counter that starts at 1 per
    // chat, and four bytes is two billion messages in one conversation.
    seq: integer('seq').notNull(),
    senderType: text('sender_type', { enum: ['user', 'agent', 'system'] }).notNull(),
    senderId: text('sender_id').notNull(),
    parts: jsonb('parts').$type<MessagePart[]>().notNull(),
    status: text('status', {
      enum: ['streaming', 'done', 'error', 'passed', 'skipped']
    }).notNull(),
    round: integer('round').notNull().default(0),
    mentions: jsonb('mentions').$type<string[]>().notNull(),
    inReplyTo: jsonb('in_reply_to').$type<string[]>(),
    usage: jsonb('usage').$type<Usage>(),
    error: text('error'),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull()
  },
  (table) => [
    index('messages_chat_created_idx').on(table.chatId, table.createdAt),
    index('messages_chat_seq_idx').on(table.chatId, table.seq)
  ]
)

/* -------------------------------------------------------------------------- */
/* Application settings                                                        */
/* -------------------------------------------------------------------------- */

export const settings = pgTable('settings', {
  userId: text('user_id').primaryKey(),
  data: jsonb('data').$type<AppSettings>().notNull(),
  updatedAt: epochMs('updated_at').notNull()
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
