/**
 * The shim's MCP server: every method it answers, and how.
 *
 * Separated from `index.ts` — which is the bundle's *entry point* and starts a
 * stdio transport the moment it is loaded — so that the behaviour can be driven
 * by a test without a process, a socket or a real `stdin`. `index.ts` keeps the
 * wiring (the real connector, the real transport, the bootstrap); everything
 * that decides what an MCP request means is here.
 *
 * ```
 *                    initialize ───┐ the SDK's; the client's name is remembered
 *                    tools/list ───┤ answered here, from @shared/mcp-tools — no I/O
 *                   prompts/list ──┤ answered here, from @shared/mcp-tools — no I/O
 *                   prompts/get ───┤ answered here: the expansion is a pure function
 *                  resources/list ─┤ forwarded when Witena is already up; [] otherwise
 *                  resources/read ─┤ forwarded when Witena is already up; an error otherwise
 *                    tools/call ───┴─▶ connector.open(), launching Witena if need be
 * ```
 *
 * **Which methods may launch the app** (WP-15's decision, and the whole reason
 * the connector has two ways in):
 *
 * | Method | Connects | Launches | Why |
 * |---|---|---|---|
 * | `initialize`, `tools/list`, `prompts/list`, `prompts/get` | never | never | Answered from `@shared/mcp-tools`. WP-0b measured Claude Code asking for all three on every session start |
 * | `resources/list` | when a discovery file already describes a live app | **no** | Same session-start listing; an empty list is the honest answer when Witena is not there |
 * | `resources/read` | same | **no** | A browse, not a request for work. The refusal names the switch instead, and a tool call is one step away |
 * | `tools/call` | yes | **yes** | The user asked the group a question; that is worth waking the app for |
 *
 * **Cancellation and progress cross in both directions.** A forwarded call gets
 * its own `Client` and its own transport, so aborting the incoming request
 * closes exactly that HTTP request — which is the only thing that aborts a
 * running tool at the other end, the endpoint being stateless (WP-4). Progress
 * is relayed only when the *IDE* asked for it, because a `notifications/progress`
 * with a token nobody issued is a protocol error rather than a courtesy.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Prompt,
  type Tool
} from '@modelcontextprotocol/sdk/types.js'
import {
  DEFAULT_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
  MCP_PROMPTS,
  MCP_SERVER_NAME,
  MCP_TOOLS,
  MIN_WAIT_SECONDS,
  renderPrompt
} from '@shared/mcp-tools'
import { APP_VERSION } from '@shared/version'
import { RESOURCE_UNAVAILABLE_TEXT, ShimError, type Connector } from './connect'

/**
 * The `tools/list` payload.
 *
 * The same cast, for the same reason, as `src/main/mcp-endpoint/server.ts`:
 * `@shared/mcp-tools` may not import the SDK (the shim bundles that module and
 * would bundle the SDK's type surface with it), so `inputSchema` is typed as a
 * plain record there. `mcp-tools.test.ts` asserts every schema is an object
 * schema with `type: 'object'`, which is what `ToolSchema` requires.
 */
const LISTED_TOOLS = MCP_TOOLS as readonly unknown[] as Tool[]

/** The `prompts/list` payload, cast for the same reason as `LISTED_TOOLS`. */
const LISTED_PROMPTS = MCP_PROMPTS as readonly unknown[] as Prompt[]

/**
 * How much longer than the discussion's own budget the shim waits for the
 * endpoint to answer.
 *
 * The endpoint's waiting tools return by `maxWaitSeconds` whether the group is
 * finished or not, so the only thing this margin has to cover is the round
 * trip plus the endpoint's own bookkeeping. Without it the SDK's default
 * 60-second request timeout would abort every `maxWaitSeconds` above ~60 —
 * silently, and with the discussion still running at the other end.
 */
export const FORWARD_MARGIN_MS = 30_000

/**
 * The timeout for one forwarded call, derived from the arguments the caller
 * sent.
 *
 * Read from the arguments rather than fixed at `MAX_WAIT_SECONDS`, so a shim
 * whose endpoint has stopped answering fails in about as long as the caller
 * asked to wait instead of in ten minutes. A value outside the contract's
 * bounds is ignored here and refused at the other end, which is where the
 * message a model can act on comes from.
 */
export function forwardTimeoutMs(args: unknown): number {
  const raw =
    typeof args === 'object' && args !== null
      ? (args as { maxWaitSeconds?: unknown }).maxWaitSeconds
      : undefined
  const seconds =
    typeof raw === 'number' && Number.isFinite(raw) && raw >= MIN_WAIT_SECONDS && raw <= MAX_WAIT_SECONDS
      ? raw
      : DEFAULT_WAIT_SECONDS
  return seconds * 1000 + FORWARD_MARGIN_MS
}

/** A refusal the calling model can read, in the shape every MCP client renders. */
export function toolErrorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/**
 * The shim's MCP server.
 *
 * Takes its connector by injection so the spawn test can drive the real thing
 * and `index.test.ts` can drive this without a socket.
 */
