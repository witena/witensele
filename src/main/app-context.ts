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
 * path in, because only `src/main/index.ts` may ask electron for `userData`.
 */
import type { UserId } from '@shared/types'
import { LOCAL_USER_ID } from '@shared/types'
import type { DatabaseHandle } from './db/database'
import { openDatabase } from './db/database'
import type { Repositories } from './db/repositories'
import { createRepositories } from './db/repositories'
import type { EventBus } from './events/bus'
import { createEventBus } from './events/bus'
import { ChatRunnerRegistry } from './orchestration/chat-runner'
import type { ChatRunnerOptions } from './orchestration/chat-runner'
import type { FetchImpl } from './providers/discovery'
import type { SecretStore } from './secrets'

export interface AppContext {
  /** The open database, including the raw driver and `close()`. */
  db: DatabaseHandle
  /** Typed persistence, already bound to `secrets.encrypt`. */
  repos: Repositories
  /** The push channel to the renderer. */
  events: EventBus
  /** Encryption for provider API keys; decryption is used only when calling a model. */
  secrets: SecretStore
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
   * Outbound HTTP for handlers that talk to a provider's REST endpoint
   * (`providers.fetchModels`). Absent means the platform `fetch`; a test injects
   * its own so the suite never opens a socket, and a future server build can put
   * a proxy-aware implementation here without touching a handler.
   */
  fetchImpl?: FetchImpl
  /** Releases the database. Safe to call more than once. */
  close(): void
}

export interface AppContextOptions {
  /** Absolute path of the SQLite file, or `':memory:'`. */
  databasePath: string
  secrets: SecretStore
  /** Defaults to `LOCAL_USER_ID`; present so a server build can pass a real user. */
  userId?: UserId
  /** Injectable so a test can watch events without reaching into the context. */
  events?: EventBus
  /** Injectable outbound HTTP; omitted, handlers use the platform `fetch`. */
  fetchImpl?: FetchImpl
  /** Passed through to every `ChatRunner`; a test injects its own `createModel`. */
  runner?: ChatRunnerOptions
}

export function createAppContext(options: AppContextOptions): AppContext {
  const { databasePath, secrets } = options
  const db = openDatabase(databasePath)
  // Wrapped rather than passed by reference so an implementation that relies on
  // `this` keeps working.
  const repos = createRepositories(db.db, { encrypt: (plain) => secrets.encrypt(plain) })

  let closed = false

  const ctx: AppContext = {
    db,
    repos,
    events: options.events ?? createEventBus(),
    secrets,
    userId: options.userId ?? LOCAL_USER_ID,
    // Replaced immediately below: the registry needs the finished context, and
    // the context declares the registry, so one of the two has to be tied off
    // after construction. Doing it here keeps every consumer's type honest.
    runners: undefined as unknown as ChatRunnerRegistry,
    // Spread rather than assigned: `exactOptionalPropertyTypes` wants the field
    // absent, not present and undefined.
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    close() {
      if (closed) return
      closed = true
      ctx.runners.stopAll()
      db.close()
    }
  }

  ctx.runners = new ChatRunnerRegistry(ctx, options.runner ?? {})
  return ctx
}
