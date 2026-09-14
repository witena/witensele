/**
 * When "Hand to executor" may be pressed (S5.6).
 *
 * The three refusals are proved against the backend in
 * `src/main/orchestration/chat-runner.test.ts`; this file proves the renderer
 * reaches the same verdict from the same three facts, in the same order, so the
 * disabled button and the rejection can never disagree about which rule applies.
 *
 * S5.12 adds a fourth rule and a second caller: "Write the deliverable" in the
 * Actions card is the same hand-off with `intent: 'deliver'`, which additionally
 * needs the chat's goal to be a `document` that names a file.
 */
import { describe, expect, it } from 'vitest'
import type { ChatGoal } from '@shared/types'
import { handoffBlocker } from './handoff'

const EXECUTOR = { role: 'executor' } as const
const PARTICIPANT = { role: 'participant' } as const
const WORKDIR = '/Users/someone/code/witena'

describe('handoffBlocker', () => {
  it('allows a bound, idle chat that has an executor', () => {
    expect(
      handoffBlocker({ workdir: WORKDIR, members: [PARTICIPANT, EXECUTOR], running: false })
    ).toBeNull()
  })

  it('refuses a chat with no working directory', () => {
    expect(handoffBlocker({ workdir: null, members: [EXECUTOR], running: false })).toBe(
      'handoff_no_workdir'
    )
    expect(handoffBlocker({ members: [EXECUTOR], running: false })).toBe('handoff_no_workdir')
    // A stored path that is only whitespace is no folder either; the backend
    // applies the same test to the same field.
    expect(handoffBlocker({ workdir: '   ', members: [EXECUTOR], running: false })).toBe(
      'handoff_no_workdir'
    )
  })

  it('refuses a chat with no executor member', () => {
    expect(
      handoffBlocker({ workdir: WORKDIR, members: [PARTICIPANT, PARTICIPANT], running: false })
    ).toBe('handoff_no_executor')
    expect(handoffBlocker({ workdir: WORKDIR, members: [], running: false })).toBe(
      'handoff_no_executor'
    )
  })

  it('refuses a chat that is already running', () => {
    expect(handoffBlocker({ workdir: WORKDIR, members: [EXECUTOR], running: true })).toBe(
      'handoff_run_active'
    )
  })

  it('names the missing folder first when more than one rule applies', () => {
    // The backend checks folder, then executor, then the run; a tooltip that
    // named a different one would send the user to fix the wrong thing.
    expect(handoffBlocker({ workdir: null, members: [PARTICIPANT], running: true })).toBe(
      'handoff_no_workdir'
    )
  })
})

/**
 * S5.12: the extra rule the "Write the deliverable" action is held to.
 *
 * It is the same function with an argument rather than a wrapper, so these cases
 * are as much about the **order** as about the new reason: a wrapper that ran
 * its own check first or last would put `handoff_no_deliverable` somewhere the
 * backend does not.
 */
describe('handoffBlocker (deliver)', () => {
  const goal = (patch: Partial<ChatGoal> = {}): ChatGoal => ({
    kind: 'document',
    description: 'Write the quarterly report',
    deliverable: 'docs/REPORT.md',
    materials: [],
    ...patch
  })

  const deliver = (input: Partial<Parameters<typeof handoffBlocker>[0]> = {}) =>
    handoffBlocker({
      workdir: WORKDIR,
      members: [PARTICIPANT, EXECUTOR],
      running: false,
      intent: 'deliver',
      goal: goal(),
      ...input
    })

  it('allows a bound, idle chat whose document goal names a file', () => {
    expect(deliver()).toBeNull()
  })

  it('refuses a chat with no goal, or a goal of another kind', () => {
    expect(deliver({ goal: null })).toBe('handoff_no_deliverable')
    expect(deliver({ goal: undefined })).toBe('handoff_no_deliverable')
    expect(deliver({ goal: goal({ kind: 'discussion' }) })).toBe('handoff_no_deliverable')
    expect(deliver({ goal: goal({ kind: 'codebase' }) })).toBe('handoff_no_deliverable')
  })

  it('refuses a document goal whose deliverable is missing or blank', () => {
    const { deliverable: _dropped, ...rest } = goal()
    expect(deliver({ goal: rest as ChatGoal })).toBe('handoff_no_deliverable')
    expect(deliver({ goal: goal({ deliverable: '  ' }) })).toBe('handoff_no_deliverable')
  })

  it('leaves the other three rules ahead of it, in the backend order', () => {
    // A chat with no folder cannot have a valid deliverable either, and the
    // folder is the thing to fix.
    expect(deliver({ workdir: null, goal: null })).toBe('handoff_no_workdir')
    expect(deliver({ members: [PARTICIPANT], goal: null })).toBe('handoff_no_executor')
    // …and the transient rule is last: a chat that is running *and* has no
    // deliverable should be told about the deliverable.
    expect(deliver({ running: true, goal: null })).toBe('handoff_no_deliverable')
    expect(deliver({ running: true })).toBe('handoff_run_active')
  })

  it('ignores the goal entirely for an ordinary hand-off', () => {
    expect(
      handoffBlocker({ workdir: WORKDIR, members: [EXECUTOR], running: false, goal: null })
    ).toBeNull()
  })
})
