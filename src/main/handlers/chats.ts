/**
 * `chats.*`, `messages.list` and the two run methods — everything the chat screen
 * calls.
 *
 * Thin, like `providers.ts`: persistence is the repositories' job, scheduling is
 * `ChatRunner`'s, and what is left here is **validation plus the events the rest
 * of the app needs to hear about**.
 *
 * Two decisions worth reading before changing anything:
 *
 * - **`chats.create` seeds members from a committee, a list, or neither.**
 *   `ChatCreateInput` carries `committeeId` (Phase 9) and `memberAgentIds`: the
 *   chat's members are the committee's, in its own order, followed by the named
 *   agents, de-duplicated keeping the first occurrence. With neither the chat is
 *   created **empty** — unless the agent library is still empty too, in which
 *   case `ensureDefaultAgent` writes the bootstrap agent and puts it in, so a
 *   fresh installation can still hold a conversation before anyone visits the
 *   Agents page. Once the user owns agents, picking who is in a chat is theirs to
 *   decide, not the handler's. `committeeId` is recorded on the chat as
 *   provenance and is **not** patchable afterwards; see `ChatCreateInput`.
 * - **A chat with no members refuses `chat.send`.** The composer stays enabled —
 *   the fix is one click away in the member panel — but the run is rejected with
 *   `validation` rather than silently producing no answer.
 * - **`chats.delete` stops the run first.** Deleting a chat cascades to its
 *   messages, so a turn still streaming into one of them would write to rows that
 *   no longer exist and emit events for a chat the renderer has dropped.
 * - **`workdir` is checked against the real filesystem** (S5.2), which is why
 *   this module reads `node:fs`. The handler layer is allowed to; the services
 *   behind it are not electron-bound either way (CLAUDE.md rule #5 is about
 *   electron, not about Node).
 * - **A chat holds at most one executor member.** PLAN.md's rule is that all
 *   writes go through a single agent, so the refusal lives where membership is
 *   written rather than where tools are attached.
 * - **`chat.send`'s `origin` is sanitised, not validated** (S10.4). It is the
 *   one field here whose text a remote party chose, and the honest answer to a
 *   client that names itself badly is to drop the label, not to refuse the
 *   discussion. See `sanitizeOriginClient`.
 * - **A goal's paths are checked against the chat's folder** (S5.10), which is
 *   the *patch's* folder when it carries one and the stored one otherwise — so
 *   binding a folder and setting a goal in a single call is legal, and setting a
 *   goal on a chat that already has a folder costs one read.
 */
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type {
  ChatCreateInput,
  ChatGoal,
  ChatGoalStatus,
  ChatMode,
  ChatPatch,
  ChatSettingsPatch,
  HandoffIntent,
  SpeakingMode,
  ValidationReason
} from '@shared/types'
import {
  GOAL_KINDS,
  HANDOFF_INTENTS,
  MAX_AUTO_ROUNDS,
  MAX_GOAL_DESCRIPTION_CHARS,
  MAX_ORIGIN_CLIENT_CHARS,
  MIN_AUTO_ROUNDS
} from '@shared/types'
import { summarizeUsage, type ChatUsageSummary } from '@shared/usage'
import { ensureDefaultAgent } from '../agents/default-agent'
import { deliverablePath, resolveInWorkdir } from '../executor/paths'
import { validation } from '../errors'
import type { AppContext } from '../app-context'
import type { HandlerModule } from './types'

/** The two orchestration modes `ChatSettings.mode` may hold. */
const CHAT_MODES: readonly ChatMode[] = ['roundrobin', 'mention-only']

/** The two speaking modes `ChatSettings.speaking` may hold. */
const SPEAKING_MODES: readonly SpeakingMode[] = ['sequential', 'parallel']

function assertId(input: unknown, what: string): asserts input is { id: string } {
  const id = (input as { id?: unknown })?.id
  if (typeof id !== 'string' || id.length === 0) throw validation(`A ${what} id is required`)
}

/**
 * Only the fields `ChatPatch` declares, and only when present.
 *
 * `storedWorkdir` is a **thunk** rather than a value because it is only needed
 * by a patch that carries a goal: reading the chat row to validate a rename
 * would be a database round trip bought for nothing, and `chats.create` has no
 * row to read at all.
 */
