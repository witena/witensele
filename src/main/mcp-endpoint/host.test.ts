/**
 * The host as the shim meets it: a file in a directory and a port that answers.
 *
 * `server.test.ts` already proves the transport over a socket a test opened
 * itself. What is under test here is the half that only the desktop app has —
 * that `start()` publishes somewhere a *different process* can find the port and
 * the token, that the file is readable by nobody else, that `stop()` takes it
 * away again, and that neither is a trap when called twice or when the file on
 * disk belongs to somebody else.
 *
 * `ctx` and `handlers` are sentinels for the same reason they are in
 * `server.test.ts`: `tools/list` is served from `@shared/mcp-tools` and a refused
 * request never reaches a tool, so nothing here needs a database.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DISCOVERY_FILE, parseDiscovery, type McpDiscovery } from '@shared/mcp-discovery'
import { MCP_PATH, MCP_TOOL_NAMES } from '@shared/mcp-tools'
import type { AppContext } from '../app-context'
import type { HandlerMap } from '../handlers/types'
import { createMcpEndpointHost, type McpEndpointHost } from './host'

const CTX = { sentinel: 'ctx' } as unknown as AppContext
const HANDLERS = { sentinel: 'handlers' } as unknown as HandlerMap

describe('the MCP endpoint host', () => {
  let dir: string
  let discoveryPath: string
  let host: McpEndpointHost

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'witena-endpoint-'))
    discoveryPath = join(dir, DISCOVERY_FILE)
    host = createMcpEndpointHost({ ctx: CTX, handlers: HANDLERS, userDataDir: dir })
  })

  afterEach(async () => {
    await host.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  /** The discovery file, parsed the way the shim parses it. */
  function published(): McpDiscovery {
    const discovery = parseDiscovery(readFileSync(discoveryPath, 'utf8'))
    expect(discovery).not.toBeNull()
    return discovery as McpDiscovery
  }

  /**
   * An SDK client on the published port, with the published token.
   *
   * The transport is cast exactly as `server.test.ts` casts it:
   * `StreamableHTTPClientTransport.sessionId` is `string | undefined` where
   * `Transport` declares `sessionId?: string`, which are different types under
   * `exactOptionalPropertyTypes` and identical at runtime.
   */
  async function connect(discovery: McpDiscovery): Promise<Client> {
    const client = new Client({ name: 'host-test', version: '0.0.0-test' })
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${discovery.port}${MCP_PATH}`),
      { requestInit: { headers: { authorization: `Bearer ${discovery.token}` } } }
    )
    await client.connect(transport as unknown as Transport)
    return client
  }

  it('starts nothing until it is asked to', () => {
    expect(host.state).toEqual({ listening: false })
    expect(() => statSync(discoveryPath)).toThrow()
  })

  it('publishes a port and a token a separate process could use', async () => {
    await host.start()

    expect(host.state).toEqual({ listening: true, port: expect.any(Number) })
    const discovery = published()
    expect(discovery.port).toBe(host.state.listening && host.state.port)
    expect(discovery.pid).toBe(process.pid)
    expect(discovery.startedAt).toBeLessThanOrEqual(Date.now())
    // 32 random bytes as base64url: long enough that guessing it is not a plan.
    expect(discovery.token.length).toBeGreaterThanOrEqual(43)

    // The file is the secret: anything that can read it can call every tool.
    expect(statSync(discoveryPath).mode & 0o777).toBe(0o600)
  })

  it('answers tools/list on the published port with the published token', async () => {
    await host.start()
    const client = await connect(published())
    try {
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES])
    } finally {
      await client.close()
    }
  })

  it('refuses the same port without the token', async () => {
    await host.start()
    const { port } = published()

    const response = await fetch(`http://127.0.0.1:${port}${MCP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    })

    expect(response.status).toBe(401)
    await response.arrayBuffer()
  })

  it('issues a different token every time it starts', async () => {
    await host.start()
    const first = published().token
    await host.stop()
    await host.start()

    expect(published().token).not.toBe(first)
  })

  it('takes the file and the port away again on stop', async () => {
    await host.start()
    const { port } = published()
    await host.stop()

    expect(host.state).toEqual({ listening: false })
    expect(() => statSync(discoveryPath)).toThrow()
    await expect(
      fetch(`http://127.0.0.1:${port}${MCP_PATH}`, { method: 'POST', body: '{}' })
    ).rejects.toThrow()
  })

  it('is idempotent in both directions', async () => {
    await host.start()
    const first = published()
    await host.start()

    // A second start is not a second socket, and not a second token: a caller
    // that asked twice (the setting, then the launch) must not invalidate a
    // token a shim is already holding.
    expect(host.state).toEqual({ listening: true, port: first.port })
    expect(published()).toEqual(first)

    await host.stop()
    await host.stop()
    expect(host.state).toEqual({ listening: false })
  })

  it('survives two starts that overlap', async () => {
    // The switch answered twice in one tick — the queue inside the host is what
    // keeps that from leaving a stray socket with nothing pointing at it.
    await Promise.all([host.start(), host.start()])

    expect(host.state).toEqual({ listening: true, port: published().port })
    const client = await connect(published())
    await client.close()
  })

  it('leaves a discovery file belonging to another process alone', async () => {
    const foreign: McpDiscovery = {
      version: 1,
      port: 65_000,
      token: 'not-ours',
      // `process.pid + 1` may well be nobody at all, which is the point: the
      // rule is "not ours", not "alive".
      pid: process.pid + 1,
      startedAt: Date.now()
    }
    writeFileSync(discoveryPath, JSON.stringify(foreign), { mode: 0o600 })

    await host.stop()
    expect(parseDiscovery(readFileSync(discoveryPath, 'utf8'))).toEqual(foreign)

    // And a host that never listened does not delete it on the way past either:
    // two apps on one `userData` should be impossible, but tidying up after a
    // live IDE session would be the wrong way to find out.
    await host.start()
    expect(published().pid).toBe(process.pid)
  })

  it('reports the port it actually listened on', async () => {
    await host.start()
    expect(host.state.listening).toBe(true)
    if (!host.state.listening) return
    expect(host.state.port).toBeGreaterThan(0)
    expect(host.state.port).toBe(published().port)
  })

  it('takes the token from the injected generator', async () => {
    const injected = createMcpEndpointHost({
      ctx: CTX,
      handlers: HANDLERS,
      userDataDir: dir,
      randomToken: () => 'a-known-token',
      pid: 4242
    })
    try {
      await injected.start()
      expect(published()).toMatchObject({ token: 'a-known-token', pid: 4242 })
    } finally {
      // Its own pid is what it wrote, so this removes the file it made.
      await injected.stop()
    }
    expect(() => statSync(discoveryPath)).toThrow()
  })
})
