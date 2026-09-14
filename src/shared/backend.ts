/**
 * The single seam between the renderer and everything behind it.
 *
 * The renderer imports nothing but `BackendClient`: no `window.witena`, no
 * `ipcRenderer`, no electron. S1.3 implements this interface over Electron IPC;
 * a later server version implements it over HTTP + WebSocket, and no page code
 * changes. A VS Code extension can reuse the same renderer for the same reason.
 *
 * Conventions:
 * - Method names are `namespace.method` strings, so the preload bridge can
 *   register one IPC channel per name from `BACKEND_METHODS` with no hand-written
 *   list per domain.
 * - Every method takes **at most one object argument** (`{ id }`, `{ chatId }`),
 *   so a new field is a non-breaking change at every layer.
 * - Rejections carry a `BackendError`; the renderer switches on `code`.
 */
import type { BackendEvent, BackendEventType, EventOf } from './events'
import type { OAuthProviderType } from './presets'
import type { ChatUsageSummary } from './usage'
import type {
  Agent,
  AgentInput,
  AgentPresence,
  ProviderAuthStatus,
  AppSettings,
  AppSettingsPatch,
  Chat,
  ChatCreateInput,
  ChatGoalStatus,
  ChatMember,
  ChatPatch,
  ConnectionTestResult,
  HandoffIntent,
  McpConnectionTestResult,
  McpServer,
  McpServerInput,
  McpToolInfo,
  MemoryEntry,
  MemorySearchHit,
  Message,
  PermissionDecision,
  Provider,
  ProviderInput,
  SkillDetail,
  SkillMeta,
  SkillWarning,
  ThemeSetting
} from './types'

/**
 * Either a saved provider or an unsaved draft from the "add provider" form, so
 * the model list can be fetched before the provider is created.
 */
export type ProviderRef = { id: string } | { draft: ProviderInput }

/**
 * Either a saved MCP server or an unsaved draft from the settings form.
 *
 * The same shape as `ProviderRef`, for the same reason: "Test connection" has to
 * work **before** Save. A user who has just typed a command wants to know it
 * spawns and lists tools before committing a record — and a server that is saved
 * first and only then found to be wrong leaves a broken row behind.
 */
export type McpServerRef = { id: string } | { draft: McpServerInput }

/**
 * Every request/response method the backend exposes.
 *
 * The full MVP surface is declared here from the start so the renderer can be
 * written against the finished contract. Only `system.ping` and
 * `system.emitTestEvent` are implemented in S1.3; the rest land with their own
 * steps (see `docs/STEPS.md`) and reject with `internal` until then.
 */
export interface BackendApi {
  /* -- system ------------------------------------------------------------- */

