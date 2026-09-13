/**
 * What the chat's folder looks like, written for a model to read (S5.11).
 *
 * PLAN.md ("Chat goal and workspace") makes the folder readable by **every**
 * member, not only by the executor: participants get the four read-only tools
 * and, so that they know what is there to read, one `Workspace` section in their
 * system prompt. This module builds that section — the folder's name, a bounded
 * tree of what is in it, and for a `codebase` goal the branch and the
 * uncommitted changes.
 *
 * ## Why a tree at all, rather than letting the model call `list_dir`
 *
 * Because the first round is the one that matters. A group asked to discuss a
 * codebase spends its opening turn calling `list_dir` three times and then
 * saying something generic, which is precisely the failure the materials
 * briefing exists to prevent. A 200-entry tree costs a few hundred tokens once
 * per turn and lets every member's first sentence be about the real folder.
 *
 * ## The caps, and why each one is there
 *
 * | Cap | Value | Why |
 * |---|---|---|
 * | Entries | `MAX_TREE_ENTRIES` (200) | A `node_modules`-sized listing would be the whole prompt |
 * | Depth | `MAX_TREE_DEPTH` (3) | Three levels name every source folder of a normal project; the fourth is mostly test fixtures |
 * | File size | `MAX_TREE_FILE_BYTES` (1 MB) | A file that big is a database, a bundle or a recording — never something the group discusses |
 * | Always skipped | `SKIPPED_TREE_DIRS` | `.git` and the build outputs, which are noise in every repository and are frequently *not* in `.gitignore` |
 *
 * ## `.gitignore`, parsed here rather than with a package
 *
 * The `ignore` package is the correct implementation of the format and would
 * have to be installed; this is a hand-written parser for the forms that occur
 * in real root `.gitignore` files — comments, blanks, `!` negation, a trailing
 * `/` for directories, a leading `/` for an anchor, `*`, `?` and `**`. The
 * trade-off is deliberate and narrow: the consequence of getting a rare pattern
 * wrong is a briefing that lists a file it did not have to (or omits one the
 * model can still `read_file`), not a wrong answer or an escaped path — the
 * boundary is `paths.ts`, and nothing here decides what may be read. Nested
 * `.gitignore` files, `.git/info/exclude` and the global excludes file are not
 * read; that limitation is recorded in `docs/features/executor/`.
 *
 * Everything here is a pure function of a folder on disk: no electron, no
 * database, no `AppContext` (CLAUDE.md rule #5).
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { basename, join } from 'node:path'
import type { ChatGoal } from '@shared/types'
import { realWorkdir } from './paths'
import { GIT_DIFF_TOOL, LIST_DIR_TOOL, READ_FILE_TOOL, SEARCH_FILES_TOOL } from './tools'

/** How many entries the tree lists before it stops and says how many are left. */
export const MAX_TREE_ENTRIES = 200

/** How many levels below the folder the tree descends. */
export const MAX_TREE_DEPTH = 3

/** Files at least this large are left out of the tree. */
export const MAX_TREE_FILE_BYTES = 1024 * 1024

/** How many `git status --short` lines the briefing prints. */
export const MAX_STATUS_LINES = 40

/** How long a `git` call may take before the briefing goes without it, in ms. */
const GIT_TIMEOUT_MS = 2_000

/**
 * Directories the tree never descends into, whatever `.gitignore` says.
 *
 * `.git` is the one that matters — it is never in a `.gitignore` and it is
 * thousands of files — and the rest are the build outputs that are usually
 * ignored and occasionally, in a fresh or a sloppy repository, are not.
 */
export const SKIPPED_TREE_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  '.turbo',
  'dist',
  'out',
  'build',
  'target',
  'coverage',
  '.cache'
])

/* -------------------------------------------------------------------------- */
/* .gitignore                                                                  */
/* -------------------------------------------------------------------------- */

/** One parsed `.gitignore` line. The **last** matching rule decides. */
export interface IgnoreRule {
  /** A `!pattern` line: it un-ignores what an earlier rule ignored. */
  negated: boolean
  /** A `pattern/` line: it matches directories only. */
  dirOnly: boolean
  /** Matches a path relative to the folder, with `/` separators and no trailing slash. */
  regex: RegExp
}

/** Escapes one literal character for use inside a regular expression. */
function escapeChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}

/**
 * A glob from a `.gitignore` line, as a regular expression over relative paths.
 *
 * `anchored` distinguishes `/build` and `src/build` (which match from the folder
 * root) from `build` (which matches at any depth) — git's own rule: a pattern
 * containing a slash anywhere but at its end is anchored.
 *
 * The trailing `(?:/.*)?` is what makes ignoring a directory ignore everything
 * under it, which matters for the tree because a pruned folder's children are
 * never visited but a *file* path may still be tested against a folder rule.
 */
