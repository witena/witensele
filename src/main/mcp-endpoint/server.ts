/**
 * Witena as an MCP **server**, over Streamable HTTP.
 *
 * This is the third transport beside Electron IPC (`src/main/ipc/register.ts`)
 * and the Node host (`src/server/http.ts`), and like them it owns no business
 * logic: it authenticates the caller, turns one HTTP request into one MCP
 * exchange, and hands `tools/call` to a `ToolRegistry` that reaches storage only
 * through `HandlerMap`. Everything it knows about the tools themselves comes
 * from `@shared/mcp-tools`, which the shim publishes verbatim.
 *
 * ```
 * shim (or any MCP client) → POST /mcp  →  guards.ts        → 401 / 403 / 413
 *                                       →  Server + transport (one per request)
 *                                       →  tools/list  → MCP_TOOLS
 *                                       →  tools/call  → ToolRegistry → ToolOutcome
 * ```
 *
 * **Stateless, by PLAN's decision.** `sessionIdGenerator: undefined` and a fresh
 * `Server` + `StreamableHTTPServerTransport` per request: a discussion's state
 * is the chat, not an MCP session, so an IDE that restarts mid-discussion picks
 * it up again with `get_discussion` and there is no session table to expire. The
 * SDK requires a fresh transport per request in this mode and says so.
 *
 * **Cancellation.** Stateless costs one thing, and it is worth stating plainly
 * because the shim (WP-5) has to work around it: a `notifications/cancelled`
 * sent by the client arrives as its *own* HTTP request, so it reaches a new
 * `Server` instance that has never heard of the request it names. It therefore
 * cannot abort it. What does abort a running tool is the socket: when the caller
 * drops the HTTP request, the response closes, this module closes the transport,
 * and the SDK's `Protocol._onclose` aborts every in-flight request handler —
 * which is the `signal` in `ToolCallContext`. So *a client cancels a Witena tool
 * call by abandoning its HTTP request*, not by sending a notification. For the
 * shim that means closing (or per-call scoping) its `StreamableHTTPClientTransport`.
 *
 * **Progress.** `notifications/progress` needs a `progressToken`, and a client
 * only gets one by asking: the SDK client sets it when `onprogress` is passed.
 * When it is absent, `ToolCallContext.progress` is left undefined and the tool
 * simply does not report — nothing in a discussion depends on progress arriving
 * (PLAN.md's decision table). The MCP progress shape has `progress` (a number)
 * and `message` and nothing else, so the round a `ProgressUpdate` carries rides
 * in the message text WP-2 writes ("Round 2 — Ada, Lin") and `progress` counts
 * the updates, which keeps it monotonically increasing as the spec requires.
 *
 * No electron (CLAUDE.md rule 5); `no-electron.test.ts` in this folder proves it
 * for the whole import closure.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool
} from '@modelcontextprotocol/sdk/types.js'
import {
  MCP_PATH,
  MCP_SERVER_NAME,
  MCP_TOOL_NAMES,
  MCP_TOOLS,
  type McpToolName
} from '@shared/mcp-tools'
import { APP_VERSION } from '@shared/version'
import type { AppContext } from '../app-context'
import type { HandlerMap } from '../handlers/types'
import {
  clientNameFrom,
  guardHeaders,
  isMcpPath,
  readBody,
  sendRefusal,
  type GuardRefusal
} from './guards'
import type { ToolCallContext, ToolOutcome, ToolRegistry } from './tool-types'
import { createTools } from './tools'

export interface McpEndpointOptions {
  ctx: AppContext
  handlers: HandlerMap
  /** The bearer token of this launch, as the discovery file publishes it. */
  token: string
  /** Defaults to `createTools()`; the transport's own tests pass a stub. */
  tools?: ToolRegistry
}

