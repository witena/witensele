/**
 * The workspace briefing (S5.11), against real temporary folders.
 *
 * Everything here touches the filesystem on purpose: the walker's whole job is
 * to describe a directory as it is, and a fake `readdirSync` would prove that
 * the code calls it rather than that the listing is right. The `git` cases are
 * skipped, individually, when `git init` does not work on this machine — the
 * briefing already treats a missing `git` as "no repository", and the test is
 * about what it prints when there *is* one.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatGoal } from '@shared/types'
import {
  MAX_STATUS_LINES,
  buildWorkspaceSection,
  formatTree,
  gitInfo,
  isIgnored,
  loadIgnoreRules,
  parseGitignore,
  walkTree,
  type GitInfo
} from './workspace'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'witena-workspace-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Writes a file, creating its parent folders. */
function file(relative: string, content = 'x\n'): void {
  const absolute = join(root, relative)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, content, 'utf8')
}

/** Every path the walk produced, in order. */
function paths(options?: Parameters<typeof walkTree>[1]): string[] {
  return walkTree(root, options).entries.map((entry) => entry.path)
}

describe('walkTree', () => {
  it('lists directories before files, each set sorted', () => {
    file('b.txt')
    file('a.txt')
    file('src/one.ts')
    file('lib/two.ts')

    expect(paths()).toEqual(['lib', 'lib/two.ts', 'src', 'src/one.ts', 'a.txt', 'b.txt'])
  })

  it('stops at maxDepth', () => {
    file('one/two/three/four/deep.txt')

    const listed = paths({ maxDepth: 3 })
    expect(listed).toContain('one/two/three')
    expect(listed.some((path) => path.includes('four'))).toBe(false)
  })

  it('stops at maxEntries and says the listing was cut', () => {
    for (let index = 0; index < 10; index += 1) file(`file-${index}.txt`)

    const result = walkTree(root, { maxEntries: 4 })
    expect(result.entries).toHaveLength(4)
    expect(result.truncated).toBe(true)
    expect(formatTree(result)).toContain('only the first 4 entries')
  })

  it('never descends into .git, node_modules or a build output', () => {
    file('.git/HEAD')
    file('node_modules/left-pad/index.js')
    file('dist/bundle.js')
    file('src/app.ts')

    expect(paths()).toEqual(['src', 'src/app.ts'])
  })

  it('leaves out a file larger than the cap', () => {
    file('small.txt', 'x')
    file('huge.bin', 'y'.repeat(2048))

    expect(paths({ maxFileBytes: 1024 })).toEqual(['small.txt'])
  })

  it('honours the folder\'s own .gitignore', () => {
    file('.gitignore', '# comment\n\nsecrets.env\nlogs/\n*.tmp\n!keep.tmp\n')
    file('secrets.env')
    file('logs/today.log')
    file('scratch.tmp')
    file('keep.tmp')
    file('src/app.ts')

    const listed = paths()
    expect(listed).not.toContain('secrets.env')
    expect(listed).not.toContain('logs')
    expect(listed).not.toContain('scratch.tmp')
    // The negation is the point of "last match wins".
    expect(listed).toContain('keep.tmp')
    expect(listed).toContain('src/app.ts')
    // …and the ignore file itself is not hidden from the group.
    expect(listed).toContain('.gitignore')
  })

  it('reads no .gitignore when the folder has none', () => {
    file('anything.env')

    expect(loadIgnoreRules(root)).toEqual([])
    expect(paths()).toEqual(['anything.env'])
  })
})

