/**
 * `McpManager`: one connection pool for every registered MCP server.
 *
 * It is the only module that talks to `@modelcontextprotocol/sdk`. Everything
 * above it — `agent-turn.ts`, the `mcp.*` handlers — sees four operations
 * (`listTools`, `callTool`, `testConnection`, `disconnect`) and never a client, a
 * transport or a child process. It imports no electron (CLAUDE.md rule #5): the
 * server records arrive through an injected `getServer`, exactly as the
 * supervisor receives its accessors.
 *
 * ## Why connections are pooled and lazy
 *
 * A stdio server is a **child process**. Connecting on app start would spawn one
 * `npx` per registered server whether or not any agent ever calls a tool, and
 * reconnecting per turn would pay the spawn cost (seconds, for an `npx` that has
 * to resolve a package) on every single message. So a client is created the first
 * time something asks for it and kept until the record changes or the app closes.
 *
 * The cache holds the **promise**, not the client: two agents speaking in
 * parallel must share one connection rather than race to create two. A failed
 * connection removes itself from the cache, so the next call retries instead of
 * being handed the same rejection forever.
 *
 * ## Why `testConnection` does not use the pool
 *
 * It answers "would this configuration work", usually for a form the user has not
 * saved yet. It therefore builds its own client, lists tools and closes — leaving
 * no process behind, and never disturbing a pooled connection an agent may be
 * using at that moment.
 *
 * ## stderr
 *
 * A stdio server that fails to start says why on stderr and nowhere else: a
 * missing package, a bad path, a credential it is unhappy about. The transport is
 * asked for `stderr: 'pipe'` and every line lands in a bounded ring buffer that
 * `mcp.log` shows in settings. Without it, "connection failed" is the entire
 * diagnostic the user gets.
 *
 * ## Environment and working directory
 *
 * A stdio child gets `process.env` with the record's `env` merged **over** it.
 * Nothing is stripped, deliberately: the servers users actually register (`npx`,
 * `uvx`, `docker`) need `PATH`, `HOME`, `NODE_*` and the platform's proxy
 * variables to work at all, and the MVP treats a registered server as trusted —
 * it already runs arbitrary commands by design. The working directory is the
 * user's home rather than the app bundle, so a filesystem server's relative paths
 * mean what the user expects.
 */
import { homedir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { APP_NAME, APP_VERSION } from '@shared/version'
import type { McpConnectionTestResult, McpServer, McpServerInput, McpToolInfo } from '@shared/types'
import { BackendFailure } from '../errors'
import {
  toToolInfo,
  type McpCallResult,
  type McpToolDefinition
} from './tools'

/** How many stderr lines one server keeps. Old lines fall off the front. */
export const LOG_LINES = 200

/** `Message.error` detail and `BackendError.message` when a tool call times out. */
export const TOOL_TIMEOUT_ERROR = 'tool timeout'

/** Everything the manager needs about a server to connect to it. */
export type McpConnectionTarget = Pick<
  McpServerInput,
  'name' | 'transport' | 'command' | 'args' | 'env' | 'url'
>

/** Helpers the transport factory is handed, so the default one stays testable. */
export interface TransportContext {
  /** Appends one stderr line to the server's ring buffer. */
  appendLog: (line: string) => void
  /** Working directory for a stdio child. */
  cwd: string
}

/** Builds the transport for a server. Injected so tests can use `InMemoryTransport`. */
export type CreateTransport = (
  target: McpConnectionTarget,
  context: TransportContext
) => Transport | Promise<Transport>

export interface McpManagerOptions {
  /**
   * Reads one server record. Throws `not_found` for an unknown id, exactly like
   * the repository does — the manager never sees the database.
   */
  getServer: (serverId: string) => McpServer
  /** Overrides transport construction; production uses the default below. */
  createTransport?: CreateTransport
  /** Working directory for stdio children. Defaults to the user's home. */
  cwd?: string
}

export interface CallToolOptions {
  /** Aborts the in-flight request; the SDK raises an abort error from `callTool`. */
  signal?: AbortSignal
  /** Budget for this one call, from `AppSettings.timeouts.toolTimeoutMs`. */
  timeoutMs?: number
}

export interface ListToolsOptions {
  /** Re-asks the server instead of answering from the per-connection cache. */
  refresh?: boolean
}

/** One live connection plus what has been learned over it. */
interface Connection {
  client: Client
  /** `listTools` result, cached for the life of this connection. */
  tools?: McpToolDefinition[]
}

/** A configuration that cannot produce a transport at all. */
function assertConnectable(target: McpConnectionTarget): void {
  if (target.transport === 'stdio') {
    if (!target.command?.trim()) {
      throw new BackendFailure('mcp_error', 'A stdio MCP server needs a command')
    }
    return
  }
  if (!target.url?.trim()) {
    throw new BackendFailure('mcp_error', 'An http MCP server needs a URL')
  }
  try {
    new URL(target.url)
  } catch {
    throw new BackendFailure('mcp_error', `Not a valid MCP server URL: ${target.url}`)
  }
}

/**
 * The production transport factory.
 *
 * `env` is merged over `process.env` rather than replacing it — see the note at
 * the top of the file — and `undefined` values are dropped, because
 * `StdioServerParameters.env` is `Record<string, string>` and Node's own env can
 * legitimately hold holes.
 */
export const createDefaultTransport: CreateTransport = (target, context) => {
  if (target.transport === 'stdio') {
    const inherited: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) inherited[key] = value
    }

    const transport = new StdioClientTransport({
      command: target.command as string,
      args: target.args ?? [],
      env: { ...inherited, ...(target.env ?? {}) },
      cwd: context.cwd,
      // Without this the child's stderr goes to the app's own stderr and the
      // user never sees it; with it, `mcp.log` can show why a server died.
      stderr: 'pipe'
    })

    // `stderr` is a PassThrough available *before* `start()`, so no early output
    // is lost between construction and connection.
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      for (const line of String(chunk).split('\n')) {
        const trimmed = line.trimEnd()
        if (trimmed.length > 0) context.appendLog(trimmed)
      }
    })
    return transport
  }

  // `env` carries the request headers for an http server. The field is shared
  // rather than duplicated because it is the same idea in both transports —
  // "extra key/value pairs this server needs" — and `McpServerInput` is a stored
  // shape that a migration would otherwise have to widen for one string map.
  const headers = target.env ?? {}

  /*
   * Cast, and the reason is worth stating: `StreamableHTTPClientTransport`
   * declares `sessionId: string | undefined` while the `Transport` interface it
   * implements declares `sessionId?: string`. Under `exactOptionalPropertyTypes`
   * those are different types, so the SDK's own class does not satisfy the SDK's
   * own interface. Reconciling it here is preferable to relaxing the flag for the
   * whole project; the shapes are identical at runtime.
   */
  return new StreamableHTTPClientTransport(new URL(target.url as string), {
    ...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {})
  }) as Transport
}

