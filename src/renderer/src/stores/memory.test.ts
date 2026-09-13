/**
 * The memory store against a fake `BackendClient`.
 *
 * What is worth proving is the **editor lifecycle**, which is the only stateful
 * thing here: open a file, type into it, `dirty` goes true, Save writes it and
 * `dirty` goes back to false, and moving to another agent forgets everything.
 * The last one matters because the panel is reused for every agent in the list.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendClient, BackendMethod } from '@shared/backend'
import type { MemoryEntry } from '@shared/types'
import { resetBackend, setBackend } from '../lib/backend-provider'
import { isDirty, MEMORY_INDEX_PATH, useMemoryStore } from './memory'

const NOTE = 'notes/project-name-1a2b3c4d.md'

interface Call {
  method: BackendMethod
  input: unknown
}

function fakeBackend(): { client: BackendClient; calls: Call[] } {
  const calls: Call[] = []
  const files = new Map<string, string>([
    [MEMORY_INDEX_PATH, `# Memory\n\n- [Project name](${NOTE}) — called Witena\n`],
    [NOTE, '---\ntitle: Project name\n---\n\nThe project is called Witena.\n']
  ])

  const entries = (): MemoryEntry[] =>
    files.has(NOTE)
      ? [{ id: NOTE, title: 'Project name', path: NOTE, createdAt: 1_757_000_000_000 }]
      : []

  const client: BackendClient = {
    invoke: (async (method: BackendMethod, input: unknown) => {
      calls.push({ method, input })
      const path = (input as { path?: string })?.path ?? ''
      if (method === 'memory.list') return entries()
      if (method === 'memory.read') return { path, content: files.get(path) ?? '' }
      if (method === 'memory.write') {
        files.set(path, (input as { content: string }).content)
        return { id: path, title: 'Project name', path, createdAt: 0 }
      }
      if (method === 'memory.delete') {
        files.delete(path)
        return undefined
      }
      throw new Error(`unexpected method: ${method}`)
    }) as BackendClient['invoke'],
    subscribe: () => () => undefined
  }

  return { client, calls }
}

beforeEach(() => {
  useMemoryStore.getState().reset()
})

afterEach(() => {
  resetBackend()
})

describe('isDirty', () => {
  it('is false with nothing open, whatever the draft holds', () => {
    expect(isDirty({ openPath: null, draft: 'typed', saved: '' })).toBe(false)
  })

  it('is true only while the draft differs from what was read', () => {
    expect(isDirty({ openPath: 'MEMORY.md', draft: 'a', saved: 'a' })).toBe(false)
    expect(isDirty({ openPath: 'MEMORY.md', draft: 'b', saved: 'a' })).toBe(true)
  })
})

describe('load', () => {
  it('lists one agent’s entries', async () => {
    setBackend(fakeBackend().client)

    await useMemoryStore.getState().load('agent-1')

    expect(useMemoryStore.getState().entries.map((entry) => entry.title)).toEqual(['Project name'])
    expect(useMemoryStore.getState().status).toBe('ready')
  })

  it('closes the open file when the panel moves to another agent', async () => {
    setBackend(fakeBackend().client)
    await useMemoryStore.getState().load('agent-1')
    await useMemoryStore.getState().open(NOTE)
    expect(useMemoryStore.getState().openPath).toBe(NOTE)

    await useMemoryStore.getState().load('agent-2')

    expect(useMemoryStore.getState().agentId).toBe('agent-2')
    expect(useMemoryStore.getState().openPath).toBeNull()
    expect(useMemoryStore.getState().draft).toBe('')
  })
})

describe('the editor lifecycle', () => {
  it('opens, edits, saves and comes back clean', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)
    await useMemoryStore.getState().load('agent-1')

    await useMemoryStore.getState().open(NOTE)
    expect(useMemoryStore.getState().draft).toContain('called Witena')
    expect(isDirty(useMemoryStore.getState())).toBe(false)

    useMemoryStore.getState().setDraft('---\ntitle: Project name\n---\n\nRenamed.\n')
    expect(isDirty(useMemoryStore.getState())).toBe(true)

    await useMemoryStore.getState().save()

    expect(isDirty(useMemoryStore.getState())).toBe(false)
    expect(backend.calls.some((call) => call.method === 'memory.write')).toBe(true)
    // The list is re-read, because a title lives inside the file just written.
    expect(backend.calls.filter((call) => call.method === 'memory.list')).toHaveLength(2)
  })

  it('opens the index even though it is not an entry', async () => {
    setBackend(fakeBackend().client)
    await useMemoryStore.getState().load('agent-1')

    await useMemoryStore.getState().open(MEMORY_INDEX_PATH)

    expect(useMemoryStore.getState().draft).toContain('# Memory')
  })

  it('saves nothing when no file is open', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)
    await useMemoryStore.getState().load('agent-1')

    await useMemoryStore.getState().save()

    expect(backend.calls.some((call) => call.method === 'memory.write')).toBe(false)
  })
})

describe('remove', () => {
  it('deletes a note, reloads the list and closes it if it was open', async () => {
    setBackend(fakeBackend().client)
    await useMemoryStore.getState().load('agent-1')
    await useMemoryStore.getState().open(NOTE)

    await useMemoryStore.getState().remove(NOTE)

    expect(useMemoryStore.getState().entries).toEqual([])
    expect(useMemoryStore.getState().openPath).toBeNull()
  })
})
