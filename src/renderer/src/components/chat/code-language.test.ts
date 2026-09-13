/**
 * The fence-language mapping.
 *
 * The case that matters is the last one: an unknown language must resolve to
 * `null` so the block renders plain, rather than being guessed at and coloured
 * with the wrong grammar.
 */
import { describe, expect, it } from 'vitest'
import {
  CODE_LANGUAGES,
  codeLanguageLabel,
  LANGUAGE_ALIASES,
  resolveCodeLanguage,
  SHIKI_LANGUAGE
} from './code-language'

describe('resolveCodeLanguage', () => {
  it('resolves every supported id to itself', () => {
    for (const language of CODE_LANGUAGES) expect(resolveCodeLanguage(language)).toBe(language)
  })

  it('resolves the aliases models actually write', () => {
    expect(resolveCodeLanguage('typescript')).toBe('ts')
    expect(resolveCodeLanguage('py')).toBe('python')
    expect(resolveCodeLanguage('sh')).toBe('bash')
    expect(resolveCodeLanguage('yml')).toBe('yaml')
    expect(resolveCodeLanguage('jsx')).toBe('tsx')
  })

  it('is case-insensitive', () => {
    expect(resolveCodeLanguage('TypeScript')).toBe('ts')
    expect(resolveCodeLanguage('JSON')).toBe('json')
  })

  it('reads only the first word of the info string', () => {
    expect(resolveCodeLanguage('ts title="a.ts"')).toBe('ts')
    expect(resolveCodeLanguage('python {1,3}')).toBe('python')
  })

  it('is null for an unknown, empty or absent language', () => {
    expect(resolveCodeLanguage('haskell')).toBeNull()
    expect(resolveCodeLanguage('')).toBeNull()
    expect(resolveCodeLanguage('   ')).toBeNull()
    expect(resolveCodeLanguage(undefined)).toBeNull()
    expect(resolveCodeLanguage(null)).toBeNull()
  })
})

describe('codeLanguageLabel', () => {
  it('prints the resolved id, so ts and typescript look the same', () => {
    expect(codeLanguageLabel('typescript')).toBe('ts')
    expect(codeLanguageLabel('ts')).toBe('ts')
  })

  it('falls back to the raw word for an unhighlighted language', () => {
    expect(codeLanguageLabel('Haskell')).toBe('haskell')
  })

  it('is empty when the fence carried no language', () => {
    expect(codeLanguageLabel(undefined)).toBe('')
    expect(codeLanguageLabel('')).toBe('')
  })
})

describe('the grammar table', () => {
  it('names a shiki grammar for every supported language', () => {
    for (const language of CODE_LANGUAGES) {
      expect(SHIKI_LANGUAGE[language], language).toBeTruthy()
    }
    expect(Object.keys(SHIKI_LANGUAGE).sort()).toEqual([...CODE_LANGUAGES].sort())
  })

  it('maps every alias onto a supported language', () => {
    for (const [alias, target] of Object.entries(LANGUAGE_ALIASES)) {
      expect(CODE_LANGUAGES, alias).toContain(target)
    }
  })

  it('never lists an alias that is already a supported id', () => {
    for (const alias of Object.keys(LANGUAGE_ALIASES)) {
      expect(CODE_LANGUAGES, alias).not.toContain(alias)
    }
  })
})
