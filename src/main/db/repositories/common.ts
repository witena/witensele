/**
 * Helpers shared by every repository.
 *
 * Repositories are the only layer that knows drizzle exists. They take and return
 * the **shared types** from `src/shared/types.ts`, so callers (IPC handlers,
 * ChatRunner, AgentTurn) never see a database row, a JSON string or a 0/1 boolean.
 *
 * Two conventions hold everywhere:
 *
 * - **Ids are UUID strings** generated here, never database autoincrement values,
 *   so a record keeps its identity across devices and a future server.
 * - **Every query is scoped by `userId`**, which is the last parameter of every
 *   method and defaults to `LOCAL_USER_ID` in the desktop build. A row belonging
 *   to another user is reported as `not_found` rather than as a permission error.
 */
import { randomUUID } from 'node:crypto'

/** A fresh UUID primary key. */
export function newId(): string {
  return randomUUID()
}

/** The current time as epoch milliseconds, the app's only timestamp format. */
export function now(): number {
  return Date.now()
}

/**
 * Spreads `{ [key]: value }` when the stored column is not null and `{}` when it
 * is, which is what `exactOptionalPropertyTypes` requires: an optional field must
 * be **absent**, not present and `undefined`.
 */
export function optional<K extends string, V>(key: K, value: V | null): { [P in K]?: V } {
  return (value === null ? {} : { [key]: value }) as { [P in K]?: V }
}

/** Inverse of `optional`: an absent optional field is stored as `NULL`. */
export function nullable<V>(value: V | undefined): V | null {
  return value === undefined ? null : value
}
