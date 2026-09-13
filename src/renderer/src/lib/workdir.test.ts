import { describe, expect, it } from 'vitest'
import { folderName, relativeToWorkdir } from './workdir'

describe('folderName', () => {
  it('returns the last segment of an absolute path', () => {
    expect(folderName('/Users/ada/code/witena')).toBe('witena')
  })

  it('ignores trailing separators', () => {
    expect(folderName('/Users/ada/code/witena/')).toBe('witena')
    expect(folderName('/Users/ada/code/witena///')).toBe('witena')
  })

  it('handles Windows separators, because the path is stored and not re-derived', () => {
    expect(folderName('C:\\Users\\ada\\witena')).toBe('witena')
    expect(folderName('C:\\Users\\ada\\witena\\')).toBe('witena')
  })

  it('prints the filesystem root as itself rather than as an empty chip', () => {
    expect(folderName('/')).toBe('/')
  })

  it('returns a bare name unchanged', () => {
    expect(folderName('witena')).toBe('witena')
  })

  it('keeps a folder name containing a dot or a space', () => {
    expect(folderName('/Users/ada/My Projects/v1.2')).toBe('v1.2')
  })
})

describe('relativeToWorkdir', () => {
  it('turns a dialog path into the relative path a goal stores', () => {
    expect(relativeToWorkdir('/Users/ada/code/witena', '/Users/ada/code/witena/docs/plan.md')).toBe(
      'docs/plan.md'
    )
    expect(relativeToWorkdir('/Users/ada/code/witena', '/Users/ada/code/witena/README.md')).toBe(
      'README.md'
    )
  })

  it('refuses a path outside the folder, which is where that refusal is discovered', () => {
    // No dialog on any platform this runs on can be confined to a directory, so
    // this conversion is the only place the pick can be rejected.
    expect(relativeToWorkdir('/Users/ada/code/witena', '/Users/ada/notes.md')).toBeNull()
    expect(relativeToWorkdir('/Users/ada/code/witena', '/etc/passwd')).toBeNull()
  })

  it('is not fooled by a sibling folder whose name starts with the same characters', () => {
    expect(relativeToWorkdir('/w/app', '/w/app-old/a.md')).toBeNull()
    expect(relativeToWorkdir('/w/app', '/w/app/a.md')).toBe('a.md')
  })

  it('refuses the folder itself: a goal names things in the folder, never the folder', () => {
    expect(relativeToWorkdir('/w/app', '/w/app')).toBeNull()
    expect(relativeToWorkdir('/w/app', '/w/app/')).toBeNull()
  })

  it('answers null when the chat is bound to nothing', () => {
    expect(relativeToWorkdir(null, '/w/a.md')).toBeNull()
    expect(relativeToWorkdir(undefined, '/w/a.md')).toBeNull()
    expect(relativeToWorkdir('', '/w/a.md')).toBeNull()
  })

  it('tolerates a trailing separator on the folder and normalises Windows ones', () => {
    expect(relativeToWorkdir('/w/app/', '/w/app/docs/a.md')).toBe('docs/a.md')
    expect(relativeToWorkdir('C:\\w\\app', 'C:\\w\\app\\docs\\a.md')).toBe('docs/a.md')
  })
})