describe('parseGitignore', () => {
  const ignored = (patterns: string, path: string, directory = false): boolean =>
    isIgnored(parseGitignore(patterns), path, directory)

  it('skips comments and blank lines', () => {
    expect(parseGitignore('# only a comment\n\n   \n')).toEqual([])
  })

  it('matches a bare name at any depth, and an anchored one only at the root', () => {
    expect(ignored('build', 'build', true)).toBe(true)
    expect(ignored('build', 'src/build', true)).toBe(true)
    expect(ignored('/build', 'build', true)).toBe(true)
    expect(ignored('/build', 'src/build', true)).toBe(false)
  })

  it('applies a trailing slash to directories only', () => {
    expect(ignored('logs/', 'logs', true)).toBe(true)
    expect(ignored('logs/', 'logs', false)).toBe(false)
  })

  it('ignores everything under an ignored directory', () => {
    expect(ignored('logs/', 'logs/today.log', false)).toBe(false)
    // The directory itself is pruned, which is what the walk uses; the path rule
    // is what a caller that tests a file directly gets.
    expect(ignored('logs', 'logs/today.log', false)).toBe(true)
  })

  it('understands *, ? and **', () => {
    expect(ignored('*.log', 'server.log')).toBe(true)
    expect(ignored('*.log', 'var/server.log')).toBe(true)
    expect(ignored('file?.txt', 'file1.txt')).toBe(true)
    expect(ignored('file?.txt', 'file12.txt')).toBe(false)
    expect(ignored('**/generated', 'a/b/generated', true)).toBe(true)
    expect(ignored('src/**/snapshot', 'src/a/b/snapshot', true)).toBe(true)
  })

  it('lets a later rule un-ignore what an earlier one caught', () => {
    expect(ignored('*.tmp\n!keep.tmp', 'keep.tmp')).toBe(false)
    expect(ignored('*.tmp\n!keep.tmp', 'other.tmp')).toBe(true)
  })

  it('treats a pattern it cannot compile as no rule at all', () => {
    // A literal bracket is not a glob this parser supports; it must not throw.
    expect(() => parseGitignore('[unclosed\n')).not.toThrow()
  })
})

describe('gitInfo', () => {
  /** True when `git init` worked here, so the repository cases are meaningful. */
  function initRepository(): boolean {
    const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' })
    if (init.error || init.status !== 0) return false
    spawnSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
    spawnSync('git', ['-C', root, 'config', 'user.name', 'Test'])
    return true
  }

  it('answers null for a folder that is not a repository', () => {
    expect(gitInfo(root)).toBeNull()
  })

  it('names the branch and the uncommitted changes', () => {
    if (!initRepository()) return
    file('README.md')

    const info = gitInfo(root)
    expect(info).not.toBeNull()
    expect(typeof (info as GitInfo).branch).toBe('string')
    expect((info as GitInfo).status.join('\n')).toContain('README.md')
    expect((info as GitInfo).status.length).toBeLessThanOrEqual(MAX_STATUS_LINES)
  })
})

describe('buildWorkspaceSection', () => {
  const goal = (kind: ChatGoal['kind']): ChatGoal => ({
    kind,
    description: 'Do the thing',
    materials: []
  })

  it('names the folder and lists what is in it', () => {
    file('src/app.ts')

    const section = buildWorkspaceSection({ workdir: root })

    expect(section.startsWith('Workspace')).toBe(true)
    expect(section).toContain('src/')
    expect(section).toContain('app.ts')
    expect(section).toContain('read_file(path)')
    expect(section).toContain('you cannot change anything in it')
  })

  it('says the folder is empty rather than printing nothing', () => {
    expect(buildWorkspaceSection({ workdir: root })).toContain('(the folder is empty)')
  })

  it('leaves the read-only sentence out for the executor, which has its own', () => {
    const section = buildWorkspaceSection({ workdir: root, executor: true })

    expect(section).toContain('Workspace')
    expect(section).not.toContain('you cannot change anything in it')
  })

  it('adds the branch and the status for a codebase goal only', () => {
    const readGit = (): GitInfo => ({
      branch: 'feat/parser',
      status: [' M src/app.ts'],
      statusTruncated: false
    })

    const code = buildWorkspaceSection({ workdir: root, goal: goal('codebase'), readGit })
    expect(code).toContain('Git branch: feat/parser')
    expect(code).toContain('M src/app.ts')

    for (const kind of ['discussion', 'document'] as const) {
      const other = buildWorkspaceSection({ workdir: root, goal: goal(kind), readGit })
      expect(other).not.toContain('Git branch')
    }
    expect(buildWorkspaceSection({ workdir: root, readGit })).not.toContain('Git branch')
  })

  it('says a codebase working tree is clean when nothing changed', () => {
    const section = buildWorkspaceSection({
      workdir: root,
      goal: goal('codebase'),
      readGit: () => ({ branch: 'main', status: [], statusTruncated: false })
    })

    expect(section).toContain('The working tree is clean.')
  })

  it('goes without the git half when the folder is not a repository', () => {
    const section = buildWorkspaceSection({
      workdir: root,
      goal: goal('codebase'),
      readGit: () => null
    })

    expect(section).toContain('Workspace')
    expect(section).not.toContain('Git branch')
  })
})