function globToRegExp(pattern: string, anchored: boolean): RegExp {
  let body = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          // `**/` matches zero or more leading path segments.
          body += '(?:.*/)?'
          index += 2
        } else {
          body += '.*'
          index += 1
        }
        continue
      }
      body += '[^/]*'
      continue
    }
    if (char === '?') {
      body += '[^/]'
      continue
    }
    body += escapeChar(char)
  }
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}(?:/.*)?$`)
}

/**
 * Parses the forms a root `.gitignore` actually contains.
 *
 * Anything it does not understand becomes a rule that matches nothing rather
 * than a thrown error: this is a listing, and a `.gitignore` with an exotic
 * pattern in it must not stop a chat from being briefed.
 */
export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(/\s+$/, '')
    if (line.length === 0 || line.startsWith('#')) continue

    let negated = false
    if (line.startsWith('!')) {
      negated = true
      line = line.slice(1)
    }
    // An escaped leading `#` or `!`; anything else keeps its backslash.
    if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1)
    if (line.length === 0) continue

    let dirOnly = false
    if (line.endsWith('/')) {
      dirOnly = true
      line = line.slice(0, -1)
    }
    if (line.length === 0) continue

    const anchored = line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)
    if (line.length === 0) continue

    try {
      rules.push({ negated, dirOnly, regex: globToRegExp(line, anchored) })
    } catch {
      continue
    }
  }
  return rules
}

/** Reads the folder's own `.gitignore`, or no rules at all when it has none. */
export function loadIgnoreRules(root: string): IgnoreRule[] {
  try {
    return parseGitignore(readFileSync(join(root, '.gitignore'), 'utf8'))
  } catch {
    return []
  }
}

/**
 * Whether `path` (relative, `/` separators) is ignored. Last match wins, which
 * is what makes `!` work: `dist` then `!dist/keep.md` keeps the second file.
 */
export function isIgnored(
  rules: readonly IgnoreRule[],
  path: string,
  directory: boolean
): boolean {
  let ignored = false
  for (const rule of rules) {
    if (rule.dirOnly && !directory) continue
    if (!rule.regex.test(path)) continue
    ignored = !rule.negated
  }
  return ignored
}

/* -------------------------------------------------------------------------- */
/* The tree                                                                    */
/* -------------------------------------------------------------------------- */

/** One line of the tree: a path relative to the folder, with its depth. */
export interface TreeEntry {
  /** Relative to the folder, `/` separators, never with a trailing slash. */
  path: string
  directory: boolean
  /** 1 for a child of the folder itself. */
  depth: number
}

export interface TreeResult {
  entries: TreeEntry[]
  /** True when the walk stopped at `maxEntries` and there is more on disk. */
  truncated: boolean
}

export interface WalkTreeOptions {
  maxEntries?: number
  maxDepth?: number
  /** Parsed `.gitignore` rules; omitted, the folder's own file is read. */
  rules?: readonly IgnoreRule[]
  /** Largest file the listing mentions. Defaults to `MAX_TREE_FILE_BYTES`. */
  maxFileBytes?: number
}

/**
 * The bounded listing of a folder, depth first, directories before files.
 *
 * Sorted rather than in `readdir` order, because the same folder must produce
 * the same briefing on two machines — a listing that reshuffles between runs is
 * one nobody can diff a prompt against.
 */
export function walkTree(root: string, options: WalkTreeOptions = {}): TreeResult {
  const maxEntries = options.maxEntries ?? MAX_TREE_ENTRIES
  const maxDepth = options.maxDepth ?? MAX_TREE_DEPTH
  const maxFileBytes = options.maxFileBytes ?? MAX_TREE_FILE_BYTES
  const rules = options.rules ?? loadIgnoreRules(root)

  const entries: TreeEntry[] = []
  let truncated = false

  const walk = (directory: string, prefix: string, depth: number): void => {
    if (depth > maxDepth || truncated) return
    let found: Dirent[]
    try {
      found = readdirSync(directory, { withFileTypes: true })
    } catch {
      // An unreadable folder is a gap in the listing, not a failed briefing.
      return
    }
    const sorted = found
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1
        return left.name.localeCompare(right.name)
      })

    for (const entry of sorted) {
      if (truncated) return
      const isDirectory = entry.isDirectory()
      if (isDirectory && SKIPPED_TREE_DIRS.has(entry.name)) continue
      const relativePath = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name
      if (isIgnored(rules, relativePath, isDirectory)) continue

      const absolute = join(directory, entry.name)
      if (!isDirectory) {
        try {
          if (statSync(absolute).size > maxFileBytes) continue
        } catch {
          continue
        }
      }

      if (entries.length >= maxEntries) {
        truncated = true
        return
      }
      entries.push({ path: relativePath, directory: isDirectory, depth })
      if (isDirectory) walk(absolute, relativePath, depth + 1)
    }
  }

  walk(root, '', 1)
  return { entries, truncated }
}

