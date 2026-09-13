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
 * How a provider proves who it is (S5.3).
 *
 * `apiKey` is the original and the default: a secret the user pastes, encrypted
 * by the `SecretStore`. `oauth` means "use the account the user is already
 * signed in to", which Witena delegates entirely to the vendor's own CLI — it
 * stores **no token of its own**, so signing out of the CLI signs Witena out too.
 *
 * Only `anthropic` implements `oauth` today. The field is shared rather than
 * derived from the type because OpenAI and Google are expected to gain their own
 * sign-in later (see "Phase 6: Backlog" in `docs/STEPS.md`), and an Anthropic
 * provider may legitimately stay on a key.
 */
export type ProviderAuth = 'apiKey' | 'oauth'

/** Every authentication mode, for validation and for the editor's control. */
export const PROVIDER_AUTH_MODES = ['apiKey', 'oauth'] as const

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
  /**
   * Absent means `apiKey`, which is what every row written before S5.3 holds.
   * Read it through `providerAuth()` in `shared/presets.ts` rather than
   * comparing it by hand, so the default lives in one place.
   */
  auth?: ProviderAuth
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
  /** Absent means `apiKey`. `oauth` is accepted only for `type: 'anthropic'`. */
  auth?: ProviderAuth
}

/**
 * What the renderer is told about the Anthropic CLI's login state.
 *
 * Deliberately **no token**: `access_token` and `refresh_token` never leave the
 * main process, so nothing that crosses IPC — or lands in a renderer heap
 * snapshot — can carry a credential. What is left is what the sign-in panel has
 * to say: which account and workspace the user is signed in as, and when the
 * current credential expires.
 *
 * `not-installed` is a first-class answer rather than an error, because "the
 * `ant` binary is not on this machine" is the ordinary state of a machine that
 * has never used it, and the panel's job is to say so and print the install
 * command.
 */
export type AnthropicAuthState = 'signed-in' | 'signed-out' | 'not-installed'

export interface AnthropicAuthStatus {
  state: AnthropicAuthState
  organizationName?: string
  accountEmail?: string
  workspaceName?: string
  /** Epoch **milliseconds** when the current credential expires. */
  expiresAt?: number
}

/* -------------------------------------------------------------------------- */
/* Agents                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `participant` agents discuss and never write. `executor` is the single agent
 * per chat that is allowed to act on the outside world, bound to `Chat.workdir`.
 *
 * PLAN.md's decision, in one line: *discussion agents are read-only; all writes
 * go through one executor*. Several models writing into the same directory
 * overwrite each other and nothing is reviewable, so exactly one writer plus a
 * diff-review loop is the shape. Two consequences are already enforced:
 * `collectAgentTools` attaches a `sideEffects` MCP server only to an `executor`
 * (S3.1), and a chat refuses a second `executor` member (S5.2). Since S5.4 the
 * executor also gets its own file, search, shell and git tools, confined to
 * `Chat.workdir` and gated by the permission prompt (`docs/features/executor/`).
 */
export type AgentRole = 'participant' | 'executor'

/** A monogram avatar: one or two letters on a solid colour. */
export interface InitialAvatar {
  kind: 'initial'
  text: string
  /** CSS colour, e.g. `#c2653a`. */
  color: string
  /**
   * Foreground CSS colour paired with `color`. Optional so records written before
   * the avatar picker existed still render, on the renderer's neutral fallback.
   */
  textColor?: string
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
   * push commits).
   *
   * Two rules read it: `collectAgentTools` attaches such a server only to an
   * `executor` agent (S3.1), and since S5.4 **every** call to one of its tools
   * goes through the permission prompt before it runs.
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

/** The three shapes a chat's goal can take (`docs/PLAN.md`, "Chat goal and workspace"). */
export const GOAL_KINDS = ['discussion', 'document', 'codebase'] as const

export type GoalKind = (typeof GOAL_KINDS)[number]

/** Longest description `chats.update` accepts; a goal is a paragraph, not a document. */
export const MAX_GOAL_DESCRIPTION_CHARS = 2_000

