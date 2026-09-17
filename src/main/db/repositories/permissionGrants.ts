/**
 * "Always allow in this chat", stored (S5.15).
 *
 * The smallest repository in the app, and deliberately so: a grant is a pair of
 * strings and a timestamp, the primary key *is* the pair, and every question
 * anyone asks of it is scoped to one chat.
 *
 * Three properties the callers depend on:
 *
 * - **`grant` is idempotent.** The same tool granted twice keeps the first
 *   `createdAt`, so the row the user sees in Group settings says when they
 *   actually decided rather than when the executor last called the tool.
 * - **`has` is a point read**, because it runs inside `PermissionGate.ask`, on
 *   the path of every gated tool call. A `list` plus a `find` would be the same
 *   answer and one more array per call.
 * - **No `userId`.** Unlike every entity table, a grant hangs off `chat_id` and
 *   the chat carries the user. The cascade is what deletes it, and a cascade
 *   cannot check a second column.
 */
import { and, desc, eq } from 'drizzle-orm'
import type { PermissionGrant } from '@shared/types'
import type { DrizzleDb } from '../database'
import { permissionGrants } from '../schema'
import { now } from './common'

export interface PermissionGrantRepository {
  /** One chat's grants, newest first — the order the settings list draws them in. */
  list(chatId: string): PermissionGrant[]
  /** True when this chat + tool pair has been granted. */
  has(chatId: string, toolName: string): boolean
  /** Records a grant. A pair that is already granted keeps its original time. */
  grant(chatId: string, toolName: string): void
  /** Forgets a grant. Revoking one that is not there is not an error. */
  revoke(chatId: string, toolName: string): void
}

export function createPermissionGrantRepository(db: DrizzleDb): PermissionGrantRepository {
  return {
    list(chatId) {
      return db
        .select()
        .from(permissionGrants)
        .where(eq(permissionGrants.chatId, chatId))
        .orderBy(desc(permissionGrants.createdAt), permissionGrants.toolName)
        .all()
    },

    has(chatId, toolName) {
      const row = db
        .select({ toolName: permissionGrants.toolName })
        .from(permissionGrants)
        .where(
          and(eq(permissionGrants.chatId, chatId), eq(permissionGrants.toolName, toolName))
        )
        .get()
      return row !== undefined
    },

    grant(chatId, toolName) {
      db.insert(permissionGrants)
        .values({ chatId, toolName, createdAt: now() })
        // The pair is the primary key, so a repeat grant is a no-op rather than
        // a conflict — and rather than a refreshed timestamp, which would make
        // the settings row report the executor's activity instead of the user's
        // decision.
        .onConflictDoNothing()
        .run()
    },

    revoke(chatId, toolName) {
      db.delete(permissionGrants)
        .where(and(eq(permissionGrants.chatId, chatId), eq(permissionGrants.toolName, toolName)))
        .run()
    }
  }
}
