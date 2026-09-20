/**
 * `witena-mcp` — the command an IDE runs.
 *
 * Every MCP client speaks stdio; not all of them speak Streamable HTTP, and
 * none of them can be told a port that is chosen at launch. So the thing an IDE
 * is configured with is this: one bundled `.cjs` file, run by the app's own
 * binary with `ELECTRON_RUN_AS_NODE=1` (WP-9's `bin/witena-mcp`), which speaks
 * stdio to the IDE and Streamable HTTP to the app.
 *
 * ```
 * Claude Code / Codex ──stdio──▶ witena-mcp ──HTTP 127.0.0.1:<ephemeral>──▶ Witena
 *                                  │
 *                    initialize ───┤ answered here (remembers clientInfo.name)
 *                    tools/list ───┤ answered here, from @shared/mcp-tools — no I/O
 *                    tools/call ───┴─▶ connect(), then forwarded
 * ```
 *
 * **Opening an IDE must not launch Witena.** That is why `tools/list` is served
 * from the shared table rather than fetched, and why `connect()` happens on the
 * first `tools/call` and not at startup: an editor that starts ten MCP servers
 * when it opens a project would otherwise start Witena ten times a day for
 * nothing. Codex also gives a server only a few seconds to come up, and a shim
 * that answered `initialize` by launching an app would lose that race.
 *
 * **stdout is the protocol.** Every diagnostic in this process goes to stderr,
 * which is where an IDE collects MCP server logs; one stray `console.log` would
 * be a parse error at the other end and a server that "crashed on startup".
 *
 * **Cancellation and progress cross in both directions.** A forwarded call gets
 * its own `Client` and its own transport, so aborting the incoming request
 * closes exactly that HTTP request — which is the only thing that aborts a
 * running tool at the other end, the endpoint being stateless (WP-4). Progress
 * is relayed only when the *IDE* asked for it, because a `notifications/progress`
 * with a token nobody issued is a protocol error rather than a courtesy.
 *
 * The import closure here is `@modelcontextprotocol/sdk`, `zod` (through
 * `@shared/mcp-tools`) and three `node:` builtins. No electron, no
 * `better-sqlite3`, nothing under `src/main/` — `no-electron.test.ts` walks it.
 */
import { spawn } from 'node:child_process'
import { readFile, readlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from '@modelcontextprotocol/sdk/types.js'
import type { McpDiscovery } from '@shared/mcp-discovery'
import {
  DEFAULT_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
  MCP_SERVER_NAME,
  MCP_TOOLS,
  MIN_WAIT_SECONDS
} from '@shared/mcp-tools'
import { APP_VERSION } from '@shared/version'
import {
  createConnector,
  openEndpointClient,
  probeDiscovery,
  ShimError,
  type Connector
} from './connect'
import { bundlePathFor, launch } from './launch'

/** Diagnostics, on stderr, where an IDE collects them. */
export function logToStderr(line: string): void {
  process.stderr.write(`[witena-mcp] ${line}\n`)
}

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
 * and a unit test can drive this without a socket.
 */
export function createShimServer(connector: Connector, log: (line: string) => void): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: APP_VERSION },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: LISTED_TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // `initialize` has already happened by the time any tool is called, so this
    // is the client's own name — `claude-code`, `codex`, whatever it calls
    // itself. It travels as `CLIENT_HEADER` and becomes the "via …" chip on the
    // message the endpoint sends (WP-13). Display data, never an identity.
    const clientName = server.getClientVersion()?.name

    let client
    try {
      client = await connector.open(clientName)
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

/** The connector this process runs with: real files, a real `open`, a real client. */
export function createProcessConnector(log: (line: string) => void): Connector {
  const env = process.env as Record<string, string | undefined>
  const home = homedir()
  const bundlePath = bundlePathFor(process.execPath)

  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch (cause) {
      // EPERM means a process with that id exists and belongs to somebody else,
      // which for a liveness check is still "alive".
      return (cause as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  return createConnector({
    env,
    home,
    readFile: (path) => readFile(path, 'utf8'),
    readLink: (path) => readlink(path),
    isAlive,
    openClient: openEndpointClient,
    launch:
      bundlePath === null
        ? null
        : (probe): Promise<McpDiscovery | null> =>
            launch({
              bundlePath,
              userDataDirOverride: env.WITENA_USER_DATA,
              spawn,
              probe,
              now: () => Date.now(),
              sleep: (ms) => new Promise((settle) => setTimeout(settle, ms)),
              log
            }),
    log
  })
}

/** Serves MCP on stdin/stdout until the IDE closes them. */
export async function main(): Promise<void> {
  const server = createShimServer(createProcessConnector(logToStderr), logToStderr)
  // `StdioServerTransport` declares `onclose: (() => void) | undefined` where
  // `Transport` declares `onclose?: () => void`; under
  // `exactOptionalPropertyTypes` the SDK's class does not satisfy the SDK's own
  // interface. The same mismatch `src/main/mcp-endpoint/server.ts` documents on
  // the server transport, and identical at runtime.
  await server.connect(new StdioServerTransport() as unknown as Transport)
  logToStderr(`ready (witena ${APP_VERSION})`)
}

// Nothing imports this module — it is the bundle's entry point, and `probeDiscovery`
// is re-exported only so the closure test and WP-15 can reach it by name.
export { probeDiscovery }

void main().catch((cause: unknown) => {
  logToStderr(`fatal: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`)
  process.exit(1)
})
