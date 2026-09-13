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
import type { Language } from '@shared/types'
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
