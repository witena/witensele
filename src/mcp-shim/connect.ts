/**
 * Finding the app, from the shim.
 *
 * The endpoint listens on an ephemeral loopback port with a bearer token that
 * is new on every launch (PLAN.md's decision table), so the shim cannot be
 * configured with either: it discovers them from `<userData>/mcp-endpoint.json`
 * every time it needs them. This module is that lookup, plus the two things
 * that make it survive a day of ordinary use — noticing that the file is stale
 * and re-reading it, and launching the app when there is no file at all.
 *
 * ```
 * open()  ─→ discovery file → pid alive? ─→ connect with the bearer token
 *              │ no                                │ 401 / ECONNREFUSED
 *              ▼                                   ▼
 *          app up?  ── yes → "the endpoint is switched off"
 *              │ no                            re-read the file, once
 *              ▼
 *          launch()  ── timed out → "app up?" again, then one of two sentences
 * ```
 *
 * **One `Client` per forwarded call.** WP-4 established that the endpoint is
 * stateless, so a `notifications/cancelled` lands on a fresh `Server` and
 * cancels nothing; what aborts a running tool is the caller *dropping its HTTP
 * request*. The SDK client owns one `AbortController` per **transport**, not
 * per request, so the only way to drop one call without dropping the others is
 * to give each call its own transport and close it. `open()` therefore returns
 * a fresh client every time and the caller closes it in a `finally`.
 *
 * Everything the module touches is injected — the environment, the home
 * directory, `readFile`, `readlink`, the liveness check, the client factory and
 * the launcher — so `connect.test.ts` can state each branch against a temporary
 * directory instead of against a running app.
 *
 * Logs go to the caller's `log`, which writes to **stderr**: stdout is the MCP
 * protocol and a stray line on it is a dead server.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolResultSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
  type CallToolResult,
  type ListResourcesRequest,
  type ListResourcesResult,
  type ReadResourceRequest,
  type ReadResourceResult
} from '@modelcontextprotocol/sdk/types.js'
import {
  DISCOVERY_FILE,
  parseDiscovery,
  userDataDirFor,
  type McpDiscovery
} from '@shared/mcp-discovery'
import { CLIENT_HEADER, MCP_PATH, MCP_SERVER_NAME } from '@shared/mcp-tools'
import { APP_VERSION } from '@shared/version'
import { LAUNCH_TIMEOUT_MS } from './launch'

/**
 * Chromium's own lock file, which Electron writes *inside* `userData`.
 *
 * WP-0a confirmed it: `SingletonLock` is a symlink named `<host>-<pid>`, and it
 * is how `requestSingleInstanceLock()` ends up keyed by `userData`. The shim
 * reads it for one purpose only — to separate *Witena is not running* and
 * *Witena is running with the endpoint switched off*, which are two different
 * sentences for the model and two different things for the user to do. It is a
 * hint, never a requirement: if it is missing or unreadable the shim falls back
 * to the weaker message rather than guessing.
 */
const SINGLETON_LOCK = 'SingletonLock'

/** Why the shim could not reach the endpoint, as the three messages below. */
export type ShimErrorKind = 'not-running' | 'endpoint-off' | 'launch-timeout'

/**
 * The three sentences a calling model may see instead of a tool result.
 *
 * English and written at the model, exactly like the tool descriptions in
 * `@shared/mcp-tools`: they say what is wrong *and* what the next action is,
 * because a coding agent that is told "not running" and nothing else will
 * either retry forever or give up. They are not UI copy and never go through
 * `t()` — CLAUDE.md rule 4 is about what the user sees in the window.
 */
