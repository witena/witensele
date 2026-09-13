/**
 * When "Hand to executor" may be pressed (S5.6).
 *
 * The three refusals are proved against the backend in
 * `src/main/orchestration/chat-runner.test.ts`; this file proves the renderer
 * reaches the same verdict from the same three facts, in the same order, so the
 * disabled button and the rejection can never disagree about which rule applies.
 */
import { describe, expect, it } from 'vitest'
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
