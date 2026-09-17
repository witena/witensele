/**
 * The fixture that runs one suite against both dialects.
 *
 * SQLite always; Postgres when `DATABASE_URL` is set, and a clearly-labelled
 * skip otherwise — so `npm test` is green on a laptop with no Docker and the
 * skip says what to start rather than pretending the coverage exists. CI keeps
 * running SQLite only for now (`docs/features/server/implement.md`, "What CI
 * does not run").
 *
 * **Why the fixture is a row gateway and not `Repositories`.** The repositories
 * are synchronous — `better-sqlite3` is, and the whole handler layer is written
 * against that — while drizzle's Postgres driver is asynchronous, so there is no
 * way to put the *same* repository object in front of both dialects without
 * changing an interface S8.1 is explicitly not allowed to change. What the two
 * dialects genuinely share is the storage contract underneath: the same tables,
 * the same columns, the same JSON documents, the same cascades, the same
 * ordering. That is what this gateway exposes and what `dialects.test.ts`
 * asserts. See `docs/features/database/context.md`, "One synchronous repository
 * interface, two dialects".
 *
 * Not imported by any production module, exactly like `testing.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asc, eq, getTableColumns, getTableName, type Column, type Table } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe } from 'vitest'
import { openDatabase, type DatabaseHandle } from './database'
import * as sqliteSchema from './schema'
import * as postgresSchema from './postgres/schema'
import { openPostgresDatabase, truncateAll, type PostgresHandle } from './postgres/database'

/** The environment variable that turns the Postgres half of every suite on. */
export const DATABASE_URL_ENV = 'DATABASE_URL'

/** What a skipped Postgres suite tells the reader to do about it. */
export const POSTGRES_SKIP_REASON =
  'DATABASE_URL is not set; run `docker compose up -d postgres` and re-run with ' +
  'DATABASE_URL=postgres://witena:witena@localhost:5432/witena'

/** The tables a suite may address, by their TypeScript names in both schemas. */
export type TableName =
  | 'providers'
  | 'agents'
  | 'mcpServers'
  | 'chats'
  | 'chatMembers'
  | 'messages'
  | 'settings'

/** A row as the fixture passes it: TypeScript property names, shared types. */
export type Row = Record<string, unknown>

/** An optional single-column filter. */
export interface Where {
  /** The column's **TypeScript** name (`chatId`), not its SQL one (`chat_id`). */
  column: string
  value: unknown
}

/**
 * The storage operations both dialects answer identically.
 *
 * Deliberately small, and it must not grow into a repository: the moment a suite
 * needs `''`-clears-the-column or a `not_found` rejection it is asking about the
 * repository layer, which is SQLite-only until that interface goes async.
 */
export interface DialectStore {
  insert(table: TableName, row: Row): Promise<void>
  selectAll(table: TableName, options?: { where?: Where; orderBy?: string }): Promise<Row[]>
  update(table: TableName, where: Where, patch: Row): Promise<void>
  remove(table: TableName, where: Where): Promise<void>
}

export interface DialectFixture {
  /** `'sqlite'` or `'postgres'`, for a test that needs to say which it is on. */
  readonly name: 'sqlite' | 'postgres'
  readonly store: DialectStore
  /** Empties every table, so each test starts from nothing. */
  reset(): Promise<void>
  /** Closes the handle and removes anything temporary. */
  cleanup(): Promise<void>
}

const SQLITE_TABLES: Record<TableName, Table> = {
  providers: sqliteSchema.providers,
  agents: sqliteSchema.agents,
  mcpServers: sqliteSchema.mcpServers,
  chats: sqliteSchema.chats,
  chatMembers: sqliteSchema.chatMembers,
  messages: sqliteSchema.messages,
  settings: sqliteSchema.settings
}

const POSTGRES_TABLES: Record<TableName, Table> = {
  providers: postgresSchema.providers,
  agents: postgresSchema.agents,
  mcpServers: postgresSchema.mcpServers,
  chats: postgresSchema.chats,
  chatMembers: postgresSchema.chatMembers,
  messages: postgresSchema.messages,
  settings: postgresSchema.settings
}

/**
 * Deletion order for the SQLite reset: children first.
 *
 * Postgres gets `TRUNCATE … CASCADE` and needs no order; SQLite has no such
 * statement, so the order is written out. Both end with seven empty tables.
 */
const SQLITE_RESET_ORDER: TableName[] = [
  'messages',
  'chatMembers',
  'chats',
  'agents',
  'mcpServers',
  'providers',
  'settings'
]

/** One column of a drizzle table, by its TypeScript property name. */
function column(table: Table, name: string): Column {
  const columns = getTableColumns(table) as Record<string, Column>
  const found = columns[name]
  if (!found) throw new Error(`No column "${name}" on ${getTableName(table)}`)
  return found
}

/**
 * The builder chain, with its per-table typing erased.
 *
 * The gateway is generic over tables by design, and drizzle's builders are
 * generic over *one* table's row type, so the two cannot both be true. The casts
 * are confined to these three aliases and to the two stores below; nothing
 * outside this file sees them, and `Row` is what every caller works with.
 */
type Chainable = {
  where(condition: unknown): Chainable
  orderBy(order: unknown): Chainable
  all(): unknown[]
}

