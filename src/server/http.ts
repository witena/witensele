/**
 * The HTTP transport: the same two channels `src/main/ipc/register.ts` mounts
 * over Electron IPC, mounted over a socket instead.
 *
 * | Electron | Server |
 * |---|---|
 * | `ipcMain.handle('witena:invoke', (method, input))` | `POST /api/<method>` |
 * | `webContents.send('witena:event', event)` | one JSON frame on `GET /ws` |
 *
 * Nothing below this file knows which of the two it is running under: the
 * handler map, `AppContext`, `ChatRunner`, `AgentTurn`, `McpManager` and the
 * repositories are taken exactly as the desktop build built them (CLAUDE.md
 * rule #5). That is the whole point of the step — the server is a second host
 * for the existing backend, not a second backend.
 *
 * **Why `node:http` + `ws` and not a framework**: see
 * `docs/features/server/context.md`. In short, the routing surface is one
 * literal prefix and a table lookup, so a router would be a dependency that
 * saves no code, and a WebSocket is needed either way.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { isBackendMethod, type BackendMethod } from '@shared/backend'
import type { BackendError, BackendErrorCode, UserId } from '@shared/types'
import type { AppContext } from '../main/app-context'
import { BackendFailure } from '../main/errors'
import type { HandlerMap } from '../main/handlers/types'
import { toBackendError, type InvokeResponse } from '../main/ipc-protocol'
import { resolveUserId } from './user'

/** The prefix every request/response method is mounted under. */
export const API_PREFIX = '/api/'

/** The path the event bus is served on. */
export const WS_PATH = '/ws'

/** The liveness probe. Answers without touching the database. */
export const HEALTH_PATH = '/healthz'

/**
 * The largest request body accepted, in bytes.
 *
 * Generous — a `chat.send` carrying a pasted document is a legitimate megabyte —
 * but finite, because an unbounded `POST` to an unauthenticated endpoint is a way
 * to exhaust a server's memory with one connection. S8.4 revisits it alongside
 * the rest of the per-user limits.
 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024

/** The erased call signature the transport works with; `HandlerMap` keeps the typing. */
type ErasedHandler = (ctx: AppContext, input: unknown) => unknown

/**
 * `BackendErrorCode` → HTTP status.
 *
 * The body is the authority and the client switches on `code`, exactly as it does
 * over IPC; the status exists so that proxies, load balancers and `curl` see
 * something truthful. Declared as a total record over the union, so a new code
 * cannot be added without deciding what it means on the wire.
 */
export const ERROR_STATUS: Record<BackendErrorCode, number> = {
  validation: 400,
  unauthorized: 401,
  not_found: 404,
  // The client asked for something the host is not currently in a state to do — a
  // CLI that is not installed, a key this installation cannot decrypt, a run that
  // was cancelled. 409 rather than 500: nothing is broken, the state is wrong.
  aborted: 409,
  ant_missing: 409,
  ant_not_logged_in: 409,
  gcloud_missing: 409,
  gcloud_not_logged_in: 409,
  gcloud_no_project: 409,
  key_unreadable: 409,
  // A dependency the server called on the user's behalf failed.
  provider_error: 502,
  mcp_error: 502,
  internal: 500
}

/** The status an error is answered with; anything unrecognised is a 500. */
export function statusForError(error: BackendError): number {
  return ERROR_STATUS[error.code] ?? 500
}

export interface WitenaServerOptions {
  /** The application context every handler receives. Built by `./context.ts`. */
  ctx: AppContext
  /**
   * The handler map. Injected rather than built here so a test can layer a stub
   * over one method, the way `registerIpc` layers the electron-only overlays over
   * theirs.
   *
   * The electron-only methods (`system.pickFolder`, `pickSavePath`, `pickPaths`,
   * `applyTheme`, and `openInEditor` for the two URL-scheme editors) are
   * deliberately **not** overlaid here: `buildHandlers()`'s own implementations
   * reject with the Electron-free message they were written to give, which is the
   * honest answer for a host that has no window. S8.3's `system.capabilities` is
   * what stops a browser from offering those controls in the first place.
   */
  handlers: HandlerMap
  /** The user behind a request. Defaults to the `LOCAL_USER_ID` seam in `./user.ts`. */
  resolveUser?: (request: IncomingMessage) => Promise<UserId>
  /** Where the server logs. Injected so a test can stay quiet. */
  log?: (message: string) => void
}

export interface WitenaServer {
  /** The underlying Node server, for a caller that wants the address or a signal. */
  readonly server: Server
  /** The port actually bound; `0` before `listen` resolves. */
  readonly port: number
  /** `http://host:port`, valid once `listen` has resolved. */
  readonly origin: string
  /** Number of open WebSocket clients. Read by the tests. */
  readonly clients: number
  listen(host: string, port: number): Promise<void>
  /** Closes every WebSocket, stops listening and resolves when the socket is free. */
  close(): Promise<void>
}

/** Reads the whole request body, refusing anything over `MAX_BODY_BYTES`. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      throw new BackendFailure('validation', `Request body exceeds ${MAX_BODY_BYTES} bytes`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The single argument a backend method takes, parsed out of the body.
 *
 * An empty body is `undefined`, which is what a no-argument method
 * (`settings.get`, `chats.list`) is called with over IPC too — so both transports
 * hand their handlers the same value and a handler cannot behave differently
 * depending on which one invoked it.
 */
function parseInput(body: string): unknown {
  if (body.trim() === '') return undefined
  try {
    return JSON.parse(body)
  } catch (cause) {
    throw new BackendFailure(
      'validation',
      `Request body is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`
    )
  }
}

