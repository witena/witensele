/**
 * The composer's `@` autocomplete.
 *
 * The boundary rules are asserted against the same cases `@shared/mentions.ts`
 * is tested on — an address is not a mention, a longer name beats a shorter one,
 * a CJK name has no word boundary — because a completion the backend would not
 * then resolve is worse than no completion at all.
 */
import { describe, expect, it } from 'vitest'
import type { MentionMember } from '@shared/mentions'
import {
  appendMention,
  extractMentionQuery,
  filterMentionCandidates,
  insertMention,
  MAX_QUERY_LENGTH
} from './mention-query'

/**
 * `\u8bc4\u5ba1\u5458` is a two-character-plus Chinese name, written as `\u` escapes on
 * purpose: CLAUDE.md rule #1 keeps CJK out of every committed file except
 * `zh-CN.json`. `src/shared/mentions.test.ts` does the same for the same reason.
 */
const REVIEWER_ZH = '\u8bc4\u5ba1\u5458'

const MEMBERS: MentionMember[] = [
  { agentId: 'a1', name: 'Ann' },
  { agentId: 'a2', name: 'Ann Lee' },
  { agentId: 'a3', name: 'Architect' },
  { agentId: 'a4', name: REVIEWER_ZH }
]

describe('extractMentionQuery', () => {
  it('finds a bare @ at the start of the text', () => {
    expect(extractMentionQuery('@', 1)).toEqual({ start: 0, end: 1, query: '' })
  })

  it('finds the token the caret is inside', () => {
    expect(extractMentionQuery('hello @Arc', 10)).toEqual({ start: 6, end: 10, query: 'Arc' })
  })

  it('ignores an @ that follows a word character', () => {
    expect(extractMentionQuery('ada@example', 11)).toBeNull()
  })

  it('accepts an @ after any whitespace, including a newline', () => {
    expect(extractMentionQuery('line one\n@Ar', 12)).toEqual({ start: 9, end: 12, query: 'Ar' })
  })

  it('stops at a newline between the caret and the @', () => {
    expect(extractMentionQuery('@Ann\nsecond', 11)).toBeNull()
  })

  it('allows spaces so a two-word name can be completed', () => {
    expect(extractMentionQuery('@Ann L', 6)).toEqual({ start: 0, end: 6, query: 'Ann L' })
  })

  it('gives up once the token is longer than the budget', () => {
    const text = `@${'x'.repeat(MAX_QUERY_LENGTH + 5)}`
    expect(extractMentionQuery(text, text.length)).toBeNull()
  })

  it('reads only up to the caret, not to the end of the text', () => {
    expect(extractMentionQuery('@Architect speaks', 4)).toEqual({ start: 0, end: 4, query: 'Arc' })
  })

  it('clamps a caret outside the text', () => {
    expect(extractMentionQuery('@Ann', 99)).toEqual({ start: 0, end: 4, query: 'Ann' })
  })

  it('is null when there is no @ before the caret', () => {
    expect(extractMentionQuery('plain text', 5)).toBeNull()
  })
})

describe('filterMentionCandidates', () => {
  it('lists every member plus the keyword for an empty query', () => {
    const names = filterMentionCandidates(MEMBERS, '').map((candidate) => candidate.name)
    expect(names).toContain('Architect')
    expect(names).toContain(REVIEWER_ZH)
    expect(names[names.length - 1]).toBe('all')
  })

  it('filters case-insensitively on the prefix', () => {
    expect(filterMentionCandidates(MEMBERS, 'arc').map((c) => c.name)).toEqual(['Architect'])
  })

  it('offers the longest matching name first, as the parser would resolve it', () => {
    expect(filterMentionCandidates(MEMBERS, 'Ann').map((c) => c.name)).toEqual(['Ann Lee', 'Ann'])
  })

  it('matches a CJK name', () => {
    const first = REVIEWER_ZH.slice(0, 1)
    expect(filterMentionCandidates(MEMBERS, first).map((c) => c.agentId)).toEqual(['a4'])
  })

  it('keeps the @all keyword out of the rows when nothing matches it', () => {
    expect(filterMentionCandidates(MEMBERS, 'Arc').some((c) => c.agentId === undefined)).toBe(false)
  })

  it('is empty when nothing matches at all', () => {
    expect(filterMentionCandidates(MEMBERS, 'zz')).toEqual([])
  })

  it('offers no keyword row for a chat with no members', () => {
    expect(filterMentionCandidates([], '')).toEqual([])
  })
})

describe('insertMention', () => {
  it('replaces the token and leaves the caret past the trailing space', () => {
    const span = extractMentionQuery('@Arc', 4)
    expect(span).not.toBeNull()
    expect(insertMention('@Arc', span!, 'Architect')).toEqual({
      text: '@Architect ',
      caret: 11
    })
  })

  it('keeps the text on both sides of the token', () => {
    const span = extractMentionQuery('hi @An rest', 6)
    expect(insertMention('hi @An rest', span!, 'Ann Lee')).toEqual({
      text: 'hi @Ann Lee rest',
      caret: 12
    })
  })
})

describe('appendMention', () => {
  it('inserts at the caret in an empty box', () => {
    expect(appendMention('', 0, 'Ann')).toEqual({ text: '@Ann ', caret: 5 })
  })

  it('adds a separating space when the caret is on a word character', () => {
    expect(appendMention('hello', 5, 'Ann')).toEqual({ text: 'hello @Ann ', caret: 11 })
  })

  it('adds no second space when the caret already follows one', () => {
    expect(appendMention('hello ', 6, 'Ann')).toEqual({ text: 'hello @Ann ', caret: 11 })
  })

  it('inserts in the middle without duplicating the following space', () => {
    expect(appendMention('a b', 1, 'Ann')).toEqual({ text: 'a @Ann b', caret: 7 })
  })
})
