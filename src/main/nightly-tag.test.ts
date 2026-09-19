/**
 * The decisions `scripts/nightly-tag.mjs` makes, without a repository: what the
 * nightly is called, when there is nothing to tag, and which unpublished drafts
 * are deleted. The script's `main()` only gathers refs and carries the decision
 * out.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- a plain `.mjs` script with JSDoc types, not part of either tsconfig
import { decide, nightlyVersion, staleNightlyDrafts } from '../../scripts/nightly-tag.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const date = new Date(Date.UTC(2026, 8, 20, 9, 30))

describe('nightlyVersion', () => {
  it('is the next patch with a UTC date stamp', () => {
    expect(nightlyVersion('0.1.0', date)).toBe('0.1.1-nightly.20260920')
    expect(nightlyVersion('1.9.9', new Date(Date.UTC(2027, 0, 5)))).toBe('1.9.10-nightly.20270105')
  })

  it('sorts above the release it follows and below the one it precedes', () => {
    // Semver: a pre-release of 0.1.1 is newer than 0.1.0 and older than 0.1.1,
    // so a nightly install moves to the stable release when it arrives.
    const nightly = nightlyVersion('0.1.0', date)
    expect(nightly.startsWith('0.1.1-')).toBe(true)
  })

  it('refuses something that is not a version', () => {
    expect(() => nightlyVersion('next', date)).toThrow()
  })
})

describe('decide', () => {
  const base = { mainSha: 'aaa', baseVersion: '0.1.0', date }

  it('tags main when no release points at it', () => {
    expect(decide({ ...base, releaseTags: [{ name: 'v0.1.0', sha: 'old' }] })).toEqual({
      action: 'tag',
      tag: 'v0.1.1-nightly.20260920'
    })
  })

  it('skips when main is already released, stable or nightly', () => {
    expect(decide({ ...base, releaseTags: [{ name: 'v0.1.0', sha: 'aaa' }] }).action).toBe('skip')
    expect(
      decide({ ...base, releaseTags: [{ name: 'v0.1.1-nightly.20260919', sha: 'aaa' }] }).action
    ).toBe('skip')
  })

  it('makes one nightly a day even if main moved again', () => {
    const releaseTags = [{ name: 'v0.1.1-nightly.20260920', sha: 'earlier-today' }]
    expect(decide({ ...base, releaseTags }).action).toBe('skip')
  })
})

describe('staleNightlyDrafts', () => {
  it('keeps the newest drafts and never names a published or a stable release', () => {
    const releases = [
      { tagName: 'v0.1.0', isDraft: true },
      { tagName: 'v0.1.1-nightly.20260916', isDraft: true },
      { tagName: 'v0.1.1-nightly.20260917', isDraft: false },
      { tagName: 'v0.1.1-nightly.20260918', isDraft: true },
      { tagName: 'v0.1.1-nightly.20260919', isDraft: true },
      { tagName: 'v0.1.1-nightly.20260920', isDraft: true }
    ]
    expect(staleNightlyDrafts(releases, 3)).toEqual(['v0.1.1-nightly.20260916'])
    expect(staleNightlyDrafts(releases, 10)).toEqual([])
  })
})

describe('release.yml and the nightly tag agree', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8')

  it('recognises exactly the tag shape the script produces', () => {
    const pattern = /\[\[ "\$tagged" =~ (\S+) \]\]/.exec(workflow)?.[1]
    expect(pattern).toBeDefined()
    // The workflow's pattern is a bash ERE; it is also a valid JS one.
    expect(new RegExp(pattern as string).test(nightlyVersion('0.1.0', date))).toBe(true)
    expect(new RegExp(pattern as string).test('0.2.0')).toBe(false)
  })

  it('refuses a stable tag that does not match package.json', () => {
    expect(workflow).toContain('does not match package.json')
  })

  it('flags a nightly draft as a pre-release so publishing it cannot become "latest"', () => {
    expect(workflow).toMatch(/if: contains\(github\.ref_name, '-nightly\.'\)[\s\S]*gh release edit "\$GITHUB_REF_NAME" --prerelease/)
  })
})
