/**
 * The endpoint over a real socket, driven by the real MCP client.
 *
 * The registry is a stub — WP-3 owns the six tools and tests them against real
 * handlers, and WP-6's contract test puts the two halves together. What is under
 * test here is only the transport: that a `tools/call` reaches the registry with
 * the right `ToolCallContext`, that `ToolOutcome` becomes the right MCP result,
 * that progress and cancellation cross the wire, and that the five refusals in
 * `guards.ts` are actually in front of the SDK rather than beside it.
 *
 * `ctx` and `handlers` are sentinels: this file proves they arrive, not what
 * they do.
 */
import { createServer, request as httpRequest, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLIENT_HEADER, MCP_PATH, MCP_TOOL_NAMES } from '@shared/mcp-tools'
import type { AppContext } from '../app-context'
import type { HandlerMap } from '../handlers/types'
import { MAX_BODY_BYTES } from './guards'
import { createMcpEndpoint, toCallToolResult, type McpEndpoint } from './server'
import type { ToolCallContext, ToolOutcome, ToolRegistry } from './tool-types'

const TOKEN = 'test-token-0123456789'

/** The two objects the endpoint only ever passes through. */
const CTX = { sentinel: 'ctx' } as unknown as AppContext
const HANDLERS = { sentinel: 'handlers' } as unknown as HandlerMap

/** The body every refusal carries: a JSON-RPC error object with a null id. */
interface JsonRpcError {
  jsonrpc: string
  id: null
  error: { code: number; message: string }
}

/** What one stubbed tool did, as the assertions read it back. */
interface Recorded {
  name: string
  args: unknown
  call: ToolCallContext
}

/**
 * A registry whose every tool records its call and returns what the test set.
 *
 * `behaviour` is swapped per test rather than parameterised per tool: each test
 * calls exactly one tool, and a table of six closures would say less than the
 * one line it replaces.
 */
function stubRegistry(
  recorded: Recorded[],
  behaviour: (r: Recorded) => Promise<ToolOutcome>
): ToolRegistry {
  const entries = MCP_TOOL_NAMES.map((name) => [
    name,
    async (args: unknown, call: ToolCallContext): Promise<ToolOutcome> => {
      const record: Recorded = { name, args, call }
      recorded.push(record)
      return behaviour(record)
    }
  ])
  return Object.fromEntries(entries) as ToolRegistry
}

