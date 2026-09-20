/**
 * The built shim, as an IDE actually runs it.
 *
 * Everything else in this folder tests a function; this tests the artefact.
 * `out/mcp-shim/witena-mcp.cjs` is built in `beforeAll` and then spawned with
 * plain `node` — never with the real bundle, which would put a second Witena on
 * a machine several agents share — and driven over stdio by the SDK's own
 * client, with a WP-4 endpoint and a hand-written discovery file standing in
 * for the app.
 *
 * Four things can only be proven here, because each of them is a property of
 * the *file* rather than of the source:
 *
 * | Claim | Why the bundle is what proves it |
 * |---|---|
 * | `tools/list` answers with no app and no discovery file | The offline table has to survive bundling, and nothing may touch the network at startup |
 * | A `tools/call` reaches the endpoint with the client's name | The bearer token, the header and the URL are assembled from a file the shim read at run time |
 * | Progress crosses both hops | Two SDK `Protocol` instances, two progress tokens, one relay |
 * | The switched-off message comes back as a tool error | An IDE must see a readable refusal, not a server that died |
 */
import { execFile } from 'node:child_process'
import { createServer, type Server as HttpServer } from 'node:http'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment
} from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DISCOVERY_FILE, type McpDiscovery } from '@shared/mcp-discovery'
import { MCP_TOOL_NAMES } from '@shared/mcp-tools'
import type { AppContext } from '../main/app-context'
import type { HandlerMap } from '../main/handlers/types'
import { createMcpEndpoint, type McpEndpoint } from '../main/mcp-endpoint/server'
import type { ToolCallContext, ToolOutcome, ToolRegistry } from '../main/mcp-endpoint/tool-types'
import { SHIM_ERROR_TEXT } from './connect'

const run = promisify(execFile)

const ROOT = resolve(import.meta.dirname, '../..')
const SHIM = join(ROOT, 'out/mcp-shim/witena-mcp.cjs')
const TOKEN = 'spawn-test-token'

/** The two objects the endpoint only passes through; the stub never reads them. */
const CTX = { sentinel: 'ctx' } as unknown as AppContext
const HANDLERS = { sentinel: 'handlers' } as unknown as HandlerMap

interface Recorded {
  name: string
  args: unknown
  call: ToolCallContext
}

