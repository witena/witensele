/**
 * Domain types shared by the main process, the preload bridge and the renderer.
 *
 * Rules that apply to everything in this file:
 *
 * - **Transport agnostic.** These types describe the data, never how it travels.
 *   The MVP moves them over Electron IPC; a later server version will move the
 *   exact same shapes over HTTP + WebSocket. Nothing here may import electron.
 * - **JSON serializable.** No `Date`, no classes, no functions, no `Map`/`Set`.
 *   Every timestamp is **epoch milliseconds** as a `number` (`Date.now()`), never
 *   an ISO string and never a `Date`.
 * - **Secrets never cross the boundary.** API keys are write-only: they appear in
 *   `ProviderInput` on the way in and are represented by `Provider.hasApiKey` on
 *   the way out.
 * - **User-visible text produced by the backend is an i18n key**, not a sentence
 *   (see `SystemNoticePart`). The renderer owns all translation.
 */

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/** Owner of a record. Every table carries one so multi-user can be added later. */
export type UserId = string

/** The single implicit user of the local desktop build. */
export const LOCAL_USER_ID: UserId = 'local'

/**
 * Fields carried by every stored entity. Primary keys are UUID strings generated
 * by the backend; `createdAt` / `updatedAt` are epoch milliseconds.
 */
export interface EntityBase {
  id: string
  userId: UserId
  createdAt: number
  updatedAt: number
}

/* -------------------------------------------------------------------------- */
/* Providers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The four AI SDK adapters the app can construct. Chinese providers, OpenRouter,
 * Ollama and LM Studio are all `openai-compatible` with a preset base URL.
 */
export type ProviderType = 'anthropic' | 'openai' | 'google' | 'openai-compatible'

/**
 * A configured model provider. Deliberately has no key field: the encrypted key
 * lives in the backend's `SecretStore` and only its presence is reported here.
 */
export interface Provider extends EntityBase {
  type: ProviderType
  name: string
  /** Custom endpoint; absent means the adapter's default. */
  baseUrl?: string
  /** Id of the entry in `shared/presets.ts` this provider was created from. */
  presetId?: string
  /** Model ids offered to agents, either preset or fetched from `/models`. */
  models: string[]
  /** True when a key is stored for this provider. The key itself never leaves main. */
  hasApiKey: boolean
}

/**
 * Create / update payload for a provider.
 *
 * `apiKey` is **write-only**: it is accepted here, encrypted and stored by the
 * backend, and never returned in any type that crosses back to the renderer.
 * Omitting it on an update keeps the stored key; passing an empty string clears it.
 */
export interface ProviderInput {
  type: ProviderType
  name: string
  baseUrl?: string
  presetId?: string
  models: string[]
  apiKey?: string
}

/* -------------------------------------------------------------------------- */
/* Agents                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `participant` agents discuss. `executor` is reserved for the post-MVP executor
 * agent bound to `Chat.workdir`; nothing implements it yet.
 */
export type AgentRole = 'participant' | 'executor'

/** A monogram avatar: one or two letters on a solid colour. */
export interface InitialAvatar {
  kind: 'initial'
  text: string
  /** CSS colour, e.g. `#c2653a`. */
  color: string
}

/**
 * Discriminated on `kind` so image or emoji avatars can be added later without
 * touching any consumer that already handles `initial`.
 */
export type AgentAvatar = InitialAvatar

/** Model call parameters. All optional: absent means the provider default. */
export interface AgentParams {
  temperature?: number
  maxTokens?: number
  /** Ask for reasoning output on models that support it. */
  reasoning?: boolean
}

/** A configured chat participant. */
export interface Agent extends EntityBase {
  name: string
  avatar: AgentAvatar
  description: string
  systemPrompt: string
  providerId: string
  modelId: string
  params: AgentParams
  /** Names of skills from `userData/skills/<name>/SKILL.md`. */
  skillNames: string[]
  mcpServerIds: string[]
  memoryEnabled: boolean
  role: AgentRole
}

/** Create / update payload for an agent: everything except the stored base fields. */
export type AgentInput = Omit<Agent, keyof EntityBase>

/* -------------------------------------------------------------------------- */
/* MCP servers                                                                 */
/* -------------------------------------------------------------------------- */