export const SHIM_ERROR_TEXT: Record<ShimErrorKind, string> = {
  'not-running': [
    'Witena is not running, and this shim cannot start it because it is not running from an installed Witena.app.',
    'Ask the user to start Witena (in development: `npm run dev`) and to turn on Settings -> Integrations -> MCP endpoint, then call this tool again.'
  ].join(' '),
  'endpoint-off': [
    'Witena is running, but its MCP endpoint is switched off, so there is nothing to connect to.',
    'Ask the user to open Witena -> Settings -> Integrations and turn the MCP endpoint on, then call this tool again.'
  ].join(' '),
  'launch-timeout': [
    `Timed out starting Witena; it did not publish its MCP endpoint within ${LAUNCH_TIMEOUT_MS / 1000} seconds.`,
    'Ask the user to open Witena, check that Settings -> Integrations -> MCP endpoint is on, and call this tool again.'
  ].join(' ')
}

/**
 * What a `resources/read` is told when nothing is listening.
 *
 * One sentence for both reasons, unlike the three above, because a resource
 * read never launches the app (see `openIfRunning`) and therefore never learns
 * which of the two it is: the shim has only looked for the discovery file, and
 * "no file" covers a Witena that is not running *and* a Witena whose endpoint
 * is switched off. Naming both is more useful than guessing one.
 */
export const RESOURCE_UNAVAILABLE_TEXT = [
  'Witena is not running, or its MCP endpoint is switched off, so this transcript cannot be read.',
  'Ask the user to open Witena and turn on Settings -> Integrations -> MCP endpoint.',
  'Calling a Witena tool instead will start the app if it is installed.'
].join(' ')

/** A refusal the shim can explain, as opposed to one it only passes on. */
export class ShimError extends Error {
  readonly kind: ShimErrorKind

  constructor(kind: ShimErrorKind) {
    super(SHIM_ERROR_TEXT[kind])
    this.name = 'ShimError'
    this.kind = kind
  }
}

/** Where the discovery file is, for this environment. Joined here: WP-1's module has no `node:path`. */
export function discoveryPathFor(env: Record<string, string | undefined>, home: string): string {
  return `${userDataDirFor(env, home)}/${DISCOVERY_FILE}`
}

/**
 * One forwarded `tools/call`, over its own transport.
 *
 * Narrower than the SDK's `Client` on purpose: it is the whole of what
 * `index.ts` needs and therefore the whole of what a test has to fake.
 */
export interface EndpointClient {
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    options: {
      signal?: AbortSignal | undefined
      timeout?: number | undefined
      onprogress?: ((progress: { progress: number; message?: string | undefined }) => void) | undefined
    }
  ): Promise<CallToolResult>
  /**
   * The two resource methods, forwarded with their own parameters.
   *
   * They need their own passthrough rather than riding on `callTool`: the only
   * thing that crosses on a tool call is the name and the arguments, while
   * `resources/list` carries a pagination `cursor` and `resources/read` carries
   * the `uri` that is the whole of the request. Forwarding them as a tool call
   * would mean inventing a tool the endpoint does not have.
   */
  listResources(params: ListResourcesRequest['params']): Promise<ListResourcesResult>
  readResource(params: ReadResourceRequest['params']): Promise<ReadResourceResult>
  close(): Promise<void>
}

export interface ConnectDeps {
  env: Record<string, string | undefined>
  home: string
  /** The discovery file's text; rejecting is "no file", which is a branch, not a failure. */
  readFile: (path: string) => Promise<string>
  /** `SingletonLock`'s target, for the "is the app up?" hint. */
  readLink: (path: string) => Promise<string>
  /** `process.kill(pid, 0)`, as a predicate. */
  isAlive: (pid: number) => boolean
  /** Opens one connected client against a live endpoint. */
  openClient: (discovery: McpDiscovery, clientName: string | undefined) => Promise<EndpointClient>
  /**
   * Starts the app and waits for its discovery file, or `null` when this
   * installation has no bundle to launch (development, or a bare `node`).
   */
  launch: ((probe: () => Promise<McpDiscovery | null>) => Promise<McpDiscovery | null>) | null
  log: (line: string) => void
}

/**
 * The discovery file, if it describes an endpoint that is actually there.
 *
 * A file whose `pid` is gone is the same as no file: the app crashed or was
 * killed without the chance to remove it, and connecting to whatever now owns
 * that port is precisely what the check exists to prevent.
 */