/**
 * What the group in this chat is working towards (S5.10).
 *
 * The kind decides what "done" means and who touches the folder:
 * `discussion` reaches a conclusion in the transcript, `document` produces one
 * file, `codebase` changes the code in the chat's `workdir`. The last two
 * therefore require a `workdir` — there is nothing to write into otherwise —
 * and `document` additionally requires a `deliverable`.
 *
 * Every path in here is **relative to `Chat.workdir`**, never absolute: the
 * folder can be moved or restored from a backup, and a goal that named
 * `/Users/ada/…` would then point at nothing. The renderer converts what the
 * native dialogs return before it sends them (`lib/workdir.ts`).
 */
export interface ChatGoal {
  kind: GoalKind
  /** Prose the user wrote; placed verbatim in every member's briefing. */
  description: string
  /**
   * The one file a `document` goal produces, relative to `workdir`.
   *
   * Required for `document` and meaningless for the other two. Its parent folder
   * need not exist yet — the point of the goal is that the file does not exist
   * at the start.
   */
  deliverable?: string
  /**
   * Files and folders under `workdir` the group starts from, relative paths.
   *
   * Each one must exist when it is saved. S5.11 places their contents in every
   * member's system prompt, in list order and inside a quarter of that model's
   * context window; what does not fit is named by path for `read_file`.
   */
  materials: string[]
}

/**
 * Whether a `document` goal's deliverable is on disk yet.
 *
 * A fact about the **filesystem**, not about the chat row, which is why it is a
 * query of its own (`chats.goalStatus`) rather than a field on `Chat`: a derived
 * column on the domain type would be stale the moment anything wrote the file,
 * and the same reasoning already keeps the member count off `Chat`.
 */
export interface ChatGoalStatus {
  /** Absolute path of the deliverable, or `null` when the goal has none. */
  deliverable: string | null
  /** True when that file exists right now. Always false without a deliverable. */
  delivered: boolean
}

export interface Chat extends EntityBase {
  title: string
  /**
   * Absolute path of the local folder this chat's executor works in, or `null`
   * when the chat is not bound to one.
   *
   * Validated by `chats.update` against the real filesystem (absolute, exists,
   * is a directory), because every path the executor resolves in S5.3 is
   * confined to it — a folder that is not there is not a boundary. A chat may
   * have an `executor` member and no `workdir`; that agent simply gets no
   * executor tools.
   */
  workdir: string | null
  /**
   * What this chat is for (S5.10), or `null` while nobody has said.
   *
   * Stored as one nullable JSON column, so a chat written before S5.10 reads as
   * `null` and behaves exactly as it did — a chat with no goal is a discussion
   * nobody bothered to name.
   */
  goal: ChatGoal | null
  settings: ChatSettings
}

/** Create / update payload for a chat. */
export type ChatInput = Omit<Chat, keyof EntityBase>

/**
 * An update payload for a chat.
 *
 * `settings` is a **partial of a partial**: the backend merges it field by field,
 * so a single control (the speaking toggle, the round count) can be persisted on
 * its own without the caller having to resend the rest and risk overwriting a
 * field another control changed a moment earlier.
 */
export interface ChatPatch extends Partial<Omit<ChatInput, 'settings'>> {
  settings?: Partial<ChatSettings>
}

/**
 * What `chats.create` accepts: a partial `ChatInput` plus the members the chat
 * starts with.
 *
 * Membership is a separate table, so it is not part of `Chat` and cannot be part
 * of `ChatInput` — but a chat created from the member picker has to be born with
 * its members rather than saved twice. Omitting the field means "no members",
 * except on an installation whose agent library is still empty, where the backend
 * falls back to the bootstrap agent (see `src/main/agents/default-agent.ts`).
 */
export interface ChatCreateInput extends ChatPatch {
  memberAgentIds?: string[]
}

/** How many automatic rounds a chat may be configured for. */
export const MIN_AUTO_ROUNDS = 1
export const MAX_AUTO_ROUNDS = 10

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

