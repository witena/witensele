/**
 * The skills store against a fake `BackendClient`.
 *
 * Two things are worth proving and are hard to see by reading the store:
 *
 * - **`missingSkillNames`**, which decides whether the agent editor shows a name
 *   as a working binding or as a missing one. It has to agree, rule for rule,
 *   with `enabledSkills` in `src/main/agents/agent-turn.ts` — the backend skips
 *   exactly the names this function calls missing.
 * - **The import flow**, whose interesting case is the one that does nothing: a
 *   cancelled folder dialog answers `null` and must leave no error behind.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendClient, BackendMethod } from '@shared/backend'
import type { SkillDetail, SkillMeta } from '@shared/types'
import { resetBackend, setBackend } from '../lib/backend-provider'
import { missingSkillNames, useSkillsStore } from './skills'

function skill(overrides: Partial<SkillMeta> = {}): SkillMeta {
  return {
    name: 'architecture-review',
    description: 'Review a design',
    path: '/tmp/skills/architecture-review',
    folder: 'architecture-review',
    fileCount: 1,
    ...overrides
  }
}

interface FakeOptions {
  skills?: SkillMeta[]
  /** What the folder dialog answers; `null` is the user cancelling. */
  picked?: string | null
  /** Thrown by `skills.import` when set. */
  importError?: Error
}

function fakeBackend(options: FakeOptions = {}): { client: BackendClient; calls: BackendMethod[] } {
  const calls: BackendMethod[] = []
  let rows = [...(options.skills ?? [])]

  const client: BackendClient = {
    invoke: (async (method: BackendMethod, input: unknown) => {
      calls.push(method)
      if (method === 'skills.list') return { skills: rows, warnings: [] }
      if (method === 'system.pickFolder') return options.picked ?? null
      if (method === 'skills.import') {
        if (options.importError) throw options.importError
        const imported = skill({
          name: 'imported',
          folder: 'imported',
          path: String((input as { sourcePath: string }).sourcePath)
        })
        rows = [...rows, imported]
        return imported
      }
      if (method === 'skills.read') {
        const name = (input as { name: string }).name
        const meta = rows.find((candidate) => candidate.name === name)
        if (!meta) throw new Error(`no such skill: ${name}`)
        return { meta, body: '# Body', files: ['checklist.md'] } satisfies SkillDetail
      }
      if (method === 'skills.delete') {
        rows = rows.filter((candidate) => candidate.name !== (input as { name: string }).name)
        return undefined
      }
      throw new Error(`unexpected method: ${method}`)
    }) as BackendClient['invoke'],
    subscribe: () => () => undefined
  }

  return { client, calls }
}

beforeEach(() => {
  useSkillsStore.setState({
    skills: [],
    warnings: [],
    status: 'idle',
    error: undefined,
    errorCode: undefined,
    selectedName: null,
    detail: null,
    importing: false
  })
})

afterEach(() => {
  resetBackend()
})

describe('missingSkillNames', () => {
  const available = [skill(), skill({ name: 'Pretty Name', folder: 'pretty-folder' })]

  it('resolves a name against the skill name and the folder name', () => {
    expect(missingSkillNames(['architecture-review', 'pretty-folder'], available)).toEqual([])
  })

  it('ignores case and surrounding space, exactly as the backend does', () => {
    expect(missingSkillNames([' Architecture-Review ', 'PRETTY NAME'], available)).toEqual([])
  })

  it('reports a name nothing on disk answers to', () => {
    expect(missingSkillNames(['architecture-review', 'deleted'], available)).toEqual(['deleted'])
  })

  it('reports everything when the library is empty', () => {
    expect(missingSkillNames(['a', 'b'], [])).toEqual(['a', 'b'])
  })
})

describe('load', () => {
  it('mirrors the library', async () => {
    setBackend(fakeBackend({ skills: [skill()] }).client)

    await useSkillsStore.getState().load()

    expect(useSkillsStore.getState().skills).toHaveLength(1)
    expect(useSkillsStore.getState().status).toBe('ready')
  })

  it('closes a detail pane whose skill is gone', async () => {
    const backend = fakeBackend({ skills: [skill()] })
    setBackend(backend.client)
    await useSkillsStore.getState().load()
    await useSkillsStore.getState().select('architecture-review')
    expect(useSkillsStore.getState().detail).not.toBeNull()

    await useSkillsStore.getState().remove('architecture-review')
    await useSkillsStore.getState().load()

    expect(useSkillsStore.getState().selectedName).toBeNull()
    expect(useSkillsStore.getState().detail).toBeNull()
  })
})

describe('importFolder', () => {
  it('imports the folder the dialog returned and opens it', async () => {
    const backend = fakeBackend({ picked: '/Users/me/Downloads/imported' })
    setBackend(backend.client)

    const meta = await useSkillsStore.getState().importFolder()

    expect(meta?.name).toBe('imported')
    expect(backend.calls).toContain('skills.import')
    expect(useSkillsStore.getState().selectedName).toBe('imported')
    expect(useSkillsStore.getState().importing).toBe(false)
  })

  it('does nothing at all when the dialog is cancelled', async () => {
    const backend = fakeBackend({ picked: null })
    setBackend(backend.client)

    const meta = await useSkillsStore.getState().importFolder()

    expect(meta).toBeNull()
    expect(backend.calls).toEqual(['system.pickFolder'])
    expect(useSkillsStore.getState().error).toBeUndefined()
  })

  it('keeps a refused import as an error rather than rejecting', async () => {
    setBackend(fakeBackend({ picked: '/tmp/x', importError: new Error('already exists') }).client)

    await expect(useSkillsStore.getState().importFolder()).resolves.toBeNull()
    expect(useSkillsStore.getState().error).toBe('already exists')
    expect(useSkillsStore.getState().importing).toBe(false)
  })
})
