/**
 * `committees.*`: the standing groups of agents the Committees page edits
 * (Phase 9).
 *
 * Thin like the other namespace files — persistence is `repos.committees`' job,
 * including the transaction that keeps a committee row and its member rows in
 * step — so what lives here is **validation and the events the rest of the app
 * needs**.
 *
 * Three rules are worth reading before changing anything:
 *
 * - **A committee is a group, not a conversation.** Nothing here touches
 *   `ChatRunner`, `chat_members` or a run: a committee is only ever *read* by
 *   `chats.create`, which expands its members into the new chat. That is what
 *   makes the snapshot a snapshot — editing a committee cannot reach a topic
 *   that was convened from it earlier.
 * - **At most one executor**, exactly as in a chat, and through the *same*
 *   check (`assertOneExecutor` in `./chats.ts`) with the same `second_executor`
 *   reason. A committee whose members could not legally sit in one chat would
 *   be a group that refuses to convene, and the refusal would arrive at the
 *   wrong moment — when the user opens a topic rather than when they build the
 *   group.
 * - **Deleting a committee is not only a row delete.** `chats.committee_id` is
 *   `ON DELETE SET NULL`, so every topic convened from it silently loses its
 *   provenance while keeping its members and its transcript. The renderer
 *   mirrors those chats, so each one is announced with a `chat.updated` —
 *   `agents.delete` does the same for the chats an agent leaves.
 */
import type { CommitteeInput, CommitteePatch } from '@shared/types'
import { MAX_COMMITTEE_NAME_CHARS } from '@shared/types'
import { validation } from '../errors'
import type { AppContext } from '../app-context'
import { assertOneExecutor } from './chats'
import type { HandlerModule } from './types'

function assertId(input: unknown, what: string): asserts input is { id: string } {
  const id = (input as { id?: unknown })?.id
  if (typeof id !== 'string' || id.length === 0) throw validation(`A ${what} id is required`)
}

/**
 * Name rules.
 *
 * Trimmed non-empty and within the cap, and that is all: unlike an agent name,
 * a committee name is a label rather than an identity — nothing resolves `@` it
 * and two committees may legitimately be called "Review" while they hold
 * different people.
 */
function assertName(name: unknown): void {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw validation('A committee name cannot be empty')
  }
  if (name.trim().length > MAX_COMMITTEE_NAME_CHARS) {
    throw validation(`A committee name is at most ${MAX_COMMITTEE_NAME_CHARS} characters`)
  }
}

/**
 * The member list: distinct ids, each an existing agent of this user, with at
 * most one executor among them.
 *
 * The repository checks existence and duplicates as well — it has to, because
 * it is the layer that writes the rows — but doing it here first means the
 * executor rule is measured against agents that are certainly present, and that
 * a bad list is refused before any transaction is opened.
 */
function assertMemberAgentIds(ctx: AppContext, value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw validation('memberAgentIds must be an array of agent ids')
  }
  if (new Set(value).size !== value.length) {
    throw validation('an agent cannot be added to the same committee twice', {
      agentIds: value
    })
  }
  // `not_found` for an id that names no agent of this user, before anything is
  // written — the same order `chats.members.set` uses.
  for (const agentId of value) ctx.repos.agents.get(agentId, ctx.userId)
  assertOneExecutor(ctx, value)
}

/** The whole record, for `committees.create`. */
function assertCommitteeInput(ctx: AppContext, input: unknown): asserts input is CommitteeInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw validation('A committee input object is required')
  }
  const candidate = input as CommitteeInput
  assertName(candidate.name)
  if (typeof candidate.description !== 'string') throw validation('description must be a string')
  assertMemberAgentIds(ctx, candidate.memberAgentIds)
}

/** Only the fields the patch actually carries, and only when present. */
function assertCommitteePatch(ctx: AppContext, patch: unknown): asserts patch is CommitteePatch {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw validation('A committee patch object is required')
  }
  const candidate = patch as CommitteePatch
  if (candidate.name !== undefined) assertName(candidate.name)
  if (candidate.description !== undefined && typeof candidate.description !== 'string') {
    throw validation('description must be a string')
  }
  if (candidate.memberAgentIds !== undefined) {
    assertMemberAgentIds(ctx, candidate.memberAgentIds)
  }
}

export const committeeHandlers: HandlerModule = {
  'committees.list': async (ctx) => ctx.repos.committees.list(ctx.userId),

  'committees.get': async (ctx, input) => {
    assertId(input, 'committee')
    return ctx.repos.committees.get(input.id, ctx.userId)
  },

  'committees.create': async (ctx, input) => {
    const candidate = (input as { input?: unknown })?.input
    assertCommitteeInput(ctx, candidate)
    return ctx.repos.committees.create(
      { ...candidate, name: candidate.name.trim() },
      ctx.userId
    )
  },

  'committees.update': async (ctx, input) => {
    assertId(input, 'committee')
    // Proves the row exists before the patch is measured against it, so a patch
    // for a deleted committee fails as `not_found` rather than as bad input.
    ctx.repos.committees.get(input.id, ctx.userId)
    assertCommitteePatch(ctx, input.patch)

    const patch = input.patch as CommitteePatch
    return ctx.repos.committees.update(
      input.id,
      { ...patch, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}) },
      ctx.userId
    )
  },

  'committees.delete': async (ctx, input) => {
    assertId(input, 'committee')
    ctx.repos.committees.get(input.id, ctx.userId)

    // Read before the delete — afterwards the foreign key has already set those
    // chats' `committee_id` to null and there is nothing left to join on.
    const affected = ctx.repos.chats.listChatIdsForCommittee(input.id, ctx.userId)
    ctx.repos.committees.delete(input.id, ctx.userId)

    for (const chatId of affected) {
      ctx.events.emit({ type: 'chat.updated', chat: ctx.repos.chats.get(chatId, ctx.userId) })
    }
  }
}
