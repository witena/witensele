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
import type { ValidationReason } from '@shared/types'

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
}

/**
 * The reason the action cannot be taken, or `null` when it can.
 *
 * The order is the backend's order (folder, executor, run), so the sentence the
 * user reads before clicking is the sentence they would have got by clicking.
 */
export function handoffBlocker(input: HandoffInput): ValidationReason | null {
  if (typeof input.workdir !== 'string' || input.workdir.trim().length === 0) {
    return 'handoff_no_workdir'
  }
  if (!input.members.some((member) => member.role === 'executor')) return 'handoff_no_executor'
  if (input.running) return 'handoff_run_active'
  return null
}
