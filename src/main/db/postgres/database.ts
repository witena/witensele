/**
 * Opening the Postgres database.
 *
 * The sibling of `../database.ts`, and shaped like it on purpose: a connection
 * string in, a drizzle handle plus `close()` out, migrations applied on the way.
 * Neither file imports electron (CLAUDE.md rule #5) and neither asks where the
 * database lives — the caller knows.
 *
 * Migrations are inlined by the same `import.meta.glob(… '?raw')` primitive the
 * SQLite migrator uses, for the same reason: the server is bundled into
 * `out/server/index.js` and a `migrations/` folder is not copied next to it. The
 * bookkeeping table is `__migrations` in both dialects, with the same "one
 * transaction per file, recorded by name" rule, so a reader who has understood
 * one migrator has understood the other.
 */
import pg from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import { splitStatements } from '../migrate'
import * as schema from './schema'

/** The drizzle handle over Postgres. The asynchronous twin of `DrizzleDb`. */
export type PostgresDb = NodePgDatabase<typeof schema>

export interface PostgresHandle {
  db: PostgresDb
  /** The raw pool, for anything drizzle cannot express and for the migrator. */
  pool: pg.Pool
  close(): Promise<void>
}

/** The table that records which migration files have already run. */
const MIGRATIONS_TABLE = '__migrations'

/** Every Postgres migration file, keyed by its path relative to this module. */
const migrationSources = import.meta.glob('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>

export interface Migration {
  name: string
  statements: string[]
}

/** The bundled Postgres migrations, ordered by file name. */
export function loadPostgresMigrations(): Migration[] {
  return Object.keys(migrationSources)
    .sort()
    .map((path) => ({
      name: path.slice(path.lastIndexOf('/') + 1),
      statements: splitStatements(migrationSources[path] ?? '')
    }))
}

/**
 * Applies every migration that is not recorded yet and returns their names.
 *
 * Idempotent, like the SQLite one: a database that is already up to date returns
 * an empty array. Each file runs inside its own transaction together with the
 * `__migrations` row, so an interrupted deploy leaves a file unapplied rather
 * than half applied.
 *
 * `pg_advisory_xact_lock` wraps the whole pass because a server *is* several
 * processes: two ECS tasks starting at once would otherwise both see the same
 * empty `__migrations` and both run `CREATE TABLE`. SQLite needs no equivalent —
 * it has one writer by construction — which is the first place the two dialects
 * stop being the same problem.
 */
export async function runPostgresMigrations(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // An arbitrary but fixed key: any two processes running *this* migrator must
    // agree on it, and nothing else in the database uses advisory locks.
    await client.query('SELECT pg_advisory_xact_lock($1)', [0x77_69_74_65])
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (name text PRIMARY KEY NOT NULL, applied_at bigint NOT NULL)`
    )
    const { rows } = await client.query<{ name: string }>(
      `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY name`
    )
    const applied = new Set(rows.map((row) => row.name))
    const pending = loadPostgresMigrations().filter((migration) => !applied.has(migration.name))

    for (const migration of pending) {
      for (const statement of migration.statements) await client.query(statement)
      await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES ($1, $2)`, [
        migration.name,
        Date.now()
      ])
    }

    await client.query('COMMIT')
    return pending.map((migration) => migration.name)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export interface PostgresOptions {
  /** Maximum pooled connections. Small by default; a Fargate task is not a laptop. */
  max?: number
  /** Skip the migration pass — used by the test fixture, which migrates once. */
  migrate?: boolean
}

/**
 * Connects to `url`, applies every pending migration and returns the handle.
 *
 * `close()` drains the pool, which is what a `SIGTERM` handler must await before
 * the process exits; leaving it out is how a redeploy turns into a handful of
 * connections Postgres keeps open until its own timeout.
 */
export async function openPostgresDatabase(
  url: string,
  options: PostgresOptions = {}
): Promise<PostgresHandle> {
  const pool = new pg.Pool({ connectionString: url, max: options.max ?? 10 })
  if (options.migrate !== false) await runPostgresMigrations(pool)

  return {
    db: drizzle(pool, { schema }),
    pool,
    close: () => pool.end()
  }
}

/**
 * Empties every table, for a test that wants a clean database without paying for
 * a new one.
 *
 * `TRUNCATE … CASCADE` rather than seven `DELETE`s: it is one statement, it does
 * not care about the foreign keys' order, and it is the difference between a
 * fixture that costs a millisecond and one that costs a connection.
 */
export async function truncateAll(db: PostgresDb): Promise<void> {
  await db.execute(
    sql.raw(
      'TRUNCATE TABLE messages, chat_members, chats, agents, mcp_servers, providers, settings CASCADE'
    )
  )
}
