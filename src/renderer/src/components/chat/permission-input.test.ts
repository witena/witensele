/**
 * What the permission card says about the call it is holding.
 *
 * The case this file exists for is `run_command`: the shell is not sandboxed, so
 * the printed command line is the entire security boundary, and anything that
 * shortened, normalised or prettified it would be a boundary that lies. The rest
 * of the cases are about not guessing — a call whose arguments are not the shape
 * the schema promises falls back to the raw JSON, because that is exactly when
 * the user needs to see what the model really sent.
 */
import { describe, expect, it } from 'vitest'
import type { CommandRisk } from '@shared/types'
import {
  CONTENT_PREVIEW_CHARS,
  describePermissionCard,
  describePermissionInput
} from './permission-input'

describe('describePermissionInput', () => {
  it('shows a command line verbatim, however it is written', () => {
    const command = 'rm -rf ./build  &&  npm run build # rebuild\n echo "done"'
    const view = describePermissionInput('run_command', { command })

    expect(view).toEqual({ kind: 'command', body: command, truncated: false })
  })

  it('never truncates a command, however long it is', () => {
    const command = `echo ${'x'.repeat(CONTENT_PREVIEW_CHARS * 2)}`
    const view = describePermissionInput('run_command', { command })

    expect(view.body).toBe(command)
    expect(view.truncated).toBe(false)
  })

  it('shows the path and the content for a write', () => {
    const view = describePermissionInput('write_file', {
      path: 'docs/NOTES.md',
      content: '# Notes\n'
    })

    expect(view).toEqual({
      path: 'docs/NOTES.md',
      kind: 'content',
      body: '# Notes\n',
      truncated: false
    })
  })

  it('caps a long file body and says that it did', () => {
    const content = 'a'.repeat(CONTENT_PREVIEW_CHARS + 10)
    const view = describePermissionInput('write_file', { path: 'big.txt', content })

    expect(view.body).toHaveLength(CONTENT_PREVIEW_CHARS)
    expect(view.truncated).toBe(true)
  })

  it('keeps an empty file an empty preview rather than raw JSON', () => {
    // `write_file` with an empty string is how a file is emptied, and it must
    // still read as a write of nothing rather than as an unknown shape.
    expect(describePermissionInput('write_file', { path: 'x.txt', content: '' })).toEqual({
      path: 'x.txt',
      kind: 'content',
      body: '',
      truncated: false
    })
  })

  it('shows the patch an edit already computed', () => {
    const patch = '--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-one\n+two\n'
    const view = describePermissionInput('edit_file', { path: 'a.ts', patch })

    expect(view).toEqual({ path: 'a.ts', kind: 'diff', body: patch, truncated: false })
  })

  it('falls back to raw JSON for an MCP tool', () => {
    const view = describePermissionInput('create_issue', { title: 'Bug', labels: ['p1'] })

    expect(view.kind).toBe('json')
    expect(view.path).toBeUndefined()
    expect(JSON.parse(view.body)).toEqual({ title: 'Bug', labels: ['p1'] })
  })

  it('falls back to raw JSON when the arguments are not the promised shape', () => {
    expect(describePermissionInput('run_command', { command: 42 }).kind).toBe('json')
    expect(describePermissionInput('write_file', { path: 'a.txt' }).kind).toBe('json')
    expect(describePermissionInput('edit_file', { path: 'a.txt' }).kind).toBe('json')
    expect(describePermissionInput('write_file', null).kind).toBe('json')
  })
})

describe('describePermissionCard (S5.15)', () => {
  const command = 'git push origin main'
  const dangerous: CommandRisk = { verdict: 'dangerous', reason: 'git-push' }

  it('warns and withholds the grant button for a dangerous command', () => {
    const view = describePermissionCard({ toolName: 'run_command', input: { command }, risk: dangerous })

    expect(view.warn).toBe('git-push')
    // The gate ignores a grant for exactly these calls, so offering one would be
    // a promise the product does not keep.
    expect(view.offersAlwaysAllow).toBe(false)
    // …and the command line is still verbatim.
    expect(view.body).toBe(command)
  })

  it('does neither for a normal command', () => {
    const view = describePermissionCard({
      toolName: 'run_command',
      input: { command: 'npm test' },
      risk: { verdict: 'normal', reason: null }
    })

    expect(view.warn).toBeNull()
    expect(view.offersAlwaysAllow).toBe(true)
  })

  it('does neither for a tool with no verdict at all', () => {
    const view = describePermissionCard({
      toolName: 'write_file',
      input: { path: 'a.md', content: '# a\n' }
    })

    expect(view.warn).toBeNull()
    expect(view.offersAlwaysAllow).toBe(true)
    expect(view.path).toBe('a.md')
  })

  it('fails safe on a blocked verdict, which cannot normally reach a card', () => {
    const view = describePermissionCard({
      toolName: 'run_command',
      input: { command: 'sudo rm -rf /' },
      risk: { verdict: 'blocked', reason: 'privilege-escalation' }
    })

    expect(view.warn).toBe('privilege-escalation')
    expect(view.offersAlwaysAllow).toBe(false)
  })
})
