/**
 * Per-agent memory: one markdown directory, an index and a note per entry.
 *
 * ```
 * <memoryDir>/<agentId>/MEMORY.md          the index, injected into the prompt
 * <memoryDir>/<agentId>/notes/<slug>.md    one file per remembered thing
 * ```
 *
 * The shape is Claude Code's, and the reason is the same one: the whole index is
 * cheap enough to carry in every system prompt, while the notes it links to are
 * read only when they turn out to matter. An agent therefore *knows what it
 * knows* on every turn without paying for the contents until it needs them.
 *
 * Markdown files rather than database rows, deliberately (PLAN.md, "Memory"):
 * the user can open, edit, diff, back up and delete them with the tools they
 * already have, and a memory the user cannot inspect is one they cannot trust.
 *
 * ## The index format
 *
 * ```md
 * # Memory
 *
 * - [Database choice](notes/database-choice-1a2b3c4d.md) — SQLite via drizzle
 * ```
 *
 * One line per entry: title, the relative path of its note, and a one-line hook.
 * `listEntries` parses exactly that shape, and anything else in the file is left
 * alone — the user may write prose around the list and it survives every save.
 *
 * ## Confinement
 *
 * Every path a caller supplies is resolved inside the agent's own directory
 * (`resolveInside`, shared with the skills loader), so neither a model calling
 * `memory_save` nor the editor can reach another agent's notes, let alone the
 * rest of the disk. No electron, no context: the directory is injected
 * (CLAUDE.md rule #5).
 */
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import matter from 'gray-matter'
import type { MemoryEntry, MemorySearchHit } from '@shared/types'
import { notFound, validation } from '../errors'
import { resolveInside } from '../skills/loader'

/** The index file, relative to an agent's memory directory. */
export const MEMORY_INDEX = 'MEMORY.md'

/** Directory the notes live in, relative to an agent's memory directory. */
export const NOTES_DIR = 'notes'

/** Heading a freshly created index starts with. */
export const MEMORY_HEADING = '# Memory'

/** Longest slug taken from a note title, before the short id is appended. */
const MAX_SLUG_LENGTH = 40

/** How many hits `search` returns. */
export const MAX_SEARCH_HITS = 10

/** Characters of context shown on either side of a match in a snippet. */
const SNIPPET_PADDING = 60

/** Longest hook copied from a note body into its index line. */
const MAX_HOOK_LENGTH = 100

/** One index line: `- [Title](notes/file.md) — hook`. */
const INDEX_LINE = /^\s*[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)(?:\s*[—–-]\s*(.*))?$/

/** What `saveNote` is given. */
export interface MemoryNoteInput {
  title: string
  content: string
}

export interface MemoryStore {
  /** Absolute path of one agent's memory directory. Created on demand by writes. */
  dirFor(agentId: string): string
  /** The whole `MEMORY.md`, or an empty string when nothing has been saved yet. */
  readIndex(agentId: string): string
  /** The index parsed into entries, newest line last, exactly as the file reads. */
  listEntries(agentId: string): MemoryEntry[]
  /** Writes `notes/<slug>-<id>.md` and appends one line to the index. */
  saveNote(agentId: string, note: MemoryNoteInput): MemoryEntry
  /** Case-insensitive substring search over the index and every note body. */
  search(agentId: string, query: string): MemorySearchHit[]
  /** One file's text. `path` is relative; `MEMORY.md` is the index. */
  readNote(agentId: string, path: string): string
  /** Writes one file the editor is showing, index included. */
  writeFile(agentId: string, path: string, content: string): MemoryEntry
  /** Removes one note and its index line; empties the index when given `MEMORY.md`. */
  deleteNote(agentId: string, path: string): void
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A file name from a title.
 *
 * Unicode letters and numbers are kept, so a Chinese title produces a readable
 * file name rather than a row of dashes; everything else collapses to a single
 * dash. An empty result (a title of nothing but punctuation) becomes `note`,
 * because the short id appended afterwards is what actually makes it unique.
 */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : 'note'
}

/** The first non-empty line of a body, trimmed to one index line's worth. */
export function hookOf(content: string): string {
  const line = content
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && !entry.startsWith('#'))
  if (!line) return ''
  const flat = line.replace(/\s+/g, ' ')
  return flat.length > MAX_HOOK_LENGTH ? `${flat.slice(0, MAX_HOOK_LENGTH - 1)}…` : flat
}