  /** Liveness probe. Used by the S1.3 acceptance test. */
  'system.ping': () => Promise<'pong'>
  /** Asks the backend to push one `system.test` event back. S1.3 test hook only. */
  'system.emitTestEvent': (input: { payload: string }) => Promise<void>
  /**
   * Opens the platform's folder picker and resolves with the chosen absolute
   * path, or `null` when the user cancelled.
   *
   * **The one method whose implementation must import electron.** Everything
   * else in this contract is a pure function of storage and the filesystem, but
   * a native modal belongs to the window system: there is no Electron-free way
   * to ask for one, and a text field the user pastes a path into would be a
   * worse product for the sake of an architectural rule. So the exception is
   * made deliberately and confined — the handler lives in `src/main/ipc/`,
   * which is already allowed to import electron (CLAUDE.md rule #5), and
   * `registerIpc` layers it over a stub that rejects everywhere else. A server
   * build implements it by rejecting, or by an upload dialog in the browser.
   */
  'system.pickFolder': () => Promise<string | null>
  /**
   * Opens the native **save** dialog and resolves with the chosen absolute path,
   * or `null` when the user cancelled (S5.10).
   *
   * The fourth method whose implementation must import electron, and a sibling
   * of `system.pickFolder` in every respect: it exists so the deliverable of a
   * `document` goal can be picked in Finder instead of typed from memory. The
   * file **need not exist** — that is the whole point of a save dialog — so
   * nothing here checks the filesystem; the renderer converts the answer to a
   * path relative to the chat's folder and `chats.update` validates it.
   *
   * `defaultDir` is where the dialog opens, normally the chat's `workdir`.
   */
  'system.pickSavePath': (input: { defaultDir?: string }) => Promise<string | null>
  /**
   * Opens the native open dialog for **files and folders, multi-select**, and
   * resolves with the chosen absolute paths (S5.10).
   *
   * The fifth, and the last of the `pick*` family. `system.pickFolder` cannot
   * serve here: a goal's materials are usually files, often several at once, and
   * sometimes a folder. Cancelling resolves with an **empty array** rather than
   * `null`, because "nothing was picked" and "the list is empty" are the same
   * answer for a caller that is about to append.
   */
  'system.pickPaths': (input: { defaultDir?: string }) => Promise<string[]>
  /**
   * Tells the window system which appearance the app is showing (S5.8).
   *
   * The **second** method whose implementation must import electron, and for the
   * same kind of reason as `system.pickFolder`: the renderer paints the page, but
   * the title bar's traffic lights, the native dialogs and the window's own
   * background are drawn by the platform, and only `nativeTheme.themeSource` can
   * tell it which way to draw them. The setting itself is stored by
   * `settings.update` like any other — this call carries no state, it is a
   * notification, which is why it resolves `void` and why a failure is ignored by
   * the caller. `handlers/system.ts` declares it and rejects; `src/main/ipc/theme.ts`
   * is the real one, layered in by `registerIpc`. A server build leaves it
   * rejecting: a browser tab has no window chrome to tint.
   */
  'system.applyTheme': (input: { theme: ThemeSetting }) => Promise<void>
  /**
   * Opens one file in the user's editor, at a line when one is known (S5.7).
   *
   * The **third** method whose implementation may need electron, and the first
   * whose need is conditional. `AppSettings.editor` decides: `'vscode'` and
   * `'cursor'` are URL schemes, and only `shell.openExternal` can hand a URL to
   * the platform, so those two are implemented in `src/main/ipc/editor.ts`;
   * `'custom'` is a command line, which `node:child_process` runs from the
   * Electron-free handler. Both branches share one module
   * (`src/main/editor/open.ts`) so the validation cannot differ between them.
   *
   * `path` must be **absolute**, and when `chatId` names a chat bound to a
   * folder it must resolve inside that folder — the same confinement rule the
   * executor's tools are held to (`src/main/executor/paths.ts`). A refusal
   * carries `editor_path_not_absolute` or `editor_path_outside_workdir` as its
   * `ValidationReason`. `chatId` is optional because the call is also reachable
   * from surfaces that are not inside a chat; without it only the first rule
   * applies.
   *
   * Resolves `void`: the platform does not report back whether the editor
   * actually came to the front, and a caller that waited for that would wait
   * forever.
   */
  'system.openInEditor': (input: {
    path: string
    /** 1-based, as every editor counts. Omitted means "the top of the file". */
    line?: number
    /** The chat whose `workdir` confines the path, when the call came from one. */
    chatId?: string
  }) => Promise<void>

  /* -- settings ----------------------------------------------------------- */

  'settings.get': () => Promise<AppSettings>
  /** Shallow merge; `timeouts` merges field by field. Returns the stored result. */
  'settings.update': (input: { patch: AppSettingsPatch }) => Promise<AppSettings>

  /* -- providers ---------------------------------------------------------- */