describe('the MCP endpoint', () => {
  let http: HttpServer
  let endpoint: McpEndpoint
  let origin: string
  let recorded: Recorded[]
  let behaviour: (r: Recorded) => Promise<ToolOutcome>

  beforeEach(async () => {
    recorded = []
    behaviour = async () => ({ ok: true, structured: { fine: true }, text: 'fine' })
    endpoint = createMcpEndpoint({
      ctx: CTX,
      handlers: HANDLERS,
      token: TOKEN,
      tools: stubRegistry(recorded, (r) => behaviour(r))
    })
    http = createServer((req, res) => {
      void endpoint.handle(req, res)
    })
    await new Promise<void>((settle) => http.listen(0, '127.0.0.1', settle))
    origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await endpoint.close()
    await new Promise<void>((settle) => {
      http.close(() => settle())
      http.closeAllConnections()
    })
  })

  /**
   * A connected SDK client, with the bearer token and optionally a client name.
   *
   * The transport is cast for the same reason `src/main/mcp/manager.ts` casts
   * its own: `StreamableHTTPClientTransport.sessionId` is `string | undefined`
   * where `Transport` declares `sessionId?: string`, which under
   * `exactOptionalPropertyTypes` are different types. Identical at runtime.
   */
  async function connect(client?: string): Promise<Client> {
    const mcp = new Client({ name: client ?? 'direct', version: '0.0.0-test' })
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}${MCP_PATH}`), {
      requestInit: {
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(client !== undefined ? { [CLIENT_HEADER]: client } : {})
        }
      }
    })
    await mcp.connect(transport as unknown as Transport)
    return mcp
  }

  /** A raw request, for the refusals no MCP client would let us send. */
  function raw(init: { path?: string; headers?: Record<string, string>; body?: string }) {
    return fetch(`${origin}${init.path ?? MCP_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TOKEN}`,
        ...init.headers
      },
      body: init.body ?? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
  }

  /** A request with headers `fetch` refuses to send, such as `Host`. */
  function rawNodeRequest(headers: Record<string, string>): Promise<{
    status: number
    body: string
  }> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    return new Promise((settle, fail) => {
      const request = httpRequest(
        `${origin}${MCP_PATH}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${TOKEN}`,
            'content-length': Buffer.byteLength(body),
            ...headers
          }
        },
        (response) => {
          let text = ''
          response.setEncoding('utf8')
          response.on('data', (chunk: string) => {
            text += chunk
          })
          response.on('end', () => settle({ status: response.statusCode ?? 0, body: text }))
        }
      )
      request.on('error', fail)
      request.end(body)
    })
  }

  /* ---------------------------------------------------------------------- */
  /* The protocol                                                            */
  /* ---------------------------------------------------------------------- */

  it('lists exactly the shared tool definitions', async () => {
    const mcp = await connect()
    const listed = await mcp.listTools()
    expect(listed.tools.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES])
    for (const tool of listed.tools) {
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.description?.length ?? 0).toBeGreaterThan(0)
    }
    await mcp.close()
  })

  it('hands a call to the registry with the arguments, ctx, handlers and client', async () => {
    const mcp = await connect('codex')
    const result = await mcp.callTool({ name: 'list_chats', arguments: { query: 'migration' } })

    expect(result.content).toEqual([{ type: 'text', text: 'fine' }])
    expect(result.structuredContent).toEqual({ fine: true })
    expect(result.isError).toBeUndefined()

    expect(recorded).toHaveLength(1)
    const [call] = recorded
    expect(call?.name).toBe('list_chats')
    expect(call?.args).toEqual({ query: 'migration' })
    expect(call?.call.ctx).toBe(CTX)
    expect(call?.call.handlers).toBe(HANDLERS)
    expect(call?.call.client).toBe('codex')
    expect(call?.call.signal.aborted).toBe(false)
    await mcp.close()
  })

  it('leaves `client` undefined for a caller that sends no client header', async () => {
    const mcp = await connect()
    await mcp.callTool({ name: 'list_agents', arguments: {} })
    expect(recorded[0]?.call.client).toBeUndefined()
    await mcp.close()
  })

  it('turns a failed outcome into isError with "<code>: <message>"', async () => {
    behaviour = async () => ({ ok: false, code: 'busy', message: 'That chat is already running.' })
    const mcp = await connect()
    const result = await mcp.callTool({ name: 'start_discussion', arguments: { question: 'x' } })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'busy: That chat is already running.' }])
    expect(result.structuredContent).toBeUndefined()
    await mcp.close()
  })

  it('turns a tool that throws into one readable failure, with no stack', async () => {
    behaviour = async () => {
      throw new Error('the registry is not supposed to throw')
    }
    const mcp = await connect()
    const result = await mcp.callTool({ name: 'get_discussion', arguments: { chatId: 'c' } })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      { type: 'text', text: 'internal: the registry is not supposed to throw' }
    ])
    await mcp.close()
  })

  it('refuses a tool it does not have as a protocol error', async () => {
    const mcp = await connect()
    // "Errors in finding the tool" are the specification's own example of what
    // belongs in a JSON-RPC error rather than in `isError`.
    await expect(mcp.callTool({ name: 'delete_everything', arguments: {} })).rejects.toThrow(
      /Unknown tool: delete_everything/
    )
    expect(recorded).toHaveLength(0)
    await mcp.close()
  })

  /* ---------------------------------------------------------------------- */
  /* Progress                                                                */
  /* ---------------------------------------------------------------------- */

  it('relays progress in order while the call is still open', async () => {
    behaviour = async (r) => {
      r.call.progress?.({ message: 'Round 1 — Ada, Lin', round: 1 })
      r.call.progress?.({ message: 'Ada has spoken', round: 1 })
      r.call.progress?.({ message: 'Round 2 — Ada, Lin', round: 2 })
      return { ok: true, structured: { status: 'running' }, text: 'still going' }
    }

    const seen: { progress: number; message?: string }[] = []
    const mcp = await connect()
    await mcp.callTool({ name: 'wait_for_discussion', arguments: { chatId: 'c' } }, undefined, {
      onprogress: (p) => seen.push({ progress: p.progress, ...(p.message ? { message: p.message } : {}) })
    })

    expect(seen).toEqual([
      { progress: 1, message: 'Round 1 — Ada, Lin' },
      { progress: 2, message: 'Ada has spoken' },
      { progress: 3, message: 'Round 2 — Ada, Lin' }
    ])
    await mcp.close()
  })

  it('gives a caller that asked for no progress no progress callback at all', async () => {
    const mcp = await connect()
    await mcp.callTool({ name: 'wait_for_discussion', arguments: { chatId: 'c' } })
    // A tool must be able to tell "nobody is listening" from "listening but
    // nothing happened", so the callback is absent rather than a no-op.
    expect(recorded[0]?.call.progress).toBeUndefined()
    await mcp.close()
  })

  /* ---------------------------------------------------------------------- */
  /* Cancellation                                                            */
  /* ---------------------------------------------------------------------- */

  it('aborts the tool’s signal when the caller drops the HTTP request', async () => {
    // The endpoint is stateless, so a `notifications/cancelled` arrives as its
    // own HTTP request and reaches a Server that never heard of the call it
    // names. What cancels a Witena tool call is abandoning its request, which is
    // what the shim (WP-5) has to do — and what this drives directly.
    let aborted: Promise<string> | undefined
    behaviour = async (r) => {
      aborted = new Promise<string>((settle) => {
        r.call.signal.addEventListener('abort', () => settle('aborted'))
      })
      // Never settles on its own: only the abort can end this call.
      return new Promise<ToolOutcome>(() => undefined)
    }

    const controller = new AbortController()
    const pending = fetch(`${origin}${MCP_PATH}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TOKEN}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'wait_for_discussion', arguments: { chatId: 'c' } }
      })
    })
    void pending.catch(() => undefined)

    await expect.poll(() => recorded.length).toBe(1)
    controller.abort()
    await expect(aborted).resolves.toBe('aborted')
  })

  it('aborts the tool’s signal when an SDK client closes mid-call', async () => {
    let aborted: Promise<string> | undefined
    behaviour = async (r) => {
      aborted = new Promise<string>((settle) => {
        r.call.signal.addEventListener('abort', () => settle('aborted'))
      })
      return new Promise<ToolOutcome>(() => undefined)
    }

    const mcp = await connect()
    void mcp.callTool({ name: 'wait_for_discussion', arguments: { chatId: 'c' } }).catch(
      () => undefined
    )
    await expect.poll(() => recorded.length).toBe(1)

    // `Client.close()` aborts the transport's fetches, the response closes, and
    // the endpoint closes the transport — which is what reaches `signal`.
    await mcp.close()
    await expect(aborted).resolves.toBe('aborted')
  })

  it('aborts every in-flight call when the endpoint itself is closed', async () => {
    const aborts: string[] = []
    behaviour = async (r) => {
      r.call.signal.addEventListener('abort', () => aborts.push(r.name))
      return new Promise<ToolOutcome>(() => undefined)
    }

    const mcp = await connect()
    const call = mcp.callTool({ name: 'wait_for_discussion', arguments: { chatId: 'c' } })
    void call.catch(() => undefined)
    await expect.poll(() => recorded.length).toBe(1)

    await endpoint.close()
    expect(aborts).toEqual(['wait_for_discussion'])
    await mcp.close()
  })

  /* ---------------------------------------------------------------------- */
  /* The refusals, in front of the SDK                                       */
  /* ---------------------------------------------------------------------- */

  it('answers 404 on any other path and never reaches a tool', async () => {
    const response = await raw({ path: '/api/chats.list' })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ jsonrpc: '2.0', id: null })
    expect(recorded).toHaveLength(0)
  })

  it('answers 403 to anything carrying an Origin', async () => {
    const response = await raw({ headers: { origin: 'https://evil.test' } })
    expect(response.status).toBe(403)
    expect(((await response.json()) as JsonRpcError).error.message).toContain('Origin')
  })

  it('answers 403 to a foreign Host, which is the rebinding case', async () => {
    // `fetch` will not let a caller set Host — it is a forbidden header name —
    // so the request that a rebound page would send is written with the lower
    // level client, which is also the only honest way to test this guard.
    const response = await rawNodeRequest({ host: 'evil.test' })
    expect(response.status).toBe(403)
    expect((JSON.parse(response.body) as JsonRpcError).error.message).toContain('Host')
  })

  it('answers 403 to loopback on somebody else’s port', async () => {
    const response = await rawNodeRequest({ host: '127.0.0.1:1' })
    expect(response.status).toBe(403)
  })

  it('answers 401 to a missing or wrong bearer token', async () => {
    expect((await raw({ headers: { authorization: '' } })).status).toBe(401)
    expect((await raw({ headers: { authorization: 'Bearer nope' } })).status).toBe(401)
  })

  it('answers 413 to a body over the cap without parsing it', async () => {
    const response = await raw({ body: `{"padding":"${'x'.repeat(MAX_BODY_BYTES)}"}` })
    expect(response.status).toBe(413)
    expect(recorded).toHaveLength(0)
  })

  it('refuses everything once it has been closed', async () => {
    await endpoint.close()
    expect((await raw({})).status).toBe(503)
  })
})

/* -------------------------------------------------------------------------- */
/* The outcome mapping, without a socket                                       */
/* -------------------------------------------------------------------------- */

describe('ToolOutcome on the wire', () => {
  it('keeps a plain object as structuredContent', () => {
    expect(toCallToolResult({ ok: true, structured: { a: 1 }, text: 'a' })).toEqual({
      content: [{ type: 'text', text: 'a' }],
      structuredContent: { a: 1 }
    })
  })

  it('drops a structured value MCP has no place for, rather than inventing a key', () => {
    // `structuredContent` is a JSON object or nothing; `text` is a complete
    // rendering of the same value either way, so a wrapper would be a field no
    // caller knows to unwrap.
    for (const structured of [[1, 2], 'text', 7, null, undefined]) {
      const result = toCallToolResult({ ok: true, structured, text: 'rendered' })
      expect(result.structuredContent).toBeUndefined()
      expect(result.content).toEqual([{ type: 'text', text: 'rendered' }])
    }
  })
})
