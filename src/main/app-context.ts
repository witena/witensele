/**
 * Everything a backend handler is allowed to reach.
 *
 * Handlers are plain functions of `(ctx, input)`: they never import electron,
 * never open a database and never reach for a module-level singleton. That is
 * what keeps the whole handler layer testable against a temporary file and
 * liftable into a Node server (CLAUDE.md rule #5) — the server builds the same
 * context from its own configuration and reuses every handler unchanged.
 *
 * This module is transport-agnostic on purpose: the caller passes the database
 * path and the data directory in, because only `src/main/index.ts` may ask
 * electron for `userData`. Everything filesystem-backed — the skills library and
 * the per-agent memory folders — is derived from that one injected directory.
 */
import { join } from 'node:path'
import type { OAuthProviderType } from '@shared/presets'
import type { AppTimeouts, UserId } from '@shared/types'
import { LOCAL_USER_ID } from '@shared/types'
import type { DatabaseHandle } from './db/database'
import { openDatabase } from './db/database'
import type { Repositories } from './db/repositories'
import { createRepositories } from './db/repositories'
import type { EventBus } from './events/bus'
import { createEventBus } from './events/bus'
import type { PermissionGate } from './executor/permissions'
import { createPermissionGate } from './executor/permissions'
import { McpManager } from './mcp/manager'
import type { McpManagerOptions } from './mcp/manager'
import { createMemoryStore, type MemoryStore } from './memory/store'
import { ChatRunnerRegistry } from './orchestration/chat-runner'
import type { ChatRunnerOptions } from './orchestration/chat-runner'
import { AgentSupervisor } from './presence/supervisor'
import type { AgentSupervisorOptions, PresenceTimeouts } from './presence/supervisor'
import type { AnthropicCli } from './providers/anthropic-cli'
import { createAnthropicCli } from './providers/anthropic-cli'
import type { GoogleCli } from './providers/google-cli'
import { createGoogleCli } from './providers/google-cli'
import { fetchModels, type FetchImpl } from './providers/discovery'
import { createProviderFetch } from './providers/registry'
import type { ModelOptions, ResolvedProvider } from './providers/registry'
import { resolveProvider } from './providers/resolve'
import type { SecretStore } from './secrets'

/**
 * The parts of `AgentSupervisorOptions` a caller may override.
 *
 * Everything else is derived from the context itself — the supervisor must not
 * reach the database, so its accessors are built here and nowhere else. Tests
 * shorten the intervals and swap the clock and the provider probe; production
 * passes nothing.
 */
export type SupervisorOverrides = Partial<
  Pick<AgentSupervisorOptions, 'clock' | 'heartbeatIntervalMs' | 'probeIntervalMs' | 'probeProvider'>
>

/**
 * The chat's overrides merged over the global setting.
 *
 * A chat stores only the fields the user changed (`ChatSettings.stallTimeoutMs`
 * / `hardTimeoutMs` are both optional), so the global `AppSettings.timeouts` is
 * the floor under every chat rather than a default copied into it at creation.
 */
export function resolveTimeouts(ctx: AppContext, chatId: string): PresenceTimeouts {
  const global: AppTimeouts = ctx.repos.settings.get(ctx.userId).timeouts
  try {
    const settings = ctx.repos.chats.get(chatId, ctx.userId).settings
    return {
      stallTimeoutMs: settings.stallTimeoutMs ?? global.stallTimeoutMs,
      hardTimeoutMs: settings.hardTimeoutMs ?? global.hardTimeoutMs
    }
  } catch {
    // The chat was deleted while a turn was still unwinding; the global budget
    // is the only sensible answer and the turn is about to end anyway.
    return { stallTimeoutMs: global.stallTimeoutMs, hardTimeoutMs: global.hardTimeoutMs }
  }
}

/**
 * The recovery probe: read the agent's provider model list.
 *
 * Deliberately **not** a generation — `providers.testConnection` loads a model
 * and costs tokens, which is not something a background loop may do every
 * minute. Never throws: an unreachable endpoint is the answer, not an error.
 */
export async function probeAgentProvider(ctx: AppContext, agentId: string): Promise<boolean> {
  try {
    const agent = ctx.repos.agents.get(agentId, ctx.userId)
    const resolved = resolveProvider(ctx, { id: agent.providerId })
    // Through the provider's own `fetch`, so a signed-in provider is probed with
    // its account token rather than with the key it does not have.
    await fetchModels(resolved, providerFetch(ctx, resolved))
    return true
  } catch {
    return false
  }
}

/**
 * The `fetch` a provider's REST calls go through, given this context.
 *
 * One line in three places (`probeAgentProvider` here, `providers.fetchModels`
 * and the connection probe in the handler) rather than three spellings of
 * "…unless it signs in, in which case wrap it".
 */
export function providerFetch(ctx: AppContext, provider: ResolvedProvider): FetchImpl {
  return createProviderFetch(provider, modelOptions(ctx))
}

/** The capabilities the model layer takes by injection, read off the context. */
export function modelOptions(ctx: AppContext): ModelOptions {
  return {
    anthropicCli: ctx.anthropicCli,
    googleCli: ctx.googleCli,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {})
  }
}