  'providers.list': () => Promise<Provider[]>
  'providers.get': (input: { id: string }) => Promise<Provider>
  'providers.create': (input: { input: ProviderInput }) => Promise<Provider>
  /** Omitting `apiKey` in the patch keeps the stored key; `''` clears it. */
  'providers.update': (input: { id: string; patch: Partial<ProviderInput> }) => Promise<Provider>
  'providers.delete': (input: { id: string }) => Promise<void>
  /** Reads the provider's `/models` endpoint; does not persist the result. */
  'providers.fetchModels': (input: { provider: ProviderRef }) => Promise<string[]>
  /**
   * Sends one tiny request and reports whether it came back. `modelId` picks
   * which model to probe; omitted, the provider's first known model is used —
   * which is rarely what you want once a list has both a 1B and a 70B model in it.
   */
  'providers.testConnection': (input: {
    provider: ProviderRef
    modelId?: string
  }) => Promise<ConnectionTestResult>
  /**
   * Whether the vendor's CLI is installed and logged in, and as whom (S5.3,
   * extended to Google in S5.13).
   *
   * `type` names which login is being asked about — the panel is rendered for
   * one provider type at a time, and `ant` and `gcloud` are independent facts
   * about the machine. It is an argument rather than three more methods per
   * vendor for the obvious reason: the question is the same question.
   *
   * Never rejects for either of the two states the panel exists to show — "not
   * installed" and "signed out" are values, not failures — so the editor can
   * render them without an error path.
   */
  'providers.authStatus': (input: { type: OAuthProviderType }) => Promise<ProviderAuthStatus>
  /**
   * Runs the vendor's login (`ant auth login`, `gcloud auth application-default
   * login`), which opens the system browser itself, and resolves with the
   * resulting status when the CLI exits. Rejects `ant_missing` / `gcloud_missing`
   * when there is no binary to run.
   */
  'providers.login': (input: { type: OAuthProviderType }) => Promise<ProviderAuthStatus>
  /** Signs the vendor's CLI out and resolves with the resulting status. */
  'providers.logout': (input: { type: OAuthProviderType }) => Promise<ProviderAuthStatus>
  /**
   * Writes the Google Cloud quota project into the application-default
   * credentials (`gcloud auth application-default set-quota-project`) and
   * resolves with the new status (S5.13).
   *
   * Deliberately **not** `{ type }`-shaped like the three above: a quota project
   * is a Google concept with no Anthropic counterpart, and a method that is
   * meaningless for half of its own argument's values is worse than a method
   * named after what it does. Rejects `gcloud_no_project` when the CLI refuses
   * the id — usually because the ADC lacks `serviceusage.services.use` on it.
   */
  'providers.setQuotaProject': (input: { project: string }) => Promise<ProviderAuthStatus>

  /* -- agents ------------------------------------------------------------- */

  'agents.list': () => Promise<Agent[]>
  'agents.get': (input: { id: string }) => Promise<Agent>
  'agents.create': (input: { input: AgentInput }) => Promise<Agent>
  'agents.update': (input: { id: string; patch: Partial<AgentInput> }) => Promise<Agent>
  'agents.delete': (input: { id: string }) => Promise<void>

  /* -- MCP servers -------------------------------------------------------- */

  'mcp.list': () => Promise<McpServer[]>
  'mcp.create': (input: { input: McpServerInput }) => Promise<McpServer>
  'mcp.update': (input: { id: string; patch: Partial<McpServerInput> }) => Promise<McpServer>
  'mcp.delete': (input: { id: string }) => Promise<void>
  /**
   * Connects, lists tools, disconnects. Never leaves the probe connection open,
   * and never touches the pooled client an agent may be mid-call on.
   *
   * Takes a `McpServerRef` rather than an id so an unsaved draft is testable.
   */
  'mcp.testConnection': (input: { server: McpServerRef }) => Promise<McpConnectionTestResult>
  /**
   * The server's tool list from the **pooled** connection, connecting if this is
   * the first ask.
   *
   * Unlike `testConnection` it keeps the client open, because the agent editor
   * asks for every bound server's tool count at once and a probe per card would
   * spawn and kill one child process per card. Rejects with `mcp_error` when the
   * server cannot be reached.
   */
  'mcp.tools': (input: { id: string }) => Promise<McpToolInfo[]>
  /**
   * The tail of a stdio server's stderr, oldest line first.
   *
   * The only way to see why a server that "just does not connect" is failing:
   * a missing package, a wrong path, a credential it printed a complaint about.
   * Empty for an http server and for one that has never been started.
   */
  'mcp.log': (input: { id: string }) => Promise<string[]>

