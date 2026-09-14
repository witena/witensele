/**
 * `src/main/editor/open.ts`: the two path rules, the two plans, and the quoting.
 *
 * A real temporary directory and a real chat row, because the confinement rule
 * being reused (`resolveInWorkdir`) resolves symlinks through the filesystem —
 * a fake would prove the wrapper, not the rule.
 *
 * The spawn itself is not driven here. `spawnEditorCommand` is four lines whose
 * only interesting half is the command string, and that is what
 * `expandEditorCommand` returns; launching `/bin/sh` from a unit test to watch it
 * do nothing would buy a flake and no coverage.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppContext } from '../app-context'
import { createTestDatabase, type TestDatabase } from '../db/testing'
import { createTestAppContext } from '../testing'
import {
  editorUrl,
  expandEditorCommand,
  planOpenInEditor,
  resolveEditorTarget,
  shellQuote
} from './open'

let database: TestDatabase
let ctx: AppContext
let root: string
let workdir: string
/** A chat bound to `workdir`, and one bound to nothing. */
let boundChatId: string
let looseChatId: string

beforeEach(() => {
  database = createTestDatabase()
  ctx = createTestAppContext(database).ctx

  // Realpathed: on macOS `tmpdir()` is under the `/var` -> `/private/var`
  // symlink, and `resolveInWorkdir` returns the resolved form, so a literal
  // comparison against the unresolved path would fail for the right reason.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'witena-editor-')))
  workdir = join(root, 'project')
  mkdirSync(workdir, { recursive: true })
  mkdirSync(join(workdir, 'src'), { recursive: true })
  writeFileSync(join(workdir, 'src', 'main.ts'), 'export {}\n', 'utf8')
  writeFileSync(join(root, 'outside.ts'), 'export {}\n', 'utf8')

  boundChatId = ctx.repos.chats.create({ title: 'Bound', workdir }, ctx.userId).id
  looseChatId = ctx.repos.chats.create({ title: 'Loose' }, ctx.userId).id
})

afterEach(() => {
  ctx.close()
  rmSync(root, { recursive: true, force: true })
})

describe('resolveEditorTarget', () => {
  it('accepts an absolute path inside the chat folder and keeps the line', () => {
    const target = resolveEditorTarget(ctx, {
      path: join(workdir, 'src', 'main.ts'),
      line: 42,
      chatId: boundChatId
    })

    expect(target).toEqual({ absolute: join(workdir, 'src', 'main.ts'), line: 42 })
  })

  it('refuses a relative path with editor_path_not_absolute', () => {
    expect(() => resolveEditorTarget(ctx, { path: 'src/main.ts', chatId: boundChatId })).toThrow(
      expect.objectContaining({
        code: 'validation',
        details: { reason: 'editor_path_not_absolute' }
      })
    )
  })

  it('refuses an empty path the same way', () => {
    expect(() => resolveEditorTarget(ctx, { path: '   ' })).toThrow(
      expect.objectContaining({ details: { reason: 'editor_path_not_absolute' } })
    )
  })

  it('refuses a path outside the chat folder with editor_path_outside_workdir', () => {
    expect(() =>
      resolveEditorTarget(ctx, { path: join(root, 'outside.ts'), chatId: boundChatId })
    ).toThrow(
      expect.objectContaining({
        code: 'validation',
        details: { reason: 'editor_path_outside_workdir' }
      })
    )
  })

  it('refuses a path that climbs out through ..', () => {
    expect(() =>
      resolveEditorTarget(ctx, { path: join(workdir, '..', 'outside.ts'), chatId: boundChatId })
    ).toThrow(expect.objectContaining({ details: { reason: 'editor_path_outside_workdir' } }))
  })

  it('refuses a symlink inside the folder that points out of it', () => {
    symlinkSync(join(root, 'outside.ts'), join(workdir, 'link.ts'))

    expect(() =>
      resolveEditorTarget(ctx, { path: join(workdir, 'link.ts'), chatId: boundChatId })
    ).toThrow(expect.objectContaining({ details: { reason: 'editor_path_outside_workdir' } }))
  })

  it('allows any absolute path when the chat has no folder', () => {
    expect(
      resolveEditorTarget(ctx, { path: join(root, 'outside.ts'), chatId: looseChatId }).absolute
    ).toBe(join(root, 'outside.ts'))
  })

  it('allows any absolute path when no chat is named at all', () => {
    expect(resolveEditorTarget(ctx, { path: join(root, 'outside.ts') }).absolute).toBe(
      join(root, 'outside.ts')
    )
  })

  it('treats an unknown chat id as no confinement rather than as an error', () => {
    expect(
      resolveEditorTarget(ctx, { path: join(root, 'outside.ts'), chatId: 'gone' }).absolute
    ).toBe(join(root, 'outside.ts'))
  })

  it('refuses a line that is not a positive integer', () => {
    for (const line of [0, -3, 1.5]) {
      expect(() => resolveEditorTarget(ctx, { path: join(workdir, 'src', 'main.ts'), line })).toThrow(
        expect.objectContaining({ code: 'validation' })
      )
    }
  })
})