function assertChatPatch(
  patch: unknown,
  storedWorkdir: () => string | null
): asserts patch is ChatPatch {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw validation('A chat patch object is required')
  }
  const candidate = patch as ChatPatch
  if (candidate.title !== undefined) {
    if (typeof candidate.title !== 'string' || candidate.title.trim().length === 0) {
      throw validation('A chat title cannot be empty')
    }
  }
  if (candidate.workdir !== undefined) assertWorkdir(candidate.workdir)
  if (candidate.goal !== undefined) {
    // The folder the goal lives in: the one this patch is binding, when it binds
    // one, and otherwise the one the chat already has.
    const workdir = candidate.workdir !== undefined ? candidate.workdir : storedWorkdir()
    assertGoal(candidate.goal, workdir)
  }
  if (candidate.settings !== undefined) assertChatSettings(candidate.settings)
}

/**
 * The chat's working directory: `null`, or an absolute path that is a directory
 * **right now**.
 *
 * Checked against the filesystem rather than merely parsed, because the path is
 * a security boundary and not a label: every file the executor reads or writes in
 * S5.3 is resolved inside it, and a folder that does not exist cannot confine
 * anything. `statSync` follows symlinks on purpose — a symlink to a directory is
 * a perfectly good working directory, and the confinement check that matters
 * (a path inside the folder whose realpath leaves it) belongs to S5.3, per file.
 *
 * There is a race here that cannot be closed: the folder can be deleted between
 * this check and the first tool call. That is what makes it a check and not a
 * guarantee, and why S5.3 resolves every path again at use.
 *
 * Each rejection carries a `ValidationReason` in `details` so the renderer can
 * say which of the three went wrong; the message itself is developer-facing.
 */
function assertWorkdir(value: unknown): asserts value is string | null {
  // `null` is how the "Clear" button unbinds a chat, and is always valid.
  if (value === null) return
  if (typeof value !== 'string' || value.trim().length === 0 || !isAbsolute(value)) {
    throw validation('workdir must be an absolute path, or null', {
      reason: 'workdir_not_absolute'
    })
  }

  let stats
  try {
    stats = statSync(value)
  } catch {
    // Every failure here — missing, unreadable, a broken symlink — reads the same
    // to the user: the folder they picked is not usable as one.
    throw validation(`workdir does not exist: ${value}`, { reason: 'workdir_missing' })
  }
  if (!stats.isDirectory()) {
    throw validation(`workdir is not a directory: ${value}`, { reason: 'workdir_not_directory' })
  }
}

/* -------------------------------------------------------------------------- */
/* The chat goal (S5.10)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One path out of a goal, resolved inside the chat's folder.
 *
 * Two rules, in this order, because they fail for different reasons and the
 * user fixes them differently:
 *
 * 1. **It has to be relative.** A goal outlives the folder it was written
 *    against — the project is moved, restored from a backup, cloned onto another
 *    machine — and an absolute path would then name something else or nothing at
 *    all. `..` is refused here rather than at the boundary below so the message
 *    says "relative" instead of "outside", which is the thing to correct.
 * 2. **It has to stay inside the folder.** `resolveInWorkdir` is the executor's
 *    own confinement check (`src/main/executor/paths.ts`), symlinks included, so
 *    a goal can never name a file the executor would be refused. Its refusals
 *    carry no `ValidationReason`, so they are re-thrown with this caller's.
 *
 * Returns the absolute path, which the material check then stats. Existence is
 * **not** checked here: a deliverable is by definition a file that is not there
 * yet.
 */
function resolveGoalPath(
  value: unknown,
  workdir: string,
  reasons: { notRelative: ValidationReason; outside: ValidationReason },
  what: string
): string {
  if (typeof value !== 'string' || value.trim().length === 0 || isAbsolute(value)) {
    throw validation(`${what} must be a non-empty path relative to the working directory`, {
      reason: reasons.notRelative
    })
  }
  const wanted = value.trim()
  // Split on both separators: the string may have been typed by hand on a
  // machine whose `path` module is not the one that will read it back.
  if (wanted.split(/[/\\]/).includes('..')) {
    throw validation(`${what} may not climb out of the working directory: ${wanted}`, {
      reason: reasons.notRelative
    })
  }

  try {
    return resolveInWorkdir(workdir, wanted).absolute
  } catch {
    throw validation(`${what} is outside the working directory: ${wanted}`, {
      reason: reasons.outside
    })
  }
}

