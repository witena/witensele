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
}

export function createAppContext(options: AppContextOptions): AppContext {
  const { databasePath, secrets } = options
  const db = openDatabase(databasePath)
  // Wrapped rather than passed by reference so an implementation that relies on
  // `this` keeps working.
  const repos = createRepositories(db.db, { encrypt: (plain) => secrets.encrypt(plain) })

  let closed = false

  return {
    db,
    repos,
    events: options.events ?? createEventBus(),
    secrets,
    userId: options.userId ?? LOCAL_USER_ID,
    // Spread rather than assigned: `exactOptionalPropertyTypes` wants the field
    // absent, not present and undefined.
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    close() {
      if (closed) return
      closed = true
      db.close()
    }
  }
}