/** Anything thrown by the SDK, as the `BackendError` the transport can carry. */
function toMcpFailure(error: unknown, fallback: string): BackendFailure {
  if (error instanceof BackendFailure) return error
  const message = error instanceof Error ? error.message : String(error)
  return new BackendFailure('mcp_error', message.length > 0 ? message : fallback)
}

export class McpManager {
  private readonly options: McpManagerOptions
  private readonly createTransport: CreateTransport
  private readonly cwd: string

  /** serverId → the connection promise. Holding the promise is what dedupes. */
  private readonly connections = new Map<string, Promise<Connection>>()
  /** serverId → stderr ring buffer. Survives a disconnect, so a crash is readable. */
  private readonly logs = new Map<string, string[]>()

  constructor(options: McpManagerOptions) {
    this.options = options
    this.createTransport = options.createTransport ?? createDefaultTransport
    this.cwd = options.cwd ?? homedir()
  }

  /** The stderr tail of a stdio server, oldest line first. */
  getLog(serverId: string): string[] {
    return [...(this.logs.get(serverId) ?? [])]
  }

  private appendLog(serverId: string, line: string): void {
    const buffer = this.logs.get(serverId) ?? []
    buffer.push(line)
    if (buffer.length > LOG_LINES) buffer.splice(0, buffer.length - LOG_LINES)
    this.logs.set(serverId, buffer)
  }

  /** Opens a client against a target. Used by both the pool and `testConnection`. */
  private async open(target: McpConnectionTarget, appendLog: (line: string) => void): Promise<Client> {
    assertConnectable(target)
    const transport = await this.createTransport(target, { appendLog, cwd: this.cwd })
    const client = new Client(
      { name: APP_NAME.toLowerCase(), version: APP_VERSION },
      // No sampling, no roots, no elicitation: the MVP is a tool consumer only,
      // and advertising a capability we do not implement invites a server to use it.
      { capabilities: {} }
    )
    await client.connect(transport)
    return client
  }