describe('editorUrl', () => {
  it('builds the vscode and cursor URLs with the line appended', () => {
    const target = { absolute: '/Users/ada/code/a.ts', line: 12 }

    expect(editorUrl('vscode', target)).toBe('vscode://file/Users/ada/code/a.ts:12')
    expect(editorUrl('cursor', target)).toBe('cursor://file/Users/ada/code/a.ts:12')
  })

  it('omits the colon entirely when there is no line', () => {
    expect(editorUrl('vscode', { absolute: '/a/b.ts', line: undefined })).toBe(
      'vscode://file/a/b.ts'
    )
  })

  it('percent-encodes each segment without eating the separators', () => {
    expect(editorUrl('vscode', { absolute: '/Users/ada/My Docs/a b.ts', line: 3 })).toBe(
      'vscode://file/Users/ada/My%20Docs/a%20b.ts:3'
    )
  })
})

describe('expandEditorCommand', () => {
  it('quotes a path containing spaces', () => {
    expect(
      expandEditorCommand('code -g {path}:{line}', {
        absolute: '/Users/ada/My Projects/a.ts',
        line: 7
      })
    ).toBe("code -g '/Users/ada/My Projects/a.ts':7")
  })

  it('substitutes line 1 when the reference carried no line', () => {
    expect(
      expandEditorCommand('code -g {path}:{line}', { absolute: '/a/b.ts', line: undefined })
    ).toBe("code -g '/a/b.ts':1")
  })

  it('escapes a single quote so a filename cannot end the quoting', () => {
    // POSIX sh has no escape inside single quotes, so the only way through is to
    // close, emit an escaped quote, and reopen: `'` becomes `'\\''`.
    expect(shellQuote("/a/it's.ts")).toBe("'/a/it'\\''s.ts'")
    expect(expandEditorCommand('vim {path}', { absolute: "/a/it's.ts", line: undefined })).toBe(
      "vim '/a/it'\\''s.ts'"
    )
  })

  it('leaves a path that would otherwise be a second command inert', () => {
    expect(
      expandEditorCommand('code {path}', { absolute: '/a/notes.md; rm -rf x', line: undefined })
    ).toBe("code '/a/notes.md; rm -rf x'")
  })

  it('substitutes every occurrence of each placeholder', () => {
    expect(
      expandEditorCommand('mine --file {path} --goto {path}:{line}', {
        absolute: '/a/b.ts',
        line: 9
      })
    ).toBe("mine --file '/a/b.ts' --goto '/a/b.ts':9")
  })
})

describe('planOpenInEditor', () => {
  it('plans a vscode URL by default', () => {
    const plan = planOpenInEditor(ctx, {
      path: join(workdir, 'src', 'main.ts'),
      line: 5,
      chatId: boundChatId
    })

    expect(plan.kind).toBe('url')
    expect(plan.kind === 'url' && plan.url).toBe(
      `vscode://file${join(workdir, 'src', 'main.ts')}:5`
    )
  })

  it('plans the cursor URL once the setting says so', () => {
    ctx.repos.settings.update({ editor: { kind: 'cursor' } }, ctx.userId)

    const plan = planOpenInEditor(ctx, { path: join(workdir, 'src', 'main.ts') })

    expect(plan.kind === 'url' && plan.url.startsWith('cursor://file/')).toBe(true)
  })

  it('plans the expanded command line for a custom editor', () => {
    ctx.repos.settings.update(
      { editor: { kind: 'custom', command: 'subl {path}:{line}' } },
      ctx.userId
    )

    const plan = planOpenInEditor(ctx, {
      path: join(workdir, 'src', 'main.ts'),
      line: 3,
      chatId: boundChatId
    })

    expect(plan.kind).toBe('command')
    expect(plan.kind === 'command' && plan.command).toBe(
      `subl '${join(workdir, 'src', 'main.ts')}':3`
    )
  })

  it('applies the path rules before the setting is even read', () => {
    ctx.repos.settings.update({ editor: { kind: 'custom' } }, ctx.userId)

    expect(() =>
      planOpenInEditor(ctx, { path: join(root, 'outside.ts'), chatId: boundChatId })
    ).toThrow(expect.objectContaining({ details: { reason: 'editor_path_outside_workdir' } }))
  })
})
