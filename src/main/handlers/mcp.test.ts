/**
 * The `mcp.*` handlers, driven through `buildHandlers()` against a real
 * temporary database and a real in-process MCP server.
 *
 * Three themes: **validation** (a record that would fail to connect is refused
 * before it is stored), **connection invalidation** (editing a server must not
 * leave a client talking to the old command), and **deletion**, which is the one
 * operation with consequences outside its own row — `agents.mcp_server_ids` is
 * JSON, so nothing cascades and the unbinding is done by hand.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppContext } from '../app-context'
import {
  agentInput,
  createTestDatabase,
  mcpServerInput,
  providerInput,
  type TestDatabase
} from '../db/testing'
import { inMemoryTransport } from '../mcp/testing'
import { createTestAppContext } from '../testing'
import { buildHandlers } from './index'

describe('handlers/mcp', () => {
  const handlers = buildHandlers()

  let database: TestDatabase
  let ctx: AppContext
  /** How many transports the pool has opened, so reconnection is observable. */
  let connections: number

  beforeEach(() => {
    database = createTestDatabase()
    connections = 0
    ctx = createTestAppContext(database, {
      mcp: {
        createTransport: async (target, context) => {
          connections += 1
          return inMemoryTransport()(target, context)
        }
      }
    }).ctx
  })

  afterEach(() => {
    ctx.close()
  })

  describe('create', () => {
    it('stores a stdio server', async () => {
      const created = await handlers['mcp.create'](ctx, { input: mcpServerInput() })

      expect(created).toMatchObject({ name: 'everything', transport: 'stdio', command: 'npx' })
      await expect(handlers['mcp.list'](ctx)).resolves.toHaveLength(1)
    })

    it('trims the name, which is also the tool prefix', async () => {
      const created = await handlers['mcp.create'](ctx, {
        input: mcpServerInput({ name: '  files  ' })
      })

      expect(created.name).toBe('files')
    })

    it('rejects a duplicate name, case-insensitively', async () => {
      await handlers['mcp.create'](ctx, { input: mcpServerInput({ name: 'Files' }) })

      await expect(
        handlers['mcp.create'](ctx, { input: mcpServerInput({ name: 'files' }) })
      ).rejects.toMatchObject({ code: 'validation' })
    })

    it('rejects a stdio server with no command', async () => {
      await expect(
        handlers['mcp.create'](ctx, { input: mcpServerInput({ command: '' }) })
      ).rejects.toMatchObject({ code: 'validation' })
    })

    it('rejects an http server whose url is missing or not a url', async () => {
      await expect(
        handlers['mcp.create'](ctx, {
          input: mcpServerInput({ transport: 'http', command: undefined })
        })
      ).rejects.toMatchObject({ code: 'validation' })

      await expect(
        handlers['mcp.create'](ctx, {
          input: mcpServerInput({ transport: 'http', command: undefined, url: 'not a url' })
        })
      ).rejects.toMatchObject({ code: 'validation' })
    })

    it('rejects a url that is not http or https', async () => {
      await expect(
        handlers['mcp.create'](ctx, {
          input: mcpServerInput({ transport: 'http', command: undefined, url: 'file:///etc/passwd' })
        })
      ).rejects.toMatchObject({ code: 'validation' })
    })

    it('accepts an https server', async () => {
      const created = await handlers['mcp.create'](ctx, {
        input: mcpServerInput({
          name: 'remote',
          transport: 'http',
          command: undefined,
          args: undefined,
          url: 'https://example.com/mcp'
        })
      })

      expect(created).toMatchObject({ transport: 'http', url: 'https://example.com/mcp' })
    })
  })

  describe('update', () => {
    it('checks the transport requirement against the merged record, not the patch', async () => {
      const created = await handlers['mcp.create'](ctx, { input: mcpServerInput() })

      // Switching to http without supplying a URL in the same patch is invalid…
      await expect(
        handlers['mcp.update'](ctx, { id: created.id, patch: { transport: 'http' } })
      ).rejects.toMatchObject({ code: 'validation' })

      // …while a patch that touches only `enabled` is fine.
      await expect(
        handlers['mcp.update'](ctx, { id: created.id, patch: { enabled: false } })
      ).resolves.toMatchObject({ enabled: false })
    })

    it('lets a server keep its own name', async () => {
      const created = await handlers['mcp.create'](ctx, { input: mcpServerInput({ name: 'files' }) })

      await expect(
        handlers['mcp.update'](ctx, { id: created.id, patch: { name: 'files' } })
      ).resolves.toMatchObject({ name: 'files' })
    })

    it('closes the pooled client when the command changes', async () => {
      const created = await handlers['mcp.create'](ctx, { input: mcpServerInput() })
      await handlers['mcp.tools'](ctx, { id: created.id })
      expect(connections).toBe(1)

      await handlers['mcp.update'](ctx, { id: created.id, patch: { command: 'uvx' } })
      await handlers['mcp.tools'](ctx, { id: created.id })

      expect(connections).toBe(2)
    })

    it('closes the pooled client when the server is disabled', async () => {
      const created = await handlers['mcp.create'](ctx, { input: mcpServerInput() })
      await handlers['mcp.tools'](ctx, { id: created.id })

      await handlers['mcp.update'](ctx, { id: created.id, patch: { enabled: false } })

      await expect(handlers['mcp.tools'](ctx, { id: created.id })).rejects.toMatchObject({
        code: 'mcp_error'
      })
    })

    it('keeps the connection for a change that cannot affect it', async () => {
      const created = await handlers['mcp.create'](ctx, { input: mcpServerInput() })
      await handlers['mcp.tools'](ctx, { id: created.id })

      await handlers['mcp.update'](ctx, { id: created.id, patch: { sideEffects: true } })
      await handlers['mcp.tools'](ctx, { id: created.id })

      expect(connections).toBe(1)
    })
  })

  describe('delete', () => {
    it('unbinds the server from every agent that listed it', async () => {
      const provider = ctx.repos.providers.create(providerInput(), ctx.userId)
      const created = await handlers['mcp.create'](ctx, { input: mcpServerInput() })
      const bound = ctx.repos.agents.create(
        agentInput({ name: 'Ada', providerId: provider.id, mcpServerIds: [created.id] }),
        ctx.userId
      )
      const untouched = ctx.repos.agents.create(
        agentInput({ name: 'Bo', providerId: provider.id, mcpServerIds: [] }),
        ctx.userId
      )

      await handlers['mcp.delete'](ctx, { id: created.id })

      expect(ctx.repos.agents.get(bound.id, ctx.userId).mcpServerIds).toEqual([])
      expect(ctx.repos.agents.get(untouched.id, ctx.userId).mcpServerIds).toEqual([])
      await expect(handlers['mcp.list'](ctx)).resolves.toEqual([])
    })

    it('rejects an id that does not exist', async () => {
      await expect(handlers['mcp.delete'](ctx, { id: 'nope' })).rejects.toMatchObject({
        code: 'not_found'
      })
    })
  })

  describe('testConnection', () => {
    it('probes an unsaved draft, so the form can be checked before Save', async () => {
      const result = await handlers['mcp.testConnection'](ctx, {
        server: { draft: mcpServerInput() }
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.tools.map((tool) => tool.name)).toContain('echo')
    })

    it('probes a saved record by id', async () => {
      const created = await handlers['mcp.create'](ctx, { input: mcpServerInput() })

      const result = await handlers['mcp.testConnection'](ctx, { server: { id: created.id } })

      expect(result.ok).toBe(true)
    })

    it('rejects a draft that could never connect', async () => {
      await expect(
        handlers['mcp.testConnection'](ctx, {
          server: { draft: mcpServerInput({ command: '' }) }
        })
      ).rejects.toMatchObject({ code: 'validation' })
    })
  })

  describe('tools and log', () => {
    it('lists the tools over the pooled connection', async () => {
      const created = await handlers['mcp.create'](ctx, { input: mcpServerInput() })

      await expect(handlers['mcp.tools'](ctx, { id: created.id })).resolves.toEqual([
        { name: 'echo', description: 'Echoes the message back' },
        { name: 'fail', description: 'Always reports a tool error' },
        { name: 'slow', description: 'Answers after a very long time' }
      ])
    })

    it('answers with an empty log for a server that has said nothing', async () => {
      const created = await handlers['mcp.create'](ctx, { input: mcpServerInput() })

      await expect(handlers['mcp.log'](ctx, { id: created.id })).resolves.toEqual([])
    })

    it('rejects both for an unknown id', async () => {
      await expect(handlers['mcp.tools'](ctx, { id: 'nope' })).rejects.toMatchObject({
        code: 'not_found'
      })
      await expect(handlers['mcp.log'](ctx, { id: 'nope' })).rejects.toMatchObject({
        code: 'not_found'
      })
    })
  })
})
