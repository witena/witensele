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
 * `anthropic` (S5.3) and `google` (S5.13) implement `oauth`; OpenAI does not
 * yet — "Sign in with ChatGPT" is a gated program (see "Phase 6: Backlog" in
 * `docs/STEPS.md`). The field is shared rather than derived from the type
 * because a provider of either kind may legitimately stay on a key.
 */
export type ProviderAuth = 'apiKey' | 'oauth'

/** Every authentication mode, for validation and for the editor's control. */
export const PROVIDER_AUTH_MODES = ['apiKey', 'oauth'] as const

/**
 * Whether this provider's stored key can still be decrypted (S7.6).
 *
 * `none` is a provider that stores no key — a local endpoint, or one that signs
 * in — and is therefore not a problem. `unreadable` is a key written by an
 * earlier installation whose encryption key is gone; the row is left exactly as
 * it is (never overwritten with something unreadable) and the UI asks for the
 * key again.
 */
export type ProviderKeyState = 'ok' | 'unreadable' | 'none'

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
   * Whether the stored key can still be read (S7.6).
   *
   * **Runtime only, not a column**: the `providers.*` handlers fill it from the
   * set of ids the startup migration could not decrypt, so it is absent from a
   * provider built anywhere else (a repository row, an editor draft) and a
   * reader must treat absent as "not determined". `unreadable` is the state the
   * UI explains — a key encrypted by a previous installation, which has to be
   * pasted again.
   */
  keyState?: ProviderKeyState
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
  /** Absent means `apiKey`. `oauth` is accepted for `anthropic` and `google`. */
  auth?: ProviderAuth
}

/**
 * What the renderer is told about a vendor CLI's login state.
 *
 * `not-installed` is a first-class answer rather than an error, because "the
 * binary is not on this machine" is the ordinary state of a machine that has
 * never used it, and the sign-in panel's job is to say so and print the install
 * command.
 */
export type ProviderAuthState = 'signed-in' | 'signed-out' | 'not-installed'

/**
 * The login state of the CLI behind one `auth: 'oauth'` provider type.
 *
 * Deliberately **no token**: an access token and a refresh token never leave the
 * main process, so nothing that crosses IPC — or lands in a renderer heap
 * snapshot — can carry a credential. What is left is what the panel has to
 * print: who the user is signed in as, the one label that gives that identity
 * context, and when the current credential expires.
 *
 * One interface for both vendors (S5.13) rather than one per vendor, because
 * every consumer — the store, the panel, the card badge — treats it as "the
 * machine's login state plus a few labels". *Which* labels are filled is a fact
 * about the vendor rather than about the shape: `ant` reports an organisation
 * and a workspace, `gcloud` reports a quota project, and a field the answering
 * CLI has no notion of is simply absent — the same case every consumer already
 * handles for a profile that carried none.
 */