/**
 * The vendor CLI behind one sign-in provider type (S5.13).
 *
 * Total over `OAuthProviderType`, so a third vendor cannot be added to
 * `OAUTH_PROVIDER_TYPES` without the compiler asking which CLI answers for it.
 * The two interfaces agree on the four methods every caller here uses; only the
 * Google one has more, and `providers.setQuotaProject` reaches for `ctx.googleCli`
 * directly rather than widening this return type to a union nobody can narrow.
 */
export function authCli(ctx: AppContext, type: OAuthProviderType): AnthropicCli {
  return type === 'anthropic' ? ctx.anthropicCli : ctx.googleCli
}

/** Directory name of the skills library inside `userDataDir`. */
export const SKILLS_DIR = 'skills'

/** Directory name of the per-agent memory folders inside `userDataDir`. */
export const MEMORY_DIR = 'memory'

/**
 * Where the skills library lives.
 *
 * Derived from the injected `userDataDir` rather than asked of electron, so the
 * whole skills feature can be driven from a unit test against a temporary
 * directory and lifted into a server later (CLAUDE.md rule #5).
 */
export function skillsDir(ctx: AppContext): string {
  return join(ctx.userDataDir, SKILLS_DIR)
}

/** Where the per-agent memory folders live. */
export function memoryDir(ctx: AppContext): string {
  return join(ctx.userDataDir, MEMORY_DIR)
}

export interface AppContext {
  /** The open database, including the raw driver and `close()`. */
  db: DatabaseHandle
  /**
   * The application's data directory: the database, `skills/` and `memory/`.
   *
   * Injected, because only `src/main/index.ts` may ask electron for
   * `app.getPath('userData')`. Read through `skillsDir()` / `memoryDir()` rather
   * than joined by hand, so the layout is stated in one place.
   */
  userDataDir: string
  /** Typed persistence, already bound to `secrets.encrypt`. */
  repos: Repositories
  /** The push channel to the renderer. */
  events: EventBus
  /** Encryption for provider API keys; decryption is used only when calling a model. */
  secrets: SecretStore
  /**
   * Ids of providers whose stored key this build cannot decrypt (S7.6).
   *
   * Filled by `migrateProviderSecrets` at startup and by `resolveProvider` when
   * a decrypt fails later; read by the `providers.*` handlers, which turn it
   * into `Provider.keyState` so the UI can ask for the key again. In memory
   * rather than a column, because it is a fact about *this installation's*
   * encryption key and not about the row: restoring the Keychain item or moving
   * the database to the machine that wrote it makes the same row readable again.
   *
   * On the context rather than in a module singleton, for the same reason the
   * runners and the supervisor are: two contexts (a test's and the app's) must
   * never share one.
   */
  unreadableSecrets: Set<string>
  /** The implicit single user of the desktop build. */
  userId: UserId
  /**
   * One `ChatRunner` per chat, holding the live run and its `AbortController`.
   *
   * It lives on the context rather than in a module singleton because a run
   * outlives the IPC call that started it: `chat.stop` must reach the same
   * controller `chat.send` created, and two contexts (a test's and the app's)
   * must never share one.
   */
  runners: ChatRunnerRegistry
  /**
   * Presence, the heartbeat and the two timeouts, for every (chat, agent) pair.
   *
   * On the context for the same reason as `runners`: a session outlives the IPC
   * call that created it, and `presence.retry` has to reach the same supervisor
   * the running turn registered with.
   */
  supervisor: AgentSupervisor
  /**
   * The MCP connection pool.
   *
   * On the context for the same reason as `runners` and `supervisor`: a stdio
   * server is a child process that outlives the call that started it, and
   * `mcp.update` has to be able to close the very client an agent turn opened.
   */
  mcp: McpManager
  /**
   * Per-agent markdown memory, bound to `memoryDir(ctx)`.
   *
   * On the context for the same reason the repositories are: it is the one
   * object that knows where an agent's notes live, and a handler that rebuilt it
   * from a path would be one more place to keep the layout in sync.
   */
  memory: MemoryStore
  /**
   * The executor's permission prompt (S5.4).
   *
   * On the context for the same reason as `runners` and `supervisor`: a prompt
   * outlives the IPC call that raised it — the tool call is suspended inside a
   * turn while the user reads the card — and `permission.reply` has to reach the
   * very gate that is holding that promise.
   */
  permissions: PermissionGate
  /**
   * Outbound HTTP for handlers that talk to a provider's REST endpoint
   * (`providers.fetchModels`). Absent means the platform `fetch`; a test injects
   * its own so the suite never opens a socket, and a future server build can put
   * a proxy-aware implementation here without touching a handler.
   */
  fetchImpl?: FetchImpl
  /**
   * The Anthropic CLI wrapper behind "Sign in with Anthropic" (S5.3).
   *
   * On the context because it owns the in-memory access-token cache and because
   * a test must be able to replace it with a stub: it is the one capability that
   * spawns a process the user installed themselves.
   */
  anthropicCli: AnthropicCli
  /**
   * The Google Cloud SDK wrapper behind "Sign in with Google" (S5.13).
   *
   * On the context for exactly the reasons `anthropicCli` is: it owns an
   * in-memory credential cache, and a test must be able to replace it with a
   * stub rather than run whatever `gcloud` the developer happens to have.
   */
  googleCli: GoogleCli
  /** Releases the database. Safe to call more than once. */
  close(): void
}

