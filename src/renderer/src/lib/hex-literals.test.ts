/**
 * Guard #3: no colour literals in the renderer.
 *
 * The light theme works because every colour in the app is a `--color-*` token
 * and the palette is swapped by one attribute on `<html>` (S5.8). A literal
 * `#2f3d4a` in a component is therefore not a style choice — it is a pixel that
 * *cannot* follow the appearance, and the only way it is ever noticed is by
 * someone opening that screen in the other theme. S5.17 found two such islands
 * (the agent avatars and the provider logo tiles) after a year of them being
 * described in the backlog as "left alone deliberately"; this test is what stops
 * the third.
 *
 * It is the same kind of cheap text guard as `i18n/used-keys.test.ts`, with the
 * same trade: it reads source text, so it costs nothing and needs no build, and
 * it can be fooled by a colour assembled at runtime. That is what review is for.
 *
 * ## The three exemptions
 *
 * | File | Why |
 * |---|---|
 * | `index.css` | Not scanned at all — it *is* the palette, and the only place a colour may be written down |
 * | `components/ui/brand-mark.tsx` | The mark's terracotta point is an identity rather than a role (S7.1); `--color-brand-point` is the same value in both palettes and `build/icon.svg` has to repeat it, because an SVG on disk cannot read a CSS variable |
 * | `components/agents/agent-display.ts` | The stored-data table: the eight amber-era hexes every pre-S5.17 agent record carries, kept so a stored colour can be mapped back to the palette slot it meant |
 *
 * Nothing else earns one. If a new colour is needed, it is a token with a light
 * override, which is what `theme.test.ts` then holds to account.
 */
import { describe, expect, it } from 'vitest'

/**
 * Every renderer source except the test files, as text.
 *
 * Vite's raw glob rather than `node:fs`, for the reason `used-keys.test.ts`
 * gives: the renderer project has no Node types. Test files are excluded
 * together with `locales/` and `generated/` — a fixture is allowed to name the
 * colour a record used to hold, and this file itself would otherwise be its own
 * first violation.
 */
const sources = import.meta.glob<string>(
  [
    '../**/*.ts',
    '../**/*.tsx',
    '!../**/*.test.ts',
    '!../**/*.test.tsx',
    '!../locales/**',
    '!../generated/**'
  ],
  { query: '?raw', import: 'default', eager: true }
)

/** Files that may contain a colour literal, and the reason is in the table above. */
const EXEMPT = ['components/ui/brand-mark.tsx', 'components/agents/agent-display.ts']

/**
 * `#abc`, `#aabbcc`, `#aabbccdd`.
 *
 * The trailing `\b` plus the alternation ordered longest-first is what keeps
 * `#aabbcc` from also reporting itself as a three-digit match, and what stops
 * the pattern from firing on a character class like `#[0-9a-f]{6}` inside a
 * regular expression — `[` is not a hex digit.
 */
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g

/**
 * Blanks out comments, keeping the newlines so line numbers survive.
 *
 * Only comments, not strings: a colour literal reaches the DOM *as* a string, so
 * blanking strings would blank exactly what this test is looking for. A `#fff`
 * mentioned in prose — `highlighter.ts` explains its choice of shiki theme by
 * quoting that theme's background — is documentation, not a painted pixel.
 */
function stripComments(source: string): string {
  let out = ''
  let index = 0
  while (index < source.length) {
    const two = source.slice(index, index + 2)
    if (two === '//') {
      const end = source.indexOf('\n', index)
      const stop = end === -1 ? source.length : end
      out += ' '.repeat(stop - index)
      index = stop
      continue
    }
    if (two === '/*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? source.length : end + 2
      out += source.slice(index, stop).replace(/[^\n]/g, ' ')
      index = stop
      continue
    }
    out += source[index] as string
    index += 1
  }
  return out
}

interface Finding {
  file: string
  line: number
  text: string
}

const files = Object.keys(sources).sort()
const findings: Finding[] = []

for (const file of files) {
  const name = file.replace(/^\.\.\//, '')
  if (EXEMPT.includes(name)) continue
  const stripped = stripComments(sources[file] as string)
  for (const match of stripped.matchAll(HEX)) {
    const line = stripped.slice(0, match.index).split('\n').length
    findings.push({ file: name, line, text: match[0] as string })
  }
}

describe('the colour-literal guard', () => {
  it('scans the renderer sources', () => {
    // A refactor that moves the tree must not silently turn this into a test
    // that passes by reading nothing.
    expect(files.length).toBeGreaterThan(50)
    expect(files.some((file) => file.endsWith('.tsx'))).toBe(true)
  })

  it('still reads the files it exempts', () => {
    // The exemption list is not allowed to rot into names that no longer exist:
    // a stale entry would quietly stop covering the file that replaced it.
    for (const exempt of EXEMPT) {
      expect(files, exempt).toContain(`../${exempt}`)
    }
  })

  it('finds a colour literal in an exempt file, so the pattern is known to work', () => {
    const table = stripComments(sources['../components/agents/agent-display.ts'] as string)
    expect(table.match(HEX)?.length ?? 0).toBeGreaterThanOrEqual(16)
  })

  it('finds no colour literal anywhere else', () => {
    expect(findings.map((found) => `${found.file}:${found.line}: ${found.text}`)).toEqual([])
  })
})