  /* -- skills ------------------------------------------------------------- */

  /** Every readable skill under `userData/skills/`, plus the folders that were skipped. */
  'skills.list': () => Promise<{ skills: SkillMeta[]; warnings: SkillWarning[] }>
  /**
   * Copies a skill folder into `userData/skills/` and returns its parsed header.
   *
   * `sourcePath` must be a folder containing `SKILL.md`. Refuses a name that is
   * already taken unless `overwrite` is set.
   */
  'skills.import': (input: { sourcePath: string; overwrite?: boolean }) => Promise<SkillMeta>
  /** The skill's frontmatter, body and bundled file list, for the detail pane. */
  'skills.read': (input: { name: string }) => Promise<SkillDetail>
  /** Removes the skill folder. The name stays on any agent that listed it. */
  'skills.delete': (input: { name: string }) => Promise<void>

  /* -- memory (one markdown directory per agent) -------------------------- */

  'memory.list': (input: { agentId: string }) => Promise<MemoryEntry[]>
  /** `path` is relative to the agent's memory directory; `MEMORY.md` is the index. */
  'memory.read': (input: { agentId: string; path: string }) => Promise<{ path: string; content: string }>
  'memory.write': (input: { agentId: string; path: string; content: string }) => Promise<MemoryEntry>
  /** Removes one note, or empties the index when `path` is `MEMORY.md`. */
  'memory.delete': (input: { agentId: string; path: string }) => Promise<void>
  /** Case-insensitive substring search over the index and every note body. */
  'memory.search': (input: { agentId: string; query: string }) => Promise<MemorySearchHit[]>

  /* -- chats -------------------------------------------------------------- */

  'chats.list': () => Promise<Chat[]>
  'chats.get': (input: { id: string }) => Promise<Chat>
  /** `memberAgentIds` seeds the member list; see `ChatCreateInput`. */
  'chats.create': (input: { input: ChatCreateInput }) => Promise<Chat>
  /** `settings` is merged field by field; see `ChatPatch`. */
  'chats.update': (input: { id: string; patch: ChatPatch }) => Promise<Chat>
  'chats.delete': (input: { id: string }) => Promise<void>
  /**
   * Ids of the chats whose title or any message text matches `query`, newest
   * chat first, capped at `CHAT_SEARCH_LIMIT`.
   *
   * Ids rather than `Chat[]`: the renderer already mirrors every chat, so the
   * left column only needs to know **which** of the rows it is holding survive
   * the filter. Sending the rows again would duplicate state that a
   * `chat.updated` event could have changed in between, and the list would then
   * show two versions of the same chat depending on whether a search was active.
   *
   * A blank query returns every chat, so the caller never has to special-case
   * "the user cleared the box".
   */
  'chats.search': (input: { query: string }) => Promise<string[]>
  /**
   * Whether this chat's `document` deliverable is on disk yet (S5.10).
   *
   * A query rather than a field on `Chat` because it is a fact about the
   * **filesystem**: a stored column would be wrong the moment anything wrote,
   * moved or deleted the file, and the renderer would be drawing a chip from a
   * value nobody refreshed. A chat with no `document` goal answers
   * `{ deliverable: null, delivered: false }` rather than rejecting — the header
   * asks for every chat it shows.
   */
  'chats.goalStatus': (input: { chatId: string }) => Promise<ChatGoalStatus>
  /** The chat's members ordered by `position`. Read by the member panel. */
  'chats.members.list': (input: { chatId: string }) => Promise<ChatMember[]>
  /** Replaces the whole member list; array order becomes `ChatMember.position`. */
  'chats.members.set': (input: { chatId: string; agentIds: string[] }) => Promise<ChatMember[]>

