/**
 * Agent records.
 *
 * Straight CRUD over the shared `Agent` type. The only subtlety is deletion:
 * `chat_members.agent_id` is a foreign key with `ON DELETE CASCADE`, so removing
 * an agent silently removes it from every chat it was a member of. That requires
 * `PRAGMA foreign_keys = ON`, which `openDatabase` sets.
 */
import { and, asc, eq } from 'drizzle-orm'
import type { Agent, AgentInput, UserId } from '@shared/types'
import { LOCAL_USER_ID } from '@shared/types'
import type { DrizzleDb } from '../database'
import type { AgentRow } from '../schema'
import { agents } from '../schema'
import { notFound } from '../../errors'
import { newId, now } from './common'

export interface AgentRepository {
  list(userId?: UserId): Agent[]
  get(id: string, userId?: UserId): Agent
  create(input: AgentInput, userId?: UserId): Agent
  update(id: string, patch: Partial<AgentInput>, userId?: UserId): Agent
  /** Also removes the agent from every chat, through the cascading foreign key. */
  delete(id: string, userId?: UserId): void
  /**
   * Drops one MCP server id from every agent that lists it, returning the ids of
   * the agents that actually changed.
   *
   * `agents.mcp_server_ids` is a JSON column, not a foreign key, so deleting a
   * server cannot cascade — without this an agent keeps pointing at a row that no
   * longer exists and its editor shows a checkbox for nothing.
   */
  removeMcpServer(serverId: string, userId?: UserId): string[]
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    userId: row.userId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    name: row.name,
    avatar: row.avatar,
    description: row.description,
    systemPrompt: row.systemPrompt,
    providerId: row.providerId,
    modelId: row.modelId,
    params: row.params,
    skillNames: row.skillNames,
    mcpServerIds: row.mcpServerIds,
    memoryEnabled: row.memoryEnabled,
    role: row.role
  }
}

export function createAgentRepository(db: DrizzleDb): AgentRepository {
  function row(id: string, userId: UserId): AgentRow {
    const found = db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, userId)))
      .get()
    if (!found) throw notFound('agent', id)
    return found
  }

  return {
    list(userId = LOCAL_USER_ID) {
      return db
        .select()
        .from(agents)
        .where(eq(agents.userId, userId))
        .orderBy(asc(agents.createdAt))
        .all()
        .map(toAgent)
    },

    get(id, userId = LOCAL_USER_ID) {
      return toAgent(row(id, userId))
    },

    create(input, userId = LOCAL_USER_ID) {
      const timestamp = now()
      const inserted: AgentRow = {
        id: newId(),
        userId,
        name: input.name,
        avatar: input.avatar,
        description: input.description,
        systemPrompt: input.systemPrompt,
        providerId: input.providerId,
        modelId: input.modelId,
        params: input.params,
        skillNames: input.skillNames,
        mcpServerIds: input.mcpServerIds,
        memoryEnabled: input.memoryEnabled,
        role: input.role,
        createdAt: timestamp,
        updatedAt: timestamp
      }
      db.insert(agents).values(inserted).run()
      return toAgent(inserted)
    },

    update(id, patch, userId = LOCAL_USER_ID) {
      const current = row(id, userId)
      const next: Partial<AgentRow> = { updatedAt: now() }
      if (patch.name !== undefined) next.name = patch.name
      if (patch.avatar !== undefined) next.avatar = patch.avatar
      if (patch.description !== undefined) next.description = patch.description
      if (patch.systemPrompt !== undefined) next.systemPrompt = patch.systemPrompt
      if (patch.providerId !== undefined) next.providerId = patch.providerId
      if (patch.modelId !== undefined) next.modelId = patch.modelId
      if (patch.params !== undefined) next.params = patch.params
      if (patch.skillNames !== undefined) next.skillNames = patch.skillNames
      if (patch.mcpServerIds !== undefined) next.mcpServerIds = patch.mcpServerIds
      if (patch.memoryEnabled !== undefined) next.memoryEnabled = patch.memoryEnabled
      if (patch.role !== undefined) next.role = patch.role
      db.update(agents).set(next).where(eq(agents.id, current.id)).run()
      return toAgent(row(id, userId))
    },

    delete(id, userId = LOCAL_USER_ID) {
      const current = row(id, userId)
      db.delete(agents).where(eq(agents.id, current.id)).run()
    },

    removeMcpServer(serverId, userId = LOCAL_USER_ID) {
      const affected: string[] = []
      const timestamp = now()
      for (const agent of this.list(userId)) {
        if (!agent.mcpServerIds.includes(serverId)) continue
        db.update(agents)
          .set({
            mcpServerIds: agent.mcpServerIds.filter((candidate) => candidate !== serverId),
            updatedAt: timestamp
          })
          .where(eq(agents.id, agent.id))
          .run()
        affected.push(agent.id)
      }
      return affected
    }
  }
}
