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
 *                       index.ts ──┤ the transport, the real connector, the bootstrap
 *                      server.ts ──┤ every method it answers, and what each one means
 *                     connect.ts ──┤ the discovery file, and the client per request
 *                      launch.ts ──┴ starting the app, when a tool call needs it
 * ```
 *
 * **Opening an IDE must not launch Witena.** That is why `tools/list` is served
 * from the shared table rather than fetched, and why `connect()` happens on the
 * first `tools/call` and not at startup: an editor that starts ten MCP servers
 * when it opens a project would otherwise start Witena ten times a day for
 * nothing. Codex also gives a server only a few seconds to come up, and a shim
 * that answered `initialize` by launching an app would lose that race.
 *
 * WP-15 added `resources/list`, `resources/read`, `prompts/list` and
 * `prompts/get` beside the two tool methods, and with them the rule about which
 * of them may launch the app. Both tables live in `server.ts`, next to the
 * handlers they describe.
 *
 * **This file is the bundle's entry point**, and the last line of it connects a
 * `StdioServerTransport` to the real `process.stdin`. That is why everything
 * that decides what a request *means* lives in `server.ts`: importing this
 * module starts a server, so a test that wanted to drive one would start a
 * second one on the test runner's own stdin.
 *
 * **stdout is the protocol.** Every diagnostic in this process goes to stderr,
 * which is where an IDE collects MCP server logs; one stray `console.log` would
 * be a parse error at the other end and a server that "crashed on startup".
 *
 * The import closure here is `@modelcontextprotocol/sdk`, `zod` (through
 * `@shared/mcp-tools`) and three `node:` builtins. No electron, no
 * `better-sqlite3`, nothing under `src/main/` — `no-electron.test.ts` walks it.
 */
import { spawn } from 'node:child_process'
import { readFile, readlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpDiscovery } from '@shared/mcp-discovery'
import { APP_VERSION } from '@shared/version'
import { createConnector, openEndpointClient, probeDiscovery, type Connector } from './connect'
import { bundlePathFor, launch } from './launch'
import { createShimServer } from './server'

/** Diagnostics, on stderr, where an IDE collects them. */
export function logToStderr(line: string): void {
  process.stderr.write(`[witena-mcp] ${line}\n`)
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

// Nothing imports this module — it is the bundle's entry point. `probeDiscovery`
// is re-exported only so the closure test can reach it by name, and
// `createShimServer` so the shape of the shim can be read from one place.
export { probeDiscovery }
export { createShimServer } from './server'

void main().catch((cause: unknown) => {
  logToStderr(`fatal: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`)
  process.exit(1)
})