  /* -- presence ----------------------------------------------------------- */

  /**
   * Live presence of every member of a chat.
   *
   * Read once when a chat is opened, to seed the renderer's store; from then on
   * `presence.changed` keeps it current. Presence is runtime-only state — it is
   * never persisted — so this is the only way to learn it after a reload.
   */
  'presence.list': (input: { chatId: string }) => Promise<AgentPresence[]>
  /**
   * Probes the agent's provider once and returns the presence that resulted.
   *
   * The manual half of the recovery loop behind the "Retry" button on an offline
   * member. The probe is a model-list request, never a generation.
   */
  'presence.retry': (input: { chatId: string; agentId: string }) => Promise<AgentPresence>

  /* -- messages ----------------------------------------------------------- */

  /** Newest first. `before` is a message id used as an exclusive cursor. */
  'messages.list': (input: { chatId: string; before?: string; limit?: number }) => Promise<Message[]>
  /**
   * Token totals and estimated cost for a whole chat, per agent and overall.
   *
   * Computed over **every** stored message, not over the page the renderer is
   * holding, which is why it exists at all: a long chat's header must not report
   * only the last hundred messages. The renderer asks once when a chat is opened
   * and then recomputes the same summary locally from `message.updated` (see
   * `summarizeUsage` in `src/shared/usage.ts`, which both sides share) rather
   * than calling this again after every turn.
   */
  'messages.usageSummary': (input: { chatId: string }) => Promise<ChatUsageSummary>

  /* -- executor permissions ----------------------------------------------- */

  /**
   * Answers one permission prompt (S5.4).
   *
   * `requestId` comes from a `permission.requested` event. The call resolves as
   * soon as the waiting tool has been released; the tool's own result arrives in
   * the transcript as usual. A `requestId` that is not pending — because the run
   * was stopped, or because the same card was answered twice — rejects with
   * `not_found`, which is the renderer's cue that the card is stale.
   *
   * `allowAlways` runs this call **and** remembers the chat + tool pair for the
   * life of the process; see `PermissionDecision`.
   */
  'permission.reply': (input: { requestId: string; decision: PermissionDecision }) => Promise<void>

  /* -- running a chat ----------------------------------------------------- */

  /**
   * Persists the user message and starts a run. Resolves with the stored user
   * message as soon as the run is scheduled; agent output arrives as events.
   *
   * `rounds` (S5.14) caps the automatic rounds of **the chain this message
   * starts**, instead of `chat.settings.maxAutoRounds`, and applies to nothing
   * else: the next typed message is back on the chat's own setting. It must be
   * an integer from `MIN_AUTO_ROUNDS` to `MAX_AUTO_ROUNDS`. The Actions card's
   * "Start a vote" is its one caller and sends `1`.
   */
  'chat.send': (input: {
    chatId: string
    text: string
    mentions?: string[]
    rounds?: number
  }) => Promise<Message>
  /** Aborts the whole chain for this chat. Idempotent when nothing is running. */
  'chat.stop': (input: { chatId: string }) => Promise<void>
  /**
   * Hands the discussion to the chat's executor (S5.6).
   *
   * Persists a user message carrying the `notices.handoff` key and mentioning
   * the executor, then runs the executor's turn and **one** review round in
   * which the other members read what it changed. Resolves with that stored
   * message as soon as the run is scheduled, exactly like `chat.send`.
   *
   * `intent` (S5.12) says what is being handed over and defaults to
   * `'implement'`, which is S5.6's behaviour unchanged. `'deliver'` — the
   * "Write the deliverable" action — stores the `notices.handoffDeliver` key
   * instead and briefs the executor to write the `document` goal's file rather
   * than to implement the conclusion. Everything else about the call is
   * identical, which is why it is an argument and not a second method.
   *
   * Rejects with `validation` and a `ValidationReason` in `details` when the
   * chat has no working directory (`handoff_no_workdir`), no executor member
   * (`handoff_no_executor`), `intent: 'deliver'` on a chat whose goal names no
   * deliverable (`handoff_no_deliverable`), or a run is already in flight
   * (`handoff_run_active`) — the four states the buttons are disabled in.
   */
  'chat.handoff': (input: { chatId: string; intent?: HandoffIntent }) => Promise<Message>
}

