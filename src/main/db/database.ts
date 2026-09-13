/**
 * Opening the SQLite database.
 *
 * The file path is **injected**, never derived here: only `src/main/index.ts` is
 * allowed to ask electron for `app.getPath('userData')` (CLAUDE.md rule #5), so
 * this module — and everything else under `src/main/db/` — stays Electron-free
 * and can be reused by tests, a CLI or the future Node server unchanged.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import type { Database } from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'
import { runMigrations } from './migrate'

/** The drizzle handle every repository takes. */
export type DrizzleDb = BetterSQLite3Database<typeof schema>

export interface DatabaseHandle {
  db: DrizzleDb
  /** The raw driver, for pragmas, the migrator and anything drizzle cannot express. */
  sqlite: Database
  close(): void
}

/** In-memory database path accepted by better-sqlite3; used by tests. */
export const MEMORY_DATABASE = ':memory:'

/**
 * Opens (creating it if needed) the database at `filePath`, applies every pending
 * migration and returns the drizzle handle.
 *
 * Pragmas:
 * - `journal_mode = WAL` — readers never block the single writer.
 * - `foreign_keys = ON` — off by default in SQLite; without it the `ON DELETE
 *   CASCADE` clauses in the schema are inert.
 * - `busy_timeout` — wait instead of failing when a write lock is held.
 *
 * `':memory:'` is accepted and skips directory creation.
 */
export function openDatabase(filePath: string, options: { busyTimeoutMs?: number } = {}): DatabaseHandle {
  if (filePath !== MEMORY_DATABASE) {
    mkdirSync(dirname(filePath), { recursive: true })
  }

  const sqlite = new BetterSqlite3(filePath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5_000}`)

  runMigrations(sqlite)

  return {
    db: drizzle(sqlite, { schema }),
    sqlite,
    close: () => {
      sqlite.close()
    }
  }
}