export async function probeDiscovery(
  deps: Pick<ConnectDeps, 'env' | 'home' | 'readFile' | 'isAlive'>
): Promise<McpDiscovery | null> {
  let text: string
  try {
    text = await deps.readFile(discoveryPathFor(deps.env, deps.home))
  } catch {
    return null
  }
  const discovery = parseDiscovery(text)
  if (discovery === null) return null
  return deps.isAlive(discovery.pid) ? discovery : null
}

/**
 * Whether *a* Witena is running against this `userData`, judged by the lock
 * file Electron keeps there.
 *
 * Only ever used to choose between two error messages, so every way of failing
 * to read it answers `false` — the weaker sentence is always safe.
 */
export async function appIsRunning(
  deps: Pick<ConnectDeps, 'env' | 'home' | 'readLink' | 'isAlive'>
): Promise<boolean> {
  try {
    const target = await deps.readLink(`${userDataDirFor(deps.env, deps.home)}/${SINGLETON_LOCK}`)
    const pid = Number(target.slice(target.lastIndexOf('-') + 1))
    return Number.isInteger(pid) && pid > 0 && deps.isAlive(pid)
  } catch {
    return false
  }
}

/**
 * Whether this failure means "the numbers in the discovery file are out of
 * date", which is the one failure worth retrying.
 *
 * Two spellings, both of which mean the app the file describes is no longer the
 * app on that port: a `401` (it restarted and minted a new token, and the file
 * we are holding is the old one) and `ECONNREFUSED` (nothing is listening
 * there any more). Anything else — a 403 from the guards, a malformed response,
 * a tool that failed — is reported rather than retried.
 */
export function isStaleEndpoint(error: unknown): boolean {
  for (let cause: unknown = error, depth = 0; cause !== undefined && depth < 8; depth += 1) {
    if (typeof cause !== 'object' || cause === null) break
    const code = (cause as { code?: unknown }).code
    if (code === 401) return true
    if (code === 'ECONNREFUSED') return true
    const message = (cause as { message?: unknown }).message
    if (typeof message === 'string' && message.includes('ECONNREFUSED')) return true
    cause = (cause as { cause?: unknown }).cause
  }
  return false
}

/** The shim's half of the connection: one connected client per forwarded call. */
export interface Connector {
  /**
   * For `tools/call`: connects, **launching Witena** when there is no endpoint
   * to connect to. A tool call is the user asking for work to be done, which is
   * the one thing worth waking an app for.
   */
  open(clientName: string | undefined): Promise<EndpointClient>
  /**
   * For the resource methods: connects only when the app is *already* there,
   * and answers `null` rather than launching it.
   *
   * WP-0b measured Claude Code sending `resources/list` on **every session
   * start**, so a listing that launched the app would launch it every time the
   * user opened a project — exactly the thing the whole shim exists to avoid.
   * `resources/read` is held to the same rule: it is a browse, the user did not
   * ask for a discussion, and a tool call is one step away if they want one.
   *
   * It probes the discovery file itself instead of calling `open()`, so there
   * is no window in which a file that vanished between the probe and the
   * connection could turn a listing into a launch.
   */
  openIfRunning(clientName: string | undefined): Promise<EndpointClient | null>
}

/**
 * The real `openClient`: an SDK `Client` over its own
 * `StreamableHTTPClientTransport`, carrying the bearer token and the name of
 * whoever is driving the shim.
 */