export interface McpEndpoint {
  /** Answers every request on `MCP_PATH`; anything else is the caller's. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  close(): Promise<void>
}

/**
 * The default registry: the six real tools.
 *
 * This was the one seam WP-3 filled — until `tools.ts` existed, the body threw a
 * sentence naming the step, because importing a module that is not there would
 * not compile and a silently empty registry would turn a wiring mistake into six
 * tools that answer "unknown tool". A caller that wants something else (WP-4's
 * own tests pass a stub) still passes `tools`.
 */
function defaultToolRegistry(): ToolRegistry {
  return createTools()
}

/** `MCP_TOOL_NAMES` as a set, so an unknown `tools/call` name is one lookup. */
const TOOL_NAMES: ReadonlySet<string> = new Set<string>(MCP_TOOL_NAMES)

function isToolName(name: string): name is McpToolName {
  return TOOL_NAMES.has(name)
}

/**
 * The `tools/list` payload.
 *
 * `McpToolDefinition.inputSchema` is a `Record<string, unknown>` because
 * `@shared/mcp-tools` may not import the SDK — the shim bundles that module and
 * would bundle the SDK's type surface with it. `mcp-tools.test.ts` asserts every
 * schema is an object schema with `type: 'object'`, which is exactly what the
 * SDK's `ToolSchema` requires, so the cast asserts something already proven.
 */
const LISTED_TOOLS = MCP_TOOLS as readonly unknown[] as Tool[]

/**
 * `ToolOutcome` → the MCP result.
 *
 * A failure is `isError: true` with `"<code>: <message>"` rather than a JSON-RPC
 * error, so the calling model can read what went wrong and correct itself — the
 * specification's own reasoning, and the reason `validation` messages from
 * `MCP_TOOL_INPUTS` are worth writing well.
 *
 * `structuredContent` is only set when `structured` is a plain object, because
 * that is all MCP allows there (`z.record(z.string(), z.unknown())`). An array
 * or a primitive is dropped rather than wrapped in an invented key: `text` is a
 * complete rendering of the same value, and a wrapper would be a field WP-3 did
 * not write and no caller knows to unwrap. Tools return objects.
 */
export function toCallToolResult(outcome: ToolOutcome): CallToolResult {
  if (!outcome.ok) {
    return {
      content: [{ type: 'text', text: `${outcome.code}: ${outcome.message}` }],
      isError: true
    }
  }
  const structured = outcome.structured
  const isPlainObject =
    typeof structured === 'object' && structured !== null && !Array.isArray(structured)
  return {
    content: [{ type: 'text', text: outcome.text }],
    ...(isPlainObject ? { structuredContent: structured as Record<string, unknown> } : {})
  }
}

/** The endpoint is shut: answered rather than dropped, so a caller sees a reason. */
const CLOSED: GuardRefusal = {
  status: 503,
  code: -32000,
  message: 'The Witena MCP endpoint is shutting down.'
}

/** Anything that is not `MCP_PATH`. */
const NO_ROUTE: GuardRefusal = {
  status: 404,
  code: -32000,
  message: `The Witena MCP endpoint serves ${MCP_PATH} only.`
}

export function createMcpEndpoint(o: McpEndpointOptions): McpEndpoint {
  const tools = o.tools ?? defaultToolRegistry()

  /** Everything still on the wire, so `close()` can end it. */
  const open = new Set<{ server: Server; transport: StreamableHTTPServerTransport }>()
  let closed = false

  /**
   * One MCP server for one HTTP request.
   *
   * `client` is captured here rather than read from `extra.requestInfo` inside
   * the handler: this instance serves exactly one request, so the closure is the
   * simpler and more honest place for a per-request value.
   */
  function buildServer(client: string | undefined): Server {
    const server = new Server(
      { name: MCP_SERVER_NAME, version: APP_VERSION },
      { capabilities: { tools: {} } }
    )

    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: LISTED_TOOLS }))

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = request.params.name
      if (!isToolName(name)) {
        // A name that is not one of ours is a bug in the caller, not a failed
        // tool — the specification asks for a protocol error for "errors in
        // finding the tool", and the shim serves `tools/list` from the same
        // table, so this is only reachable by a direct client or version skew.
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`)
      }

      const progressToken = extra._meta?.progressToken
      let sent = 0
      const progress =
        progressToken === undefined
          ? undefined
          : (update: { message: string; round?: number }): void => {
              sent += 1
              void extra
                .sendNotification({
                  method: 'notifications/progress',
                  params: { progressToken, progress: sent, message: update.message }
                })
                // A caller that went away mid-discussion is ordinary; the run
                // keeps going and the tool must not see an exception for it.
                .catch(() => undefined)
            }

      const call: ToolCallContext = {
        ctx: o.ctx,
        handlers: o.handlers,
        signal: extra.signal,
        ...(client !== undefined ? { client } : {}),
        ...(progress !== undefined ? { progress } : {})
      }

      try {
        return toCallToolResult(await tools[name](request.params.arguments ?? {}, call))
      } catch (cause) {
        // The registry's contract is that it never throws. This is the net under
        // it: a bug in one tool becomes one failed call the model can read,
        // never a dead MCP server and never a stack on the wire.
        return toCallToolResult({
          ok: false,
          code: 'internal',
          message: cause instanceof Error ? cause.message : String(cause)
        })
      }
    })

    return server
  }

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let parsedBody: unknown
    if (req.method === 'POST') {
      const body = await readBody(req)
      if (!body.ok) {
        sendRefusal(res, body.refusal)
        return
      }
      parsedBody = body.value
    }

    const server = buildServer(clientNameFrom(req.headers))
    /*
     * Stateless, per the file header. The SDK spells that
     * `{ sessionIdGenerator: undefined }`, which does not type-check under
     * `exactOptionalPropertyTypes` — the option is declared `?: () => string`.
     * Omitting the key is the same property read at runtime, and the same
     * mismatch `src/main/mcp/manager.ts` documents for the client transport.
     */
    const transport = new StreamableHTTPServerTransport({})
    const entry = { server, transport }
    open.add(entry)

    // Both the ordinary end of a response and a caller that hung up arrive here.
    // Closing the transport is what aborts an in-flight tool call, so this line
    // is the whole of "Cancellation" above.
    res.on('close', () => {
      open.delete(entry)
      void transport.close()
      void server.close()
    })

    // `StreamableHTTPServerTransport` declares `onclose: (() => void) | undefined`
    // while the `Transport` interface it implements declares `onclose?: () => void`;
    // under `exactOptionalPropertyTypes` the SDK's own class does not satisfy the
    // SDK's own interface. Identical at runtime — see `src/main/mcp/manager.ts`,
    // which reconciles the mirror image of this on the client side.
    await server.connect(transport as unknown as Transport)
    await transport.handleRequest(req, res, parsedBody)
  }

  return {
    async handle(req, res) {
      if (!isMcpPath(req.url)) {
        sendRefusal(res, NO_ROUTE)
        return
      }
      if (closed) {
        sendRefusal(res, CLOSED)
        return
      }

      const refusal = guardHeaders(req.headers, req.socket.localPort, o.token)
      if (refusal !== null) {
        sendRefusal(res, refusal)
        return
      }

      try {
        await serve(req, res)
      } catch (cause) {
        // The mirror of `src/server/http.ts`'s catch: a failure inside the
        // transport leaves as one JSON body, never as an HTML error page and
        // never as a half-written response.
        if (res.headersSent) {
          res.destroy()
          return
        }
        sendRefusal(res, {
          status: 500,
          code: ErrorCode.InternalError,
          message: cause instanceof Error ? cause.message : String(cause)
        })
      }
    },

    async close() {
      closed = true
      const entries = [...open]
      open.clear()
      await Promise.all(
        entries.map(async (entry) => {
          await entry.transport.close()
          await entry.server.close()
        })
      )
    }
  }
}
