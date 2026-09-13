/**
 * Who speaks next — the pure half of `ChatRunner`.
 *
 * Everything in this file is a function of plain data: member ids in `position`
 * order, the mentions already parsed out of a message (`@shared/mentions`), and
 * the chat's mode. No database, no events, no clock. That is what makes the
 * scheduling rules of PLAN's "Orchestration" section testable one by one instead
 * of only observable through a live multi-round run.
 *
 * ## The rules
 *
 * | Trigger | Speakers |
 * |---|---|
 * | A user message, `roundrobin` | every member, in `position` order |
 * | A user message, `mention-only` | the members the message mentioned, in `position` order |
 * | The round that just ended | every member mentioned by that round's replies, minus self-mentions, minus non-members, minus the repliers that `passed` |
 * | "Hand to executor" (S5.6) | the chat's executor, alone, whatever the mode |
 * | The round after that one | every other member, in `position` order, reviewing what it changed |
 *
 * Two details that are decisions rather than implementation:
 *
 * - **Speaker order is always `position` order**, never mention order. The chat's
 *   member order is the one thing the user can set by hand (S2.2's drag handle),
 *   so a round whose order depended on which name a model typed first would make
 *   that control a lie.
 * - **A plan carries `inReplyTo` with it.** Knowing *that* an agent speaks is not
 *   enough: the UI prints "replying to @x", so the reason has to be computed
 *   where the speakers are and travel with them into the message row.
 */
import type { ChatMode } from '@shared/types'

/**
 * What a round is: who speaks, and — per speaker — who pulled them in.
 *
 * `inReplyTo` values are agent ids plus the literal `USER_SOURCE`, which is what
 * `Message.inReplyTo` stores.
 */
export interface RoundPlan {
  /** Agent ids, in `position` order, deduplicated. */
  speakers: string[]
  /** Speaker agent id → who mentioned them, in the order they were found. */
  inReplyTo: Record<string, string[]>
}

/** The value `inReplyTo` carries when the human's message is what asked. */
export const USER_SOURCE = 'user'

/** A round that schedules nobody. */
export const EMPTY_PLAN: RoundPlan = { speakers: [], inReplyTo: {} }

/** One user message, reduced to what scheduling needs from it. */
export interface UserTrigger {
  /** The effective mention set already stored on the message. */
  mentions: string[]
}

/** One finished agent turn of the round that just ended. */
export interface ReplyTrigger {
  agentId: string
  /** The mentions parsed out of the finished reply. */
  mentions: string[]
  /** `[PASS]` replies schedule nobody, whatever they happen to contain. */
  passed: boolean
}

/** Builds a plan from `speaker → sources` pairs, ordered by membership position. */
function toPlan(memberIds: readonly string[], sources: Map<string, string[]>): RoundPlan {
  const speakers = memberIds.filter((id) => sources.has(id))
  const inReplyTo: Record<string, string[]> = {}
  for (const id of speakers) {
    const from = sources.get(id) ?? []
    if (from.length > 0) inReplyTo[id] = from
  }
  return { speakers, inReplyTo }
}

/** Appends `source` to `id`'s list without repeating it. */
function addSource(sources: Map<string, string[]>, id: string, source: string | null): void {
  const existing = sources.get(id)
  const list = existing ?? []
  if (source !== null && !list.includes(source)) list.push(source)
  if (!existing) sources.set(id, list)
}

/**
 * The round a batch of user messages triggers.
 *
 * A batch rather than one message, because several can land while a round is
 * running and they are all answered together at the next boundary — the next
 * turn rebuilds its view from the whole transcript either way.
 */