  /** The pooled connection for a server, connecting on first use. */
  private connection(serverId: string): Promise<Connection> {
    const cached = this.connections.get(serverId)
    if (cached) return cached

    const server = this.options.getServer(serverId)
    if (!server.enabled) {
      // Not cached: a disabled server must connect the moment it is enabled,
      // without the pool remembering a rejection.
      return Promise.reject(
        new BackendFailure('mcp_error', `MCP server is disabled: ${server.name}`, { id: serverId })
      )
    }

    const pending = this.open(server, (line) => this.appendLog(serverId, line))
      .then((client): Connection => ({ client }))
      .catch((error: unknown) => {
        // Drop the failed attempt so the next call reconnects rather than being
        // handed this rejection forever.
        if (this.connections.get(serverId) === pending) this.connections.delete(serverId)
        throw toMcpFailure(error, `Could not connect to ${server.name}`)
      })

    this.connections.set(serverId, pending)
    return pending
  }

  /** The pooled client, connecting lazily. Rejects with `mcp_error`. */
  async getClient(serverId: string): Promise<Client> {
    return (await this.connection(serverId)).client
  }

  /**
   * The server's tools, cached for the life of the connection.
   *
   * A server may change its tool list and send `notifications/tools/list_changed`;
   * the MVP does not subscribe to that, so `refresh: true` is how settings asks
   * again after the user changed something.
   */
  async listTools(serverId: string, options: ListToolsOptions = {}): Promise<McpToolDefinition[]> {
    const connection = await this.connection(serverId)
    if (!options.refresh && connection.tools) return connection.tools

    try {
      const result = await connection.client.listTools()
      connection.tools = result.tools.map(
        (entry): McpToolDefinition => ({
          name: entry.name,
          ...(entry.description ? { description: entry.description } : {}),
          inputSchema: entry.inputSchema as Record<string, unknown>
        })
      )
      return connection.tools
    } catch (error) {
      throw toMcpFailure(error, 'Could not list tools')
    }
  }

  /** The tool list in the shape the renderer shows. */
  async listToolInfo(serverId: string, options: ListToolsOptions = {}): Promise<McpToolInfo[]> {
    return toToolInfo(await this.listTools(serverId, options))
  }

  /**
   * Runs one tool.
   *
   * The timeout and the abort are the SDK's own (`RequestOptions.timeout` /
   * `.signal`), which **cancel** the in-flight request rather than only stopping
   * us waiting for it — see `docs/features/mcp/backend.md`. Both are translated
   * into a `BackendFailure` so `agent-turn.ts` never has to know an `McpError`
   * exists.
   */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options: CallToolOptions = {}
  ): Promise<McpCallResult> {
    const connection = await this.connection(serverId)
    try {
      const result = await connection.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.timeoutMs ? { timeout: options.timeoutMs } : {})
        }
      )
      return result as McpCallResult
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // The SDK reports its own budget as an `McpError` with `RequestTimeout`;
      // the message is the only stable part across transports.
      if (/timed? ?out/i.test(message)) {
        throw new BackendFailure('mcp_error', TOOL_TIMEOUT_ERROR, { tool: toolName })
      }
      throw toMcpFailure(error, `${toolName} failed`)
    }
  }

  /**
   * Connects with a **fresh** client, lists tools and closes again.
   *
   * Never touches the pool, so testing a server an agent is mid-call on is safe,
   * and never leaves a child process behind even when listing fails.
   */
  async testConnection(target: McpConnectionTarget, serverId?: string): Promise<McpConnectionTestResult> {
    const started = Date.now()
    let client: Client | undefined
    try {
      client = await this.open(target, (line) => {
        if (serverId) this.appendLog(serverId, line)
      })
      const result = await client.listTools()
      return {
        ok: true,
        latencyMs: Date.now() - started,
        tools: toToolInfo(
          result.tools.map((entry) => ({
            name: entry.name,
            ...(entry.description ? { description: entry.description } : {}),
            inputSchema: entry.inputSchema as Record<string, unknown>
          }))
        )
      }
    } catch (error) {
      return { ok: false, error: toMcpFailure(error, 'Could not connect').toBackendError() }
    } finally {
      // `finally`, so a child process is reaped even when `listTools` throws.
      await client?.close().catch(() => undefined)
    }
  }

  /**
   * Closes a pooled connection, if there is one.
   *
   * Called when a record is disabled, re-pointed or deleted: a client that is
   * still talking to the old command would keep answering with the old tools.
   */
  async disconnect(serverId: string): Promise<void> {
    const pending = this.connections.get(serverId)
    if (!pending) return
    this.connections.delete(serverId)
    try {
      const connection = await pending
      await connection.client.close()
    } catch {
      // A connection that never came up has nothing to close, and a close that
      // fails must not stop the update that asked for it.
    }
  }

  /** Closes every connection. Called from `AppContext.close()`. */
  async closeAll(): Promise<void> {
    const ids = [...this.connections.keys()]
    await Promise.all(ids.map((id) => this.disconnect(id)))
  }
}