describe('the built shim over stdio', () => {
  let dir: string
  let http: HttpServer
  let endpoint: McpEndpoint
  let port: number
  let recorded: Recorded[]
  let behaviour: (r: Recorded) => Promise<ToolOutcome>

  beforeAll(async () => {
    // The artefact under test, built the way `npm run mcp-shim:build` builds it.
    await run(process.execPath, [
      join(ROOT, 'node_modules/vite/bin/vite.js'),
      'build',
      '--config',
      'vite.mcp-shim.config.ts'
    ], { cwd: ROOT })
  }, 180_000)

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'witena-shim-spawn-'))
    recorded = []
    behaviour = async () => ({ ok: true, structured: { fine: true }, text: 'fine' })

    const tools = Object.fromEntries(
      MCP_TOOL_NAMES.map((name) => [
        name,
        async (args: unknown, call: ToolCallContext): Promise<ToolOutcome> => {
          const record: Recorded = { name, args, call }
          recorded.push(record)
          return behaviour(record)
        }
      ])
    ) as ToolRegistry

    endpoint = createMcpEndpoint({ ctx: CTX, handlers: HANDLERS, token: TOKEN, tools })
    http = createServer((req, res) => {
      void endpoint.handle(req, res)
    })
    await new Promise<void>((settle) => http.listen(0, '127.0.0.1', settle))
    port = (http.address() as AddressInfo).port
  })

  afterEach(async () => {
    await endpoint.close()
    await new Promise<void>((settle) => {
      http.close(() => settle())
      http.closeAllConnections()
    })
    await rm(dir, { recursive: true, force: true })
  })

  /** The discovery file the app would have written, pointing at the stub endpoint. */
  async function writeDiscovery(over: Partial<McpDiscovery> = {}): Promise<void> {
    const discovery: McpDiscovery = {
      version: 1,
      port,
      token: TOKEN,
      // This test process stands in for the app: it is alive, which is what the
      // shim checks before it trusts the port.
      pid: process.pid,
      startedAt: Date.now(),
      ...over
    }
    await writeFile(join(dir, DISCOVERY_FILE), JSON.stringify(discovery), 'utf8')
  }

  /** The shim, spawned as an IDE spawns it, with its own user-data directory. */
  async function startShim(clientName = 'spawn-test-client'): Promise<Client> {
    const client = new Client({ name: clientName, version: '0.0.0-test' })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SHIM],
      env: { ...getDefaultEnvironment(), WITENA_USER_DATA: dir },
      // Piped rather than inherited: the shim logs every connection attempt to
      // stderr and a passing run should say nothing.
      stderr: 'pipe'
    })
    await client.connect(transport as unknown as Transport)
    return client
  }

  it(
    'lists the tools with no app, no endpoint and no discovery file',
    async () => {
      // Opening an IDE must not launch Witena: `tools/list` is served from
      // `@shared/mcp-tools` and touches nothing.
      const client = await startShim()
      const listed = await client.listTools()
      expect(listed.tools.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES])
      expect(recorded).toHaveLength(0)
      await client.close()
    },
    60_000
  )

  it(
    'forwards a call with the discovery file’s token and the IDE’s own name',
    async () => {
      await writeDiscovery()
      const client = await startShim('codex')

      const result = await client.callTool({
        name: 'list_chats',
        arguments: { query: 'migration' }
      })

      expect(result.content).toEqual([{ type: 'text', text: 'fine' }])
      expect(result.structuredContent).toEqual({ fine: true })
      expect(recorded).toHaveLength(1)
      expect(recorded[0]?.name).toBe('list_chats')
      expect(recorded[0]?.args).toEqual({ query: 'migration' })
      // `initialize.clientInfo.name`, carried over as CLIENT_HEADER — which is
      // what WP-13 turns into the "via codex" chip on the message.
      expect(recorded[0]?.call.client).toBe('codex')
      await client.close()
    },
    60_000
  )

  it(
    'relays progress across both hops, in order',
    async () => {
      await writeDiscovery()
      behaviour = async (r) => {
        r.call.progress?.({ message: 'Round 1 — Ada, Lin', round: 1 })
        r.call.progress?.({ message: 'Ada has spoken', round: 1 })
        return { ok: true, structured: { status: 'running' }, text: 'still going' }
      }

      const seen: { progress: number; message?: string }[] = []
      const client = await startShim()
      await client.callTool(
        { name: 'wait_for_discussion', arguments: { chatId: 'c', maxWaitSeconds: 5 } },
        undefined,
        {
          onprogress: (p) =>
            seen.push({ progress: p.progress, ...(p.message ? { message: p.message } : {}) })
        }
      )

      expect(seen).toEqual([
        { progress: 1, message: 'Round 1 — Ada, Lin' },
        { progress: 2, message: 'Ada has spoken' }
      ])
      // A `progressToken` reached the endpoint only because the IDE asked for
      // one: the shim passes `onprogress` through, and the SDK mints the
      // second hop's token from it.
      expect(recorded[0]?.call.progress).toBeDefined()
      await client.close()
    },
    60_000
  )

  it(
    'answers a tool error, not a crash, when Witena is up with the endpoint off',
    async () => {
      // No discovery file, but the lock Electron keeps inside userData says an
      // app is there — which is exactly "the switch is off".
      await symlink(`host-${process.pid}`, join(dir, 'SingletonLock'))

      const client = await startShim()
      const result = await client.callTool({ name: 'list_agents', arguments: {} })
      expect(result.isError).toBe(true)
      expect(result.content).toEqual([
        { type: 'text', text: SHIM_ERROR_TEXT['endpoint-off'] }
      ])
      await client.close()
    },
    60_000
  )

  it(
    'says Witena is not running when there is no app and no bundle to launch',
    async () => {
      // Spawned with plain `node`, so `process.execPath` is not inside a
      // `.app`: there is nothing to launch and the shim says so rather than
      // spending twenty seconds finding out.
      const started = Date.now()
      const client = await startShim()
      const result = await client.callTool({ name: 'list_chats', arguments: {} })
      expect(result.isError).toBe(true)
      expect(result.content).toEqual([
        { type: 'text', text: SHIM_ERROR_TEXT['not-running'] }
      ])
      expect(Date.now() - started).toBeLessThan(20_000)
      await client.close()
    },
    60_000
  )

  it(
    'passes a failed tool outcome through unchanged',
    async () => {
      await writeDiscovery()
      behaviour = async () => ({ ok: false, code: 'busy', message: 'That chat is already running.' })
      const client = await startShim()
      const result = await client.callTool({ name: 'start_discussion', arguments: { question: 'x' } })
      expect(result.isError).toBe(true)
      expect(result.content).toEqual([
        { type: 'text', text: 'busy: That chat is already running.' }
      ])
      await client.close()
    },
    60_000
  )

  it(
    'cancels the running tool when the IDE abandons the call',
    async () => {
      // The endpoint is stateless, so `notifications/cancelled` cannot reach
      // the call it names (WP-4). What aborts it is the shim closing the
      // transport it gave this one call — which is the whole reason a client is
      // built per call rather than once.
      await writeDiscovery()
      let aborted: Promise<string> | undefined
      behaviour = async (r) => {
        aborted = new Promise<string>((settle) => {
          r.call.signal.addEventListener('abort', () => settle('aborted'))
        })
        return new Promise<ToolOutcome>(() => undefined)
      }

      const client = await startShim()
      const controller = new AbortController()
      const pending = client.callTool(
        { name: 'wait_for_discussion', arguments: { chatId: 'c' } },
        undefined,
        { signal: controller.signal }
      )
      void pending.catch(() => undefined)

      await expect.poll(() => recorded.length).toBe(1)
      controller.abort()
      await expect(aborted).resolves.toBe('aborted')
      await client.close()
    },
    60_000
  )

  it(
    're-reads the discovery file when the one it cached has gone stale',
    async () => {
      // The app restarted between two calls: same shim process, new token.
      await writeDiscovery({ token: 'stale-token' })
      const client = await startShim()

      const refused = await client.callTool({ name: 'list_chats', arguments: {} })
      expect(refused.isError).toBe(true)
      expect(recorded).toHaveLength(0)

      await writeDiscovery()
      const accepted = await client.callTool({ name: 'list_chats', arguments: {} })
      expect(accepted.isError).toBeUndefined()
      expect(recorded).toHaveLength(1)
      await client.close()
    },
    60_000
  )
})
