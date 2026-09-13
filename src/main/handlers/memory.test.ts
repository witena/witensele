/**
 * `memory.*` against a real temporary `userData` directory.
 *
 * The store's own suite covers the file format and the confinement; what is
 * asserted here is the handler layer's share — that an unknown agent is refused
 * before a directory is created for it, that the files land under the injected
 * `userDataDir`, and that every method validates its input rather than trusting
 * the TypeScript signature.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent } from '@shared/types'
import type { AppContext } from '../app-context'
import { agentInput, createTestDatabase, providerInput, type TestDatabase } from '../db/testing'
import { createTestAppContext } from '../testing'
import { buildHandlers } from './index'

describe('handlers/memory', () => {
  let database: TestDatabase
  let ctx: AppContext
  let agent: Agent
  const handlers = buildHandlers()

  beforeEach(() => {
    database = createTestDatabase()
    ctx = createTestAppContext(database).ctx
    const provider = ctx.repos.providers.create(providerInput(), ctx.userId)
    agent = ctx.repos.agents.create(
      agentInput({ providerId: provider.id, memoryEnabled: true }),
      ctx.userId
    )
  })

  afterEach(() => {
    ctx.close()
  })

  describe('memory.list', () => {
    it('is empty for an agent that has never remembered anything', async () => {
      await expect(handlers['memory.list'](ctx, { agentId: agent.id })).resolves.toEqual([])
    })

    it('lists what the agent saved', async () => {
      ctx.memory.saveNote(agent.id, { title: 'Project', content: 'Called Witena.' })

      const entries = await handlers['memory.list'](ctx, { agentId: agent.id })

      expect(entries).toHaveLength(1)
      expect(entries[0]?.title).toBe('Project')
    })

    it('rejects an unknown agent with not_found and creates nothing', async () => {
      await expect(handlers['memory.list'](ctx, { agentId: 'ghost' })).rejects.toMatchObject({
        code: 'not_found'
      })
      expect(existsSync(join(database.dir, 'memory', 'ghost'))).toBe(false)
    })

    it('rejects a missing agent id with validation', async () => {
      await expect(handlers['memory.list'](ctx, { agentId: '' })).rejects.toMatchObject({
        code: 'validation'
      })
    })
  })

  describe('memory.read', () => {
    it('reads a note the agent wrote, under the injected userDataDir', async () => {
      const saved = ctx.memory.saveNote(agent.id, { title: 'Stack', content: 'Electron.' })

      const result = await handlers['memory.read'](ctx, { agentId: agent.id, path: saved.path })

      expect(result.path).toBe(saved.path)
      expect(result.content).toContain('Electron.')
      expect(existsSync(join(database.dir, 'memory', agent.id, saved.path))).toBe(true)
    })

    it('reads the index even before the first save', async () => {
      await expect(
        handlers['memory.read'](ctx, { agentId: agent.id, path: 'MEMORY.md' })
      ).resolves.toEqual({ path: 'MEMORY.md', content: '' })
    })

    it('refuses a path that leaves the agent folder', async () => {
      await expect(
        handlers['memory.read'](ctx, { agentId: agent.id, path: '../../witena.db' })
      ).rejects.toMatchObject({ code: 'validation' })
    })

    it('rejects a missing path with validation', async () => {
      await expect(
        handlers['memory.read'](ctx, { agentId: agent.id, path: '' })
      ).rejects.toMatchObject({ code: 'validation' })
    })
  })

  describe('memory.write', () => {
    it('writes the index the editor is showing', async () => {
      const entry = await handlers['memory.write'](ctx, {
        agentId: agent.id,
        path: 'MEMORY.md',
        content: '# Memory\n\n- [By hand](notes/a.md) — written in the editor\n'
      })

      expect(entry.path).toBe('MEMORY.md')
      expect(ctx.memory.listEntries(agent.id)[0]?.title).toBe('By hand')
    })

    it('rejects content that is not a string', async () => {
      await expect(
        handlers['memory.write'](ctx, {
          agentId: agent.id,
          path: 'MEMORY.md',
          content: 42 as unknown as string
        })
      ).rejects.toMatchObject({ code: 'validation' })
    })
  })

  describe('memory.delete', () => {
    it('removes a note and its index line', async () => {
      const saved = ctx.memory.saveNote(agent.id, { title: 'Doomed', content: 'Goes.' })

      await handlers['memory.delete'](ctx, { agentId: agent.id, path: saved.path })

      await expect(handlers['memory.list'](ctx, { agentId: agent.id })).resolves.toEqual([])
    })

    it('rejects a note that does not exist with not_found', async () => {
      await expect(
        handlers['memory.delete'](ctx, { agentId: agent.id, path: 'notes/nope.md' })
      ).rejects.toMatchObject({ code: 'not_found' })
    })
  })

  describe('memory.search', () => {
    it('finds a saved fact', async () => {
      ctx.memory.saveNote(agent.id, { title: 'Project', content: 'The project is called Witena.' })

      const hits = await handlers['memory.search'](ctx, { agentId: agent.id, query: 'witena' })

      expect(hits.length).toBeGreaterThan(0)
      expect(hits.some((hit) => hit.snippet.includes('Witena'))).toBe(true)
    })

    it('rejects a query that is not a string', async () => {
      await expect(
        handlers['memory.search'](ctx, { agentId: agent.id, query: 42 as unknown as string })
      ).rejects.toMatchObject({ code: 'validation' })
    })
  })
})
