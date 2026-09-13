import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadMigrations, runMigrations } from './migrate'
import { openDatabase } from './database'
import { createTestDatabase, type TestDatabase } from './testing'

const EXPECTED_TABLES = [
  '__migrations',
  'agents',
  'chat_members',
  'chats',
  'mcp_servers',
  'messages',
  'providers',
  'settings'
]

function tableNames(database: TestDatabase): string[] {
  const rows = database.handle.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>
  return rows.map((row) => row.name).filter((name) => !name.startsWith('sqlite_'))
}

describe('db/migrate', () => {
  let database: TestDatabase

  beforeEach(() => {
    database = createTestDatabase()
  })

  afterEach(() => {
    database.cleanup()
  })

  it('bundles at least one migration, with its statements split', () => {
    const migrations = loadMigrations()
    expect(migrations.length).toBeGreaterThan(0)
    expect(migrations[0]?.name).toMatch(/^0000_.*\.sql$/)
    expect(migrations[0]?.statements.some((sql) => sql.startsWith('CREATE TABLE'))).toBe(true)
    // The breakpoint marker is a separator, never part of a statement.
    for (const migration of migrations) {
      for (const statement of migration.statements) {
        expect(statement).not.toContain('--> statement-breakpoint')
      }
    }
  })

  it('creates every table when the database is opened', () => {
    expect(tableNames(database)).toEqual(EXPECTED_TABLES)
  })

  it('records each migration once and applies nothing on a second run', () => {
    const applied = database.handle.sqlite
      .prepare('SELECT name FROM __migrations')
      .all() as Array<{ name: string }>
    expect(applied.map((row) => row.name)).toEqual(loadMigrations().map((m) => m.name))

    expect(runMigrations(database.handle.sqlite)).toEqual([])
  })

  it('is idempotent across a close and reopen, and keeps the data', () => {
    const chat = database.repos.chats.create({ title: 'Survives a restart' })

    database.reopen()

    expect(runMigrations(database.handle.sqlite)).toEqual([])
    expect(tableNames(database)).toEqual(EXPECTED_TABLES)
    expect(database.repos.chats.get(chat.id).title).toBe('Survives a restart')
  })

  it('enables WAL and foreign keys', () => {
    expect(database.handle.sqlite.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(database.handle.sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('accepts an in-memory database', () => {
    const memory = openDatabase(':memory:')
    try {
      const rows = memory.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chats'")
        .all()
      expect(rows).toHaveLength(1)
    } finally {
      memory.close()
    }
  })
})
