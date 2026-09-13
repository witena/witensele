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
import type { BackendEvent } from '@shared/events'
import { LOCAL_USER_ID } from '@shared/types'
import type { AppContext, SupervisorOverrides } from './app-context'
import { createSupervisor } from './app-context'
import { createRepositories } from './db/repositories'
import type { TestDatabase } from './db/testing'
import { createEventBus } from './events/bus'
import { ChatRunnerRegistry, type ChatRunnerOptions } from './orchestration/chat-runner'
import type { AgentSupervisor } from './presence/supervisor'
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
    repos: createRepositories(database.handle.db, { encrypt: (plain) => secrets.encrypt(plain) }),
    events: bus,
    secrets,
    userId: LOCAL_USER_ID,
    // Tied off immediately below, as in `createAppContext`.
    runners: undefined as unknown as ChatRunnerRegistry,
    supervisor: undefined as unknown as AgentSupervisor,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    close: () => {
      ctx.supervisor.stop()
      database.cleanup()
    }
  }
  ctx.runners = new ChatRunnerRegistry(ctx, options.runner ?? {})
  ctx.supervisor = createSupervisor(ctx, {
    // Nothing real is probed from a unit test unless the test says otherwise.
    probeProvider: () => Promise.resolve(false),
    ...options.supervisor
  })

  return { ctx, events, secrets }
}
