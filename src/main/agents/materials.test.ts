/**
 * The materials section (S5.11): what is inlined, what is listed, and where the
 * line between the two falls.
 *
 * The budget is driven with a deliberately tiny `contextWindow` rather than with
 * enormous fixture files, so a case reads as "this much room, these files" and
 * the assertions are about the rule rather than about how many bytes of Lorem
 * ipsum somebody pasted.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { estimateTokens } from './context-budget'
import {
  MATERIALS_BUDGET_SHARE,
  MAX_MATERIAL_FILE_BYTES,
  buildMaterialsSection,
  hasBinaryExtension,
  readMaterialText
} from './materials'

let workdir: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'witena-materials-'))
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

function file(relative: string, content: string | Buffer): void {
  const absolute = join(workdir, relative)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, content)
}

/** A section with room for everything, unless the case says otherwise. */
const build = (materials: string[], contextWindow = 200_000) =>
  buildMaterialsSection({ workdir, materials, contextWindow })

describe('buildMaterialsSection', () => {
  it('is empty for a chat that marked nothing', () => {
    expect(build([])).toMatchObject({ text: '', inlined: [], listed: [], omitted: 0 })
  })

  it('inlines a marked file under its own path', () => {
    file('notes.md', '# Notes\n\nThe decision was X.\n')

    const section = build(['notes.md'])

    expect(section.inlined).toEqual(['notes.md'])
    expect(section.listed).toEqual([])
    expect(section.text).toContain('Materials')
    expect(section.text).toContain('--- notes.md ---')
    expect(section.text).toContain('The decision was X.')
    expect(section.estimatedTokens).toBe(estimateTokens(section.text))
  })

  it('inlines several in the order the user listed them', () => {
    file('one.md', 'first\n')
    file('two.md', 'second\n')

    const section = build(['two.md', 'one.md'])

    expect(section.inlined).toEqual(['two.md', 'one.md'])
    expect(section.text.indexOf('second')).toBeLessThan(section.text.indexOf('first'))
  })

  it('expands a marked folder into its tree and then its files', () => {
    file('spec/a.md', 'alpha\n')
    file('spec/b.md', 'beta\n')

    const section = build(['spec'])

    expect(section.inlined).toEqual(['spec', 'spec/a.md', 'spec/b.md'])
    expect(section.text).toContain('--- spec/ (folder) ---')
    expect(section.text).toContain('alpha')
    expect(section.text).toContain('beta')
  })

  it('lists the rest by path once the budget is spent', () => {
    file('big.md', 'x'.repeat(4_000))
    file('small.md', 'tiny\n')

    // 4 000 narrow characters ≈ 1 000 tokens, and a quarter of 2 000 is 500.
    const section = buildMaterialsSection({ workdir, materials: ['big.md', 'small.md'], contextWindow: 2_000 })

    expect(section.inlined).toEqual([])
    expect(section.listed).toEqual(['big.md', 'small.md'])
    expect(section.omitted).toBe(2)
    expect(section.text).toContain('read_file(path)')
    expect(section.text).toContain('- big.md')
    expect(section.text).not.toContain('xxxx')
  })

  it('inlines what fits before the budget runs out, and lists what follows', () => {
    file('first.md', 'a short one\n')
    file('second.md', 'y'.repeat(8_000))
    file('third.md', 'also short\n')

    const section = buildMaterialsSection({
      workdir,
      materials: ['first.md', 'second.md', 'third.md'],
      contextWindow: 2_000
    })

    expect(section.inlined).toEqual(['first.md'])
    // "The rest", not "whatever else fits": `third.md` would have fitted, and it
    // is listed anyway so the inlined set is a prefix the user can predict.
    expect(section.listed).toEqual(['second.md', 'third.md'])
    expect(section.omitted).toBe(2)
  })

  it('stays inside its share of the window', () => {
    for (let index = 0; index < 20; index += 1) file(`file-${index}.md`, 'z'.repeat(2_000))

    const contextWindow = 8_000
    const section = build(
      Array.from({ length: 20 }, (_, index) => `file-${index}.md`),
      contextWindow
    )

    expect(section.inlined.length).toBeGreaterThan(0)
    expect(section.omitted).toBeGreaterThan(0)
    // The listing itself costs a little on top of the inlined blocks, so the
    // assertion is about the order of magnitude the share fixes, not the byte.
    expect(section.estimatedTokens).toBeLessThan(contextWindow * MATERIALS_BUDGET_SHARE * 2)
  })

  it('never inlines a binary file, whatever the budget is', () => {
    file('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    file('data.bin', Buffer.from([1, 2, 0, 3]))
    file('notes.md', 'readable\n')

    const section = build(['logo.png', 'data.bin', 'notes.md'])

    expect(section.inlined).toEqual(['notes.md'])
    expect(section.listed).toEqual(['logo.png', 'data.bin'])
    expect(section.text).toContain('logo.png (binary, not readable as text)')
    // A binary file does not spend the budget, so what follows it is still inlined.
    expect(section.text).toContain('readable')
  })

  it('drops a material that is no longer on disk rather than listing it', () => {
    file('here.md', 'here\n')

    const section = build(['here.md', 'gone.md'])

    expect(section.inlined).toEqual(['here.md'])
    expect(section.listed).toEqual([])
  })

  it('drops a material that resolves outside the folder', () => {
    const section = build(['../../etc/passwd'])

    expect(section).toMatchObject({ text: '', omitted: 0 })
  })

  it('cuts one enormous file at the per-file cap and marks it', () => {
    file('huge.md', 'q'.repeat(MAX_MATERIAL_FILE_BYTES + 500))

    const section = build(['huge.md'], 1_000_000)

    expect(section.inlined).toEqual(['huge.md'])
    expect(section.text).toContain('… (truncated)')
    expect(section.text.length).toBeLessThan(MAX_MATERIAL_FILE_BYTES + 1_000)
  })
})

describe('binary detection', () => {
  it('knows the extensions that are never text', () => {
    expect(hasBinaryExtension('a/logo.png')).toBe(true)
    expect(hasBinaryExtension('archive.tar.gz')).toBe(true)
    expect(hasBinaryExtension('notes.md')).toBe(false)
    expect(hasBinaryExtension('Makefile')).toBe(false)
    expect(hasBinaryExtension('.gitignore')).toBe(false)
  })

  it('falls back to a null byte in the content', () => {
    file('weird.data', Buffer.from([65, 66, 0, 67]))
    file('fine.data', 'ABC\n')

    expect(readMaterialText(join(workdir, 'weird.data'), 'weird.data')).toBeNull()
    expect(readMaterialText(join(workdir, 'fine.data'), 'fine.data')).toBe('ABC\n')
  })

  it('answers null for a file it cannot read at all', () => {
    expect(readMaterialText(join(workdir, 'missing.md'), 'missing.md')).toBeNull()
  })
})
