/**
 * A real MCP server, in this process.
 *
 * The MCP SDK ships both halves of the protocol and an `InMemoryTransport` that
 * links them, so a test can exercise `McpManager` against a **genuine** server —
 * real `initialize`, real `tools/list`, real `tools/call`, real error semantics —
 * with no child process, no `npx` download and no network. That is strictly
 * better than a hand-written fake transport, which would only prove that the
 * manager agrees with the fake.
 *
 * Not imported by any production module, exactly like `db/testing.ts`, so it
 * never reaches the bundle.
 */
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { CreateTransport } from './manager'

/** How long `slow` waits before answering, so a timeout test has room to fire. */
export const SLOW_TOOL_DELAY_MS = 5_000

export interface InMemoryMcpOptions {
  /** Advertised server name. Irrelevant to the client; useful in a failure message. */
  name?: string
  /** Tools every connection offers. Defaults to `echo`, `fail` and `slow`. */
  register?: (server: McpServer) => void
}

/** `echo` answers, `fail` reports `isError`, `slow` never answers in time. */
function registerDefaultTools(server: McpServer): void {
  server.registerTool(
    'echo',
    { description: 'Echoes the message back', inputSchema: { message: z.string() } },
    async ({ message }) => ({ content: [{ type: 'text' as const, text: `Echo: ${message}` }] })
  )

  server.registerTool(
    'fail',
    { description: 'Always reports a tool error', inputSchema: {} },
    async () => ({ isError: true, content: [{ type: 'text' as const, text: 'the tool exploded' }] })
  )

  server.registerTool(
    'slow',
    { description: 'Answers after a very long time', inputSchema: {} },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, SLOW_TOOL_DELAY_MS))
      return { content: [{ type: 'text' as const, text: 'finally' }] }
    }
  )
}

/**
 * A transport factory for `McpManager`, backed by an in-process server.
 *
 * One server per transport, because `McpServer.connect` takes ownership of the
 * transport it is given — reusing a server across two connections would have the
 * second one talking over the first one's pipe.
 */
export function inMemoryTransport(options: InMemoryMcpOptions = {}): CreateTransport {
  const register = options.register ?? registerDefaultTools

  return async () => {
    const server = new McpServer({ name: options.name ?? 'witena-test', version: '1.0.0' })
    register(server)
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    return clientSide
  }
}

/** A factory whose connection always fails, for the unreachable-server cases. */
export function failingTransport(message = 'connection refused'): CreateTransport {
  return () => {
    throw new Error(message)
  }
}