/**
 * The chat's goal: `null`, or a description plus whatever its kind requires.
 *
 * `workdir` is the folder the goal's paths are resolved in — the patch's own
 * when it carries one, the stored one otherwise — and `null` means the chat is
 * bound to nothing, which is a legal state for a `discussion` with no materials
 * and for nothing else.
 *
 * Every refusal a control can actually produce carries a `ValidationReason`, so
 * the panel can say which field is wrong rather than "the request was rejected
 * as invalid". The malformed-object refusals below (a bad `kind`, `materials`
 * that is not an array) carry none on purpose: no control can send them, and a
 * reason is a sentence a user is meant to act on.
 */
function assertGoal(value: unknown, workdir: string | null): asserts value is ChatGoal | null {
  // `null` is how the panel removes a goal, and is always valid.
  if (value === null) return
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw validation('A chat goal must be an object, or null')
  }
  const goal = value as ChatGoal

  if (!GOAL_KINDS.includes(goal.kind)) throw validation('unknown chat goal kind')
  if (!Array.isArray(goal.materials) || goal.materials.some((entry) => typeof entry !== 'string')) {
    throw validation('goal materials must be an array of relative paths')
  }

  if (typeof goal.description !== 'string' || goal.description.trim().length === 0) {
    throw validation('a chat goal needs a description', { reason: 'goal_description_empty' })
  }
  if (goal.description.length > MAX_GOAL_DESCRIPTION_CHARS) {
    throw validation(
      `a chat goal description is at most ${MAX_GOAL_DESCRIPTION_CHARS} characters`,
      { reason: 'goal_description_too_long' }
    )
  }

  // A goal that names files needs a folder for them to be in. `document` and
  // `codebase` always do; a `discussion` only does once it lists materials.
  const needsWorkdir =
    goal.kind === 'document' || goal.kind === 'codebase' || goal.materials.length > 0
  if (needsWorkdir && workdir === null) {
    throw validation('this goal needs the chat to be bound to a folder', {
      reason: 'goal_needs_workdir'
    })
  }
  // The folder was validated when it was bound, which says nothing about now: a
  // goal resolved against a folder that has been deleted would fail as "outside"
  // and send the user looking for the wrong mistake.
  if (needsWorkdir) assertWorkdir(workdir)

  if (goal.kind === 'document') {
    if (goal.deliverable === undefined) {
      throw validation('a document goal needs a deliverable', {
        reason: 'goal_deliverable_required'
      })
    }
    resolveGoalPath(
      goal.deliverable,
      workdir as string,
      { notRelative: 'goal_deliverable_not_relative', outside: 'goal_deliverable_outside_workdir' },
      'a deliverable'
    )
  } else if (goal.deliverable !== undefined) {
    // Not a `ValidationReason`: the panel drops the field when the kind changes,
    // so only a hand-written call can reach this.
    throw validation('only a document goal may carry a deliverable')
  }

  for (const material of goal.materials) {
    const absolute = resolveGoalPath(
      material,
      workdir as string,
      { notRelative: 'goal_material_not_relative', outside: 'goal_material_outside_workdir' },
      'a material'
    )
    // Unlike the deliverable, a material is something the group reads, so it has
    // to be there. `agents/materials.ts` (S5.11) is what reads it, through the
    // same `resolveInWorkdir` this check uses — and re-stats it at that moment,
    // because a file can be deleted between being marked and being read.
    if (!existsSync(absolute)) {
      throw validation(`a material does not exist: ${material}`, {
        reason: 'goal_material_missing'
      })
    }
  }
}

/**
 * Where a `document` goal's deliverable is, and whether it is there yet.
 *
 * A **query** rather than a field on `Chat` because it is a fact about the
 * filesystem: a column would be written once and then be wrong the moment
 * anything created, moved or deleted the file, and the same reasoning already
 * keeps the member count off the domain type. The renderer asks when it opens a
 * chat and whenever that chat changes; S5.12 is what makes an executor turn ask.
 *
 * Where the path comes from is `deliverablePath` (`executor/paths.ts`), shared
 * since S5.12 with the executor turn that appends a chip for the file it just
 * delivered: two spellings of the same `join` would be two chances for the chip
 * in the header and the chip in the transcript to name different files. That
 * helper uses `join` rather than `resolveInWorkdir` — the path was confined when
 * the goal was saved, and a folder that has since gone simply answers "not
 * delivered" instead of throwing at a chip that only wants to know whether to
 * say so.
 */
