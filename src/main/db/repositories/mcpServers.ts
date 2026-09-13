/**
 * MCP server records.
 *
 * `command` / `args` / `env` describe a `stdio` server and `url` describes an
 * `http` one; the half that does not apply is stored as `NULL` and mapped back to
 * an **absent** field rather than an explicit `undefined`, because
 * `exactOptionalPropertyTypes` distinguishes the two and JSON transport does not.
 */
import { and, asc, eq } from 'drizzle-orm'
import type { McpServer, McpServerInput, UserId } from '@shared/types'
import { LOCAL_USER_ID } from '@shared/types'
import type { DrizzleDb } from '../database'
import type { McpServerRow } from '../schema'
import { mcpServers } from '../schema'
import { notFound } from '../../errors'
import { newId, now, nullable, optional } from './common'

export interface McpServerRepository {
  list(userId?: UserId): McpServer[]
  get(id: string, userId?: UserId): McpServer
  create(input: McpServerInput, userId?: UserId): McpServer
  update(id: string, patch: Partial<McpServerInput>, userId?: UserId): McpServer
  delete(id: string, userId?: UserId): void
}

function toMcpServer(row: McpServerRow): McpServer {
  return {
    id: row.id,
    userId: row.userId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    name: row.name,
    transport: row.transport,
    ...optional('command', row.command),
    ...optional('args', row.args),
    ...optional('env', row.env),
    ...optional('url', row.url),
    enabled: row.enabled,
    sideEffects: row.sideEffects
  }
}

export function createMcpServerRepository(db: DrizzleDb): McpServerRepository {
  function row(id: string, userId: UserId): McpServerRow {
    const found = db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, userId)))
      .get()
    if (!found) throw notFound('mcp server', id)
    return found
  }

  return {
    list(userId = LOCAL_USER_ID) {
      return db
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.userId, userId))
        .orderBy(asc(mcpServers.createdAt))
        .all()
        .map(toMcpServer)
    },

    get(id, userId = LOCAL_USER_ID) {
      return toMcpServer(row(id, userId))
    },

    create(input, userId = LOCAL_USER_ID) {
      const timestamp = now()
      const inserted: McpServerRow = {
        id: newId(),
        userId,
        name: input.name,
        transport: input.transport,
        command: nullable(input.command),
        args: nullable(input.args),
        env: nullable(input.env),
        url: nullable(input.url),
        enabled: input.enabled,
        sideEffects: input.sideEffects,
        createdAt: timestamp,
        updatedAt: timestamp
      }
      db.insert(mcpServers).values(inserted).run()
      return toMcpServer(inserted)
    },

    update(id, patch, userId = LOCAL_USER_ID) {
      const current = row(id, userId)
      const next: Partial<McpServerRow> = { updatedAt: now() }
      if (patch.name !== undefined) next.name = patch.name
      if (patch.transport !== undefined) next.transport = patch.transport
      if (patch.command !== undefined) next.command = patch.command === '' ? null : patch.command
      if (patch.args !== undefined) next.args = patch.args
      if (patch.env !== undefined) next.env = patch.env
      if (patch.url !== undefined) next.url = patch.url === '' ? null : patch.url
      if (patch.enabled !== undefined) next.enabled = patch.enabled
      if (patch.sideEffects !== undefined) next.sideEffects = patch.sideEffects
      db.update(mcpServers).set(next).where(eq(mcpServers.id, current.id)).run()
      return toMcpServer(row(id, userId))
    },

    delete(id, userId = LOCAL_USER_ID) {
      const current = row(id, userId)
      db.delete(mcpServers).where(eq(mcpServers.id, current.id)).run()
    }
  }
}
