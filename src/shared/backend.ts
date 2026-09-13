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
import type {
  Agent,
  AgentInput,
  AgentPresence,
  AppSettings,
  AppSettingsPatch,
  Chat,
  ChatCreateInput,
  ChatMember,
  ChatPatch,
  ConnectionTestResult,
  McpConnectionTestResult,
  McpServer,
  McpServerInput,
  McpToolInfo,
  MemoryEntry,
  Message,
  Provider,
  ProviderInput,
  SkillMeta
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

  'skills.list': () => Promise<SkillMeta[]>
  /** Copies a skill folder into `userData/skills/` and returns its parsed header. */
  'skills.import': (input: { sourcePath: string }) => Promise<SkillMeta>

  /* -- memory (one markdown directory per agent) -------------------------- */

  'memory.list': (input: { agentId: string }) => Promise<MemoryEntry[]>
  /** `path` is relative to the agent's memory directory; `MEMORY.md` is the index. */
  'memory.read': (input: { agentId: string; path: string }) => Promise<{ path: string; content: string }>
  'memory.write': (input: { agentId: string; path: string; content: string }) => Promise<MemoryEntry>

  /* -- chats -------------------------------------------------------------- */

  'chats.list': () => Promise<Chat[]>
  'chats.get': (input: { id: string }) => Promise<Chat>
  /** `memberAgentIds` seeds the member list; see `ChatCreateInput`. */
  'chats.create': (input: { input: ChatCreateInput }) => Promise<Chat>
  /** `settings` is merged field by field; see `ChatPatch`. */
  'chats.update': (input: { id: string; patch: ChatPatch }) => Promise<Chat>
  'chats.delete': (input: { id: string }) => Promise<void>
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

  /* -- running a chat ----------------------------------------------------- */

  /**
   * Persists the user message and starts a run. Resolves with the stored user
   * message as soon as the run is scheduled; agent output arrives as events.
   */
  'chat.send': (input: { chatId: string; text: string; mentions?: string[] }) => Promise<Message>
  /** Aborts the whole chain for this chat. Idempotent when nothing is running. */
  'chat.stop': (input: { chatId: string }) => Promise<void>
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
  'settings.get',
  'settings.update',
  'providers.list',
  'providers.get',
  'providers.create',
  'providers.update',
  'providers.delete',
  'providers.fetchModels',
  'providers.testConnection',
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
  'memory.list',
  'memory.read',
  'memory.write',
  'chats.list',
  'chats.get',
  'chats.create',
  'chats.update',
  'chats.delete',
  'chats.members.list',
  'chats.members.set',
  'presence.list',
  'presence.retry',
  'messages.list',
  'chat.send',
  'chat.stop'
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