export async function openEndpointClient(
  discovery: McpDiscovery,
  clientName: string | undefined
): Promise<EndpointClient> {
  const client = new Client({ name: `${MCP_SERVER_NAME}-shim`, version: APP_VERSION })
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${discovery.port}${MCP_PATH}`),
    {
      requestInit: {
        headers: {
          authorization: `Bearer ${discovery.token}`,
          ...(clientName !== undefined ? { [CLIENT_HEADER]: clientName } : {})
        }
      }
    }
  )

  /*
   * Cast, for the reason `src/main/mcp/manager.ts` states at length:
   * `StreamableHTTPClientTransport.sessionId` is `string | undefined` where the
   * `Transport` interface it implements declares `sessionId?: string`, and
   * under `exactOptionalPropertyTypes` those are different types. Identical at
   * runtime.
   */
  await client.connect(transport as unknown as Transport)

  return {
    async callTool(params, options) {
      // Rebuilt key by key rather than passed through: `RequestOptions`
      // declares `signal?: AbortSignal` and friends without `| undefined`, so
      // under `exactOptionalPropertyTypes` an object that *has* the key with
      // the value `undefined` is a different type from one that lacks it.
      const requestOptions = {
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
        ...(options.onprogress !== undefined ? { onprogress: options.onprogress } : {})
      }
      return (await client.callTool(
        params,
        CallToolResultSchema,
        requestOptions
      )) as CallToolResult
    },
    async listResources(params) {
      // `client.request` rather than `client.listResources`, so the forwarded
      // `params` object crosses verbatim: the typed helper takes the same
      // shape, but going through `request` keeps this hop a relay rather than a
      // second client with opinions of its own.
      return (await client.request(
        { method: 'resources/list', ...(params === undefined ? {} : { params }) },
        ListResourcesResultSchema
      )) as ListResourcesResult
    },
    async readResource(params) {
      return (await client.request(
        { method: 'resources/read', params },
        ReadResourceResultSchema
      )) as ReadResourceResult
    },
    async close() {
      await client.close()
    }
  }
}

/**
 * The connector.
 *
 * It caches the discovery file's contents between calls — the file is read once
 * per app launch in the happy case, not once per tool call — and throws that
 * cache away the moment the endpoint answers like a different process.
 */
export function createConnector(deps: ConnectDeps): Connector {
  let cached: McpDiscovery | null = null

  const probe = (): Promise<McpDiscovery | null> => probeDiscovery(deps)

  /** The discovery file, launching the app if that is what it takes. Throws `ShimError`. */
  async function resolveEndpoint(): Promise<McpDiscovery> {
    const found = await probe()
    if (found !== null) return found

    if (await appIsRunning(deps)) throw new ShimError('endpoint-off')
    if (deps.launch === null) throw new ShimError('not-running')

    const launched = await deps.launch(probe)
    if (launched !== null) return launched

    // The app may have come up and simply not opened the door. Asking again is
    // what turns "timed out" into the sentence that names the switch.
    throw new ShimError((await appIsRunning(deps)) ? 'endpoint-off' : 'launch-timeout')
  }

  return {
    async open(clientName) {
      const first = cached ?? (await resolveEndpoint())
      try {
        const client = await deps.openClient(first, clientName)
        cached = first
        return client
      } catch (cause) {
        cached = null
        if (!isStaleEndpoint(cause)) throw cause

        // Exactly one retry, and only after re-reading the file: an app that
        // restarted has published new numbers, and an app that is gone will be
        // launched by `resolveEndpoint` or explained by it.
        deps.log(
          `127.0.0.1:${first.port} is not the endpoint the discovery file described; re-reading it`
        )
        const second = await resolveEndpoint()
        const client = await deps.openClient(second, clientName)
        cached = second
        return client
      }
    },

    async openIfRunning(clientName) {
      // Always the file, never the cache: a cached endpoint that has since gone
      // away would make this answer "running" and then fail, and the caller
      // cannot tell those apart. `probeDiscovery` also checks the pid.
      const found = await probe()
      if (found === null) return null

      try {
        const client = await deps.openClient(found, clientName)
        cached = found
        return client
      } catch (cause) {
        // A failure here is reported as "nothing is listening" rather than
        // raised: the file said there was an endpoint and the socket disagreed,
        // which for a listing is the same as no endpoint at all. The reason
        // goes to stderr, where it is debuggable without becoming an error in
        // the IDE's resource picker.
        cached = null
        deps.log(
          `127.0.0.1:${found.port} did not answer a resource request: ${
            cause instanceof Error ? cause.message : String(cause)
          }`
        )
        return null
      }
    }
  }
}
