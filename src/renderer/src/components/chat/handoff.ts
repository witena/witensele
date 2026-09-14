/**
 * When "Hand to executor" is available, and — when it is not — which rule says
 * so (S5.6).
 *
 * The answer is a `ValidationReason`, the same identifier `ChatRunner.handoff`
 * rejects with, for two reasons. It keeps one set of words for one rule: the
 * disabled button's tooltip and the error under the composer are both
 * `validationReasonMessage(t, reason)`, so a chat with no folder cannot be
 * explained one way by the control and another way by the refusal. And it keeps
 * the check honest: the renderer decides whether to *offer* the action, the
 * backend decides whether to *run* it, and writing both against the same
 * vocabulary is what makes the two easy to compare when they disagree.
 *
 * Pure, and takes only what it reads, so every branch is a unit test rather
 * than a screen to click through.
 */
import type { ChatGoal, HandoffIntent, ValidationReason } from '@shared/types'

/** The little the rule needs to know about one member. */
export interface HandoffMember {
  role: 'participant' | 'executor'
}

export interface HandoffInput {
  /** The chat's working directory, or `null`/`undefined` when it has none. */
  workdir?: string | null | undefined
  /** The chat's members, in `position` order. */
  members: readonly HandoffMember[]
  /** True while a run of this chat is in flight, or a send is on its way. */
  running: boolean
  /**
   * What is being handed over; `'implement'` when omitted (S5.12).
   *
   * One function for both buttons rather than a second `deliverBlocker`, because
   * "Write the deliverable" is "Hand to executor" plus one rule: a rule added by
   * a wrapper would be a second order for the same four checks, and the order is
   * the part that has to match the backend.
   */
  intent?: HandoffIntent
  /** The chat's goal, read only by the `deliver` rule. */
  goal?: ChatGoal | null | undefined
}

/**
 * The reason the action cannot be taken, or `null` when it can.
 *
 * The order is the backend's order — folder, executor, deliverable, run — so the
 * sentence the user reads before clicking is the sentence they would have got by
 * clicking. The transient rule is deliberately **last**: a chat that is both
 * missing its deliverable and running should be told about the deliverable,
 * which is the one that will still be true in a minute.
 */
export function handoffBlocker(input: HandoffInput): ValidationReason | null {
  if (typeof input.workdir !== 'string' || input.workdir.trim().length === 0) {
    return 'handoff_no_workdir'
  }
  if (!input.members.some((member) => member.role === 'executor')) return 'handoff_no_executor'
  if (input.intent === 'deliver' && !hasDeliverable(input.goal)) return 'handoff_no_deliverable'
  if (input.running) return 'handoff_run_active'
  return null
}

/** Whether this goal names a file to write — a `document` with a deliverable. */
function hasDeliverable(goal: ChatGoal | null | undefined): boolean {
  if (!goal || goal.kind !== 'document') return false
  return typeof goal.deliverable === 'string' && goal.deliverable.trim().length > 0
}
