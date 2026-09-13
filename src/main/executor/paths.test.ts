/**
 * Path confinement against a real temporary directory.
 *
 * Nothing is mocked, for the same reason `skills/loader.test.ts` mocks nothing:
 * the module exists to answer questions about the filesystem, and a fake
 * filesystem would answer the question the fake was written to answer. Every
 * case below is a security assertion — an executor's paths come from a language
 * model — so each names the specific escape it closes rather than asserting that
 * "some error happens".
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatGoal } from '@shared/types'
import { deliverablePath, isInside, realPathOf, realWorkdir, resolveInWorkdir } from './paths'

let root: string
let workdir: string
let outside: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'witena-paths-'))
  workdir = join(root, 'project')
  outside = join(root, 'secrets')
  mkdirSync(workdir, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(workdir, 'README.md'), '# Project\n', 'utf8')
  writeFileSync(join(outside, 'key.txt'), 'hunter2\n', 'utf8')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveInWorkdir', () => {
  it('resolves a relative path inside the folder', () => {
    const resolved = resolveInWorkdir(workdir, 'README.md')
    expect(resolved.relative).toBe('README.md')
    expect(resolved.absolute).toBe(join(realWorkdir(workdir), 'README.md'))
  })

  it('resolves nested paths and normalises them', () => {
    expect(resolveInWorkdir(workdir, './src/../README.md').relative).toBe('README.md')
  })

  it('treats an empty path as the folder itself', () => {
    expect(resolveInWorkdir(workdir, '').relative).toBe('.')
    expect(resolveInWorkdir(workdir, undefined).relative).toBe('.')
  })

  it('refuses a path that climbs out with ..', () => {
    expect(() => resolveInWorkdir(workdir, '../secrets/key.txt')).toThrow(
      /outside the working directory/
    )
  })

  it('refuses a path that climbs out and back through a sibling name', () => {
    expect(() => resolveInWorkdir(workdir, '../project-other/file')).toThrow(
      /outside the working directory/
    )
  })

  it('refuses an absolute path outside the folder', () => {
    expect(() => resolveInWorkdir(workdir, join(outside, 'key.txt'))).toThrow(
      /outside the working directory/
    )
    expect(() => resolveInWorkdir(workdir, '/etc/passwd')).toThrow(/outside the working directory/)
  })

  it('accepts an absolute path that is inside the folder', () => {
    // Unlike `skills/loader.ts`, which refuses every absolute path: an executor
    // is told its folder and reads absolute paths out of compiler output.
    const absolute = join(realWorkdir(workdir), 'README.md')
    expect(resolveInWorkdir(workdir, absolute).relative).toBe('README.md')
  })

  it('refuses reading through a symlink whose target leaves the folder', () => {
    symlinkSync(outside, join(workdir, 'escape'))
    expect(() => resolveInWorkdir(workdir, 'escape/key.txt')).toThrow(
      /outside the working directory/
    )
  })

  it('refuses a symlink to a single file outside the folder', () => {
    symlinkSync(join(outside, 'key.txt'), join(workdir, 'key-link.txt'))
    expect(() => resolveInWorkdir(workdir, 'key-link.txt')).toThrow(
      /outside the working directory/
    )
  })

  it('refuses writing a NEW file through a symlinked directory', () => {
    // The case a naive implementation misses: the target does not exist yet, so
    // realpathing *it* proves nothing — only its nearest existing ancestor does.
    symlinkSync(outside, join(workdir, 'escape'))
    expect(() => resolveInWorkdir(workdir, 'escape/new-file.txt')).toThrow(
      /outside the working directory/
    )
  })

  it('accepts a path that does not exist yet inside the folder', () => {
    const resolved = resolveInWorkdir(workdir, 'src/deep/new-file.ts')
    expect(resolved.relative).toBe(join('src', 'deep', 'new-file.ts'))
  })

  it('accepts a symlink that stays inside the folder', () => {
    mkdirSync(join(workdir, 'src'))
    writeFileSync(join(workdir, 'src', 'index.ts'), 'export {}\n', 'utf8')
    symlinkSync(join(workdir, 'src'), join(workdir, 'lib'))
    // Reported as the caller spelled it, not as its realpath: the link is inside
    // the folder, so the path the model used is the one the diff should name.
    expect(resolveInWorkdir(workdir, 'lib/index.ts').relative).toBe(join('lib', 'index.ts'))
  })

  it('refuses when the working directory itself is gone', () => {
    rmSync(workdir, { recursive: true, force: true })
    expect(() => resolveInWorkdir(workdir, 'README.md')).toThrow(/no longer exists/)
  })

  it('refuses when the chat has no working directory at all', () => {
    expect(() => resolveInWorkdir('', 'README.md')).toThrow(/no working directory/)
  })
})

describe('realPathOf', () => {
  it('resolves an existing path through its symlinks', () => {
    symlinkSync(outside, join(workdir, 'escape'))
    expect(realPathOf(join(workdir, 'escape'))).toBe(resolve(realWorkdir(outside)))
  })

  it('resolves the existing ancestor of a path that is not there yet', () => {
    symlinkSync(outside, join(workdir, 'escape'))
    expect(realPathOf(join(workdir, 'escape', 'a', 'b.txt'))).toBe(
      join(realWorkdir(outside), 'a', 'b.txt')
    )
  })
})

describe('isInside', () => {
  it('accepts the root itself and anything under it', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/a/b', '/a/b/c')).toBe(true)
  })

  it('rejects a sibling whose name merely starts with the root', () => {
    expect(isInside('/a/b', '/a/bc')).toBe(false)
    expect(isInside('/a/b', '/a')).toBe(false)
  })
})

/**
 * S5.12: the one place the deliverable's absolute path is computed.
 *
 * Shared by `chats.goalStatus` and by the executor turn that appends the chip,
 * so that the header and the transcript cannot end up naming different files.
 * Unlike everything above it, this one touches no filesystem and refuses
 * nothing: the goal's paths were confined when they were saved.
 */
describe('deliverablePath', () => {
  const goal = (patch: Partial<ChatGoal> = {}): ChatGoal => ({
    kind: 'document',
    description: 'Write the quarterly report',
    deliverable: 'docs/REPORT.md',
    materials: [],
    ...patch
  })

  it('joins the folder and the relative deliverable', () => {
    expect(deliverablePath(goal(), '/tmp/project')).toBe('/tmp/project/docs/REPORT.md')
  })

  it('answers null for everything that is not a document with a file', () => {
    expect(deliverablePath(null, '/tmp/project')).toBeNull()
    expect(deliverablePath(undefined, '/tmp/project')).toBeNull()
    expect(deliverablePath(goal({ kind: 'discussion' }), '/tmp/project')).toBeNull()
    expect(deliverablePath(goal({ kind: 'codebase' }), '/tmp/project')).toBeNull()
    expect(deliverablePath(goal({ deliverable: '  ' }), '/tmp/project')).toBeNull()
    const { deliverable: _dropped, ...rest } = goal()
    expect(deliverablePath(rest as ChatGoal, '/tmp/project')).toBeNull()
  })

  it('answers null for a chat with no folder, rather than a relative path', () => {
    expect(deliverablePath(goal(), null)).toBeNull()
    expect(deliverablePath(goal(), '')).toBeNull()
  })

  it('does not care whether the file, or the folder, is there', () => {
    // The whole point of a deliverable is that it does not exist yet; and a
    // folder that has since been unmounted answers a path, which the caller
    // then finds is not on disk.
    expect(deliverablePath(goal(), join(root, 'gone'))).toBe(
      join(root, 'gone', 'docs', 'REPORT.md')
    )
  })
})
