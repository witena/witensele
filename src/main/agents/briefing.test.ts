/**
 * The group briefing in both languages.
 *
 * The assertions are deliberately about **content rather than wording**: every
 * member has to appear, the agent has to be told which one it is, and the two
 * protocol tokens (`@` and `[PASS]`) have to be present. Asserting the exact
 * sentences would make every prompt improvement a test edit, which is how prompt
 * tests stop being read.
 *
 * The Chinese assertions compare against strings built here from the same data
 * the builder receives (names, `PASS_TOKEN`), so this file itself stays free of
 * Chinese — CLAUDE.md rule #1 exempts only `briefing.zh-CN.ts`.
 */
import { describe, expect, it } from 'vitest'
import type { ChatGoal, Language } from '@shared/types'
import {
  buildGroupBriefing,
  PASS_TOKEN,
  resolveMainLanguage,
  toBriefingMember,
  type BriefingMember
} from './briefing'

const architect: BriefingMember = { name: 'Architect', description: 'Systems thinker' }
const reviewer: BriefingMember = { name: 'Reviewer', description: 'Finds the failure path' }
const quiet: BriefingMember = { name: 'Quiet', description: '' }

const LANGUAGES: Language[] = ['en', 'zh-CN']

describe('buildGroupBriefing', () => {
  for (const language of LANGUAGES) {
    describe(language, () => {
      const briefing = buildGroupBriefing({
        language,
        self: architect,
        members: [architect, reviewer, quiet]
      })

      it('lists every member with its description', () => {
        expect(briefing).toContain(architect.name)
        expect(briefing).toContain(architect.description)
        expect(briefing).toContain(reviewer.name)
        expect(briefing).toContain(reviewer.description)
        // A member with no description still has to be in the roster.
        expect(briefing).toContain(quiet.name)
      })

      it('tells the agent which member it is', () => {
        // The name appears both in the roster and in the "you are" line.
        expect(briefing.split(architect.name).length - 1).toBeGreaterThanOrEqual(2)
      })

      it('explains the [name] prefix protocol', () => {
        expect(briefing).toContain(`[${reviewer.name}]`)
      })

      it('explains @ mentions', () => {
        expect(briefing).toContain(`@${reviewer.name}`)
      })

      it('states the PASS rule', () => {
        expect(briefing).toContain(PASS_TOKEN)
      })
    })
  }

  it('produces different text for the two languages', () => {
    const input = { self: architect, members: [architect, reviewer] }
    expect(buildGroupBriefing({ ...input, language: 'en' })).not.toBe(
      buildGroupBriefing({ ...input, language: 'zh-CN' })
    )
  })

  it('falls back to a roster of one when the member list is empty', () => {
    const briefing = buildGroupBriefing({ language: 'en', self: architect, members: [] })

    expect(briefing).toContain(architect.name)
    expect(briefing).toContain(PASS_TOKEN)
  })
})

/**
 * The goal section (S5.10).
 *
 * Content, not wording, like the rest of this file — with one exception that is
 * the whole point of the feature: the user's **description** has to appear
 * verbatim in every language, because it is the one part of the prompt they
 * wrote themselves.
 */
describe('buildGroupBriefing (goal)', () => {
  const goal = (patch: Partial<ChatGoal> = {}): ChatGoal => ({
    kind: 'discussion',
    description: 'Decide whether to split the runner',
    materials: [],
    ...patch
  })

  const brief = (language: Language, value: ChatGoal | null): string =>
    buildGroupBriefing({ language, self: architect, members: [architect, reviewer], goal: value })

  for (const language of LANGUAGES) {
    describe(language, () => {
      it('says nothing about a goal when the chat has none', () => {
        // A chat with no goal is a discussion nobody bothered to name, and a
        // paragraph explaining that would be prompt spent on nothing.
        expect(brief(language, null)).toBe(
          buildGroupBriefing({ language, self: architect, members: [architect, reviewer] })
        )
      })

      it('carries the description verbatim for every kind', () => {
        expect(brief(language, goal())).toContain(goal().description)
        expect(brief(language, goal({ kind: 'codebase' }))).toContain(goal().description)
        expect(
          brief(language, goal({ kind: 'document', deliverable: 'docs/plan.md' }))
        ).toContain(goal().description)
      })

      it('names the deliverable of a document goal', () => {
        expect(brief(language, goal({ kind: 'document', deliverable: 'docs/plan.md' }))).toContain(
          'docs/plan.md'
        )
      })

      it('tells a codebase chat that the executor makes the change, not them', () => {
        // PLAN.md's one-writer rule is invisible to a participant otherwise, and
        // a model told to change a codebase will write the change out in prose
        // as if it had.
        const codebase = brief(language, goal({ kind: 'codebase' }))
        expect(codebase).toContain('executor')
        expect(brief(language, goal())).not.toContain('executor')
      })

      it('does not name a deliverable a discussion has no business having', () => {
        expect(brief(language, goal())).not.toContain('docs/plan.md')
      })
    })
  }

  it('says it in a different language in each, as the rest of the briefing does', () => {
    expect(brief('en', goal({ kind: 'codebase' }))).not.toBe(
      brief('zh-CN', goal({ kind: 'codebase' }))
    )
  })
})

