/**
 * The migrator.
 *
 * drizzle-orm ships `migrate(db, { migrationsFolder })`, which reads `.sql` files
 * from disk at runtime. That does not survive packaging: the main process is
 * bundled into `out/main/index.js` and the migrations folder is not copied next
 * to it. So the SQL is **inlined into the bundle at build time** instead:
 * `import.meta.glob(… { query: '?raw', eager: true })` is a Vite primitive that
 * electron-vite resolves for the main build and vitest resolves for tests, which
 * is why the same code path is exercised by both.
 *
 * Applied migrations are tracked by file name in a `__migrations` table, each
 * file is applied inside a transaction, and the statements within a file are
 * split on drizzle's `--> statement-breakpoint` marker.
 *
 * To add a migration: edit `schema.ts`, run `npm run db:generate`, commit the new
 * `migrations/*.sql` together with `migrations/meta/`. Never edit an applied file.
 */
import type { Database } from 'better-sqlite3'

/**
 * Every migration file, keyed by its path relative to this module. Eager and raw,
 * so the bundle contains the SQL text itself rather than a runtime file read.
 */
const migrationSources = import.meta.glob('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>

/** The table that records which migration files have already run. */
const MIGRATIONS_TABLE = '__migrations'

/** drizzle-kit separates the statements of one file with this marker. */
const STATEMENT_BREAKPOINT = '--> statement-breakpoint'

export interface Migration {
  /** File name without the directory, e.g. `0000_outstanding_medusa.sql`. */
  name: string
  /** Statements of the file, already split and trimmed. */
  statements: string[]
}

/** The bundled migrations, ordered by file name (drizzle prefixes them `0000_`…). */
export function loadMigrations(): Migration[] {
  return Object.keys(migrationSources)
    .sort()
    .map((path) => {
      const name = path.slice(path.lastIndexOf('/') + 1)
      const sql = migrationSources[path] ?? ''
      const statements = sql
        .split(STATEMENT_BREAKPOINT)
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0)
      return { name, statements }
    })
}

/** Names of the migrations already recorded in the database. */
export function appliedMigrations(sqlite: Database): string[] {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (name text PRIMARY KEY NOT NULL, applied_at integer NOT NULL)`
  )
  const rows = sqlite
    .prepare(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY name`)
    .all() as Array<{ name: string }>
  return rows.map((row) => row.name)
}

/**
 * Applies every migration that is not recorded yet and returns their names.
 * Idempotent: a database that is already up to date returns an empty array.
 */
export function runMigrations(sqlite: Database): string[] {
  const applied = new Set(appliedMigrations(sqlite))
  const pending = loadMigrations().filter((migration) => !applied.has(migration.name))
  if (pending.length === 0) return []

  const record = sqlite.prepare(
    `INSERT INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`
  )

  for (const migration of pending) {
    const apply = sqlite.transaction(() => {
      for (const statement of migration.statements) sqlite.exec(statement)
      record.run(migration.name, Date.now())
    })
    apply()
  }

  return pending.map((migration) => migration.name)
}