/**
 * One tool invocation by an agent.
 *
 * `toolName` is the tool's **own** name as the MCP server declares it (`echo`),
 * not the prefixed name the model sees (`everything__echo`): the prefix exists
 * only to keep two servers' tools apart inside one model call, and a user
 * reading the transcript wants the real name. `serverId` / `serverName` carry
 * where it came from, which is what the card prints as `serverName · toolName`.
 *
 * Both are optional because a later step adds tools with no server behind them
 * (`read_skill` in S3.2, `memory_save` in S3.3).
 */
export interface ToolCallPart {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  /** Tool arguments; shape is defined by the tool's own JSON schema. */
  input: unknown
  /** The `McpServer.id` whose client ran this tool, when it came from one. */
  serverId?: string
  /** That server's display name, stored so a deleted server still reads right. */
  serverName?: string
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
  /**
   * Who this message answers: the agent ids whose previous-round messages
   * mentioned this agent, plus the literal `'user'` when the human's message did.
   *
   * Absent on user messages and on any reply nobody asked for by name. It is
   * what the UI's "replying to @x" label reads, so it is stored rather than
   * recomputed: membership and mentions both change over the life of a chat.
   */
  inReplyTo?: string[]
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

/**
 * The stored appearance setting.
 *
 * `'system'` is not a theme, it is a *rule*: the resolved theme follows
 * `prefers-color-scheme` and changes while the app is running. Everything that
 * paints turns it into `'light' | 'dark'` at use time — `resolveTheme` in the
 * renderer, `nativeTheme` in the main process — exactly as `'system'` works for
 * the language, and for the same reason: storing the resolved value would freeze
 * a user who asked to follow the machine.
 */
export type ThemeSetting = 'system' | 'light' | 'dark'

/** Every value `AppSettings.theme` accepts, in the order the control shows them. */
export const THEME_SETTINGS = ['system', 'light', 'dark'] as const satisfies readonly ThemeSetting[]

/**
 * Which editor `system.openInEditor` hands a file to (S5.7).
 *
 * The two named editors are URL schemes — `vscode://file/<path>:<line>` and its
 * Cursor twin — because a URL needs nothing installed on the `PATH` and works
 * whether or not the user ever ran "Install 'code' command in PATH". `'custom'`
 * is the escape hatch for everything else, and it is a command line rather than
 * a second scheme because that is the only interface every editor has.
 */
export type EditorKind = 'vscode' | 'cursor' | 'custom'

/** Every value `EditorSettings.kind` accepts, in the order the control shows them. */
export const EDITOR_KINDS = ['vscode', 'cursor', 'custom'] as const satisfies readonly EditorKind[]

/**
 * The command template `kind: 'custom'` starts from.
 *
 * `{path}` and `{line}` are the only placeholders; the backend substitutes them
 * with the *quoted* absolute path and the line number, so a template may put them
 * anywhere without thinking about spaces in a directory name.
 */
export const DEFAULT_EDITOR_COMMAND = 'code -g {path}:{line}'

export interface EditorSettings {
  kind: EditorKind
  /** Only used when `kind` is `'custom'`, but kept across a switch away and back. */
  command: string
}

export interface AppSettings {
  /** `'system'` follows the OS language, which is the first-launch default. */
  language: Language | 'system'
  /** `'system'` follows the OS appearance, which is the first-launch default. */
  theme: ThemeSetting
  /** Where a `path:line` chip, a diff header or a file tool card opens (S5.7). */
  editor: EditorSettings
  timeouts: AppTimeouts
}

/** Settings a fresh installation starts with. */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  language: 'system',
  theme: 'system',
  editor: {
    kind: 'vscode',
    command: DEFAULT_EDITOR_COMMAND
  },
  timeouts: {
    stallTimeoutMs: 30_000,
    hardTimeoutMs: 120_000,
    toolTimeoutMs: 60_000
  }
}

