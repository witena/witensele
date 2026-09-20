/**
 * Guard #1: the two locale files stay in step.
 *
 * CLAUDE.md rule #4 says both files are updated together. This test is what makes
 * that a mechanical fact instead of a habit: a key added to one file and not the
 * other fails CI, and so does a placeholder left empty or an English sentence
 * pasted into the Chinese file.
 */
import { describe, expect, it } from 'vitest'
import { AGENT_TEMPLATES } from '@shared/agent-templates'
import { MCP_PRESETS } from '@shared/mcp-presets'
import en from '../locales/en.json'
import zhCN from '../locales/zh-CN.json'

type LocaleTree = { [key: string]: string | LocaleTree }

const english = en as LocaleTree
const chinese = zhCN as LocaleTree

/**
 * The namespaces the plan fixes; changing this list is a deliberate decision.
 *
 * S1.5 removed `smoke`: the throwaway screen it belonged to became Settings →
 * Developer, and its strings moved under `settings.developer.*` where they sit
 * with the rest of that page rather than in a namespace of their own.
 */
const EXPECTED_NAMESPACES = [
  'common',
  'nav',
  'chat',
  'committees',
  'agents',
  'settings',
  'presence',
  'errors',
  'notices'
]

/** Han characters plus the CJK punctuation the Chinese copy uses. */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/

/** Flattens a locale tree into `a.b.c` → value, which is how `t()` addresses it. */
function flatten(tree: LocaleTree, prefix = ''): Map<string, string> {
  const flat = new Map<string, string>()
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') flat.set(path, value)
    else for (const [nested, leaf] of flatten(value, path)) flat.set(nested, leaf)
  }
  return flat
}

const flatEn = flatten(english)
const flatZh = flatten(chinese)

describe('locale files', () => {
  it('declare the same top-level namespaces', () => {
    expect(Object.keys(english).sort()).toEqual([...EXPECTED_NAMESPACES].sort())
    expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort())
  })

  it('have identical key trees', () => {
    // Sorted arrays rather than set arithmetic so a failure prints the diff.
    expect([...flatZh.keys()].sort()).toEqual([...flatEn.keys()].sort())
  })

  it('carry a leaf string for every key in both files', () => {
    expect(flatEn.size).toBeGreaterThan(0)
    for (const [key, value] of flatEn) expect(value.trim(), `en.json ${key}`).not.toBe('')
    for (const [key, value] of flatZh) expect(value.trim(), `zh-CN.json ${key}`).not.toBe('')
  })

  it('keep English free of CJK characters', () => {
    // en.json is a committed English file like any other (CLAUDE.md rule #1):
    // the Chinese name of a language belongs in zh-CN.json, not here.
    for (const [key, value] of flatEn) {
      expect(CJK.test(value), `en.json ${key} contains CJK: ${value}`).toBe(false)
    }
  })

  it('are actually translated rather than a copy of English', () => {
    expect(flatZh).not.toEqual(flatEn)

    // Pragmatic rule: a Chinese value either contains CJK, or is a value that is
    // intentionally identical in both languages — a brand name (`Witena`), a
    // language's endonym (`English`), a symbol (`…`, `—`). Anything else that is
    // pure ASCII is an untranslated string that slipped through.
    for (const [key, value] of flatZh) {
      if (CJK.test(value)) continue
      expect(value, `zh-CN.json ${key} is neither translated nor identical to en.json`).toBe(
        flatEn.get(key)
      )
    }
  })

  it('describe every connector preset in both languages', () => {
    // The gallery looks its description up with a runtime key
    // (`settings.mcp.presets.<id>`), which `used-keys.test.ts` cannot see. This
    // is the check that replaces it: a preset added to `@shared/mcp-presets`
    // without copy would otherwise render its own key on the tile.
    const expected = MCP_PRESETS.map((preset) => `settings.mcp.presets.${preset.id}`).sort()
    const described = (flat: Map<string, string>): string[] =>
      [...flat.keys()].filter((key) => key.startsWith('settings.mcp.presets.')).sort()

    // Both directions: no preset without copy, and no copy left behind by a
    // preset that was renamed or removed.
    expect(described(flatEn)).toEqual(expected)
    expect(described(flatZh)).toEqual(expected)
  })

  it('describes every agent template in both languages', () => {
    // Same shape as the connector presets above, and for the same reason: the
    // first-run card looks a template's description up with a runtime key
    // (`agents.templates.<id>`), which `used-keys.test.ts` cannot see. Both
    // directions, so a template added without copy and copy left behind by a
    // template that was renamed both fail here.
    const expected = AGENT_TEMPLATES.map((template) => `agents.templates.${template.id}`).sort()
    const described = (flat: Map<string, string>): string[] =>
      [...flat.keys()].filter((key) => key.startsWith('agents.templates.')).sort()

    expect(described(flatEn)).toEqual(expected)
    expect(described(flatZh)).toEqual(expected)
  })

  it('use the same interpolation placeholders in both languages', () => {
    const placeholders = (value: string): string[] =>
      [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1] as string).sort()

    for (const [key, value] of flatEn) {
      expect(placeholders(flatZh.get(key) ?? ''), `zh-CN.json ${key}`).toEqual(placeholders(value))
    }
  })
})