/* -------------------------------------------------------------------------- */
/* SQLite                                                                      */
/* -------------------------------------------------------------------------- */

function sqliteStore(handle: DatabaseHandle): DialectStore {
  const db = handle.db

  return {
    async insert(table, row) {
      db.insert(SQLITE_TABLES[table] as never)
        .values(row as never)
        .run()
    },

    async selectAll(table, options = {}) {
      const target = SQLITE_TABLES[table]
      let query = db.select().from(target as never) as unknown as Chainable
      if (options.where) {
        query = query.where(eq(column(target, options.where.column), options.where.value))
      }
      if (options.orderBy) query = query.orderBy(asc(column(target, options.orderBy)))
      return query.all() as Row[]
    },

    async update(table, where, patch) {
      const target = SQLITE_TABLES[table]
      db.update(target as never)
        .set(patch as never)
        .where(eq(column(target, where.column), where.value))
        .run()
    },

    async remove(table, where) {
      const target = SQLITE_TABLES[table]
      db.delete(target as never)
        .where(eq(column(target, where.column), where.value))
        .run()
    }
  }
}

export function createSqliteFixture(): DialectFixture {
  const dir = mkdtempSync(join(tmpdir(), 'witena-dialect-'))
  // A real file rather than `':memory:'`, for the same reason `db/testing.ts`
  // uses one: the migrator's behaviour on a file is the behaviour that ships.
  const handle = openDatabase(join(dir, 'witena.db'))

  return {
    name: 'sqlite',
    store: sqliteStore(handle),
    async reset() {
      // Off for the duration: the order below is already child-first, and a
      // single `DELETE` that trips a cascade mid-reset would leave the tables in
      // a state that depends on which one ran first.
      handle.sqlite.pragma('foreign_keys = OFF')
      for (const table of SQLITE_RESET_ORDER) {
        handle.sqlite.exec(`DELETE FROM ${getTableName(SQLITE_TABLES[table])}`)
      }
      handle.sqlite.pragma('foreign_keys = ON')
    },
    async cleanup() {
      handle.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Postgres                                                                    */
/* -------------------------------------------------------------------------- */

/** The Postgres builder chain: the same shape, awaited instead of `.all()`. */
type PgChainable = {
  where(condition: unknown): PgChainable
  orderBy(order: unknown): PgChainable
} & Promise<unknown[]>

function postgresStore(handle: PostgresHandle): DialectStore {
  const db = handle.db

  return {
    async insert(table, row) {
      await db.insert(POSTGRES_TABLES[table] as never).values(row as never)
    },

    async selectAll(table, options = {}) {
      const target = POSTGRES_TABLES[table]
      let query = db.select().from(target as never) as unknown as PgChainable
      if (options.where) {
        query = query.where(eq(column(target, options.where.column), options.where.value))
      }
      if (options.orderBy) query = query.orderBy(asc(column(target, options.orderBy)))
      return (await query) as Row[]
    },

    async update(table, where, patch) {
      const target = POSTGRES_TABLES[table]
      await db
        .update(target as never)
        .set(patch as never)
        .where(eq(column(target, where.column), where.value))
    },

    async remove(table, where) {
      const target = POSTGRES_TABLES[table]
      await db.delete(target as never).where(eq(column(target, where.column), where.value))
    }
  }
}

/** Connects to `DATABASE_URL`, migrating it if this is the first suite to arrive. */
export async function createPostgresFixture(url: string): Promise<DialectFixture> {
  const handle = await openPostgresDatabase(url, { max: 4 })
  return {
    name: 'postgres',
    store: postgresStore(handle),
    reset: () => truncateAll(handle.db),
    cleanup: () => handle.close()
  }
}

/* -------------------------------------------------------------------------- */
/* The `describe` wrapper                                                      */
/* -------------------------------------------------------------------------- */

/** How a suite receives its fixture: a getter, because Postgres connects lazily. */
export type DialectSuite = (fixture: () => DialectFixture) => void

/**
 * Runs `body` once per available dialect.
 *
 * The fixture is built in `beforeAll` and reaches the suite through a getter
 * rather than as a value, because the Postgres one is asynchronous and vitest
 * collects `describe` bodies synchronously.
 *
 * The skipped Postgres suite still *runs its body at collection time*, so its
 * tests appear in the report as skipped by name instead of vanishing — which is
 * the difference between "these are not covered here" and "these do not exist".
 */
export function describeDialects(title: string, body: DialectSuite): void {
  const url = process.env[DATABASE_URL_ENV]?.trim()

  const suite = (open: () => Promise<DialectFixture>): void => {
    let fixture: DialectFixture
    beforeAll(async () => {
      fixture = await open()
    })
    afterAll(async () => {
      await fixture.cleanup()
    })
    beforeEach(async () => {
      await fixture.reset()
    })
    body(() => fixture)
  }

  describe(`${title} [sqlite]`, () => {
    suite(async () => createSqliteFixture())
  })

  if (!url) {
    describe.skip(`${title} [postgres: ${POSTGRES_SKIP_REASON}]`, () => {
      // The body still needs a getter; nothing calls it, because the whole
      // suite is skipped.
      body(() => {
        throw new Error('the Postgres fixture is skipped')
      })
    })
    return
  }

  describe(`${title} [postgres]`, () => {
    suite(() => createPostgresFixture(url))
  })
}
