/**
 * The renderer's copy of the merge rule, and the drift it has to report.
 *
 * `mergeMembers` mirrors `initialMembers` in `src/main/handlers/chats.ts`, so
 * the cases below are deliberately the ones `src/main/handlers/chats.test.ts`
 * asserts against the real thing: committee first, extras after, first
 * occurrence wins. Two implementations of one rule are only safe while both are
 * held to the same examples.
 */
import { describe, expect, it } from 'vitest'
import type { Committee } from '@shared/types'
import { LOCAL_USER_ID } from '@shared/types'
import { mergeMembers, missingCommitteeMembers } from './committee-members'

function committee(memberAgentIds: string[]): Committee {
  return {
    id: 'committee-1',
    userId: LOCAL_USER_ID,
    createdAt: 1,
    updatedAt: 1,
    name: 'Architecture review',
    description: '',
    memberAgentIds
  }
}

describe('mergeMembers', () => {
  it('puts the committee first and the extras after it', () => {
    expect(mergeMembers(['a', 'b'], ['c'])).toEqual(['a', 'b', 'c'])
  })

  it('keeps the first occurrence, so a duplicate stays in its committee place', () => {
    // The whole point of "first occurrence wins": ticking someone who is already
    // a committee member must not move them to the end of the speaking order.
    expect(mergeMembers(['a', 'b'], ['a', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('de-duplicates within each list as well as across them', () => {
    expect(mergeMembers(['a', 'a'], ['b', 'b'])).toEqual(['a', 'b'])
  })

  it('answers either list on its own, and an empty list for neither', () => {
    expect(mergeMembers([], ['a', 'b'])).toEqual(['a', 'b'])
    expect(mergeMembers(['a', 'b'], [])).toEqual(['a', 'b'])
    // The "+" button's case: nothing selected, so the backend decides — which
    // is the behaviour S9.3 promised the dialog would not change.
    expect(mergeMembers([], [])).toEqual([])
  })

  it('does not mutate what it was given', () => {
    const committeeIds = ['a']
    const extraIds = ['b']
    mergeMembers(committeeIds, extraIds)
    expect(committeeIds).toEqual(['a'])
    expect(extraIds).toEqual(['b'])
  })
})

describe('missingCommitteeMembers', () => {
  it('reports the members the chat was never given, in committee order', () => {
    expect(missingCommitteeMembers(committee(['a', 'b', 'c']), ['b'])).toEqual(['a', 'c'])
  })

  it('is empty when the chat already has everyone', () => {
    expect(missingCommitteeMembers(committee(['a', 'b']), ['b', 'a', 'z'])).toEqual([])
  })

  it('ignores members the chat has that the committee does not', () => {
    // The extras a topic was convened with, and anyone added since. A sync only
    // ever adds; it never proposes a removal.
    expect(missingCommitteeMembers(committee(['a']), ['a', 'x', 'y'])).toEqual([])
  })

  it('answers nothing for a chat with no committee, or one that was deleted', () => {
    expect(missingCommitteeMembers(null, ['a'])).toEqual([])
    expect(missingCommitteeMembers(undefined, ['a'])).toEqual([])
  })

  it('reports the whole committee for a chat that lost its members', () => {
    expect(missingCommitteeMembers(committee(['a', 'b']), [])).toEqual(['a', 'b'])
  })
})
