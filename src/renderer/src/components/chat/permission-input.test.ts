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
import { CONTENT_PREVIEW_CHARS, describePermissionInput } from './permission-input'

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