/** One index line for an entry. */
function indexLine(title: string, path: string, hook: string): string {
  return hook.length > 0 ? `- [${title}](${path}) — ${hook}` : `- [${title}](${path})`
}

/** A window of `text` around `at`, with ellipses where it was cut. */
function snippetAround(text: string, at: number, length: number): string {
  const start = Math.max(0, at - SNIPPET_PADDING)
  const end = Math.min(text.length, at + length + SNIPPET_PADDING)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

export function createMemoryStore(memoryDir: string): MemoryStore {
  const root = resolve(memoryDir)

  /** The agent's directory, created if this is the first write. */
  const ensureDir = (agentId: string): string => {
    const dir = agentDir(agentId)
    mkdirSync(join(dir, NOTES_DIR), { recursive: true })
    return dir
  }

  /**
   * The agent's directory path, without creating it.
   *
   * The id is validated rather than trusted: it reaches here from an IPC call
   * and would otherwise be a path segment a caller controls.
   */
  const agentDir = (agentId: string): string => {
    if (typeof agentId !== 'string' || agentId.trim().length === 0) {
      throw validation('An agent id is required')
    }
    if (/[\\/]|\.\./.test(agentId)) throw validation('That is not a valid agent id', { agentId })
    return join(root, agentId)
  }

  /** A path inside the agent's directory, or a rejection. Creates nothing. */
  const resolvePath = (agentId: string, path: string): string => {
    const dir = agentDir(agentId)
    // `resolveInside` calls `realpathSync` on the root, which needs it to exist.
    mkdirSync(dir, { recursive: true })
    return resolveInside(dir, path)
  }

  const readIndex = (agentId: string): string => {
    const file = join(agentDir(agentId), MEMORY_INDEX)
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }

  /** `{ title, createdAt }` of one note, from its frontmatter or its mtime. */
  const noteHeader = (agentId: string, path: string): { title?: string; createdAt: number } => {
    try {
      const file = join(agentDir(agentId), path)
      const parsed = matter(readFileSync(file, 'utf8')) as { data: Record<string, unknown> }
      const title = typeof parsed.data['title'] === 'string' ? parsed.data['title'] : undefined
      const createdAt =
        typeof parsed.data['createdAt'] === 'number'
          ? parsed.data['createdAt']
          : statSync(file).mtimeMs
      return { ...(title !== undefined ? { title } : {}), createdAt }
    } catch {
      return { createdAt: 0 }
    }
  }

  const listEntries = (agentId: string): MemoryEntry[] => {
    const entries: MemoryEntry[] = []
    for (const line of readIndex(agentId).split('\n')) {
      const match = INDEX_LINE.exec(line)
      if (!match) continue
      const title = (match[1] as string).trim()
      const path = (match[2] as string).trim()
      // Only the notes directory is linkable: an index line may otherwise point
      // at an http URL, or at a file outside the agent's own folder.
      if (!path.startsWith(`${NOTES_DIR}/`) || path.includes('..')) continue
      entries.push({
        id: path,
        title,
        path,
        createdAt: noteHeader(agentId, path).createdAt
      })
    }
    return entries
  }

  const saveNote = (agentId: string, note: MemoryNoteInput): MemoryEntry => {
    const title = typeof note?.title === 'string' ? note.title.trim() : ''
    const content = typeof note?.content === 'string' ? note.content.trim() : ''
    if (title.length === 0) throw validation('A memory note needs a title')
    if (content.length === 0) throw validation('A memory note needs content')

    const dir = ensureDir(agentId)
    const createdAt = Date.now()

    // The short id is what makes the name unique; the loop is the belt to its
    // braces, because two saves in the same millisecond are entirely possible
    // when several agents answer in parallel.
    let path = ''
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = `${NOTES_DIR}/${slugify(title)}-${randomUUID().slice(0, 8)}.md`
      if (!existsSync(join(dir, candidate))) {
        path = candidate
        break
      }
    }
    if (path.length === 0) throw validation('Could not find a free note file name')

    writeFileSync(
      join(dir, path),
      matter.stringify(`${content}\n`, { title, createdAt }),
      'utf8'
    )

    // Appended, never rewritten: whatever the user has written around the list
    // is theirs, and a save must not reformat a document it did not author. The
    // blank line only appears when the previous line is not already an entry.
    const existing = readIndex(agentId).replace(/\s+$/, '')
    const head = existing.length > 0 ? existing : MEMORY_HEADING
    const separator = INDEX_LINE.test(head.slice(head.lastIndexOf('\n') + 1)) ? '\n' : '\n\n'
    writeFileSync(
      join(dir, MEMORY_INDEX),
      `${head}${separator}${indexLine(title, path, hookOf(content))}\n`,
      'utf8'
    )

    return { id: path, title, path, createdAt }
  }

  const readNote = (agentId: string, path: string): string => {
    const file = resolvePath(agentId, path)
    try {
      return readFileSync(file, 'utf8')
    } catch {
      // The index is allowed not to exist yet: the editor opens it on an agent
      // that has never remembered anything and gets an empty document.
      if (path === MEMORY_INDEX) return ''
      throw notFound('Memory file', path)
    }
  }

  const writeFile = (agentId: string, path: string, content: string): MemoryEntry => {
    if (typeof content !== 'string') throw validation('Memory content must be a string')
    ensureDir(agentId)
    const file = resolvePath(agentId, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content, 'utf8')

    const header = noteHeader(agentId, path)
    return {
      id: path,
      title: header.title ?? path,
      path,
      createdAt: header.createdAt
    }
  }

  const deleteNote = (agentId: string, path: string): void => {
    const file = resolvePath(agentId, path)
    if (path === MEMORY_INDEX) {
      // Deleting the index means "forget everything you have listed"; the notes
      // stay on disk so a mis-click is recoverable by hand.
      writeFileSync(file, `${MEMORY_HEADING}\n`, 'utf8')
      return
    }
    if (!existsSync(file)) throw notFound('Memory file', path)
    rmSync(file, { force: true })

    // The index line would otherwise link to a file that is gone.
    const index = readIndex(agentId)
    if (index.length === 0) return
    const kept = index
      .split('\n')
      .filter((line) => {
        const match = INDEX_LINE.exec(line)
        return match === null || (match[2] as string).trim() !== path
      })
      .join('\n')
    writeFileSync(join(agentDir(agentId), MEMORY_INDEX), kept, 'utf8')
  }

  /** Every note file on disk, whether or not the index mentions it. */
  const noteFiles = (agentId: string): string[] => {
    try {
      return readdirSync(join(agentDir(agentId), NOTES_DIR))
        .filter((name) => name.endsWith('.md') && !name.startsWith('.'))
        .sort()
        .map((name) => `${NOTES_DIR}/${name}`)
    } catch {
      return []
    }
  }

  const search = (agentId: string, query: string): MemorySearchHit[] => {
    const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
    if (needle.length === 0) return []

    const indexed = new Map(listEntries(agentId).map((entry) => [entry.path, entry]))
    const hits: { hit: MemorySearchHit; score: number; createdAt: number }[] = []

    // The index first: a title match is the strongest signal there is, and an
    // index the user wrote prose into is itself worth searching.
    const index = readIndex(agentId)
    const indexAt = index.toLowerCase().indexOf(needle)
    if (indexAt >= 0) {
      hits.push({
        hit: {
          path: MEMORY_INDEX,
          title: MEMORY_INDEX,
          snippet: snippetAround(index, indexAt, needle.length)
        },
        score: 3,
        createdAt: Number.MAX_SAFE_INTEGER
      })
    }

    for (const path of noteFiles(agentId)) {
      let raw: string
      try {
        raw = readFileSync(join(agentDir(agentId), path), 'utf8')
      } catch {
        continue
      }
      const parsed = matter(raw) as { data: Record<string, unknown>; content: string }
      const title =
        (typeof parsed.data['title'] === 'string' ? parsed.data['title'] : undefined) ??
        indexed.get(path)?.title ??
        path
      const createdAt =
        typeof parsed.data['createdAt'] === 'number' ? parsed.data['createdAt'] : 0

      const titleAt = title.toLowerCase().indexOf(needle)
      const bodyAt = parsed.content.toLowerCase().indexOf(needle)
      if (titleAt < 0 && bodyAt < 0) continue

      hits.push({
        hit: {
          path,
          title,
          snippet:
            bodyAt >= 0
              ? snippetAround(parsed.content, bodyAt, needle.length)
              : snippetAround(parsed.content, 0, 0)
        },
        // A title match outranks a body match: a note called "Project name" is a
        // better answer to "project name" than one that mentions it in passing.
        score: titleAt >= 0 ? 2 : 1,
        createdAt
      })
    }

    return hits
      .sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
      .slice(0, MAX_SEARCH_HITS)
      .map((entry) => entry.hit)
  }

  return {
    dirFor: agentDir,
    readIndex,
    listEntries,
    saveNote,
    search,
    readNote,
    writeFile,
    deleteNote
  }
}
