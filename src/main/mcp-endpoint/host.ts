/**
 * The listening half of the endpoint: a loopback socket and a discovery file.
 *
 * `server.ts` turns one HTTP request into one MCP exchange but opens no socket
 * of its own, because the same handler is meant to be mounted by the Node host
 * later (PLAN.md, "Online version"). This module is what the **desktop** app
 * mounts it with, and it owns the three facts PLAN's decision table fixed:
 *
 * - `127.0.0.1:0` — an ephemeral port, so there is nothing to collide with and
 *   no port number to keep in an IDE's configuration file.
 * - A fresh `randomBytes(32)` bearer token **per `start()`**, so nothing
 *   long-lived leaks into a config file either.
 * - `<userData>/mcp-endpoint.json`, mode `0600`, written once `listen` has
 *   resolved and removed on `stop()` — the only way the shim can learn either
 *   number (`@shared/mcp-discovery`).
 *
 * Nothing here imports electron (CLAUDE.md rule 5): `node:http`, `node:fs`,
 * `node:crypto` and `node:path` are the whole of it, and the `userData`
 * directory arrives as a string because only `src/main/index.ts` may ask
 * electron where it is. `no-electron.test.ts` in this folder proves the claim
 * for the whole import closure.
 *
 * **The order in `stop()` is deliberate.** The discovery file is removed
 * *synchronously and first*, before any socket is closed: `before-quit` in
 * `src/main/index.ts` is a synchronous listener that cannot await anything, so
 * a quit is only guaranteed to get as far as the first synchronous statement.
 * Removing the file there means a dying app never leaves a shim pointed at a
 * port that is about to close — which is the stale-file case
 * `parseDiscovery` + `process.kill(pid, 0)` exist to survive, not one to create.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import {
  DISCOVERY_FILE,
  DISCOVERY_VERSION,
  parseDiscovery,
  type McpDiscovery
} from '@shared/mcp-discovery'
import type { AppContext } from '../app-context'
import type { HandlerMap } from '../handlers/types'
import { createMcpEndpoint, type McpEndpoint } from './server'

/** Loopback only. A door that answered on every interface would be a different feature. */
const LOOPBACK = '127.0.0.1'

/** The discovery file's permissions: the user, and nobody else on the machine. */
const DISCOVERY_MODE = 0o600

export interface McpEndpointHost {
  /**
   * Whether the socket is up, and on which port.
   *
   * A union rather than `port: number | null`, so a caller that has narrowed on
   * `listening` has the port without a second check — which is what WP-11's
   * `integrations.status` reports.
   */
  readonly state: { listening: false } | { listening: true; port: number }
  /** Idempotent. Listens on `127.0.0.1:0`, then writes the discovery file `0600`. */
  start(): Promise<void>
  /** Idempotent. Removes the discovery file, closes sockets. */
  stop(): Promise<void>
}

export interface McpEndpointHostOptions {
  ctx: AppContext
  handlers: HandlerMap
  /** Where the discovery file goes; `app.getPath('userData')` on the desktop. */
  userDataDir: string
  /**
   * The bearer token generator. Injected so a test can assert on a known value;
   * production gets 32 random bytes per `start()`.
   */
  randomToken?: () => string
  /**
   * The pid the discovery file publishes, and the one `stop()` checks before it
   * deletes anything. Injected for the "a foreign file is left alone" test.
   */
  pid?: number
}

/** 32 random bytes, url-safe: what a bearer token is when nobody has to type it. */
function defaultToken(): string {
  return randomBytes(32).toString('base64url')
}