function goalStatus(goal: ChatGoal | null, workdir: string | null): ChatGoalStatus {
  const deliverable = deliverablePath(goal, workdir)
  if (deliverable === null) return { deliverable: null, delivered: false }
  return { deliverable, delivered: existsSync(deliverable) }
}

/**
 * At most one `executor` among a chat's members.
 *
 * PLAN.md: *discussion agents are read-only; all writes go through one executor*.
 * Two writers in one chat would overwrite each other's changes in the same
 * folder and leave a diff nobody can review, so the second one is refused at the
 * moment membership is written — which is the only place that can see the whole
 * resulting list, because `chats.members.set` replaces it wholesale.
 *
 * Every id has already been resolved by the caller, so `agents.get` here is a
 * repeat read of rows that are certainly present.
 *
 * Exported since S9.1: `committees.*` applies the same rule to a committee's
 * members, because a group whose members cannot legally sit in one chat is a
 * group that refuses to convene. One function rather than two so the refusal
 * and its `second_executor` reason cannot drift apart.
 */
export function assertOneExecutor(ctx: AppContext, agentIds: string[]): void {
  const executors = agentIds.filter(
    (agentId) => ctx.repos.agents.get(agentId, ctx.userId).role === 'executor'
  )
  if (executors.length > 1) {
    throw validation('a chat may have only one executor member', {
      reason: 'second_executor',
      agentIds: executors
    })
  }
}

/**
 * The orchestration settings, field by field.
 *
 * The patch is merged into the stored object by the repository, so every field is
 * optional here and only the ones present are checked. The bounds are the ones
 * the member panel offers; validating them in the backend as well means a future
 * caller (the server build, a script) cannot store a chat that `ChatRunner`
 * would then have to defend itself against every round.
 */
function assertChatSettings(value: unknown): asserts value is ChatSettingsPatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw validation('chat settings must be an object')
  }
  const settings = value as ChatSettingsPatch

  // S5.16. The id is not checked against this chat's membership here, and that
  // is deliberate: membership changes after the setting is written, so the
  // runner has to survive an id that names nobody anyway (it falls back to the
  // first eligible member). Validating it twice would only mean the panel could
  // refuse what the runner already handles. `null` is how the select goes back
  // to "first in speaking order"; see `mergeChatSettings`.
  if (settings.closingAgentId !== undefined && settings.closingAgentId !== null) {
    if (typeof settings.closingAgentId !== 'string' || settings.closingAgentId.length === 0) {
      throw validation('closingAgentId must be an agent id, or null')
    }
  }

  // S5.18. Only the value `false` turns automatic delivery off, so the check is
  // simply "a boolean or nothing": `undefined` leaves the field alone in the
  // merge, and an absent field is what "on" has always looked like on a chat
  // stored before this setting existed.
  if (settings.autoDeliver !== undefined && typeof settings.autoDeliver !== 'boolean') {
    throw validation('autoDeliver must be a boolean')
  }

  if (settings.mode !== undefined && !CHAT_MODES.includes(settings.mode)) {
    throw validation('unknown chat mode')
  }
  if (settings.speaking !== undefined && !SPEAKING_MODES.includes(settings.speaking)) {
    throw validation('unknown speaking mode')
  }
  if (settings.maxAutoRounds !== undefined) {
    const rounds = settings.maxAutoRounds
    if (
      typeof rounds !== 'number' ||
      !Number.isInteger(rounds) ||
      rounds < MIN_AUTO_ROUNDS ||
      rounds > MAX_AUTO_ROUNDS
    ) {
      throw validation(`maxAutoRounds must be an integer between ${MIN_AUTO_ROUNDS} and ${MAX_AUTO_ROUNDS}`)
    }
  }
  for (const field of ['stallTimeoutMs', 'hardTimeoutMs'] as const) {
    const timeout = settings[field]
    if (timeout === undefined) continue
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      throw validation(`${field} must be a positive number of milliseconds`)
    }
  }
}

function assertAgentIds(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw validation('agentIds must be an array of agent ids')
  }
}

