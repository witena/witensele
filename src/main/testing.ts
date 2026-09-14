/**
 * An `AppContext` for unit tests: a real temporary database file, an in-process
 * event bus that records everything, and the insecure secret store.
 *
 * It exists because every service in the main process takes its context by
 * injection (CLAUDE.md rule #5), so the whole backend — handlers, `ChatRunner`,
 * `AgentTurn` — can be driven from vitest with no electron and no network. The
 * repositories are rebuilt here rather than taken from the `db/testing.ts`
 * fixture so that `encrypt` and `secrets.decrypt` are two halves of the *same*
 * store; a provider key written through one and read through another never
 * round-trips.
 *
 * Not imported by any production module, exactly like `db/testing.ts`, so it
 * never reaches the bundle.
 */
import { join } from 'node:path'
import type { BackendEvent } from '@shared/events'
import { LOCAL_USER_ID } from '@shared/types'
import type { AppContext, SupervisorOverrides } from './app-context'
import { createMcpManager, createSupervisor, MEMORY_DIR } from './app-context'
import { createRepositories } from './db/repositories'
import type { TestDatabase } from './db/testing'
import { createEventBus } from './events/bus'
import { createPermissionGate } from './executor/permissions'
import type { McpManager, McpManagerOptions } from './mcp/manager'
import { createMemoryStore } from './memory/store'
import { ChatRunnerRegistry, type ChatRunnerOptions } from './orchestration/chat-runner'
import type { AgentSupervisor } from './presence/supervisor'
import type { AnthropicCli } from './providers/anthropic-cli'
import { antMissing } from './providers/anthropic-cli'
import type { GoogleCli } from './providers/google-cli'
import { gcloudMissing } from './providers/google-cli'
import type { FetchImpl } from './providers/discovery'
import { createInsecureSecretStore, type SecretStore } from './secrets'

export interface TestAppContextOptions {
  /** Injected outbound HTTP, so a test never opens a socket. */
  fetchImpl?: FetchImpl
  /** Passed to every `ChatRunner`; a test injects `createModel` here. */
  runner?: ChatRunnerOptions
  /**
   * Clock, intervals and provider probe of the `AgentSupervisor`.
   *
   * The default is deliberately the real one: a suite that never stalls a turn
   * must not have to think about presence at all, and the real timers are
   * `unref`ed so a 1 s heartbeat cannot keep vitest alive. A test about the
   * heartbeat passes `heartbeatIntervalMs` (and a fake `probeProvider`) here.
   */
  supervisor?: SupervisorOverrides
  /**
   * Transport construction for the `McpManager`.
   *
   * A suite that exercises tools passes `createTransport` so the client talks to
   * an in-process `McpServer` over `InMemoryTransport` — no child process, no
   * `npx` download, and a deterministic tool list.
   */
  mcp?: Omit<McpManagerOptions, 'getServer'>
  /**
   * The Anthropic CLI (S5.3). Defaults to `absentAnthropicCli()`, which reports
   * "not installed" and spawns nothing: a unit test must never run a binary that
   * happens to be on the developer's machine, or the suite's result would depend
   * on whether they had signed in.
   */
  anthropicCli?: AnthropicCli
  /**
   * The Google CLI (S5.13). Defaults to `absentGoogleCli()`, for the same
   * reason: a machine that has never installed the Google Cloud SDK is the
   * honest baseline, and a suite whose result depended on the developer's own
   * `gcloud auth application-default login` would be no test at all.
   */
  googleCli?: GoogleCli
  /**
   * Request ids for the `PermissionGate` (S5.4).
   *
   * A suite that answers a prompt has to know its id; injecting a counter is
   * simpler than fishing the `permission.requested` event out of the array,
   * and it makes the assertions readable (`request-1`).
   */
  newRequestId?: () => string
}

/**
 * A CLI that is not there.
 *
 * The default for every test context, and the honest baseline: `ant` is
 * software the user installs separately, so "absent" is the state the suite
 * should assume unless it is the thing under test.
 */
export function absentAnthropicCli(): AnthropicCli {
  // Exactly what the real implementation does with no binary to run: `status`
  // answers with a state, everything that would have to *execute* rejects.
  const missing = (): Promise<never> => Promise.reject(antMissing())
  return {
    status: () => Promise.resolve({ state: 'not-installed' }),
    login: missing,
    logout: missing,
    accessToken: missing
  }
}

/**
 * A Google CLI that is not there. The Google half of `absentAnthropicCli`.
 */
export function absentGoogleCli(): GoogleCli {
  const missing = (): Promise<never> => Promise.reject(gcloudMissing())
  return {
    status: () => Promise.resolve({ state: 'not-installed' }),
    login: missing,
    logout: missing,
    accessToken: missing,
    project: missing,
    setQuotaProject: missing
  }
}

export interface TestAppContext {
  ctx: AppContext
  /** Every event emitted on the bus, in order. */
  events: BackendEvent[]
  secrets: SecretStore
}

/** Builds a context around an already-open test database. */
export function createTestAppContext(
  database: TestDatabase,
  options: TestAppContextOptions = {}
): TestAppContext {
  const bus = createEventBus()
  const events: BackendEvent[] = []
  bus.subscribe((event) => events.push(event))
  const secrets = createInsecureSecretStore()

  const ctx: AppContext = {
    db: database.handle,
    // The database fixture's own temporary directory doubles as `userData`, so
    // `skills/` and `memory/` land beside `witena.db` and are removed with it.
    userDataDir: database.dir,
    repos: createRepositories(database.handle.db, { encrypt: (plain) => secrets.encrypt(plain) }),
    events: bus,
    secrets,
    userId: LOCAL_USER_ID,
    // Tied off immediately below, as in `createAppContext`.
    runners: undefined as unknown as ChatRunnerRegistry,
    supervisor: undefined as unknown as AgentSupervisor,
    mcp: undefined as unknown as McpManager,
    memory: createMemoryStore(join(database.dir, MEMORY_DIR)),
    permissions: createPermissionGate({
      emit: (event) => bus.emit(event),
      ...(options.newRequestId ? { newRequestId: options.newRequestId } : {})
    }),
    anthropicCli: options.anthropicCli ?? absentAnthropicCli(),
    googleCli: options.googleCli ?? absentGoogleCli(),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    close: () => {
      ctx.supervisor.stop()
      ctx.permissions.abortAll()
      void ctx.mcp.closeAll().catch(() => undefined)
      database.cleanup()
    }
  }
  ctx.runners = new ChatRunnerRegistry(ctx, options.runner ?? {})
  ctx.supervisor = createSupervisor(ctx, {
    // Nothing real is probed from a unit test unless the test says otherwise.
    probeProvider: () => Promise.resolve(false),
    ...options.supervisor
  })
  ctx.mcp = createMcpManager(ctx, options.mcp ?? {})

  return { ctx, events, secrets }
}
