/**
 * The guard that makes "two schema files" a safe choice.
 *
 * `../schema.ts` and `./schema.ts` describe the same eight tables in two
 * dialects. A column added to one and forgotten in the other would be a bug that
 * only appears in production on whichever dialect was missed, so the two are
 * compared here through drizzle's own table metadata rather than by reading:
 * same tables, same column names, same nullability, same defaults, same primary
 * keys.
 *
 * It needs no database. That is deliberate — the comparison is about the
 * declarations, and a guard that only ran when Postgres was up would not be a
 * guard at all on a laptop without Docker.
 *
 * What it does **not** compare is the column *types*: `integer` versus `bigint`
 * and `text` versus `jsonb` are exactly the differences the two files exist to
 * express (`./schema.ts` has the table). The drift that matters is structural.
 */
import { getTableColumns, getTableName, Table } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import * as sqliteSchema from '../schema'
import * as postgresSchema from './schema'

/** One column's structure, in the terms both dialects share. */
interface ColumnShape {
  name: string
  notNull: boolean
  hasDefault: boolean
  primary: boolean
  /** The `{ enum: [...] }` values, when the column declares them. */
  enumValues: string[] | null
}

/** Every exported drizzle table in a schema module, keyed by SQL table name. */
function tablesOf(module: Record<string, unknown>): Map<string, Table> {
  const out = new Map<string, Table>()
  for (const value of Object.values(module)) {
    if (value instanceof Table) out.set(getTableName(value), value)
  }
  return out
}

/** One table's columns, sorted by name so declaration order is not a difference. */
function shapeOf(table: Table): ColumnShape[] {
  return Object.values(getTableColumns(table))
    .map((column) => ({
      name: column.name,
      notNull: column.notNull,
      hasDefault: column.hasDefault,
      primary: column.primary,
      enumValues: column.enumValues ? [...column.enumValues] : null
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

describe('the SQLite and Postgres schemas stay in step', () => {
  const sqliteTables = tablesOf(sqliteSchema as unknown as Record<string, unknown>)
  const postgresTables = tablesOf(postgresSchema as unknown as Record<string, unknown>)

  it('declares the same eight tables', () => {
    expect([...postgresTables.keys()].sort()).toEqual([...sqliteTables.keys()].sort())
    expect(sqliteTables.size).toBe(8)
  })

  for (const name of [...tablesOf(sqliteSchema as unknown as Record<string, unknown>).keys()].sort()) {
    it(`declares ${name} identically`, () => {
      const sqlite = sqliteTables.get(name)
      const postgres = postgresTables.get(name)
      expect(sqlite, `${name} is missing from the SQLite schema`).toBeDefined()
      expect(postgres, `${name} is missing from the Postgres schema`).toBeDefined()
      expect(shapeOf(postgres as Table)).toEqual(shapeOf(sqlite as Table))
    })
  }

  it('would notice a column that exists in only one of them', () => {
    // The guard on the guard: `shapeOf` has to be able to tell two tables apart.
    const withoutGoal = shapeOf(sqliteTables.get('chats') as Table).filter(
      (column) => column.name !== 'goal'
    )
    expect(withoutGoal).not.toEqual(shapeOf(postgresTables.get('chats') as Table))
  })
})
