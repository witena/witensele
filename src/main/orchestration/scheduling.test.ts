/**
 * The scheduling rules, without a model, a database or a clock.
 *
 * `chat-runner.test.ts` proves the engine wires these up correctly; this file
 * proves the rules themselves, which is where the edge cases live: a self
 * mention, a mention of somebody who left the chat, a `[PASS]`, and the round
 * counter that a user message resets.
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_PLAN,
  mergePlans,
  planFromReplies,
  planFromUserMessages,
  reachedRoundLimit,
  USER_SOURCE
} from './scheduling'

const MEMBERS = ['a', 'b', 'c']

describe('planFromUserMessages', () => {
  it('gives every member the floor in roundrobin, in position order', () => {
    const plan = planFromUserMessages('roundrobin', MEMBERS, [{ mentions: [] }])

    expect(plan.speakers).toEqual(['a', 'b', 'c'])
    expect(plan.inReplyTo).toEqual({})
  })

  it('labels the members the user named, and still lets everyone speak', () => {
    const plan = planFromUserMessages('roundrobin', MEMBERS, [{ mentions: ['c'] }])

    expect(plan.speakers).toEqual(['a', 'b', 'c'])
    expect(plan.inReplyTo).toEqual({ c: [USER_SOURCE] })
  })

  it('gives only the mentioned members the floor in mention-only', () => {
    const plan = planFromUserMessages('mention-only', MEMBERS, [{ mentions: ['c', 'a'] }])

    // Mention order was c, a — position order is a, c.
    expect(plan.speakers).toEqual(['a', 'c'])
    expect(plan.inReplyTo).toEqual({ a: [USER_SOURCE], c: [USER_SOURCE] })
  })

  it('schedules nobody in mention-only when nothing was mentioned', () => {
    expect(planFromUserMessages('mention-only', MEMBERS, [{ mentions: [] }])).toEqual(EMPTY_PLAN)
  })

  it('answers a batch of messages as one round', () => {
    const plan = planFromUserMessages('mention-only', MEMBERS, [
      { mentions: ['b'] },
      { mentions: ['a'] }
    ])

    expect(plan.speakers).toEqual(['a', 'b'])
  })

  it('ignores a mention of an agent that is not in the chat', () => {
    const plan = planFromUserMessages('mention-only', MEMBERS, [{ mentions: ['gone'] }])

    expect(plan.speakers).toEqual([])
  })
})

describe('planFromReplies', () => {
  it('schedules the members a reply mentioned, with the author as the source', () => {
    const plan = planFromReplies(MEMBERS, [{ agentId: 'a', mentions: ['c'], passed: false }])

    expect(plan.speakers).toEqual(['c'])
    expect(plan.inReplyTo).toEqual({ c: ['a'] })
  })

  it('drops a self-mention', () => {
    const plan = planFromReplies(MEMBERS, [{ agentId: 'a', mentions: ['a'], passed: false }])

    expect(plan).toEqual(EMPTY_PLAN)
  })

  it('drops a mention of somebody who is not a member', () => {
    const plan = planFromReplies(MEMBERS, [{ agentId: 'a', mentions: ['zz'], passed: false }])

    expect(plan.speakers).toEqual([])
  })

  it('ignores the mentions of a passed reply', () => {
    const plan = planFromReplies(MEMBERS, [{ agentId: 'a', mentions: ['b'], passed: true }])

    expect(plan.speakers).toEqual([])
  })

  it('merges two repliers naming the same member and keeps both sources', () => {
    const plan = planFromReplies(MEMBERS, [
      { agentId: 'c', mentions: ['b'], passed: false },
      { agentId: 'a', mentions: ['b'], passed: false }
    ])

    expect(plan.speakers).toEqual(['b'])
    expect(plan.inReplyTo).toEqual({ b: ['c', 'a'] })
  })

  it('returns the speakers in position order, not mention order', () => {
    const plan = planFromReplies(MEMBERS, [{ agentId: 'b', mentions: ['c', 'a'], passed: false }])

    expect(plan.speakers).toEqual(['a', 'c'])
  })
})

describe('mergePlans', () => {
  it('unions the speakers back into position order', () => {
    const fromUser = planFromUserMessages('mention-only', MEMBERS, [{ mentions: ['c'] }])
    const fromReplies = planFromReplies(MEMBERS, [{ agentId: 'c', mentions: ['a'], passed: false }])

    const merged = mergePlans(MEMBERS, fromUser, fromReplies)

    expect(merged.speakers).toEqual(['a', 'c'])
    expect(merged.inReplyTo).toEqual({ a: ['c'], c: [USER_SOURCE] })
  })

  it('concatenates the sources of a member both plans schedule', () => {
    const merged = mergePlans(
      MEMBERS,
      { speakers: ['b'], inReplyTo: { b: [USER_SOURCE] } },
      { speakers: ['b'], inReplyTo: { b: ['a'] } }
    )

    expect(merged.speakers).toEqual(['b'])
    expect(merged.inReplyTo).toEqual({ b: [USER_SOURCE, 'a'] })
  })

  it('is the empty plan when nothing is scheduled', () => {
    expect(mergePlans(MEMBERS, EMPTY_PLAN, EMPTY_PLAN)).toEqual(EMPTY_PLAN)
  })
})

describe('reachedRoundLimit', () => {
  it('counts the round the user triggered', () => {
    // maxAutoRounds = 1 means "answer me once, then give me the floor back".
    expect(reachedRoundLimit(0, 1)).toBe(false)
    expect(reachedRoundLimit(1, 1)).toBe(true)
  })

  it('allows exactly maxAutoRounds rounds', () => {
    expect(reachedRoundLimit(2, 3)).toBe(false)
    expect(reachedRoundLimit(3, 3)).toBe(true)
  })

  it('is false again after the counter is reset by a user message', () => {
    // The reset itself lives in the runner; this is the shape it relies on.
    expect(reachedRoundLimit(0, 3)).toBe(false)
  })
})