/**
 * A shallow patch of `AppSettings`.
 *
 * `timeouts` and `editor` may each be updated one field at a time, because both
 * are written by a form whose controls commit separately: the kind is a click and
 * the command template is a field that commits on blur, and a whole-object write
 * from either would overwrite whatever the other one did a moment earlier.
 */
export interface AppSettingsPatch {
  language?: AppSettings['language']
  theme?: AppSettings['theme']
  editor?: Partial<EditorSettings>
  timeouts?: Partial<AppTimeouts>
}

/* -------------------------------------------------------------------------- */
/* Skills and memory (filesystem-backed, not stored in the database)           */
/* -------------------------------------------------------------------------- */

/**
 * The progressive-disclosure header of a skill: only `name` and `description`
 * go into the system prompt; the body is fetched on demand with the `read_skill`
 * tool. The other fields exist for the settings cards, which have to say enough
 * about a skill for the user to recognize it without opening it.
 */
export interface SkillMeta {
  name: string
  description: string
  /** Absolute path of the skill directory under `userData/skills/`. */
  path: string
  /** The folder the skill lives in, which may differ from the frontmatter name. */
  folder: string
  /** Free-form version string from the frontmatter, when the author wrote one. */
  version?: string
  /** Frontmatter tags, normalized to a string array. */
  tags?: string[]
  /** Bundled resource files beside `SKILL.md`, counted up to `MAX_SKILL_FILES`. */
  fileCount: number
}

/**
 * A skill with its body, for the settings detail pane and the `read_skill` tool.
 * `files` lists the bundled resources `read_skill_file` may be asked for.
 */
export interface SkillDetail {
  meta: SkillMeta
  /** The markdown below the frontmatter. */
  body: string
  /** Paths relative to the skill folder, `SKILL.md` and hidden files excluded. */
  files: string[]
}

/**
 * A skill folder that was found but could not be used, so the settings page can
 * say why instead of silently listing one folder fewer.
 */
export interface SkillWarning {
  folder: string
  reason: 'missing-description' | 'unreadable'
}

/** One entry in an agent's `MEMORY.md` index, backed by a file under `notes/`. */
export interface MemoryEntry {
  id: string
  title: string
  /** Path relative to the agent's memory directory, e.g. `notes/2026-09-13-api.md`. */
  path: string
  createdAt: number
}

/** One hit of `memory_search`, over the index and every note body. */
export interface MemorySearchHit {
  /** Path relative to the agent's memory directory. */
  path: string
  title: string
  /** A window of the matching text, for the model and for the UI. */
  snippet: string
}

/* -------------------------------------------------------------------------- */
/* Executor permissions (S5.4)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The three answers to a permission prompt.
 *
 * `allowAlways` is PLAN.md's "always allow in this chat": it runs the call and
 * remembers the **chat + tool** pair, so every later call of that tool in that
 * chat runs without asking again. It is deliberately not remembered per input —
 * a user who has decided that this executor may run `write_file` in this chat
 * has decided about the tool, not about one path — and deliberately not
 * persisted: the memory lives for the life of the process, so closing the app is
 * always a way back to being asked.
 */
export const PERMISSION_DECISIONS = ['allow', 'deny', 'allowAlways'] as const

/** One of `allow`, `deny`, `allowAlways`. */
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number]