/** Writes one JSON response. */
function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  })
  response.end(body)
}

/**
 * Writes a failure in the **same envelope the IPC protocol uses**.
 *
 * `{ ok: false, error }` rather than a bare error object, so `HttpBackendClient`
 * (S8.3) can reuse the preload bridge's unwrapping verbatim: one shape for both
 * transports means one place where a `BackendError` becomes a throw again.
 */
function sendFailure(response: ServerResponse, error: BackendError): void {
  const payload: InvokeResponse = { ok: false, error }
  sendJson(response, statusForError(error), payload)
}

export function createWitenaServer(options: WitenaServerOptions): WitenaServer {
  const { ctx, handlers } = options
  const resolveUser = options.resolveUser ?? resolveUserId
  const log = options.log ?? ((message: string) => console.log(message))

  const sockets = new Set<WebSocket>()
  const wss = new WebSocketServer({ noServer: true })

  let host = ''
  let port = 0

  /**
   * One subscription for the whole server, fanned out to the open sockets.
   *
   * Not one subscription per client: the bus delivers to every listener in turn,
   * and a hundred listeners each running `JSON.stringify` over the same streaming
   * delta is ninety-nine wasted serialisations. Serialise once, write many — which
   * also makes the frames byte-identical for every client.
   */
  const unsubscribe = ctx.events.subscribe((event) => {
    if (sockets.size === 0) return
    const frame = JSON.stringify(event)
    for (const socket of sockets) {
      // Checked rather than caught: a socket closing while a run streams is
      // ordinary, and an exception here would surface inside the bus.
      if (socket.readyState !== socket.OPEN) continue
      socket.send(frame)
    }
  })

  /**
   * The user seam (S8.2).
   *
   * Until accounts exist there is one context and one user, so a resolved id that
   * is not the context's own is a programming error rather than a state to
   * support — and answering `unauthorized` is both the honest reply and the exact
   * place S8.2 replaces with a per-user context.
   */
  function assertUser(userId: UserId): void {
    if (userId === ctx.userId) return
    throw new BackendFailure(
      'unauthorized',
      `This server hosts ${ctx.userId} only; per-user contexts arrive with accounts (S8.2)`
    )
  }

  async function handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string
  ): Promise<void> {
    if (request.method !== 'POST') {
      // 405 with `Allow`, so a browser that stumbled onto the URL is told what the
      // endpoint is instead of a 404 that suggests a typo.
      response.setHeader('allow', 'POST')
      sendFailure(response, {
        code: 'validation',
        message: `${pathname} is POST only, got ${request.method ?? 'an unknown method'}`
      })
      return
    }

    const method = pathname.slice(API_PREFIX.length)
    if (!isBackendMethod(method)) {
      sendFailure(response, { code: 'not_found', message: `Unknown backend method: ${method}` })
      return
    }

    // Resolved before the body is read, so an unauthenticated request is refused
    // without the server first buffering eight megabytes for it (S8.2).
    assertUser(await resolveUser(request))
    const input = parseInput(await readBody(request))
    const handler = handlers[method as BackendMethod] as ErasedHandler
    const value = await handler(ctx, input)
    const payload: InvokeResponse = { ok: true, value }
    sendJson(response, 200, payload)
  }

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname

    if (pathname === HEALTH_PATH) {
      sendJson(response, 200, { status: 'ok' })
      return
    }

    if (!pathname.startsWith(API_PREFIX)) {
      sendFailure(response, { code: 'not_found', message: `No route for ${pathname}` })
      return
    }

    handleApi(request, response, pathname).catch((error: unknown) => {
      // The mirror of `registerIpc`'s try/catch: every failure, a bug included,
      // leaves as a `BackendError` the client can switch on. Nothing here ever
      // sends a stack trace or an HTML error page.
      if (response.headersSent) {
        response.destroy()
        return
      }
      sendFailure(response, toBackendError(error))
    })
  })

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    if (pathname !== WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    // The user is resolved at connect time and not again: a WebSocket outlives any
    // one request, so S8.2 verifies the token here and closes the socket when it
    // expires rather than re-checking per frame.
    resolveUser(request)
      .then((userId) => {
        assertUser(userId)
        wss.handleUpgrade(request, socket, head, (ws) => {
          sockets.add(ws)
          ws.on('close', () => sockets.delete(ws))
          // A client that errors is a client that is gone; the bus must not care.
          ws.on('error', () => sockets.delete(ws))
        })
      })
      .catch(() => {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
      })
  })

  return {
    server,
    get port() {
      return port
    },
    get origin() {
      return `http://${host}:${port}`
    },
    get clients() {
      return sockets.size
    },

    listen(nextHost, nextPort) {
      host = nextHost
      return new Promise((settle, reject) => {
        server.once('error', reject)
        server.listen(nextPort, nextHost, () => {
          const address = server.address()
          port = typeof address === 'object' && address !== null ? address.port : nextPort
          server.removeListener('error', reject)
          log(`[witena] api listening on http://${host}:${port}`)
          settle()
        })
      })
    },

    async close() {
      unsubscribe()
      for (const socket of sockets) socket.close()
      sockets.clear()
      wss.close()
      await new Promise<void>((settle) => {
        server.close(() => settle())
        // Sockets held open by HTTP keep-alive would otherwise keep `close`
        // pending for the length of the timeout; nothing here needs to drain.
        server.closeAllConnections()
      })
    }
  }
}