/** stdio spawns a child process; http is the MCP Streamable HTTP transport. */
export type McpTransport = 'stdio' | 'http'

/**
 * A registered MCP server. `command` / `args` / `env` apply to `stdio`, `url`
 * applies to `http`; the unused half is absent rather than empty.
 */
export interface McpServer extends EntityBase {
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  enabled: boolean
  /**
   * Marks a server whose tools change the outside world (write files, send mail,
   * push commits). Reserved for the permission prompt; the MVP only displays it.
   */
  sideEffects: boolean
}

/** Create / update payload for an MCP server. */
export type McpServerInput = Omit<McpServer, keyof EntityBase>

/* -------------------------------------------------------------------------- */
/* Chats                                                                       */
/* -------------------------------------------------------------------------- */

/** `roundrobin`: every member speaks. `mention-only`: only @mentioned agents do. */
export type ChatMode = 'roundrobin' | 'mention-only'

/** Within one round, agents either speak one after another or all at once. */
export type SpeakingMode = 'sequential' | 'parallel'

/** Per-chat orchestration settings. The timeouts override `AppSettings.timeouts`. */
export interface ChatSettings {
  mode: ChatMode
  speaking: SpeakingMode
  /** How many rounds may run without the user before control returns to them. */
  maxAutoRounds: number
  /** Per-chat override in milliseconds; absent means use the global setting. */
  stallTimeoutMs?: number
  /** Per-chat override in milliseconds; absent means use the global setting. */
  hardTimeoutMs?: number
}

/** Settings a new chat starts with: everyone speaks, in order, for up to 3 rounds. */
export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  mode: 'roundrobin',
  speaking: 'sequential',
  maxAutoRounds: 3
}

export interface Chat extends EntityBase {
  title: string
  /**
   * Local working directory for the future executor agent. Reserved: the MVP
   * always stores `null`.
   */
  workdir: string | null
  settings: ChatSettings
}

/** Create / update payload for a chat. */
export type ChatInput = Omit<Chat, keyof EntityBase>

/**
 * Membership of an agent in a chat. `position` is the speaking order in
 * `roundrobin` mode, ascending from 0.
 */
export interface ChatMember {
  chatId: string
  agentId: string
  position: number
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

export type SenderType = 'user' | 'agent' | 'system'

/**
 * `passed` is a deliberate abstention (the agent replied `[PASS]`); `skipped` is
 * an agent the supervisor dropped after the hard timeout.
 */
export type MessageStatus = 'streaming' | 'done' | 'error' | 'passed' | 'skipped'

export interface TextPart {
  type: 'text'
  text: string
}

/** Model reasoning, rendered in a collapsed block. */
export interface ReasoningPart {
  type: 'reasoning'
  text: string
}

export interface ToolCallPart {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  /** Tool arguments; shape is defined by the tool's own JSON schema. */
  input: unknown
}

export interface ToolResultPart {
  type: 'tool-result'
  /** Matches the `toolCallId` of the `tool-call` part it answers. */
  toolCallId: string
  output: unknown
  isError?: boolean
}

/** Reserved for the executor agent: a unified diff produced by a code change. */
export interface DiffPart {
  type: 'diff'
  path: string
  patch: string
}

/** Reserved for editor integration: a clickable `file:line` reference. */
export interface FileRefPart {
  type: 'file-ref'
  path: string
  line?: number
}

/**
 * Backend-authored notice such as "X did not respond and was skipped".
 *
 * It carries an **i18n key plus parameters, never a sentence**, because the
 * backend does not know the UI language and the message is stored forever while
 * the language can change.
 */
export interface SystemNoticePart {
  type: 'system-notice'
  key: string
  params?: Record<string, string | number>
}

/** Everything a message can be made of, discriminated on `type`. */
export type MessagePart =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | ToolResultPart
  | DiffPart
  | FileRefPart
  | SystemNoticePart

/** Token accounting for one message, as reported by the provider. */
export interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface Message extends EntityBase {
  chatId: string
  senderType: SenderType
  /** `UserId` for a user message, agent id for an agent message, `'system'` otherwise. */
  senderId: string
  parts: MessagePart[]
  status: MessageStatus
  /** 1-based round this message belongs to; 0 for messages outside a run. */
  round: number
  /** Agent ids @mentioned in this message; drives the next round's speakers. */
  mentions: string[]
  usage?: Usage
  /** Present when `status` is `error`; an operator-facing detail, not UI copy. */
  error?: string
}

/* -------------------------------------------------------------------------- */
/* Presence                                                                    */
/* -------------------------------------------------------------------------- */

/** Teams-style presence: green / red / orange / grey in the member panel. */
export type PresenceState = 'available' | 'working' | 'away' | 'offline'

/** Live presence of one agent inside one chat. Not persisted. */
export interface AgentPresence {
  chatId: string
  agentId: string
  state: PresenceState
  /** When the current state was entered, epoch ms. */
  since: number
  /** Last stream chunk or tool event, epoch ms; drives the stall timeout. */
  lastActivityAt: number
}

/* -------------------------------------------------------------------------- */
/* Application settings                                                        */
/* -------------------------------------------------------------------------- */

export type Language = 'zh-CN' | 'en'

export interface AppTimeouts {
  /** No activity for this long turns an agent `away` (informational only). */
  stallTimeoutMs: number
  /** No activity for this long aborts the turn and marks the message `skipped`. */
  hardTimeoutMs: number
  /** Budget for a single MCP tool call. */
  toolTimeoutMs: number
}

export interface AppSettings {
  /** `'system'` follows the OS language, which is the first-launch default. */
  language: Language | 'system'
  /** Only a dark theme exists; the field is here so light can be added later. */
  theme: 'dark'
  timeouts: AppTimeouts
}

/** Settings a fresh installation starts with. */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  language: 'system',
  theme: 'dark',
  timeouts: {
    stallTimeoutMs: 30_000,
    hardTimeoutMs: 120_000,
    toolTimeoutMs: 60_000
  }
}

