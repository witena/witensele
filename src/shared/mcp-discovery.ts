/**
 * How the shim finds the endpoint: one small file in `userData`.
 *
 * PLAN.md's decision table: the endpoint listens on an **ephemeral** loopback
 * port with a **fresh bearer token per launch**, so there is no fixed port to
 * collide with and nothing long-lived to leak into an IDE's config file. That
 * only works if the shim can discover both at run time, and the one thing the
 * shim and the app reliably agree on is the userData directory.
 *
 * So the app writes `<userData>/mcp-endpoint.json` (mode `0600`) once it is
 * listening and removes it when it stops, and the shim reads it on the first
 * `tools/call`. Re-reading the file is also how the shim survives an app
 * restart: `ECONNREFUSED` or a `401` means the numbers are stale, not that the
 * design failed.
 *
 * Both halves parse it with the same function, because the file is a contract
 * between two processes that may be different *versions* of Witena — an IDE
 * keeps a shim running across an app update. Hence `version`, and hence a parser
 * that answers `null` instead of throwing: every way the file can be wrong
 * (absent, half-written, from a future release, left behind by a dead process)
 * ends in the same place, which is "launch or report that Witena is not up".
 *
 * Pure by contract: no `node:` imports, because the shim bundles it and because
 * `userDataDirFor` takes the environment and the home directory as arguments so
 * a test can ask about a directory that does not exist.
 */
import { APP_NAME } from './version'

/** The file's name inside `userData`. Callers join it themselves — this module has no `node:path`. */
export const DISCOVERY_FILE = 'mcp-endpoint.json'

/** The only schema this build writes and the only one it accepts. */
export const DISCOVERY_VERSION = 1

/**
 * What a live endpoint publishes about itself.
 *
 * `pid` is the liveness check: the shim calls `process.kill(pid, 0)` before it
 * trusts the port, because a file left behind by a crashed app is otherwise
 * indistinguishable from a running one. `startedAt` is epoch milliseconds, the
 * app's only timestamp format, and exists so a human debugging a stale file can
 * see how old it is.
 */
export interface McpDiscovery {
  version: 1
  port: number
  token: string
  pid: number
  startedAt: number
}

/** A positive, whole, finite number — what a port, a pid and a timestamp all are. */
function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * The discovery file's contents, or `null` if it is anything else.
 *
 * Every field is checked rather than assumed, because the shim acts on the
 * result: it opens a socket to `port` and sends `token` to whatever answers.
 * A `version` that is not this one is refused outright — a future release may
 * mean something different by the same field names, and connecting anyway is
 * how two versions of Witena would talk past each other.
 */
export function parseDiscovery(text: string): McpDiscovery | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  if (record.version !== DISCOVERY_VERSION) return null
  if (!isPositiveInt(record.port) || record.port > 65_535) return null
  if (typeof record.token !== 'string' || record.token.length === 0) return null
  if (!isPositiveInt(record.pid)) return null
  if (!isPositiveInt(record.startedAt)) return null

  return {
    version: DISCOVERY_VERSION,
    port: record.port,
    token: record.token,
    pid: record.pid,
    startedAt: record.startedAt
  }
}

/** `app.setName(APP_NAME)` runs before anything reads `userData`, so this is the directory's name. */
const APP_DIR = APP_NAME

/**
 * Where `app.getPath('userData')` points, computed without electron.
 *
 * The shim is not an Electron process and the endpoint's host must not import
 * electron (CLAUDE.md rule 5), so both derive the path from the rule electron
 * follows on macOS — `~/Library/Application Support/<app name>` — with
 * `WITENA_USER_DATA` overriding it exactly as `src/main/index.ts` does, before
 * the lock and before the database. Honouring the override here is what lets the
 * e2e harness point a shim and an app at the same temporary directory.
 *
 * macOS-only, like everything else this app ships, which is why the separator is
 * a literal `/` rather than `node:path`.
 */
export function userDataDirFor(env: Record<string, string | undefined>, home: string): string {
  const override = env.WITENA_USER_DATA
  if (override !== undefined && override.length > 0) return override
  return `${home.replace(/\/+$/, '')}/Library/Application Support/${APP_DIR}`
}