/** The tree as indented lines, directories marked with a trailing slash. */
export function formatTree(result: TreeResult): string {
  const lines = result.entries.map((entry) => {
    const name = entry.path.slice(entry.path.lastIndexOf('/') + 1)
    return `${'  '.repeat(entry.depth - 1)}${name}${entry.directory ? '/' : ''}`
  })
  if (result.truncated) {
    lines.push(`… (only the first ${result.entries.length} entries are listed)`)
  }
  return lines.join('\n')
}

/* -------------------------------------------------------------------------- */
/* git                                                                         */
/* -------------------------------------------------------------------------- */

/** The branch and the uncommitted changes, when the folder is a repository. */
export interface GitInfo {
  branch: string | null
  /** `git status --short` lines, capped at `MAX_STATUS_LINES`. */
  status: string[]
  /** True when there were more status lines than the cap. */
  statusTruncated: boolean
}

/** One `git` invocation in the folder, or `null` when it failed for any reason. */
function git(workdir: string, args: string[]): string | null {
  try {
    const result = spawnSync('git', ['-C', workdir, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      // The briefing is worth a fraction of a second, never a hung turn.
      windowsHide: true
    })
    if (result.error || result.status !== 0) return null
    return result.stdout
  } catch {
    return null
  }
}

/**
 * The branch and working-tree state, or `null` when the folder is not a git
 * repository — or when `git` is not installed, which is the same answer as far
 * as the briefing is concerned.
 */
export function gitInfo(workdir: string): GitInfo | null {
  const inside = git(workdir, ['rev-parse', '--is-inside-work-tree'])
  if (inside === null || inside.trim() !== 'true') return null

  const branchOutput = git(workdir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  // A repository with no commits yet answers nothing useful here; `symbolic-ref`
  // still knows which branch the first commit will land on.
  const branch =
    branchOutput && branchOutput.trim().length > 0 && branchOutput.trim() !== 'HEAD'
      ? branchOutput.trim()
      : (git(workdir, ['symbolic-ref', '--short', 'HEAD']) ?? '').trim() || null

  const statusOutput = git(workdir, ['status', '--short']) ?? ''
  const all = statusOutput.split('\n').filter((line) => line.trim().length > 0)
  return {
    branch,
    status: all.slice(0, MAX_STATUS_LINES),
    statusTruncated: all.length > MAX_STATUS_LINES
  }
}

/* -------------------------------------------------------------------------- */
/* The section                                                                 */
/* -------------------------------------------------------------------------- */

export interface WorkspaceSectionInput {
  /** The chat's folder. Resolved to its real path before anything is read. */
  workdir: string
  /** The chat's goal, which decides whether the git state is included. */
  goal?: ChatGoal | null
  /**
   * True when this member is the chat's executor.
   *
   * The executor's own section (`buildExecutorSection`) already lists all seven
   * tools and says which of them ask first, so repeating four of them here would
   * be the same instruction in two wordings. A participant gets the sentence,
   * because nothing else in its prompt says the tools exist.
   */
  executor?: boolean
  /** Injectable for the tests; defaults to the real `git`. */
  readGit?: (workdir: string) => GitInfo | null
}

/**
 * The `Workspace` section of every member's system prompt.
 *
 * Model-facing English, like the group briefing and the executor section: the
 * renderer never sees it, so CLAUDE.md rule #4 does not make it an i18n key.
 *
 * The git half is added for a `codebase` goal only. A `document` or `discussion`
 * chat that happens to sit in a repository does not need to know which branch it
 * is on, and `git status --short` in a working repository is dozens of lines of
 * something nobody asked about.
 */
export function buildWorkspaceSection(input: WorkspaceSectionInput): string {
  const root = realWorkdir(input.workdir)
  const tree = formatTree(walkTree(root))

  const lines = [
    'Workspace',
    '',
    `This chat is bound to the folder ${basename(root)} (${root}).`,
    '',
    `What is in it, at most ${MAX_TREE_ENTRIES} entries and ${MAX_TREE_DEPTH} levels deep, with ignored and generated files left out:`,
    '',
    tree.length > 0 ? tree : '(the folder is empty)'
  ]

  if (input.goal?.kind === 'codebase') {
    const info = (input.readGit ?? gitInfo)(root)
    if (info) {
      lines.push('')
      lines.push(`Git branch: ${info.branch ?? '(detached)'}`)
      if (info.status.length > 0) {
        lines.push('Uncommitted changes (git status --short):')
        lines.push('')
        lines.push(info.status.join('\n'))
        if (info.statusTruncated) lines.push(`… (only the first ${MAX_STATUS_LINES} are listed)`)
      } else {
        lines.push('The working tree is clean.')
      }
    }
  }

  if (input.executor !== true) {
    lines.push('')
    lines.push(
      `You can read this folder — ${READ_FILE_TOOL}(path), ${LIST_DIR_TOOL}(path), ${SEARCH_FILES_TOOL}(query, path) and ${GIT_DIFF_TOOL}(path) — and you cannot change anything in it. Read what you need before you argue about it, and quote what you found. Every change is made afterwards, by this chat's executor.`
    )
  }

  return lines.join('\n')
}