/** A shallow patch of `AppSettings`; `timeouts` may be updated one field at a time. */
export interface AppSettingsPatch {
  language?: AppSettings['language']
  theme?: AppSettings['theme']
  timeouts?: Partial<AppTimeouts>
}

/* -------------------------------------------------------------------------- */
/* Skills and memory (filesystem-backed, not stored in the database)           */
/* -------------------------------------------------------------------------- */

/**
 * The progressive-disclosure header of a skill: only these fields go into the
 * system prompt; the body is fetched on demand with the `read_skill` tool.
 */
export interface SkillMeta {
  name: string
  description: string
  /** Absolute path of the skill directory under `userData/skills/`. */
  path: string
}

/** One entry in an agent's `MEMORY.md` index, backed by a file under `notes/`. */
export interface MemoryEntry {
  id: string
  title: string
  /** Path relative to the agent's memory directory, e.g. `notes/2026-09-13-api.md`. */
  path: string
  createdAt: number
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Machine-readable failure classes. The renderer switches on `code` to pick an
 * i18n key; `message` is for logs and developer-facing detail, not UI copy.
 * `unauthorized` is reserved for the server version and unused locally.
 */
export type BackendErrorCode =
  | 'not_found'
  | 'validation'
  | 'provider_error'
  | 'mcp_error'
  | 'aborted'
  | 'unauthorized'
  | 'internal'

/** Serializable error shape: an `Error` cannot survive the transport intact. */
export interface BackendError {
  code: BackendErrorCode
  message: string
  details?: unknown
}

/* -------------------------------------------------------------------------- */
/* Connection tests                                                            */
/* -------------------------------------------------------------------------- */

export interface ConnectionTestOk {
  ok: true
  latencyMs: number
  /**
   * The model the probe actually ran against, for the "test connection" result
   * line. Optional because an MCP probe (`McpConnectionTestResult`) has no model;
   * a provider probe always sets it.
   */
  model?: string
}

export interface ConnectionTestFailure {
  ok: false
  error: BackendError
}

/** Result of "test connection" on a provider. */
export type ConnectionTestResult = ConnectionTestOk | ConnectionTestFailure

/** Result of "test connection" on an MCP server; success also lists its tools. */
export type McpConnectionTestResult =
  | (ConnectionTestOk & { toolNames: string[] })
  | ConnectionTestFailure
