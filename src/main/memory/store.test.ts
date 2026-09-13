/**
 * The memory store against a real temporary directory.
 *
 * Like the skills loader's suite, nothing is mocked: the feature *is* the files,
 * so the cases read what was written. The traversal cases are security
 * assertions — `memory_save` and the editor both reach here with strings that
 * came from outside — and the index cases are about a format the user is allowed
 * to edit by hand, so they check that hand-written prose survives a save.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryStore, hookOf, slugify, MAX_SEARCH_HITS, type MemoryStore } from './store'
import { buildMemorySection, MEMORY_PROMPT_MAX_BYTES, MEMORY_TRUNCATED } from './tools'

const AGENT = 'agent-1'

let root: string
let memory: string
let store: MemoryStore

/** The raw text of one of the agent's files. */
function read(path: string): string {
  return readFileSync(join(memory, AGENT, path), 'utf8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'witena-memory-'))
  memory = join(root, 'memory')
  store = createMemoryStore(memory)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('slugify', () => {
  it('keeps letters and numbers and collapses everything else', () => {
    expect(slugify('Database choice: SQLite!')).toBe('database-choice-sqlite')
  })

  it('falls back to a fixed name when nothing survives', () => {
    expect(slugify('!!! ???')).toBe('note')
  })

  it('bounds the length', () => {
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(40)
  })
})

describe('hookOf', () => {
  it('takes the first line that is neither empty nor a heading', () => {
    expect(hookOf('# Title\n\nThe user prefers SQLite.\nMore.')).toBe('The user prefers SQLite.')
  })

  it('truncates a long line', () => {
    expect(hookOf('x'.repeat(500)).length).toBeLessThanOrEqual(100)
  })
})

describe('saveNote', () => {
  it('writes a note with frontmatter and appends one index line', () => {
    const entry = store.saveNote(AGENT, {
      title: 'Project name',
      content: 'The project is called Witena.'
    })

    expect(entry.path).toMatch(/^notes\/project-name-[0-9a-f]{8}\.md$/)
    expect(entry.title).toBe('Project name')

    const note = read(entry.path)
    expect(note).toContain('title: Project name')
    expect(note).toContain('createdAt:')
    expect(note).toContain('The project is called Witena.')

    const index = read('MEMORY.md')
    expect(index).toContain('# Memory')
    expect(index).toContain(`- [Project name](${entry.path}) — The project is called Witena.`)
  })

  it('appends without rewriting what is already in the index', () => {
    const first = store.saveNote(AGENT, { title: 'One', content: 'First fact.' })
    const second = store.saveNote(AGENT, { title: 'Two', content: 'Second fact.' })

    const index = read('MEMORY.md')
    expect(index).toContain(first.path)
    expect(index).toContain(second.path)
    expect(index.indexOf(first.path)).toBeLessThan(index.indexOf(second.path))
    expect(index.split('# Memory')).toHaveLength(2)
  })

  it('keeps prose the user wrote around the list', () => {
    store.writeFile(AGENT, 'MEMORY.md', '# Memory\n\nNotes I keep by hand.\n')
    store.saveNote(AGENT, { title: 'Added', content: 'By the agent.' })

    expect(read('MEMORY.md')).toContain('Notes I keep by hand.')
  })

  it('gives two notes with the same title different files', () => {
    const first = store.saveNote(AGENT, { title: 'Same', content: 'One.' })
    const second = store.saveNote(AGENT, { title: 'Same', content: 'Two.' })

    expect(first.path).not.toBe(second.path)
    expect(store.listEntries(AGENT)).toHaveLength(2)
  })

  it('keeps two agents apart', () => {
    store.saveNote(AGENT, { title: 'Mine', content: 'Only mine.' })

    expect(store.listEntries('agent-2')).toEqual([])
  })

  it('refuses an empty title or empty content', () => {
    expect(() => store.saveNote(AGENT, { title: '  ', content: 'x' })).toThrow(
      expect.objectContaining({ code: 'validation' })
    )
    expect(() => store.saveNote(AGENT, { title: 'x', content: '  ' })).toThrow(
      expect.objectContaining({ code: 'validation' })
    )
  })

  it('refuses an agent id that is a path', () => {
    expect(() => store.saveNote('../escape', { title: 'x', content: 'y' })).toThrow(
      expect.objectContaining({ code: 'validation' })
    )
  })
})

describe('listEntries', () => {
  it('is empty for an agent that has never saved anything', () => {
    expect(store.listEntries(AGENT)).toEqual([])
    expect(store.readIndex(AGENT)).toBe('')
  })

  it('parses title, path and creation time out of the index', () => {
    const saved = store.saveNote(AGENT, { title: 'Chosen stack', content: 'Electron.' })

    const entries = store.listEntries(AGENT)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.title).toBe('Chosen stack')
    expect(entries[0]?.path).toBe(saved.path)
    expect(entries[0]?.createdAt).toBeGreaterThan(0)
  })

  it('ignores a line that links outside the notes folder', () => {
    store.writeFile(
      AGENT,
      'MEMORY.md',
      '# Memory\n\n- [Escape](../../../etc/passwd) — nope\n- [Web](https://example.com) — nope\n'
    )

    expect(store.listEntries(AGENT)).toEqual([])
  })
})

describe('search', () => {
  beforeEach(() => {
    store.saveNote(AGENT, { title: 'Project name', content: 'The project is called Witena.' })
    store.saveNote(AGENT, { title: 'Database', content: 'SQLite through drizzle, one writer.' })
    store.saveNote(AGENT, {
      title: 'Unrelated',
      content: 'The user likes long walks and short meetings.'
    })
  })

  it('finds a note by its body, case-insensitively', () => {
    const hits = store.search(AGENT, 'DRIZZLE')

    expect(hits.some((hit) => hit.title === 'Database')).toBe(true)
    expect(hits.find((hit) => hit.title === 'Database')?.snippet).toContain('drizzle')
  })

  it('ranks a title match above a body match', () => {
    store.saveNote(AGENT, { title: 'Passing mention', content: 'We also use a database here.' })

    const hits = store.search(AGENT, 'database')
    // The index matches too (it lists both titles); among the notes, the one
    // called "Database" has to come before the one that merely mentions it.
    const titles = hits.map((hit) => hit.title)
    expect(titles.indexOf('Database')).toBeLessThan(titles.indexOf('Passing mention'))
  })

  it('returns nothing for a query that matches nothing', () => {
    expect(store.search(AGENT, 'kubernetes')).toEqual([])
  })

  it('returns nothing for an empty query', () => {
    expect(store.search(AGENT, '   ')).toEqual([])
  })

  it('caps the number of hits', () => {
    for (let index = 0; index < MAX_SEARCH_HITS + 5; index += 1) {
      store.saveNote(AGENT, { title: `Note ${index}`, content: 'the common word appears here' })
    }

    expect(store.search(AGENT, 'common word')).toHaveLength(MAX_SEARCH_HITS)
  })

  it('marks a snippet that was cut on both sides', () => {
    store.saveNote(AGENT, {
      title: 'Long',
      content: `${'padding '.repeat(30)}NEEDLE${' padding'.repeat(30)}`
    })

    const hit = store.search(AGENT, 'needle').find((entry) => entry.title === 'Long')
    expect(hit?.snippet.startsWith('…')).toBe(true)
    expect(hit?.snippet.endsWith('…')).toBe(true)
    expect(hit?.snippet).toContain('NEEDLE')
  })
})

describe('readNote and writeFile', () => {
  it('round-trips a note the editor changed', () => {
    const entry = store.saveNote(AGENT, { title: 'Editable', content: 'Before.' })

    store.writeFile(AGENT, entry.path, '---\ntitle: Editable\n---\n\nAfter.\n')

    expect(store.readNote(AGENT, entry.path)).toContain('After.')
    expect(store.search(AGENT, 'After')).toHaveLength(1)
  })

  it('reads and writes the index itself', () => {
    store.writeFile(AGENT, 'MEMORY.md', '# Memory\n\n- [Hand written](notes/x.md) — by me\n')

    expect(store.readNote(AGENT, 'MEMORY.md')).toContain('Hand written')
    expect(store.listEntries(AGENT)[0]?.title).toBe('Hand written')
  })

  it('answers with an empty index rather than failing before the first save', () => {
    expect(store.readNote(AGENT, 'MEMORY.md')).toBe('')
  })

  it('refuses a path that climbs out of the agent folder', () => {
    writeFileSync(join(root, 'secret.txt'), 'sk-live-1234', 'utf8')
    mkdirSync(join(memory, AGENT), { recursive: true })

    expect(() => store.readNote(AGENT, '../../secret.txt')).toThrow(
      expect.objectContaining({ code: 'validation' })
    )
    expect(() => store.writeFile(AGENT, '../../secret.txt', 'overwritten')).toThrow(
      expect.objectContaining({ code: 'validation' })
    )
    expect(readFileSync(join(root, 'secret.txt'), 'utf8')).toBe('sk-live-1234')
  })

  it('refuses to reach another agent', () => {
    store.saveNote('agent-2', { title: 'Theirs', content: 'Not yours.' })

    expect(() => store.readNote(AGENT, '../agent-2/MEMORY.md')).toThrow(
      expect.objectContaining({ code: 'validation' })
    )
  })

  it('rejects a note that does not exist with not_found', () => {
    expect(() => store.readNote(AGENT, 'notes/nope.md')).toThrow(
      expect.objectContaining({ code: 'not_found' })
    )
  })
})

describe('deleteNote', () => {
  it('removes the file and its index line', () => {
    const kept = store.saveNote(AGENT, { title: 'Kept', content: 'Stays.' })
    const doomed = store.saveNote(AGENT, { title: 'Doomed', content: 'Goes.' })

    store.deleteNote(AGENT, doomed.path)

    expect(store.listEntries(AGENT).map((entry) => entry.path)).toEqual([kept.path])
    expect(read('MEMORY.md')).not.toContain(doomed.path)
    expect(() => store.readNote(AGENT, doomed.path)).toThrow(
      expect.objectContaining({ code: 'not_found' })
    )
  })

  it('empties the index when the index itself is deleted', () => {
    store.saveNote(AGENT, { title: 'One', content: 'Fact.' })

    store.deleteNote(AGENT, 'MEMORY.md')

    expect(store.listEntries(AGENT)).toEqual([])
    expect(read('MEMORY.md').trim()).toBe('# Memory')
  })
})

describe('buildMemorySection', () => {
  it('carries the whole index when it fits', () => {
    store.saveNote(AGENT, { title: 'Small', content: 'Short fact.' })

    const section = buildMemorySection(store.readIndex(AGENT))

    expect(section).toContain('Small')
    expect(section).toContain('memory_save')
    expect(section).not.toContain(MEMORY_TRUNCATED)
  })

  it('says so explicitly when nothing has been remembered', () => {
    expect(buildMemorySection(store.readIndex(AGENT))).toContain('empty')
  })

  it('truncates an oversized index on a line boundary and marks it', () => {
    // Enough entries that the index is comfortably past the prompt budget.
    for (let index = 0; index < 400; index += 1) {
      store.saveNote(AGENT, {
        title: `Entry number ${index}`,
        content: `A fact worth remembering, number ${index}, with some padding text.`
      })
    }
    const index = store.readIndex(AGENT)
    expect(Buffer.byteLength(index, 'utf8')).toBeGreaterThan(MEMORY_PROMPT_MAX_BYTES)

    const section = buildMemorySection(index)

    expect(section).toContain(MEMORY_TRUNCATED)
    // The cap applies to the index, not to the sentences around it.
    const body = section.slice(section.indexOf('# Memory'), section.indexOf(MEMORY_TRUNCATED))
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(MEMORY_PROMPT_MAX_BYTES)
    // Cut between entries: the last kept line is a whole index line.
    const lines = body.trimEnd().split('\n')
    expect(lines[lines.length - 1]).toMatch(/^- \[.+\]\(notes\/.+\.md\)/)
  })
})