/**
 * S5.12: the review block, for the round a hand-off schedules after the executor.
 *
 * Content rather than wording again, and the one thing that has to be *placed*
 * rather than merely present: the block comes after the goal, so the sentence
 * that says what to judge the change against is next to the thing it names.
 */
describe('buildGroupBriefing (review)', () => {
  const goal: ChatGoal = {
    kind: 'codebase',
    description: 'Split the runner in two',
    materials: []
  }

  const brief = (language: Language, reviewing: boolean, value: ChatGoal | null = goal): string =>
    buildGroupBriefing({
      language,
      self: reviewer,
      members: [architect, reviewer],
      goal: value,
      reviewing
    })

  for (const language of LANGUAGES) {
    describe(language, () => {
      it('says nothing at all in an ordinary round', () => {
        expect(brief(language, false)).toBe(
          buildGroupBriefing({
            language,
            self: reviewer,
            members: [architect, reviewer],
            goal
          })
        )
      })

      it('adds a block, after the goal, when the round is a review', () => {
        const reviewing = brief(language, true)
        const ordinary = brief(language, false)

        expect(reviewing.length).toBeGreaterThan(ordinary.length)
        expect(reviewing.startsWith(ordinary)).toBe(true)
        // The goal's own text is still the last thing before it, which is what
        // "judge it against the goal above" depends on.
        expect(reviewing).toContain(goal.description)
        expect(reviewing.indexOf(goal.description)).toBeLessThan(ordinary.length)
      })

      it('points a chat with no goal at the conclusion instead', () => {
        // A hand-off in a chat that never set a goal is legal, and a briefing
        // that told the reviewer to judge against "the goal above" would then be
        // pointing at nothing.
        const none = brief(language, true, null)
        expect(none.length).toBeGreaterThan(
          buildGroupBriefing({ language, self: reviewer, members: [architect, reviewer] }).length
        )
      })
    })
  }

  it('names the executor role in English so the reviewer knows whose work it is', () => {
    expect(brief('en', true)).toMatch(/executor of this chat has just changed files/)
    expect(brief('en', true)).toMatch(/judge it against the goal of this chat/)
    expect(brief('en', true, null)).toMatch(/judge it against the conclusion the group reached/)
  })

  it('says it in a different language in each, as the rest of the briefing does', () => {
    expect(brief('en', true)).not.toBe(brief('zh-CN', true))
  })
})

describe('toBriefingMember', () => {
  it('keeps only the name and the description', () => {
    expect(
      toBriefingMember({
        id: 'a1',
        userId: 'local',
        createdAt: 0,
        updatedAt: 0,
        name: 'Ada',
        avatar: { kind: 'initial', text: 'A', color: '#4a3a2f' },
        description: 'Careful',
        systemPrompt: 'You are Ada.',
        providerId: 'p1',
        modelId: 'm1',
        params: {},
        skillNames: [],
        mcpServerIds: [],
        memoryEnabled: false,
        role: 'participant'
      })
    ).toEqual({ name: 'Ada', description: 'Careful' })
  })
})

describe('resolveMainLanguage', () => {
  it('passes a concrete language through', () => {
    expect(resolveMainLanguage('en')).toBe('en')
    expect(resolveMainLanguage('zh-CN')).toBe('zh-CN')
  })

  it('resolves system to one of the two supported languages', () => {
    // The host locale decides which; what matters is that `'system'` never
    // reaches a language module.
    expect(LANGUAGES).toContain(resolveMainLanguage('system'))
  })

  it('agrees with the host locale', () => {
    const locale = new Intl.DateTimeFormat().resolvedOptions().locale
    expect(resolveMainLanguage('system')).toBe(/^zh\b/i.test(locale) ? 'zh-CN' : 'en')
  })
})