export function planFromUserMessages(
  mode: ChatMode,
  memberIds: readonly string[],
  messages: readonly UserTrigger[]
): RoundPlan {
  const sources = new Map<string, string[]>()
  const mentioned = new Set<string>()
  for (const message of messages) {
    for (const agentId of message.mentions) {
      if (memberIds.includes(agentId)) mentioned.add(agentId)
    }
  }

  if (mode === 'roundrobin') {
    // Everyone speaks; the ones the user actually named also get the label.
    for (const id of memberIds) addSource(sources, id, mentioned.has(id) ? USER_SOURCE : null)
  } else {
    for (const id of mentioned) addSource(sources, id, USER_SOURCE)
  }

  return toPlan(memberIds, sources)
}

/**
 * The round the replies of the round that just ended schedule.
 *
 * Self-mentions are dropped (an agent asking itself a question would never
 * terminate), so are mentions of agents that are not in the chat, and a `passed`
 * reply contributes nothing at all.
 */
export function planFromReplies(
  memberIds: readonly string[],
  replies: readonly ReplyTrigger[]
): RoundPlan {
  const sources = new Map<string, string[]>()
  for (const reply of replies) {
    if (reply.passed) continue
    for (const agentId of reply.mentions) {
      if (agentId === reply.agentId) continue
      if (!memberIds.includes(agentId)) continue
      addSource(sources, agentId, reply.agentId)
    }
  }
  return toPlan(memberIds, sources)
}

/**
 * The first round of a hand-off (S5.6): the executor, alone, answering the user.
 *
 * It ignores the chat's `mode` on purpose. "Hand to executor" is not a message
 * everybody is invited to answer — the whole point of PLAN.md's one-writer rule
 * is that exactly one member touches the folder — so a `roundrobin` chat must
 * not put four models in front of the executor before it starts working.
 *
 * An executor that is no longer a member schedules nobody, which the runner
 * reads as an empty plan and finishes on. `memberIds` is therefore the filter
 * here as everywhere else.
 */
export function planFromHandoff(memberIds: readonly string[], executorId: string): RoundPlan {
  const sources = new Map<string, string[]>()
  if (memberIds.includes(executorId)) addSource(sources, executorId, USER_SOURCE)
  return toPlan(memberIds, sources)
}

/**
 * The review round of a hand-off: everybody **except** the executor, in
 * `position` order, replying to it.
 *
 * Every other member rather than "every participant": a chat that somehow holds
 * two executors (S5.2's known gap — `agents.update` can promote a member) has
 * exactly one that `executorWorkdir` armed, and the other one has no tools and
 * nothing to lose by reviewing. The rule "whoever did not just write the code
 * reads it" is also the one that stays true if roles grow a third value.
 *
 * The round is scheduled whatever the chat's `mode` is, for the same reason the
 * hand-off round ignores it: the user asked for a review, and `mention-only`
 * would silently answer with nothing because a notice is not a review.
 */
export function planFromReview(memberIds: readonly string[], executorId: string): RoundPlan {
  const sources = new Map<string, string[]>()
  for (const id of memberIds) {
    if (id === executorId) continue
    addSource(sources, id, executorId)
  }
  return toPlan(memberIds, sources)
}

/** Union of two plans, back in `position` order, with the sources concatenated. */
export function mergePlans(
  memberIds: readonly string[],
  ...plans: readonly RoundPlan[]
): RoundPlan {
  const sources = new Map<string, string[]>()
  for (const plan of plans) {
    for (const id of plan.speakers) {
      addSource(sources, id, null)
      for (const source of plan.inReplyTo[id] ?? []) addSource(sources, id, source)
    }
  }
  return toPlan(memberIds, sources)
}

/**
 * Whether the automatic chain has to stop and give the user the floor.
 *
 * `roundsSinceUser` counts **every round run since the last user message,
 * including the one that message triggered**: `maxAutoRounds` is the promise
 * "this chat will not run more than N rounds before it comes back to you", and a
 * cap that ignored the first round would run N+1.
 */
export function reachedRoundLimit(roundsSinceUser: number, maxAutoRounds: number): boolean {
  return roundsSinceUser >= maxAutoRounds
}