/** The name of any backend method. */
export type BackendMethod = keyof BackendApi

/**
 * The transport-agnostic client the renderer depends on.
 *
 * `invoke` is one request/response call; `subscribe` is the push channel. There
 * is nothing else — anything a page needs must be expressible as one of the two.
 */
export interface BackendClient {
  /** Calls a backend method. Rejects with a `BackendError`. */
  invoke<M extends BackendMethod>(
    method: M,
    ...args: Parameters<BackendApi[M]>
  ): ReturnType<BackendApi[M]>

  /** Subscribes to every backend event. Returns the unsubscribe function. */
  subscribe(listener: (event: BackendEvent) => void): () => void

  /** Convenience filter over `subscribe`. Returns the unsubscribe function. */
  subscribeTo?<T extends BackendEventType>(type: T, listener: (event: EventOf<T>) => void): () => void
}

/**
 * Every method name as data, for the layers that must iterate them: the preload
 * bridge exposes one channel per entry and the main process asserts that each has
 * a handler. Kept in sync with `BackendApi` by the compile-time check below.
 */
export const BACKEND_METHODS = [
  'system.ping',
  'system.emitTestEvent',
  'system.pickFolder',
  'system.pickSavePath',
  'system.pickPaths',
  'system.applyTheme',
  'system.openInEditor',
  'settings.get',
  'settings.update',
  'providers.list',
  'providers.get',
  'providers.create',
  'providers.update',
  'providers.delete',
  'providers.fetchModels',
  'providers.testConnection',
  'providers.authStatus',
  'providers.login',
  'providers.logout',
  'providers.setQuotaProject',
  'agents.list',
  'agents.get',
  'agents.create',
  'agents.update',
  'agents.delete',
  'mcp.list',
  'mcp.create',
  'mcp.update',
  'mcp.delete',
  'mcp.testConnection',
  'mcp.tools',
  'mcp.log',
  'skills.list',
  'skills.import',
  'skills.read',
  'skills.delete',
  'memory.list',
  'memory.read',
  'memory.write',
  'memory.delete',
  'memory.search',
  'chats.list',
  'chats.get',
  'chats.create',
  'chats.update',
  'chats.delete',
  'chats.search',
  'chats.goalStatus',
  'chats.members.list',
  'chats.members.set',
  'presence.list',
  'presence.retry',
  'messages.list',
  'messages.usageSummary',
  'permission.reply',
  'chat.send',
  'chat.stop',
  'chat.handoff'
] as const satisfies readonly BackendMethod[]

/** A method name that appears in `BACKEND_METHODS`. */
type ListedBackendMethod = (typeof BACKEND_METHODS)[number]

type Assert<T extends true> = T

/**
 * Compile-time proof that `BACKEND_METHODS` and `keyof BackendApi` are the same
 * set. `satisfies` above rejects a name that is not a method; this rejects a
 * method that was added to `BackendApi` and not to the array.
 */
export type BackendMethodsAreExhaustive = Assert<
  [Exclude<BackendMethod, ListedBackendMethod>, Exclude<ListedBackendMethod, BackendMethod>] extends [never, never]
    ? true
    : false
>

/** Narrows a value to a known method name at runtime (used by the IPC registry). */
export function isBackendMethod(value: unknown): value is BackendMethod {
  return typeof value === 'string' && (BACKEND_METHODS as readonly string[]).includes(value)
}