export interface AppContextOptions {
  /** Absolute path of the SQLite file, or `':memory:'`. */
  databasePath: string
  /** Absolute path of the data directory holding `skills/` and `memory/`. */
  userDataDir: string
  secrets: SecretStore
  /** Defaults to `LOCAL_USER_ID`; present so a server build can pass a real user. */
  userId?: UserId
  /** Injectable so a test can watch events without reaching into the context. */
  events?: EventBus
  /** Injectable outbound HTTP; omitted, handlers use the platform `fetch`. */
  fetchImpl?: FetchImpl
  /** Injectable Anthropic CLI; omitted, the real `ant`-spawning implementation. */
  anthropicCli?: AnthropicCli
  /** Injectable Google CLI; omitted, the real `gcloud`-spawning implementation. */
  googleCli?: GoogleCli
  /** Passed through to every `ChatRunner`; a test injects its own `createModel`. */
  runner?: ChatRunnerOptions
  /** Clock, intervals and provider probe of the `AgentSupervisor`. */
  supervisor?: SupervisorOverrides
  /**
   * Transport construction and working directory of the `McpManager`.
   *
   * `getServer` is never overridable: it is derived from the context's own
   * repositories, exactly like the supervisor's accessors.
   */
  mcp?: Omit<McpManagerOptions, 'getServer'>
}

/** Builds the MCP pool's accessors from a finished context. */
export function createMcpManager(
  ctx: AppContext,
  overrides: Omit<McpManagerOptions, 'getServer'> = {}
): McpManager {
  return new McpManager({
    getServer: (serverId) => ctx.repos.mcpServers.get(serverId, ctx.userId),
    ...overrides
  })
}

/** Builds the supervisor's accessors from a finished context. */
export function createSupervisor(
  ctx: AppContext,
  overrides: SupervisorOverrides = {}
): AgentSupervisor {
  return new AgentSupervisor({
    emit: (event) => ctx.events.emit(event),
    getTimeouts: (chatId) => resolveTimeouts(ctx, chatId),
    listChatIdsForAgent: (agentId) => ctx.repos.chats.listChatIdsForAgent(agentId, ctx.userId),
    listAgentIdsForChat: (chatId) =>
      ctx.repos.chats.listMembers(chatId, ctx.userId).map((member) => member.agentId),
    probeProvider: (agentId) => probeAgentProvider(ctx, agentId),
    ...overrides
  })
}

export function createAppContext(options: AppContextOptions): AppContext {
  const { databasePath, userDataDir, secrets } = options
  const db = openDatabase(databasePath)
  // Wrapped rather than passed by reference so an implementation that relies on
  // `this` keeps working.
  const repos = createRepositories(db.db, { encrypt: (plain) => secrets.encrypt(plain) })

  let closed = false

  const events = options.events ?? createEventBus()

  const ctx: AppContext = {
    db,
    userDataDir,
    repos,
    events,
    secrets,
    unreadableSecrets: new Set<string>(),
    userId: options.userId ?? LOCAL_USER_ID,
    // Replaced immediately below: the registry needs the finished context, and
    // the context declares the registry, so one of the two has to be tied off
    // after construction. Doing it here keeps every consumer's type honest.
    runners: undefined as unknown as ChatRunnerRegistry,
    supervisor: undefined as unknown as AgentSupervisor,
    mcp: undefined as unknown as McpManager,
    memory: createMemoryStore(join(userDataDir, MEMORY_DIR)),
    permissions: createPermissionGate({ emit: (event) => events.emit(event) }),
    anthropicCli: options.anthropicCli ?? createAnthropicCli(),
    googleCli: options.googleCli ?? createGoogleCli(),
    // Spread rather than assigned: `exactOptionalPropertyTypes` wants the field
    // absent, not present and undefined.
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    close() {
      if (closed) return
      closed = true
      ctx.runners.stopAll()
      ctx.supervisor.stop()
      // After `stopAll`, so a prompt whose turn is being aborted is closed by
      // its own signal and this only catches whatever that missed.
      ctx.permissions.abortAll()
      // Fire and forget: `close()` is synchronous because every caller of it is
      // (electron's `will-quit`, a test's `afterEach`), and a child process that
      // takes a moment to exit must not hold either of them up. The transport
      // kills the process, so nothing is leaked by not awaiting.
      void ctx.mcp.closeAll().catch(() => undefined)
      db.close()
    }
  }

  ctx.runners = new ChatRunnerRegistry(ctx, options.runner ?? {})
  ctx.supervisor = createSupervisor(ctx, options.supervisor ?? {})
  ctx.mcp = createMcpManager(ctx, options.mcp ?? {})
  return ctx
}