/**
 * The client name that goes into a message's `OriginPart` (S10.4).
 *
 * `chat.send`'s `origin.client` is the one field of the whole backend surface
 * that a **remote party chose the text of**: the MCP shim copies it from the
 * calling IDE's `initialize.clientInfo.name`, which is whatever that client
 * decided to call itself, and the endpoint hands it on. It is then stored
 * forever and drawn in a chip, so it is cleaned here — at the boundary, once —
 * rather than in the runner, the row model and the chip in three slightly
 * different ways:
 *
 * - **Control characters are removed**, not escaped. A newline, a `\r` or an
 *   ANSI escape in a chip is a client trying to be somewhere it is not, and
 *   there is no legitimate client name that contains one.
 * - **Trimmed and capped at `MAX_ORIGIN_CLIENT_CHARS`**, because a chip sits on
 *   the message header line beside the round and the timestamp; a client that
 *   sent a kilobyte would push the rest of the row off the screen.
 * - **Empty means absent.** A client that sends `""`, or a name that was nothing
 *   but control characters, gets no flag — a chip reading "via" with a blank
 *   after it says less than no chip at all.
 *
 * It is deliberately **not** rejected with `validation`: the caller is a coding
 * agent relaying a third string, and refusing its discussion over the shape of a
 * label would be a tool failure where dropping the label is the honest outcome.
 */
export function sanitizeOriginClient(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // `\p{C}` is every Unicode "other" category: controls, format characters such
  // as the bidi overrides, surrogates and unassigned code points.
  const cleaned = value.replace(/\p{C}/gu, '').trim()
  if (cleaned.length === 0) return null
  return cleaned.slice(0, MAX_ORIGIN_CLIENT_CHARS).trim()
}

/** `chat.send`'s `origin`, sanitised, or `null` when it carries no usable name. */
function originOf(input: unknown): { client: string } | null {
  const origin = (input as { origin?: unknown })?.origin
  if (origin === null || origin === undefined) return null
  if (typeof origin !== 'object') throw validation('origin must be an object')
  const client = sanitizeOriginClient((origin as { client?: unknown }).client)
  return client === null ? null : { client }
}

/**
 * The member list a new chat is born with.
 *
 * Since S9.1 it has two sources, in this order: the committee this topic is
 * convened from, in its own `position` order, then the individual agents the
 * caller named. Duplicates are dropped keeping the **first** occurrence, so an
 * agent who is both a committee member and an extra keeps the committee's
 * place in the speaking order rather than being pushed to the end.
 *
 * Expanding the committee here is what makes joining a **snapshot**: the ids
 * land in `chat_members` and nothing reads the committee again, so editing the
 * committee tomorrow cannot change a topic convened today. `Chat.committeeId`
 * records only where they came from.
 *
 * When the merged list is empty the chat is empty too, *except* on an
 * installation whose agent library has never been used: there `ensureDefaultAgent`
 * writes the bootstrap agent so the very first chat of a fresh install can still
 * be talked to. That fallback rejects with `validation` when no provider has a
 * model, which is the only way a first-run user can reach it — the renderer turns
 * the code into copy that points at Settings.
 */
async function initialMembers(
  ctx: AppContext,
  committeeId: string | undefined,
  memberAgentIds: string[] | undefined
): Promise<string[]> {
  // `not_found` for a committee that is gone or belongs to another user.
  const fromCommittee =
    committeeId === undefined ? [] : ctx.repos.committees.get(committeeId, ctx.userId).memberAgentIds

  const merged: string[] = []
  for (const agentId of [...fromCommittee, ...(memberAgentIds ?? [])]) {
    if (!merged.includes(agentId)) merged.push(agentId)
  }
  if (merged.length > 0) return merged

  if (ctx.repos.agents.list(ctx.userId).length > 0) return []
  return [(await ensureDefaultAgent(ctx)).id]
}

/**
 * Usage over a whole chat, priced with each agent's own provider.
 *
 * The arithmetic itself is `summarizeUsage` in `@shared/usage`, which the
 * renderer runs on the same messages: this function only supplies the "which
 * model, on which provider" lookup, from the repositories. An agent or provider
 * the user has since deleted resolves to `undefined`, which keeps its tokens in
 * the total and leaves its cost unknown — the honest answer, and the reason the
 * lookup is a function rather than a prebuilt map.
 */
