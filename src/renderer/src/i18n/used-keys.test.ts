/**
 * Guard #2: no hard-coded UI strings, and no key that does not exist.
 *
 * CLAUDE.md rule #4 is the one rule a reviewer forgets first, because a literal
 * in JSX looks perfectly fine in a diff. This test is a *cheap CI guard*, not a
 * compiler: it works on the source text of `src/renderer/src/**`, so it trades
 * completeness for costing nothing and needing no build step.
 *
 * ## What it checks
 *
 * 1. **Every literal key resolves.** `t('a.b')`, `t("a.b")` and `i18nKey="a.b"`
 *    must name a leaf string in `en.json` (the reference file — `locales.test.ts`
 *    separately proves `zh-CN.json` has the same tree). A typo in a key is
 *    otherwise invisible until someone reads the screen in production.
 * 2. **No JSX text node is a literal.** Text that sits between a tag and the next
 *    `<` and contains three or more consecutive Latin letters is a violation.
 *
 * ## The heuristic, and what it costs
 *
 * Before matching, comments and the *contents* of string / template literals are
 * blanked out, so `className="flex h-screen"`, a URL in a comment and a `>` inside
 * a string cannot produce a hit. What remains is scanned with `JSX_TEXT`: an
 * opening or closing tag, then a run of text, then the next `<`. The run may not
 * contain `{` `}` (so `{t('…')}` and `{value}` never match) nor `(` `)` `[` `]`
 * `;` `=` (so `useState<string | null>(null)` and other generic arguments, which
 * also look like `>…<`, do not either).
 *
 * Consequences, accepted on purpose:
 *
 * - Only `.tsx` files are scanned for literals. A string built in a `.ts` helper
 *   and rendered elsewhere slips through; that is what code review is for.
 * - Keys assembled at runtime (`t(option.labelKey)`, `t('notices.' + key)`) are
 *   invisible to check 1. They are rare, and both current cases are covered by
 *   their own unit tests instead.
 * - Hard-coded text containing a bracket or a semicolon escapes check 2, as does
 *   text of fewer than three letters — which is what lets `{a} · {b}` separators
 *   through without an allowlist entry.
 *
 * `ALLOWED_JSX_TEXT` is the escape hatch; it is empty on purpose. Add to it only
 * for text that genuinely must not be translated (a brand mark, a code sample),
 * never to silence a missing translation.
 */
import { describe, expect, it } from 'vitest'
import en from '../locales/en.json'

/**
 * Every renderer source, as text.
 *
 * Vite's raw glob rather than `node:fs`: the renderer project deliberately has no
 * Node types (`tsconfig.web.json` lists only `vite/client`), so a renderer file —
 * test or not — must not import `fs`. The exclusions are the test files
 * themselves and `locales/`, which *is* the strings.
 */
const sources = import.meta.glob<string>(
  ['../**/*.ts', '../**/*.tsx', '!../**/*.test.ts', '!../**/*.test.tsx', '!../locales/**'],
  { query: '?raw', import: 'default', eager: true }
)

/** Exact JSX text nodes that may stay untranslated. Keep this empty if you can. */
const ALLOWED_JSX_TEXT: string[] = []

/**
 * A tag, the text node after it, and the `<` that ends it — the terminator is a
 * lookahead so it can also open the next match. Consuming it would skip every
 * other tag and let `<p>literal</p>` through when a tag preceded it.
 */
const JSX_TEXT = /<\/?[A-Za-z][^<>]*>([^<>{}()[\];=]*)(?=<)/g

/**
 * Blanks out comments and the contents of string / template literals, preserving
 * the delimiters so the remaining source still parses visually. Character by
 * character rather than by regex, because a regex cannot tell a quote inside a
 * comment from a real one.
 */
function stripCommentsAndStrings(source: string): string {
  let out = ''
  let index = 0

  while (index < source.length) {
    const two = source.slice(index, index + 2)

    if (two === '//') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (two === '/*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? source.length : end + 2
      // Keep the newlines so reported line numbers stay usable.
      out += source.slice(index, stop).replace(/[^\n]/g, ' ')
      index = stop
      continue
    }

    const char = source[index] as string
    if (char === '"' || char === "'" || char === '`') {
      out += char
      index += 1
      while (index < source.length && source[index] !== char) {
        if (source[index] === '\\') index += 1
        out += source[index] === '\n' ? '\n' : ' '
        index += 1
      }
      out += char
      index += 1
      continue
    }

    out += char
    index += 1
  }

  return out
}

/** Resolves `a.b.c` in the English tree; returns undefined unless it is a leaf. */
function lookup(key: string): string | undefined {
  let node: unknown = en
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return typeof node === 'string' ? node : undefined
}

interface Finding {
  file: string
  text: string
}

const files = Object.keys(sources).sort()
const usedKeys: Finding[] = []
const jsxLiterals: Finding[] = []

for (const file of files) {
  const name = file.replace(/^\.\.\//, '')
  const source = sources[file] as string
  const stripped = stripCommentsAndStrings(source)

  // Keys: `t('a.b')` / `t("a.b")`, and `<Trans i18nKey="a.b" />`. `\bt\(` cannot
  // match `it(` or `expect(` — the preceding character is a word character there.
  for (const match of source.matchAll(/\bt\(\s*(['"])([^'"]+)\1/g)) {
    usedKeys.push({ file: name, text: match[2] as string })
  }
  for (const match of source.matchAll(/\bi18nKey=(['"])([^'"]+)\1/g)) {
    usedKeys.push({ file: name, text: match[2] as string })
  }

  if (!file.endsWith('.tsx')) continue

  for (const match of stripped.matchAll(JSX_TEXT)) {
    const text = (match[1] as string).trim()
    if (!/[A-Za-z]{3,}/.test(text)) continue
    if (ALLOWED_JSX_TEXT.includes(text)) continue
    jsxLiterals.push({ file: name, text })
  }
}

describe('i18n usage guard', () => {
  it('scans the renderer sources', () => {
    // A refactor that moves or renames the tree must not silently disable the
    // guard by leaving it with nothing to read.
    expect(files.length).toBeGreaterThan(0)
    expect(files.some((file) => file.endsWith('.tsx'))).toBe(true)
    expect(usedKeys.length).toBeGreaterThan(0)
  })

  it('resolves every literal translation key against en.json', () => {
    const missing = usedKeys.filter((used) => lookup(used.text) === undefined)
    expect(missing.map((used) => `${used.file}: t('${used.text}')`)).toEqual([])
  })

  it('finds no hard-coded text in JSX', () => {
    expect(jsxLiterals.map((found) => `${found.file}: ${JSON.stringify(found.text)}`)).toEqual([])
  })
})