/** Narrows an unknown value to a decision, for the handler's validation. */
export function isPermissionDecision(value: unknown): value is PermissionDecision {
  return typeof value === 'string' && (PERMISSION_DECISIONS as readonly string[]).includes(value)
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Machine-readable failure classes. The renderer switches on `code` to pick an
 * i18n key; `message` is for logs and developer-facing detail, not UI copy.
 * `unauthorized` is reserved for the server version and unused locally.
 *
 * The two `ant_*` codes are classes rather than `ValidationReason`s on purpose:
 * they describe the state of a **tool on the user's machine**, not a malformed
 * request, and they are raised by the provider layer (a model being built for a
 * chat turn) as well as by a handler validating a form.
 */
export type BackendErrorCode =
  | 'not_found'
  | 'validation'
  | 'provider_error'
  | 'mcp_error'
  | 'aborted'
  | 'unauthorized'
  | 'internal'
  /** The Anthropic CLI (`ant`) is not installed, or not where it was expected. */
  | 'ant_missing'
  /** `ant` is installed but no profile is logged in (`ant auth login`). */
  | 'ant_not_logged_in'

/** Serializable error shape: an `Error` cannot survive the transport intact. */
export interface BackendError {
  code: BackendErrorCode
  message: string
  details?: unknown
}

/**
 * The `validation` refusals the renderer has a sentence of its own for.
 *
 * `BackendErrorCode` is deliberately coarse — seven classes for the whole
 * product — and "the request was rejected as invalid" is the right answer for
 * almost every one of them, because the control that sent the request is right
 * there saying what it wanted. These are the exceptions: the user picked a
 * folder and it turned out not to be one, added a member the chat cannot hold,
 * or asked for a sign-in mode this provider cannot have, and the generic
 * sentence would leave them guessing.
 *
 * A reason travels in `BackendError.details` as `{ reason }`, so it is an
 * **identifier the renderer translates**, never a sentence the backend wrote
 * (CLAUDE.md rule #4). Adding one means adding an `errors.<reason>` key to both
 * locale files; `i18n/errors.ts` switches over the union and the compiler proves
 * the mapping is total.
 */
export const VALIDATION_REASONS = [
  'workdir_not_absolute',
  'workdir_missing',
  'workdir_not_directory',
  'second_executor',
  /** `auth: 'oauth'` on a provider type that has no sign-in flow yet. */
  'oauth_unsupported_provider',
  /** `auth: 'oauth'` together with a custom base URL, which cannot be signed into. */
  'oauth_custom_base_url',
  /** `chat.handoff` on a chat that is not bound to a folder (S5.6). */
  'handoff_no_workdir',
  /** `chat.handoff` on a chat whose members include no executor (S5.6). */
  'handoff_no_executor',
  /** `chat.handoff` while a run of that chat is still going (S5.6). */
  'handoff_run_active',
  /** `system.openInEditor` was given a path that is not absolute (S5.7). */
  'editor_path_not_absolute',
  /** `system.openInEditor` was given a path outside the chat's folder (S5.7). */
  'editor_path_outside_workdir',
  /** A goal was saved with a blank description (S5.10). */
  'goal_description_empty',
  /** A goal description longer than `MAX_GOAL_DESCRIPTION_CHARS` (S5.10). */
  'goal_description_too_long',
  /** A `document` goal with no `deliverable` (S5.10). */
  'goal_deliverable_required',
  /** A deliverable that is absolute, blank, or climbs out with `..` (S5.10). */
  'goal_deliverable_not_relative',
  /** A deliverable that resolves outside the chat's folder (S5.10). */
  'goal_deliverable_outside_workdir',
  /** A material that is absolute, blank, or climbs out with `..` (S5.10). */
  'goal_material_not_relative',
  /** A material that resolves outside the chat's folder (S5.10). */
  'goal_material_outside_workdir',
  /** A material that is not on disk (S5.10). */
  'goal_material_missing',
  /** A `document` or `codebase` goal on a chat bound to no folder (S5.10). */
  'goal_needs_workdir'
] as const

export type ValidationReason = (typeof VALIDATION_REASONS)[number]

/** The shape `BackendError.details` takes when a reason is carried. */
export interface ValidationDetails {
  reason: ValidationReason
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

/**
 * One tool a server offers, as the settings page and the agent editor show it.
 *
 * The JSON schema is deliberately **not** here: the renderer only ever lists
 * names and descriptions, and a schema is unbounded input that would cross the
 * transport on every list call for nothing.
 */
export interface McpToolInfo {
  name: string
  description?: string
}

/** Result of "test connection" on an MCP server; success also lists its tools. */
export type McpConnectionTestResult =
  | (ConnectionTestOk & { tools: McpToolInfo[] })
  | ConnectionTestFailure
