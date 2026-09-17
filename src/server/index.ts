/**
 * The Node host: `npm run server`.
 *
 * The sibling of `src/main/index.ts`. That file is the Electron entry and is one
 * of the two places allowed to import electron; this one is the *other* host for
 * the same backend and imports none — enforced by `no-electron.test.ts`, which
 * walks this module's whole import graph.
 *
 * What it does, in order: read the environment, build the `AppContext`, build the
 * handler map, mount it over HTTP and the event bus over a WebSocket, and shut all
 * of it down cleanly on a signal. Everything interesting is in the modules it
 * calls; this file is wiring, exactly like its Electron counterpart.
 */
import { buildHandlers } from '../main/handlers'
import { readConfig, ENV_DATABASE_URL, type ServerConfig } from './config'
import { createServerContext } from './context'
import { createWitenaServer, type WitenaServer } from './http'

/** Signals that mean "stop": Ctrl-C at a terminal, `docker stop` in a container. */
const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const

/**
 * Starts the server and returns it together with the teardown.
 *
 * Exported so a test — or a future embedding, such as the one a VS Code extension
 * would want — can start the whole host without the signal handling and the
 * `process.exit` below.
 */
export async function startServer(config: ServerConfig): Promise<{
  server: WitenaServer
  stop: () => Promise<void>
}> {
  if (config.databaseUrl) {
    // Said out loud rather than silently ignored. `DATABASE_URL` is real — the
    // compose file, the Postgres migrator and the dual-dialect test fixture all
    // read it — but the handlers cannot run on it yet, because `Repositories` is
    // synchronous and drizzle's Postgres driver is not. See
    // `docs/features/server/context.md`, "Postgres is not the server's database yet".
    console.warn(
      `[witena] ${ENV_DATABASE_URL} is set but the server still opens SQLite at ` +
        `${config.databasePath}: the repository interface is synchronous (S8.1 decision 2)`
    )
  }

  const ctx = createServerContext(config)
  const server = createWitenaServer({ ctx, handlers: buildHandlers() })
  await server.listen(config.host, config.port)

  return {
    server,
    stop: async () => {
      await server.close()
      ctx.close()
    }
  }
}

/**
 * True when this module is the process entry rather than an import.
 *
 * `npm run server` builds to `out/server/index.js` and runs it with node, so the
 * comparison is against `process.argv[1]`; importing the module from a test does
 * not match and therefore starts nothing.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === new URL(`file://${entry}`).href
}

if (isEntryPoint()) {
  const config = readConfig()
  startServer(config)
    .then(({ stop }) => {
      let stopping = false
      for (const signal of STOP_SIGNALS) {
        process.on(signal, () => {
          // A second Ctrl-C while the first is still draining must not start a
          // second teardown against a context that is already closing.
          if (stopping) return
          stopping = true
          console.log(`[witena] ${signal}, shutting down`)
          stop()
            .then(() => process.exit(0))
            .catch((error: unknown) => {
              console.error('[witena] shutdown failed:', error)
              process.exit(1)
            })
        })
      }
    })
    .catch((error: unknown) => {
      console.error('[witena] server failed to start:', error)
      process.exit(1)
    })
}
