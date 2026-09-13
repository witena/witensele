/**
 * `McpManager` against a **real** MCP server running in this process.
 *
 * `mcp/testing.ts` links an SDK `McpServer` to the manager's client with
 * `InMemoryTransport`, so every name this file depends on — `client.connect`,
 * `listTools`, `callTool`, the `content` / `isError` result shape,
 * `RequestOptions.timeout` — is exercised for real rather than against a fake
 * that agrees with us by construction. What that cannot cover (spawning `npx`,
 * piping stderr) is the end-to-end spec's job.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { McpServer } from '@shared/types'
import { LOCAL_USER_ID } from '@shared/types'
import { createTestDatabase, mcpServerInput, type TestDatabase } from '../db/testing'
import { McpManager } from './manager'
import { failingTransport, inMemoryTransport } from './testing'

describe('McpManager', () => {
  let database: TestDatabase
  let server: McpServer
  let manager: McpManager

  /** A manager whose pool reads the test database and talks to the in-process server. */
  function createManager(createTransport = inMemoryTransport()): McpManager {
    return new McpManager({
      getServer: (id) => database.repos.mcpServers.get(id, LOCAL_USER_ID),
      createTransport
    })
  }

  beforeEach(() => {
    database = createTestDatabase()
    server = database.repos.mcpServers.create(mcpServerInput(), LOCAL_USER_ID)
    manager = createManager()
  })

  afterEach(async () => {
    await manager.closeAll()
    database.cleanup()
  })

  describe('listTools', () => {
    it('discovers the tools the server registered', async () => {
      const tools = await manager.listTools(server.id)

      expect(tools.map((tool) => tool.name).sort()).toEqual(['echo', 'fail', 'slow'])
      expect(tools.find((tool) => tool.name === 'echo')?.description).toBe(
        'Echoes the message back'
      )
      // The JSON schema comes through untouched, which is what `jsonSchema()` wraps.
      expect(tools.find((tool) => tool.name === 'echo')?.inputSchema).toMatchObject({
        type: 'object',
        properties: { message: { type: 'string' } }
      })
    })

    it('connects once for concurrent callers', async () => {
      let connections = 0
      const counting = createManager(async (target, context) => {
        connections += 1
        return inMemoryTransport()(target, context)
      })

      await Promise.all([counting.listTools(server.id), counting.listTools(server.id)])
      await counting.listTools(server.id)

      expect(connections).toBe(1)
      await counting.closeAll()
    })

    it('reconnects after a failed connection instead of caching the rejection', async () => {
      let attempts = 0
      const flaky = createManager(async (target, context) => {
        attempts += 1
        if (attempts === 1) throw new Error('connection refused')
        return inMemoryTransport()(target, context)
      })

      await expect(flaky.listTools(server.id)).rejects.toMatchObject({ code: 'mcp_error' })
      await expect(flaky.listTools(server.id)).resolves.toHaveLength(3)
      expect(attempts).toBe(2)
      await flaky.closeAll()
    })

    it('refuses to connect a disabled server', async () => {
      const disabled = database.repos.mcpServers.update(
        server.id,
        { enabled: false },
        LOCAL_USER_ID
      )

      await expect(manager.listTools(disabled.id)).rejects.toMatchObject({
        code: 'mcp_error',
        message: expect.stringContaining('disabled')
      })
    })

    it('re-asks the server when refresh is set', async () => {
      let connections = 0
      const counting = createManager(async (target, context) => {
        connections += 1
        return inMemoryTransport()(target, context)
      })

      await counting.listTools(server.id)
      await counting.listTools(server.id, { refresh: true })

      // A refresh re-lists over the *same* connection; it does not reconnect.
      expect(connections).toBe(1)
      await counting.closeAll()
    })
  })

  describe('callTool', () => {
    it('runs a tool and returns its content blocks', async () => {
      const result = await manager.callTool(server.id, 'echo', { message: 'WITENA-42' })

      expect(result.isError).not.toBe(true)
      expect(result.content?.[0]).toMatchObject({ type: 'text', text: 'Echo: WITENA-42' })
    })

    it('reports a tool that failed as isError rather than throwing', async () => {
      const result = await manager.callTool(server.id, 'fail', {})

      expect(result.isError).toBe(true)
      expect(result.content?.[0]).toMatchObject({ text: 'the tool exploded' })
    })

    it('gives up on a tool that outruns its budget', async () => {
      await expect(
        manager.callTool(server.id, 'slow', {}, { timeoutMs: 20 })
      ).rejects.toMatchObject({ code: 'mcp_error', message: 'tool timeout' })
    })

    it('stops waiting when the turn is aborted', async () => {
      const controller = new AbortController()
      const running = manager.callTool(server.id, 'slow', {}, { signal: controller.signal })
      controller.abort()

      await expect(running).rejects.toMatchObject({ code: 'mcp_error' })
    })

    it('reports an unknown tool as isError, not as a rejection', async () => {
      // Worth pinning: the SDK answers a `tools/call` for a name the server does
      // not have with a normal result carrying `isError`, so the model is told
      // "that tool does not exist" and can pick another one. Only a transport
      // failure rejects.
      const result = await manager.callTool(server.id, 'nope', {})

      expect(result.isError).toBe(true)
      expect(result.content?.[0]).toMatchObject({ text: expect.stringContaining('not found') })
    })
  })

  describe('testConnection', () => {
    it('reports the tools it found and a latency', async () => {
      const result = await manager.testConnection(mcpServerInput())

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.tools.map((tool) => tool.name).sort()).toEqual(['echo', 'fail', 'slow'])
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    })

    it('leaves the pool alone, so a probe never disturbs a running agent', async () => {
      await manager.listTools(server.id)
      await manager.testConnection(mcpServerInput())

      // The pooled connection still answers: the probe closed its own client only.
      await expect(manager.listTools(server.id)).resolves.toHaveLength(3)
    })

    it('answers with a failure rather than throwing when the server will not start', async () => {
      const broken = createManager(failingTransport('spawn npx ENOENT'))

      const result = await broken.testConnection(mcpServerInput())

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'mcp_error', message: 'spawn npx ENOENT' }
      })
      await broken.closeAll()
    })

    it('rejects a configuration that cannot produce a transport at all', async () => {
      const stdioWithoutCommand = await manager.testConnection(
        mcpServerInput({ command: undefined })
      )
      const httpWithoutUrl = await manager.testConnection(
        mcpServerInput({ transport: 'http', command: undefined })
      )

      expect(stdioWithoutCommand.ok).toBe(false)
      expect(httpWithoutUrl.ok).toBe(false)
    })
  })

  describe('disconnect', () => {
    it('drops the pooled client so the next call reconnects', async () => {
      let connections = 0
      const counting = createManager(async (target, context) => {
        connections += 1
        return inMemoryTransport()(target, context)
      })

      await counting.listTools(server.id)
      await counting.disconnect(server.id)
      await counting.listTools(server.id)

      expect(connections).toBe(2)
      await counting.closeAll()
    })

    it('is a no-op for a server that was never connected', async () => {
      await expect(manager.disconnect(server.id)).resolves.toBeUndefined()
    })
  })

  describe('getLog', () => {
    it('is empty until a server writes to stderr', () => {
      expect(manager.getLog(server.id)).toEqual([])
    })

    it('keeps the stderr lines a transport reports', async () => {
      const noisy = createManager(async (target, context) => {
        context.appendLog('npm warn exec')
        context.appendLog('server ready')
        return inMemoryTransport()(target, context)
      })

      await noisy.listTools(server.id)

      expect(noisy.getLog(server.id)).toEqual(['npm warn exec', 'server ready'])
      await noisy.closeAll()
    })
  })
})
