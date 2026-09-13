/**
 * `@mention` parsing, rule by rule.
 *
 * This is the unit test PLAN's test gate names first ("@mention parsing"),
 * because every scheduling decision downstream is built on its output and none
 * of the interesting cases — a name with a space, a Chinese name, `@Anna` next
 * to a member called `Ann` — can be observed from a live run without reading a
 * model's mind.
 *
 * The Chinese fixture names are written as `\u` escapes on purpose: CLAUDE.md
 * rule #1 keeps CJK out of every committed file except `zh-CN.json` and
 * `briefing.zh-CN.ts`.
 */
import { describe, expect, it } from 'vitest'
import { findMentions, parseMentions, splitMentions, type MentionMember } from './mentions'

/** `\u5c0f\u660e` is a two-character Chinese given name. */
const XIAO_MING = '\u5c0f\u660e'
/** `\u5c0f\u660e\u4e3d` is the same name plus one character, for longest-match. */
const XIAO_MING_LI = '\u5c0f\u660e\u4e3d'

const member = (agentId: string, name: string): MentionMember => ({ agentId, name })

const ANN = member('ann', 'Ann')
const ANN_LEE = member('ann-lee', 'Ann Lee')
const ARCHITECT = member('arch', 'Architect')
const REVIEWER = member('rev', 'Reviewer')

describe('parseMentions', () => {
  it('finds a plain ASCII name', () => {
    expect(parseMentions('@Architect what do you think?', [ARCHITECT, REVIEWER])).toEqual(['arch'])
  })

  it('returns nothing when no member is named', () => {
    expect(parseMentions('No mentions here at all.', [ARCHITECT])).toEqual([])
    expect(parseMentions('', [ARCHITECT])).toEqual([])
  })

  it('matches names that contain spaces', () => {
    expect(parseMentions('thanks @Ann Lee, noted', [ANN_LEE, ARCHITECT])).toEqual(['ann-lee'])
  })

  it('prefers the longest matching name', () => {
    // Both members match at the same `@`; the longer name has to win, or an
    // agent can never be addressed once a colleague's name is a prefix of it.
    expect(parseMentions('@Ann Lee please review', [ANN, ANN_LEE])).toEqual(['ann-lee'])
    // …and the short one still matches when the long one does not.
    expect(parseMentions('@Ann please review', [ANN, ANN_LEE])).toEqual(['ann'])
  })

  it('is case-insensitive', () => {
    expect(parseMentions('@architect and @REVIEWER', [ARCHITECT, REVIEWER])).toEqual([
      'arch',
      'rev'
    ])
  })

  it('requires a word boundary after an ASCII name', () => {
    expect(parseMentions('@Anna is someone else', [ANN])).toEqual([])
    expect(parseMentions('@Ann_Lee is someone else', [ANN])).toEqual([])
    // Punctuation is a boundary, so the common cases still match.
    for (const text of ['@Ann.', '@Ann, hello', '(@Ann)', 'hey @Ann']) {
      expect(parseMentions(text, [ANN])).toEqual(['ann'])
    }
  })

  it('matches a CJK name on any boundary', () => {
    const members = [member('xm', XIAO_MING), ARCHITECT]
    expect(parseMentions(`@${XIAO_MING}\u4f60\u597d`, members)).toEqual(['xm'])
    expect(parseMentions(`@${XIAO_MING}`, members)).toEqual(['xm'])
  })

  it('still prefers the longest CJK name', () => {
    const members = [member('xm', XIAO_MING), member('xml', XIAO_MING_LI)]
    expect(parseMentions(`@${XIAO_MING_LI}`, members)).toEqual(['xml'])
  })

  it('deduplicates and keeps the order of first appearance', () => {
    expect(
      parseMentions('@Reviewer then @Architect then @Reviewer again', [ARCHITECT, REVIEWER])
    ).toEqual(['rev', 'arch'])
  })

  it('expands @all and @everyone to every member', () => {
    expect(parseMentions('@all thoughts?', [ARCHITECT, REVIEWER])).toEqual(['arch', 'rev'])
    expect(parseMentions('@everyone thoughts?', [ARCHITECT, REVIEWER])).toEqual(['arch', 'rev'])
    expect(parseMentions('@ALL thoughts?', [ARCHITECT, REVIEWER])).toEqual(['arch', 'rev'])
  })

  it('lets a member named "all" win over the keyword', () => {
    const all = member('all-agent', 'all')
    expect(parseMentions('@all please', [ARCHITECT, all])).toEqual(['all-agent'])
  })

  it('ignores an @ that follows a word character', () => {
    expect(parseMentions('write to ann@Architect.example', [ARCHITECT])).toEqual([])
  })

  it('ignores a name that is not a member of this chat', () => {
    expect(parseMentions('@Reviewer over to you', [ARCHITECT])).toEqual([])
  })

  it('finds several mentions in one text', () => {
    expect(parseMentions('@Architect and @Ann Lee, compare notes', [ARCHITECT, ANN_LEE])).toEqual([
      'arch',
      'ann-lee'
    ])
  })
})

describe('findMentions', () => {
  it('reports the span of every token', () => {
    expect(findMentions('hi @Ann!', [ANN])).toEqual([{ start: 3, end: 7, agentIds: ['ann'] }])
  })
})

describe('splitMentions', () => {
  it('splits a text into plain pieces and mention tokens', () => {
    expect(splitMentions('hi @Ann, ok?', [ANN])).toEqual([
      { text: 'hi ' },
      { text: '@Ann', agentIds: ['ann'] },
      { text: ', ok?' }
    ])
  })

  it('returns one plain piece when nothing matches', () => {
    expect(splitMentions('nothing here', [ANN])).toEqual([{ text: 'nothing here' }])
    expect(splitMentions('', [ANN])).toEqual([])
  })

  it('handles a mention at the very start and end', () => {
    expect(splitMentions('@Ann', [ANN])).toEqual([{ text: '@Ann', agentIds: ['ann'] }])
  })
})
