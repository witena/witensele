import { describe, expect, it } from 'vitest'
import { argsToText, envToText, textToArgs, textToEnv } from '../../stores/mcp'
import { canonicalArgs, canonicalEnv, visibleText } from './mcp-text'

/**
 * What the editor does on each keystroke: keep the text, store the normalised
 * value. The tests then ask what the box shows on the render that follows.
 */
function typeArgs(text: string): { typed: string; stored: string } {
  return { typed: text, stored: argsToText(textToArgs(text)) }
}

function typeEnv(text: string): { typed: string; stored: string } {
  return { typed: text, stored: envToText(textToEnv(text)) }
}

describe('visibleText for arguments', () => {
  it('keeps a trailing newline the user has just typed', () => {
    // Enter after `-y`: the draft holds ['-y'], the box must still show the
    // empty second line so the next character lands on it.
    const { typed, stored } = typeArgs('-y\n')
    expect(stored).toBe('-y')
    expect(visibleText(typed, stored, canonicalArgs)).toBe('-y\n')
  })

  it('keeps the two lines once the second argument is typed', () => {
    const { typed, stored } = typeArgs('-y\n@modelcontextprotocol/server-everything')
    expect(visibleText(typed, stored, canonicalArgs)).toBe(typed)
    expect(textToArgs(typed)).toEqual(['-y', '@modelcontextprotocol/server-everything'])
  })

  it('keeps blank lines and surrounding spaces while they are being edited', () => {
    const { typed, stored } = typeArgs('  -y  \n\n\n@scope/pkg\n')
    expect(stored).toBe('-y\n@scope/pkg')
    expect(visibleText(typed, stored, canonicalArgs)).toBe(typed)
  })

  it('keeps an empty box empty', () => {
    expect(visibleText('', argsToText([]), canonicalArgs)).toBe('')
  })

  it('shows the draft when it no longer matches what was typed', () => {
    // The user typed into one server, then opened another: its arguments win.
    const stored = argsToText(['--root', '/Users/me/My Files'])
    expect(visibleText('-y\n', stored, canonicalArgs)).toBe(stored)
  })

  it('shows a fresh draft after "Add" even if the previous text was only whitespace', () => {
    // '  \n' normalises to nothing, and a fresh draft holds nothing — the text
    // is kept, and it is harmless: it is whitespace in an empty box.
    expect(visibleText('  \n', argsToText([]), canonicalArgs)).toBe('  \n')
    // But real text is dropped the moment the draft is replaced by a record.
    expect(visibleText('-y', argsToText(['a']), canonicalArgs)).toBe('a')
  })
})

describe('visibleText for environment', () => {
  it('keeps a variable name that has no "=" yet', () => {
    const { typed, stored } = typeEnv('API_KEY')
    expect(stored).toBe('')
    expect(visibleText(typed, stored, canonicalEnv)).toBe('API_KEY')
  })

  it('keeps a trailing newline after a complete pair', () => {
    const { typed, stored } = typeEnv('API_KEY=abc\n')
    expect(stored).toBe('API_KEY=abc')
    expect(visibleText(typed, stored, canonicalEnv)).toBe('API_KEY=abc\n')
  })

  it('keeps a second pair being typed under a complete one', () => {
    const { typed, stored } = typeEnv('A=1\nB')
    expect(stored).toBe('A=1')
    expect(visibleText(typed, stored, canonicalEnv)).toBe('A=1\nB')
  })

  it('shows the draft when another record was opened', () => {
    const stored = envToText({ TOKEN: 'x=y' })
    expect(visibleText('A=1\nB', stored, canonicalEnv)).toBe('TOKEN=x=y')
  })
})