export function createShimServer(connector: Connector, log: (line: string) => void): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: APP_VERSION },
    // The same three the endpoint declares, and for the same reason no
    // `subscribe` or `listChanged`: the endpoint is stateless, so there is
    // nothing to subscribe to and nothing that could announce a change.
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  )

  /**
   * `initialize.clientInfo.name` — `claude-code`, `codex`, whatever the client
   * calls itself. It travels as `CLIENT_HEADER` and becomes the "via …" chip on
   * the message the endpoint sends (WP-13). Display data, never an identity.
   */
  const clientName = (): string | undefined => server.getClientVersion()?.name

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: LISTED_TOOLS }))

  /* ---------------------------------------------------------------------- */
  /* Prompts: answered here, with no I/O at all                              */
  /* ---------------------------------------------------------------------- */

  server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: LISTED_PROMPTS }))

  server.setRequestHandler(GetPromptRequestSchema, (request) => {
    // `renderPrompt` is a pure function of the arguments and lives in
    // `@shared/mcp-tools`, so forwarding this would be a round trip — and a
    // launch — for a string this process can already produce. The endpoint runs
    // the same function, so the two can never answer differently.
    const rendered = renderPrompt(request.params.name, request.params.arguments)
    if (!rendered.ok) throw new McpError(ErrorCode.InvalidParams, rendered.message)
    return { description: rendered.description, messages: rendered.messages }
  })

  /* ---------------------------------------------------------------------- */
  /* Resources: forwarded, but only to an app that is already running        */
  /* ---------------------------------------------------------------------- */

  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const client = await connector.openIfRunning(clientName())
    if (client === null) {
      // Claude Code asks for this on every session start. An empty list is what
      // "Witena is not open" looks like; launching the app to fill it in would
      // start Witena every time the user opened an editor.
      log('resources/list: Witena is not running, answering an empty list')
      return { resources: [] }
    }
    try {
      return await client.listResources(request.params)
    } catch (cause) {
      // A listing is a courtesy: an endpoint that answered badly is the same to
      // the picker as an endpoint that is not there, and an error here would
      // surface as a broken `@`-mention menu rather than as an empty one.
      log(`resources/list: ${cause instanceof Error ? cause.message : String(cause)}`)
      return { resources: [] }
    } finally {
      await client.close().catch(() => undefined)
    }
  })

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const client = await connector.openIfRunning(clientName())
    if (client === null) {
      // A read names one thing, so an empty answer would be a lie. This is a
      // JSON-RPC error rather than a tool result because `resources/read` has
      // no `isError` shape to put a sentence in.
      log(`resources/read ${request.params.uri}: Witena is not running`)
      throw new McpError(ErrorCode.InternalError, RESOURCE_UNAVAILABLE_TEXT)
    }
    try {
      // Errors from the endpoint — an unknown chat, a uri that is not ours —
      // are already `McpError`s written for this reader, so they travel as they
      // are rather than being rewritten by a relay.
      return await client.readResource(request.params)
    } finally {
      await client.close().catch(() => undefined)
    }
  })

  // Nothing to expand: every chat resource is a concrete uri that
  // `resources/list` already names. Answered rather than left out because Codex
  // asks for it (WP-0b saw the handler in its binary), and an empty list is
  // truthful where `Method not found` is noise in somebody's log.
  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: [] }))

  /* ---------------------------------------------------------------------- */
  /* Tools: the one method that may launch Witena                            */
  /* ---------------------------------------------------------------------- */

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    let client
    try {
      client = await connector.open(clientName())
    } catch (cause) {
      if (cause instanceof ShimError) {
        log(`${request.params.name}: ${cause.kind}`)
        return toolErrorResult(cause.message)
      }
      log(`${request.params.name}: ${cause instanceof Error ? cause.message : String(cause)}`)
      return toolErrorResult(
        `Could not reach Witena's MCP endpoint: ${cause instanceof Error ? cause.message : String(cause)}`
      )
    }

    // Closing this call's transport is what drops its HTTP request, and
    // dropping the HTTP request is the only thing that aborts the tool running
    // at the other end (the endpoint is stateless, so `notifications/cancelled`
    // reaches a Server that never heard of the call). Hence one client per
    // call, and hence this listener.
    const cancel = (): void => {
      log(`${request.params.name}: cancelled by the client; dropping the request`)
      void client.close().catch(() => undefined)
    }
    extra.signal.addEventListener('abort', cancel, { once: true })

    const progressToken = extra._meta?.progressToken
    const args = request.params.arguments ?? {}

    try {
      return await client.callTool(
        // Only the name and the arguments are forwarded. The incoming `_meta`
        // carries the *IDE's* progress token, which means nothing to the
        // endpoint; the SDK mints this hop's own token when `onprogress` is
        // passed below.
        { name: request.params.name, arguments: args },
        {
          signal: extra.signal,
          timeout: forwardTimeoutMs(args),
          ...(progressToken === undefined
            ? {}
            : {
                onprogress: (progress): void => {
                  void extra
                    .sendNotification({
                      method: 'notifications/progress',
                      params: {
                        progressToken,
                        progress: progress.progress,
                        ...(progress.message !== undefined ? { message: progress.message } : {})
                      }
                    })
                    // An IDE that stopped listening is ordinary; the discussion
                    // keeps going and the call must not fail over a courtesy.
                    .catch(() => undefined)
                }
              })
        }
      )
    } catch (cause) {
      if (extra.signal.aborted) throw cause
      log(`${request.params.name}: ${cause instanceof Error ? cause.message : String(cause)}`)
      return toolErrorResult(
        `The call to Witena failed: ${cause instanceof Error ? cause.message : String(cause)}`
      )
    } finally {
      extra.signal.removeEventListener('abort', cancel)
      await client.close().catch(() => undefined)
    }
  })

  return server
}
