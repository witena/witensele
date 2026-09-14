/**
 * The path detector (S5.7).
 *
 * Weighted towards the *negative* cases on purpose: this function draws a
 * clickable control over model output, so the thing worth proving is what it
 * refuses. A missed path costs the user a copy and paste; a wrong one is a
 * button that opens a file nobody mentioned.
 */
import { describe, expect, it } from 'vitest'
import { absoluteInWorkdir, findFileRefs, splitLineSuffix } from './file-refs'

const WORKDIR = '/Users/ada/code/witena'

/** Just the fields a caller renders, so the cases read as one line each. */
function refs(text: string, workdir: string | null = WORKDIR): { path: string; line?: number }[] {
  return findFileRefs(text, workdir).map((ref) => ({
    path: ref.path,
    ...(ref.line === undefined ? {} : { line: ref.line })
  }))
}

describe('absoluteInWorkdir', () => {
  it('resolves a relative path against the folder', () => {
    expect(absoluteInWorkdir(WORKDIR, 'src/main.ts')).toBe('/Users/ada/code/witena/src/main.ts')
  })

  it('accepts an absolute path that is already inside', () => {
    expect(absoluteInWorkdir(WORKDIR, `${WORKDIR}/src/main.ts`)).toBe(
      '/Users/ada/code/witena/src/main.ts'
    )
  })

  it('refuses an absolute path outside the folder', () => {
    expect(absoluteInWorkdir(WORKDIR, '/etc/passwd')).toBeNull()
  })

  it('refuses a relative path that climbs out', () => {
    expect(absoluteInWorkdir(WORKDIR, '../secrets/key.txt')).toBeNull()
    expect(absoluteInWorkdir(WORKDIR, 'src/../../secrets/key.txt')).toBeNull()
  })

  it('applies . and .. that stay inside', () => {
    expect(absoluteInWorkdir(WORKDIR, './src/../src/main.ts')).toBe(
      '/Users/ada/code/witena/src/main.ts'
    )
  })

  it('does not treat a sibling sharing a prefix as inside', () => {
    expect(absoluteInWorkdir(WORKDIR, '/Users/ada/code/witena-old/a.ts')).toBeNull()
  })

  it('ignores a trailing slash on the folder', () => {
    expect(absoluteInWorkdir(`${WORKDIR}/`, 'a.ts')).toBe('/Users/ada/code/witena/a.ts')
  })

  it('refuses a Windows-looking path whatever the folder is', () => {
    expect(absoluteInWorkdir(WORKDIR, 'C:\\Users\\ada\\a.ts')).toBeNull()
    expect(absoluteInWorkdir(WORKDIR, 'src\\main.ts')).toBeNull()
  })

  it('without a folder keeps an absolute path and refuses a relative one', () => {
    expect(absoluteInWorkdir(null, '/Users/ada/notes.md')).toBe('/Users/ada/notes.md')
    expect(absoluteInWorkdir('', 'src/main.ts')).toBeNull()
  })
})

describe('splitLineSuffix', () => {
  it('splits a trailing line number off', () => {
    expect(splitLineSuffix('src/main.ts:42')).toEqual({ path: 'src/main.ts', line: 42 })
  })

  it('leaves a token with no line alone', () => {
    expect(splitLineSuffix('src/main.ts')).toEqual({ path: 'src/main.ts' })
  })

  it('takes only the last colon-number group', () => {
    expect(splitLineSuffix('src/main.ts:42:7')).toEqual({ path: 'src/main.ts:42', line: 7 })
  })
})

describe('findFileRefs', () => {
  it('finds a relative path with a line', () => {
    expect(refs('I changed src/main/index.ts:42 to fix it')).toEqual([
      { path: 'src/main/index.ts', line: 42 }
    ])
  })

  it('finds a bare path with no line', () => {
    expect(refs('see docs/README.md for the rest')).toEqual([{ path: 'docs/README.md' }])
  })

  it('finds an absolute path inside the folder', () => {
    expect(refs(`the failure is in ${WORKDIR}/src/a.ts:9`)).toEqual([
      { path: `${WORKDIR}/src/a.ts`, line: 9 }
    ])
  })

  it('reports the absolute path for every match, relative or not', () => {
    const found = findFileRefs('src/a.ts:1 and /Users/ada/code/witena/src/b.ts', WORKDIR)

    expect(found.map((ref) => ref.absolute)).toEqual([
      '/Users/ada/code/witena/src/a.ts',
      '/Users/ada/code/witena/src/b.ts'
    ])
  })

  it('ignores a path that resolves outside the folder', () => {
    expect(refs('do not open /etc/passwd:1 please')).toEqual([])
    expect(refs('nor ../../secrets/key.txt')).toEqual([])
  })

  it('ignores a URL, including one whose tail looks like a path and a line', () => {
    expect(refs('see https://example.com/src/main.ts:42 for context')).toEqual([])
    expect(refs('http://localhost:5173/src/app.tsx')).toEqual([])
  })

  it('ignores a version number that is shaped like path:line', () => {
    expect(refs('pinned at 1.2:3 for now')).toEqual([])
    expect(refs('upgrade to v1.2.3 first')).toEqual([])
  })

  it('ignores a Windows-looking token', () => {
    expect(refs('on Windows it is C:\\Users\\ada\\a.ts')).toEqual([])
    expect(refs('src\\main.ts is the other spelling')).toEqual([])
  })

  it('ignores prose that happens to contain a slash', () => {
    expect(refs('the read/write split, and input/output too')).toEqual([])
  })

  it('ignores a token that is a scheme rather than a path', () => {
    expect(refs('write to someone@example.com or mailto:someone@example.com')).toEqual([])
  })

  it('strips the punctuation a path picks up from the sentence', () => {
    expect(refs('I edited (src/main.ts:12), then docs/PLAN.md.')).toEqual([
      { path: 'src/main.ts', line: 12 },
      { path: 'docs/PLAN.md' }
    ])
    expect(refs('in `src/a.ts` and "docs/b.md"')).toEqual([
      { path: 'src/a.ts' },
      { path: 'docs/b.md' }
    ])
  })

  it('reports the offsets of the trimmed token, not the raw one', () => {
    const text = '(src/main.ts:12)'
    const [found] = findFileRefs(text, WORKDIR)

    expect(text.slice(found?.start ?? 0, found?.end ?? 0)).toBe('src/main.ts:12')
  })

  it('finds every reference in a line, in order', () => {
    expect(refs('src/a.ts:1 then src/b.ts:2 then src/c.ts')).toEqual([
      { path: 'src/a.ts', line: 1 },
      { path: 'src/b.ts', line: 2 },
      { path: 'src/c.ts' }
    ])
  })

  it('finds nothing at all when the chat has no folder', () => {
    expect(refs('src/main.ts:42', null)).toEqual([])
    expect(refs('/Users/ada/notes.md', '')).toEqual([])
  })

  it('has no opinion about whether the file exists', () => {
    // The renderer cannot stat anything, and a chip on a file that was deleted
    // last week opens an empty buffer rather than doing nothing.
    expect(refs('deleted src/gone.ts:3 yesterday')).toEqual([{ path: 'src/gone.ts', line: 3 }])
  })

  it('does not chip a bare extensionless name', () => {
    // The documented cost of the extension rule: `Makefile` is a real file and
    // is never a chip, because `and/or` must not be one either.
    expect(refs('run Makefile and LICENSE')).toEqual([])
  })
})