function summarizeChatUsage(ctx: AppContext, chatId: string): ChatUsageSummary {
  const models = new Map<string, { modelId: string; presetId?: string | undefined } | undefined>()
  return summarizeUsage(ctx.repos.messages.listForContext(chatId, ctx.userId), (agentId) => {
    if (models.has(agentId)) return models.get(agentId)
    let resolved: { modelId: string; presetId?: string | undefined } | undefined
    try {
      const agent = ctx.repos.agents.get(agentId, ctx.userId)
      const provider = ctx.repos.providers.get(agent.providerId, ctx.userId)
      resolved = { modelId: agent.modelId, presetId: provider.presetId }
    } catch {
      resolved = undefined
    }
    models.set(agentId, resolved)
    return resolved
  })
}

export const chatHandlers: HandlerModule = {
  'chats.list': async (ctx) => ctx.repos.chats.list(ctx.userId),

  'chats.get': async (ctx, input) => {
    assertId(input, 'chat')
    return ctx.repos.chats.get(input.id, ctx.userId)
  },

  'chats.create': async (ctx, input) => {
    const create: ChatCreateInput = input?.input ?? {}
    const { memberAgentIds, committeeId, ...patch } = create
    // No row yet, so a goal can only be validated against the folder this same
    // call is binding.
    assertChatPatch(patch, () => null)
    if (memberAgentIds !== undefined) assertAgentIds(memberAgentIds)
    if (committeeId !== undefined && (typeof committeeId !== 'string' || committeeId.length === 0)) {
      throw validation('committeeId must be a committee id')
    }

    const members = await initialMembers(ctx, committeeId, memberAgentIds)
    // Before the row exists: a chat created with two executors — from the
    // committee, from the extras, or one of each — would otherwise be written
    // and then left half-built when `setMembers` refused.
    assertOneExecutor(ctx, members)
    const chat = ctx.repos.chats.create(
      { ...patch, ...(committeeId === undefined ? {} : { committeeId }) },
      ctx.userId
    )
    // `setMembers` validates that every agent exists and rejects duplicates.
    ctx.repos.chats.setMembers(ctx.userId, chat.id, members)

    // Re-read: `setMembers` bumps `updatedAt`, and the list is ordered by it.
    const created = ctx.repos.chats.get(chat.id, ctx.userId)
    ctx.events.emit({ type: 'chat.updated', chat: created })
    return created
  },

  'chats.update': async (ctx, input) => {
    assertId(input, 'chat')
    // The stored folder is read only when the patch carries a goal and no
    // `workdir` of its own; `assertChatPatch` calls the thunk in exactly that
    // case, so a rename still costs one write and no read.
    assertChatPatch(input.patch, () => ctx.repos.chats.get(input.id, ctx.userId).workdir)
    // The repository always bumps `updatedAt`, so a rename floats the chat to the
    // top of the list exactly like a new message does.
    const chat = ctx.repos.chats.update(input.id, input.patch, ctx.userId)
    ctx.events.emit({ type: 'chat.updated', chat })
    return chat
  },

  'chats.delete': async (ctx, input) => {
    assertId(input, 'chat')
    ctx.runners.remove(input.id)
    ctx.repos.chats.delete(input.id, ctx.userId)
    ctx.events.emit({ type: 'chat.deleted', chatId: input.id })
  },

  'chats.search': async (ctx, input) => {
    const query = (input as { query?: unknown })?.query
    if (typeof query !== 'string') throw validation('A search query is required')
    // A blank query is "no filter" by contract, not an error: the renderer calls
    // this on every keystroke and the last keystroke is often a deletion.
    return ctx.repos.chats.search(query, ctx.userId)
  },

  'chats.goalStatus': async (ctx, input) => {
    const chatId = (input as { chatId?: unknown })?.chatId
    if (typeof chatId !== 'string' || chatId.length === 0) throw validation('A chat id is required')
    const chat = ctx.repos.chats.get(chatId, ctx.userId)
    return goalStatus(chat.goal, chat.workdir)
  },

  'chats.members.list': async (ctx, input) => {
    const chatId = (input as { chatId?: unknown })?.chatId
    if (typeof chatId !== 'string' || chatId.length === 0) throw validation('A chat id is required')
    return ctx.repos.chats.listMembers(chatId, ctx.userId)
  },

  'chats.members.set': async (ctx, input) => {
    const chatId = (input as { chatId?: unknown })?.chatId
    if (typeof chatId !== 'string' || chatId.length === 0) throw validation('A chat id is required')
    assertAgentIds(input.agentIds)
    // `not_found` for an id that names no agent of this user, before anything is
    // written: an empty member list is a valid state, a bogus one is not.
    for (const agentId of input.agentIds) ctx.repos.agents.get(agentId, ctx.userId)
    assertOneExecutor(ctx, input.agentIds)

    const members = ctx.repos.chats.setMembers(ctx.userId, chatId, input.agentIds)
    ctx.events.emit({ type: 'chat.updated', chat: ctx.repos.chats.get(chatId, ctx.userId) })
    return members
  },

  'messages.list': async (ctx, input) => {
    const chatId = (input as { chatId?: unknown })?.chatId
    if (typeof chatId !== 'string' || chatId.length === 0) throw validation('A chat id is required')
    if (input.limit !== undefined && !(input.limit > 0)) {
      throw validation('limit must be a positive number')
    }
    // Newest first, per the `BackendApi` contract; the renderer reverses it.
    return ctx.repos.messages.list(
      {
        chatId,
        ...(input.before ? { before: input.before } : {}),
        ...(input.limit ? { limit: input.limit } : {})
      },
      ctx.userId
    )
  },

  'messages.usageSummary': async (ctx, input) => {
    const chatId = (input as { chatId?: unknown })?.chatId
    if (typeof chatId !== 'string' || chatId.length === 0) throw validation('A chat id is required')
    // `not_found` for a chat that is gone, rather than an empty summary that
    // would look like a chat which simply has not spoken yet.
    ctx.repos.chats.get(chatId, ctx.userId)
    return summarizeChatUsage(ctx, chatId)
  },

  'chat.send': async (ctx, input) => {
    const chatId = (input as { chatId?: unknown })?.chatId
    if (typeof chatId !== 'string' || chatId.length === 0) throw validation('A chat id is required')
    if (typeof input.text !== 'string') throw validation('A message text is required')
    if (input.mentions !== undefined) assertAgentIds(input.mentions)
    // S5.14: the cap this one chain runs under. Bounded by the same constants
    // `chat.settings.maxAutoRounds` is, because it is the same number arriving
    // by a different route — a caller must not buy an unbounded run by sending
    // it per message instead of storing it.
    const rounds = (input as { rounds?: unknown }).rounds
    if (rounds !== undefined) {
      if (
        typeof rounds !== 'number' ||
        !Number.isInteger(rounds) ||
        rounds < MIN_AUTO_ROUNDS ||
        rounds > MAX_AUTO_ROUNDS
      ) {
        throw validation(`rounds must be an integer between ${MIN_AUTO_ROUNDS} and ${MAX_AUTO_ROUNDS}`)
      }
    }

    // S10.4: who sent this for the user. Sanitised rather than validated — see
    // `sanitizeOriginClient` — so a client with an unusable name still gets its
    // discussion, just without a chip on the message.
    const origin = originOf(input)

    return ctx.runners.send({
      chatId,
      text: input.text,
      ...(input.mentions ? { mentions: input.mentions } : {}),
      ...(rounds !== undefined ? { rounds } : {}),
      ...(origin === null ? {} : { origin })
    })
  },

  'chat.handoff': async (ctx, input) => {
    const chatId = (input as { chatId?: unknown })?.chatId
    if (typeof chatId !== 'string' || chatId.length === 0) throw validation('A chat id is required')
    // `intent` (S5.12) is checked here only for its *shape*; whether this chat
    // can satisfy it is the runner's question, like the other three.
    const intent = (input as { intent?: unknown })?.intent
    if (intent !== undefined && !HANDOFF_INTENTS.includes(intent as HandoffIntent)) {
      throw validation(`Unknown hand-off intent: ${String(intent)}`)
    }
    // Everything else this refuses — no folder, no executor, no deliverable, a
    // run already in flight — is a fact about the *run*, and the runner is the
    // only object that holds all four. It rejects with a `ValidationReason` the
    // renderer translates; see `ChatRunner.handoff`.
    return ctx.runners.handoff({
      chatId,
      ...(intent === undefined ? {} : { intent: intent as HandoffIntent })
    })
  },

  'chat.stop': async (ctx, input) => {
    const chatId = (input as { chatId?: unknown })?.chatId
    if (typeof chatId !== 'string' || chatId.length === 0) throw validation('A chat id is required')
    // Idempotent by contract: stopping an idle chat is not an error.
    ctx.runners.stop(chatId)
  }
}
