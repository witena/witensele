import { describe, expect, it } from 'vitest'
import { folderName } from './workdir'

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