export function createMcpEndpointHost(o: McpEndpointHostOptions): McpEndpointHost {
  const discoveryPath = join(o.userDataDir, DISCOVERY_FILE)
  const newToken = o.randomToken ?? defaultToken
  const pid = o.pid ?? process.pid

  /** Non-null exactly while the socket is up. */
  let live: { http: HttpServer; endpoint: McpEndpoint; port: number } | null = null
  /** The in-flight `start()` / `stop()`, so two callers never race one socket. */
  let pending: Promise<void> = Promise.resolve()

  /**
   * Writes the discovery file with the mode it must have.
   *
   * `writeFileSync`'s `mode` only applies to a file it *creates*, and a file
   * left behind by a previous launch is a file it does not create — so the
   * `chmod` is not belt and braces, it is the half that covers the second run.
   */
  function publish(port: number, token: string): void {
    const discovery: McpDiscovery = {
      version: DISCOVERY_VERSION,
      port,
      token,
      pid,
      startedAt: Date.now()
    }
    writeFileSync(discoveryPath, `${JSON.stringify(discovery, null, 2)}\n`, {
      mode: DISCOVERY_MODE
    })
    chmodSync(discoveryPath, DISCOVERY_MODE)
  }

  /**
   * Removes the discovery file, but only if it is ours.
   *
   * A file naming another process is a **running** Witena on the same directory
   * — two apps on one `userData` should be impossible (the single-instance lock,
   * S10.3), but a lock is not a proof, and deleting somebody else's discovery
   * file would break a live IDE session to tidy up after ourselves. Unreadable,
   * unparseable or absent all mean "nothing of ours is there": the file is left
   * exactly as found, because a file this process did not write is not this
   * process's to delete.
   */
  function unpublish(): void {
    let existing: McpDiscovery | null
    try {
      existing = parseDiscovery(readFileSync(discoveryPath, 'utf8'))
    } catch {
      return
    }
    if (!existing || existing.pid !== pid) return
    try {
      unlinkSync(discoveryPath)
    } catch {
      // Removed by something else between the read and here: the desired state.
    }
  }

  async function startOnce(): Promise<void> {
    if (live) return

    const token = newToken()
    const endpoint = createMcpEndpoint({ ctx: o.ctx, handlers: o.handlers, token })
    // `handle` answers `MCP_PATH` and 404s everything else itself, so the host
    // routes nothing: this is the whole mount.
    const http = createServer((req, res) => {
      void endpoint.handle(req, res)
    })

    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (cause: Error): void => reject(cause)
        http.once('error', failed)
        http.listen(0, LOOPBACK, () => {
          http.removeListener('error', failed)
          resolve()
        })
      })
    } catch (cause) {
      await endpoint.close()
      http.close()
      throw cause
    }

    // Only now is the port knowable, which is why the file is written here and
    // not at construction — and why `guards.ts` reads the port off the socket
    // rather than being told it.
    const port = (http.address() as AddressInfo).port
    live = { http, endpoint, port }
    try {
      publish(port, token)
    } catch (cause) {
      // A port nobody can discover is not a running endpoint; it is a socket
      // nothing will ever reach. Unwind rather than report success.
      live = null
      await endpoint.close()
      await closeHttp(http)
      throw cause
    }
  }

  async function closeHttp(http: HttpServer): Promise<void> {
    await new Promise<void>((resolve) => {
      http.close(() => resolve())
      // Keep-alive connections would otherwise hold `close()` open until they
      // time out. The transports are already closed by `endpoint.close()`, so
      // there is nothing on these sockets left to finish.
      http.closeAllConnections()
    })
  }

  async function stopOnce(): Promise<void> {
    const running = live
    live = null
    if (!running) return
    // Again, because a `start()` may have won the queue since `stop()` was
    // called and written a fresh file. `unpublish` is idempotent.
    unpublish()
    // What ends the in-flight waits — `close()` closes every transport still on
    // the wire, which aborts the `signal` of every tool call riding on one.
    await running.endpoint.close()
    await closeHttp(running.http)
  }

  /** Serialises `start` / `stop` so a toggle answered twice cannot leave a stray socket. */
  function queue(step: () => Promise<void>): Promise<void> {
    const next = pending.then(step, step)
    // Swallowed on the chaining path only: the caller still sees the rejection.
    pending = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  return {
    get state() {
      return live ? { listening: true as const, port: live.port } : { listening: false as const }
    },
    start: () => queue(startOnce),
    stop: () => {
      // Synchronously, before the queue: `before-quit` cannot await, and the
      // file is the one piece of state that outlives the process. See the
      // header — `stopOnce` does it again, because a `start()` ahead of us in
      // the queue may write a fresh one.
      if (live) unpublish()
      return queue(stopOnce)
    }
  }
}
