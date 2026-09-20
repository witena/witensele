/**
 * Committees: a named, ordered standing group of agents (Phase 9), and the
 * join rows that hold its membership.
 *
 * Two things beyond CRUD live here:
 *
 * - **Membership rides on the entity.** There is no `committees.members.*`
 *   method: `memberAgentIds` is part of `Committee`, and `create` / `update`
 *   write the committee row and replace its join rows in **one transaction**,
 *   so a reader never sees a committee whose members are half-written. The
 *   array index becomes `position`, exactly as in `chats.setMembers`, which is
 *   why the order a caller passes is the order a chat later inherits.
 * - **Gaps close on read.** `committee_members.agent_id` cascades, so deleting
 *   an agent silently removes it from every committee and leaves the remaining
 *   positions with a hole in them (0, 2, 3). Members are always read ordered by
 *   `position` and handed out as an array, so the hole disappears the moment it
 *   is read and the next write renumbers from 0.
 *
 * `list` returns newest `updatedAt` first, like `chats.list`: the Committees
 * page shows the one that was last worked on at the top.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import type { Committee, CommitteeInput, CommitteePatch, UserId } from '@shared/types'
import { LOCAL_USER_ID } from '@shared/types'
import type { DrizzleDb } from '../database'
import type { CommitteeRow } from '../schema'
import { agents, committeeMembers, committees } from '../schema'
import { notFound, validation } from '../../errors'
import { newId, now } from './common'

export interface CommitteeRepository {
  /** Newest `updatedAt` first, each with its members in `position` order. */
  list(userId?: UserId): Committee[]
  get(id: string, userId?: UserId): Committee
  create(input: CommitteeInput, userId?: UserId): Committee
  /** An absent field is left alone; `memberAgentIds` replaces the whole list. */
  update(id: string, patch: CommitteePatch, userId?: UserId): Committee
  /**
   * Cascades to `committee_members` and sets `chats.committee_id` to null —
   * the topics convened from this committee keep their members and lose only
   * the record of where they came from.
   */
  delete(id: string, userId?: UserId): void
}

export function createCommitteeRepository(db: DrizzleDb): CommitteeRepository {
  function row(id: string, userId: UserId): CommitteeRow {
    const found = db
      .select()
      .from(committees)
      .where(and(eq(committees.id, id), eq(committees.userId, userId)))
      .get()
    if (!found) throw notFound('committee', id)
    return found
  }

  function memberIds(committeeId: string): string[] {
    return db
      .select({ agentId: committeeMembers.agentId })
      .from(committeeMembers)
      .where(eq(committeeMembers.committeeId, committeeId))
      .orderBy(asc(committeeMembers.position))
      .all()
      .map((member) => member.agentId)
  }

  /**
   * The members of several committees at once, so `list` costs two queries
   * rather than one per row.
   */
  function memberIdsFor(committeeIds: string[]): Map<string, string[]> {
    const grouped = new Map<string, string[]>()
    if (committeeIds.length === 0) return grouped
    const rows = db
      .select()
      .from(committeeMembers)
      .where(inArray(committeeMembers.committeeId, committeeIds))
      .orderBy(asc(committeeMembers.position))
      .all()
    for (const member of rows) {
      const list = grouped.get(member.committeeId)
      if (list) list.push(member.agentId)
      else grouped.set(member.committeeId, [member.agentId])
    }
    return grouped
  }

  /**
   * Every id is a distinct agent of this user.
   *
   * The same two rules `chats.setMembers` applies, and for the same reason: an
   * id that names nothing would become a member the editor cannot render, and a
   * duplicate would make the composite primary key throw a SQLite error instead
   * of a refusal anyone can read.
   */
  function assertMembers(userId: UserId, agentIds: string[]): void {
    if (new Set(agentIds).size !== agentIds.length) {
      throw validation('an agent cannot be added to the same committee twice', { agentIds })
    }
    for (const agentId of agentIds) {
      const agent = db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
        .get()
      if (!agent) throw notFound('agent', agentId)
    }
  }

  function toCommittee(committee: CommitteeRow, members: string[]): Committee {
    return {
      id: committee.id,
      userId: committee.userId,
      createdAt: committee.createdAt,
      updatedAt: committee.updatedAt,
      name: committee.name,
      description: committee.description,
      memberAgentIds: members
    }
  }

  return {
    list(userId = LOCAL_USER_ID) {
      const rows = db
        .select()
        .from(committees)
        .where(eq(committees.userId, userId))
        .orderBy(desc(committees.updatedAt))
        .all()
      const members = memberIdsFor(rows.map((committee) => committee.id))
      return rows.map((committee) => toCommittee(committee, members.get(committee.id) ?? []))
    },

    get(id, userId = LOCAL_USER_ID) {
      const committee = row(id, userId)
      return toCommittee(committee, memberIds(committee.id))
    },

    create(input, userId = LOCAL_USER_ID) {
      assertMembers(userId, input.memberAgentIds)
      const timestamp = now()
      const inserted: CommitteeRow = {
        id: newId(),
        userId,
        name: input.name,
        description: input.description,
        createdAt: timestamp,
        updatedAt: timestamp
      }

      db.transaction((tx) => {
        tx.insert(committees).values(inserted).run()
        if (input.memberAgentIds.length > 0) {
          tx.insert(committeeMembers)
            .values(
              input.memberAgentIds.map((agentId, position) => ({
                committeeId: inserted.id,
                agentId,
                position
              }))
            )
            .run()
        }
      })

      return toCommittee(inserted, [...input.memberAgentIds])
    },

    update(id, patch, userId = LOCAL_USER_ID) {
      const current = row(id, userId)
      if (patch.memberAgentIds !== undefined) assertMembers(userId, patch.memberAgentIds)

      const next: Partial<CommitteeRow> = { updatedAt: now() }
      if (patch.name !== undefined) next.name = patch.name
      if (patch.description !== undefined) next.description = patch.description

      db.transaction((tx) => {
        tx.update(committees).set(next).where(eq(committees.id, current.id)).run()
        // A whole-list replace rather than a merge, like `chats.setMembers`: the
        // order *is* the value, and a merge could never remove the last member.
        if (patch.memberAgentIds !== undefined) {
          tx.delete(committeeMembers).where(eq(committeeMembers.committeeId, current.id)).run()
          if (patch.memberAgentIds.length > 0) {
            tx.insert(committeeMembers)
              .values(
                patch.memberAgentIds.map((agentId, position) => ({
                  committeeId: current.id,
                  agentId,
                  position
                }))
              )
              .run()
          }
        }
      })

      return this.get(current.id, userId)
    },

    delete(id, userId = LOCAL_USER_ID) {
      const current = row(id, userId)
      db.delete(committees).where(eq(committees.id, current.id)).run()
    }
  }
}