export interface ProviderAuthStatus {
  state: ProviderAuthState
  /** The signed-in identity. An account email for both CLIs today. */
  account?: string
  /** Anthropic: the organisation the profile belongs to. */
  organizationName?: string
  /** Anthropic: the workspace the profile is scoped to. */
  workspaceName?: string
  /**
   * Google: the quota project `x-goog-user-project` names, which is the project
   * billed for the request. Absent means the user signed in but never chose one,
   * which the panel offers to fix — the Gemini API refuses an end-user
   * credential that names no project.
   */
  project?: string
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

/**
 * The eight entries of the monogram palette, as stored.
 *
 * An index rather than a colour, because the colour depends on the appearance
 * (S5.17): `--color-avatar-3-bg` is a deep violet in the dark theme and a pale
 * one in the light theme, and a record cannot hold both. One small integer holds
 * the *choice* and lets the stylesheet hold the consequences.
 */
export type AvatarPaletteIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

/** The eight indexes, in the order the avatar picker offers them. */
export const AVATAR_PALETTE_INDEXES: readonly AvatarPaletteIndex[] = [1, 2, 3, 4, 5, 6, 7, 8]

/** A monogram avatar: one or two letters on one of the eight palette entries. */
export interface InitialAvatar {
  kind: 'initial'
  text: string
  /**
   * Which palette entry the tile is painted with (S5.17). The authority at
   * render time whenever it is present.
   *
   * Optional because every agent written before S5.17 has only the two colour
   * fields below. Those records are **not** migrated: the renderer maps the
   * stored hex to the nearest entry as it draws, which costs nothing, cannot
   * half-fail, and leaves a downgrade to the previous build working.
   */
  palette?: AvatarPaletteIndex
  /**
   * CSS colour, e.g. `#c2653a`.
   *
   * Since S5.17 this is a *compatibility shadow* on a record the current build
   * wrote — the amber-era hex of whatever `palette` names — rather than the
   * thing that gets painted. It is still required, so that a consumer that has
   * never heard of `palette` (an older build, an export, a future server) always
   * has a colour to fall back to.
   */
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
  /**
   * **Show thinking**: whether this agent's reasoning is kept in the transcript
   * (S5.14).
   *
   * It used to mean "ask for reasoning output", which it never did — no provider
   * option was ever set from it — and the transcripts of the first real use were
   * the argument for the meaning it has now: the model thinks either way, and
   * this decides whether the thought is **stored and rendered** or discarded as
   * the stream arrives. A group of four open models each streaming a chain of
   * thought is a transcript nobody can read.
   *
   * Absent is not `false`: it means "nobody has chosen", and the answer is then
   * `showsThinkingByDefault` in `@shared/presets` — off for a local or
   * `openai-compatible` provider, on for `anthropic`, `openai` and `google`. The
   * default is written into `params` at `agents.create`, so an agent made today
   * carries its own answer; the fallback at turn time is what keeps every agent
   * written before S5.14 behaving.
   */
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
/* Committees                                                                  */
/* -------------------------------------------------------------------------- */

/** How long a committee name may be. Long enough to be descriptive, short
 * enough to fit the list row it is read in. */
export const MAX_COMMITTEE_NAME_CHARS = 100

/**
 * A named, ordered standing group of agents (Phase 9).
 *
 * A committee only assembles people; it never holds a conversation itself. A
 * chat is a *topic* the committee is convened on, and joining is a **snapshot**:
 * the members below are expanded into `chat_members` when the chat is created
 * and `Chat.committeeId` records where they came from, so orchestration keeps
 * reading membership exactly as before and an old topic does not change when
 * the committee does.
 *
 * `memberAgentIds` is **ordered** — it is the speaking order a chat inherits —
 * and rides on the entity rather than behind `committees.members.*` methods:
 * the repository reads and replaces the join rows in the same transaction as
 * the committee row, so a member list is never half-written.
 */
export interface Committee extends EntityBase {
  name: string
  description: string
  /** Member agent ids in speaking order. Deduplicated, every id an existing agent. */
  memberAgentIds: string[]
}

/** Create payload for a committee: everything except the stored base fields. */
export type CommitteeInput = Omit<Committee, keyof EntityBase>

/** Update payload for a committee. An absent field is left alone. */
export type CommitteePatch = Partial<CommitteeInput>

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
  /**
   * The member that writes the conclusion when a discussion closes (S5.16).
   *
   * Absent — the default — means "the first eligible member in speaking order",
   * which is what S5.14 always did. When it names a member of this chat that is
   * available and is not an executor, that member writes the conclusion instead;
   * anything else (a member since removed, one the supervisor has taken offline,
   * an executor) falls back to the same first-in-order rule rather than skipping
   * the conclusion, because a chat that agreed must still hand back an answer.
   *
   * An agent id rather than a position, because the speaking order is dragged
   * around by the user and "the second member" would silently become somebody
   * else.
   */
  closingAgentId?: string
  /**
   * Whether a closed discussion writes the `document` goal's deliverable by
   * itself (S5.18).
   *
   * **Absent means on**, which is why the field is optional rather than a
   * `boolean` with `true` in `DEFAULT_CHAT_SETTINGS`: the setting was added to a
   * JSON column that thousands of stored rows already lack, and a chat written
   * before this step must behave exactly like one created after it. Only a
   * literal `false` — the user turning the switch off — stops the hand-off.
   *
   * It is read only where all of S5.12's other conditions already hold: a
   * `document` goal with a deliverable, a working directory and an executor
   * member. On any other chat it is a switch with nothing behind it, which is
   * why the Goal panel only shows it for a `document`.
   */
  autoDeliver?: boolean
  /** Per-chat override in milliseconds; absent means use the global setting. */
  stallTimeoutMs?: number
  /** Per-chat override in milliseconds; absent means use the global setting. */
  hardTimeoutMs?: number
}

/**
 * A patch of `ChatSettings`, in which `closingAgentId` may be `null` (S5.16).
 *
 * Every other field is only ever *set*, so `Partial<ChatSettings>` says all
 * there is to say about them. `closingAgentId` is the first setting that can be
 * **unset** — picking "First in speaking order" again — and `undefined` cannot
 * carry that across a transport: JSON drops the key, and a dropped key is
 * exactly what "leave this field alone" means in a merge. So the wire word for
 * "clear it" is `null`, and `chats.update` turns it back into an absent field
 * before the row is written, which is why the stored type has no `null` in it.
 */
export interface ChatSettingsPatch extends Partial<Omit<ChatSettings, 'closingAgentId'>> {
  /** The member that closes, or `null` for "the first eligible one". */
  closingAgentId?: string | null
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

/**
 * What the user is handing the executor (S5.12).
 *
 * One `chat.handoff` with an argument rather than two methods, because the two
 * differ in **one sentence of the briefing and one notice key** and in nothing
 * else: the same executor is chosen by the same rule, the same message shape is
 * stored, and the same two staged rounds run. A second method would have been
 * `handoff()` copied for its last paragraph.
 *
 * - `implement` — S5.6's hand-off: build the conclusion the group reached.
 * - `deliver` — the "Write the deliverable" action: write the `document` goal's
 *   file now. Refused (`handoff_no_deliverable`) on a chat whose goal is not a
 *   `document` with a deliverable, because there would be no file to name.
 */
export const HANDOFF_INTENTS = ['implement', 'deliver'] as const

export type HandoffIntent = (typeof HANDOFF_INTENTS)[number]

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
  /**
   * The committee this topic was convened from (Phase 9), or `null` for a chat
   * assembled out of individual agents.
   *
   * **Provenance, not membership.** The committee's members were expanded into
   * `chat_members` when the chat was created; this field only records where
   * they came from, so the renderer can badge the topic and offer "Sync
   * committee members" when the committee has since grown. Deleting the
   * committee sets it back to `null` (`ON DELETE SET NULL`) and leaves the
   * chat's members untouched, and a chat written before Phase 9 reads `null`.
   */
  committeeId: string | null
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
 * field another control changed a moment earlier. Since S5.16 it is a
 * `ChatSettingsPatch`, which is that partial plus the one field a control can
 * clear.
 */
export interface ChatPatch extends Partial<Omit<ChatInput, 'settings' | 'committeeId'>> {
  settings?: ChatSettingsPatch
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
  /**
   * The committee to convene this topic on (Phase 9).
   *
   * Its members, in `position` order, become the chat's first members, followed
   * by `memberAgentIds`, de-duplicated keeping the first occurrence. It is
   * accepted **only here**: `ChatPatch` deliberately omits it, because
   * provenance is written once and a topic that changed committee would be a
   * snapshot of nothing.
   */
  committeeId?: string
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

/**
 * The mark on the one message that is the group's answer (S5.16).
 *
 * A **flag**: it carries no content of its own, it is stored **first** in
 * `parts`, and it says one thing — this message is the conclusion S5.14's
 * closing turn was run to produce. A part rather than a column or a
 * `MessageKind`, because `parts` is already the open, migration-free place
 * where a message says what it is made of: a new member of this union costs no
 * schema change and a row written before S5.16 simply has none.
 *
 * Everything that reads a message treats it as invisible unless it is looking
 * for it: `partsToText` (the history transform) skips it, so the model never
 * sees a flag; `messageText` in the renderer skips it, so it is never drawn as
 * text. Only the transcript row model and the chip that finds it read it.
 */
export interface ConclusionPart {
  type: 'conclusion'
}

/** Everything a message can be made of, discriminated on `type`. */
export type MessagePart =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | ToolResultPart
  | DiffPart
  | FileRefPart
  | ConclusionPart
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
  /**
   * How long a permission prompt waits for an answer before it denies itself
   * (S5.15).
   *
   * Minutes rather than seconds, and much longer than the other three, because
   * the thing being waited for is a **person** reading a diff — not a model
   * answering or a process exiting. Until S5.15 a prompt nobody answered was
   * ended only by Stop or by `hardTimeoutMs`, which recorded the turn as
   * `skipped`: true, and not the reason.
   */
  permissionTimeoutMs: number
}

/* -------------------------------------------------------------------------- */
/* Executor safety (S5.15)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How `run_command` is confined (S5.15).
 *
 * `'workdir-write'` runs the command under `/usr/bin/sandbox-exec` with a
 * generated profile that lets it read anything the user can read and write only
 * inside the chat's folder, the system temp directories and the null-ish
 * devices; the network stays open, because a build that cannot fetch its
 * dependencies is not a build. `'off'` is S5.4's behaviour and is kept for the
 * cases the profile is too tight for — a tool that insists on writing its cache
 * into the home directory, or a machine where `sandbox-exec` has been removed.
 */
export type ExecutorSandboxMode = 'workdir-write' | 'off'

/** Every value `ExecutorSettings.sandbox` accepts, in the order the control shows them. */
export const EXECUTOR_SANDBOX_MODES = [
  'workdir-write',
  'off'
] as const satisfies readonly ExecutorSandboxMode[]

export interface ExecutorSettings {
  sandbox: ExecutorSandboxMode
}

/**
 * How dangerous a `run_command` line is (S5.15).
 *
 * `blocked` never runs and never prompts; `dangerous` always prompts and
 * ignores an `allowAlways` grant; `normal` behaves as it did before S5.15. The
 * classifier is `src/main/executor/command-policy.ts`, and its header explains
 * why a `normal` verdict is not a claim that the command is safe.
 */
export type CommandVerdict = 'blocked' | 'dangerous' | 'normal'

/**
 * Why a command got the verdict it got.
 *
 * A **code**, never a sentence: the backend does not know the UI language, so
 * the card translates it under `chat.commandRisk.*` (CLAUDE.md rule #4), and the
 * model reads a separate English sentence from `blockedCommandMessage`.
 */
export type CommandRiskReason =
  | 'privilege-escalation'
  | 'disk-write'
  | 'shutdown'
  | 'fork-bomb'
  | 'destructive-delete'
  | 'destructive-permissions'
  | 'recursive-delete'
  | 'git-push'
  | 'git-reset-hard'
  | 'git-clean'
  | 'history-rewrite'
  | 'package-publish'
  | 'download-to-shell'
  | 'command-substitution'
  | 'outside-workdir'
  | 'background-process'

/** Every reason code, for the locale guard and the policy's own tests. */
export const COMMAND_RISK_REASONS = [
  'privilege-escalation',
  'disk-write',
  'shutdown',
  'fork-bomb',
  'destructive-delete',
  'destructive-permissions',
  'recursive-delete',
  'git-push',
  'git-reset-hard',
  'git-clean',
  'history-rewrite',
  'package-publish',
  'download-to-shell',
  'command-substitution',
  'outside-workdir',
  'background-process'
] as const satisfies readonly CommandRiskReason[]

/** One verdict with the rule that produced it; `reason` is null only for `normal`. */
export interface CommandRisk {
  verdict: CommandVerdict
  reason: CommandRiskReason | null
}

/**
 * One remembered "always allow in this chat" (S5.15).
 *
 * Persisted since S5.15, which is a reversal of S5.4's decision that a grant
 * must die with the process. The reason it is safe to reverse is the rest of
 * this step: a grant is now **listed and revocable** in the chat's Group
 * settings, and a `dangerous` command ignores it entirely. An invisible grant
 * was the problem, not a durable one.
 */
export interface PermissionGrant {
  chatId: string
  /** The tool the grant is about: `run_command`, or an MCP tool's own name. */
  toolName: string
  createdAt: number
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
  /** How `run_command` is confined (S5.15). */
  executor: ExecutorSettings
  timeouts: AppTimeouts
  /**
   * True once the user pressed Skip on the first-run card (S7.5).
   *
   * A setting rather than browser storage: it is a fact about this
   * installation, it has to survive a cleared web storage and a different
   * window, and the server version of the app (Phase 8) will want it per
   * account. It is never set back to `false` by the UI — the card is not a
   * feature to switch on and off, and a user who wants it again has an empty
   * installation anyway.
   */
  onboardingDismissed: boolean
}

/** Settings a fresh installation starts with. */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  language: 'system',
  theme: 'system',
  editor: {
    kind: 'vscode',
    command: DEFAULT_EDITOR_COMMAND
  },
  executor: {
    sandbox: 'workdir-write'
  },
  timeouts: {
    stallTimeoutMs: 30_000,
    hardTimeoutMs: 120_000,
    toolTimeoutMs: 60_000,
    permissionTimeoutMs: 300_000
  },
  onboardingDismissed: false
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
  executor?: Partial<ExecutorSettings>
  timeouts?: Partial<AppTimeouts>
  onboardingDismissed?: boolean
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
 * has decided about the tool, not about one path.
 *
 * Since S5.15 the grant is **persisted** (`permission_grants`), which S5.4
 * refused to do on the grounds that a grant surviving a restart is a permission
 * the user cannot see. The grounds were right and the conclusion was the wrong
 * half: S5.15 makes the grant visible and revocable in the chat's Group settings
 * instead, and a `dangerous` command ignores every grant, so quitting the app is
 * no longer the only way back to being asked.
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
 * The `ant_*` and `gcloud_*` codes are classes rather than `ValidationReason`s
 * on purpose: they describe the state of a **tool on the user's machine**, not a
 * malformed request, and they are raised by the provider layer (a model being
 * built for a chat turn) as well as by a handler validating a form.
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
  /** The Google Cloud SDK (`gcloud`) is not installed, or not where it was expected. */
  | 'gcloud_missing'
  /** `gcloud` is installed but has no application-default credentials (S5.13). */
  | 'gcloud_not_logged_in'
  /**
   * `gcloud` is signed in but names no quota project, so a request would have no
   * `x-goog-user-project` header — which the Gemini API refuses for an end-user
   * credential. The sign-in panel offers a field that sets one.
   */
  | 'gcloud_no_project'
  /**
   * A stored API key cannot be decrypted by this build (S7.6).
   *
   * The key was encrypted by an earlier installation whose encryption key is
   * gone — an unsigned rebuild loses the `safeStorage` Keychain item, because
   * macOS grants it per application identity. Nothing is broken and nothing was
   * lost except the key itself: pasting it again fixes the provider for good,
   * since every key written since S7.6 is held by `userData/secrets.key`, which
   * updates do not touch.
   */
  | 'key_unreadable'

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
  /** `chat.handoff` with `intent: 'deliver'` on a chat with no deliverable (S5.12). */
  'handoff_no_deliverable',
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
