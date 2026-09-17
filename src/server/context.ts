/**
 * Building the `AppContext` from a `ServerConfig`.
 *
 * The desktop build does the same thing in `src/main/index.ts` from
 * `app.getPath('userData')`; this is the second caller of `createAppContext`,
 * and the fact that it is *only* a second caller — no fork of the context, no
 * server-flavoured repositories — is what CLAUDE.md rule #5 buys.
 *
 * Two differences from the desktop, both of them consequences of having no
 * window rather than choices:
 *
 * - `FileKeySecretStore` is built **unwrapped**. On the desktop a signed build
 *   wraps the key file with electron's `safeStorage`; a server has no Keychain,
 *   so the key file's own permissions are the protection until `KmsSecretStore`
 *   replaces it in S8.4.
 * - Nothing seeds `skills/` from `resources/`: the bundled skills are copied by
 *   the packaged app on first launch, and a container image that wants them can
 *   mount them into `WITENA_DATA_DIR`. S8.3 decides whether the server ships a
 *   library of its own.
 */
import { mkdirSync } from 'node:fs'
import { createAppContext, type AppContext, type AppContextOptions } from '../main/app-context'
import { migrateProviderSecrets } from '../main/providers/migrate-secrets'
import { createFileKeySecretStore } from '../main/secrets'
import type { ServerConfig } from './config'

export interface ServerContextOptions {
  /** Where the server logs. Injected so a test can stay quiet. */
  log?: (message: string) => void
  /**
   * Passed straight through to `createAppContext`.
   *
   * The HTTP contract test uses it to inject `runner.createModel`, exactly as
   * `createTestAppContext` does for the unit suites — so the contract test drives
   * the real `ChatRunner` and the real `AgentTurn` against a `MockLanguageModelV4`
   * and never opens a socket to a provider.
   */
  context?: Partial<AppContextOptions>
}

/**
 * Opens the database, builds the context and runs the startup passes the desktop
 * app runs.
 *
 * `migrateProviderSecrets` is included on purpose: a data directory can be moved
 * from a laptop to a server, and a row still holding a `safeStorage` value would
 * otherwise be permanently unreadable with no explanation. It is idempotent and
 * skips every row that is already in the current format.
 */
export function createServerContext(
  config: ServerConfig,
  options: ServerContextOptions = {}
): AppContext {
  const log = options.log ?? ((message: string) => console.log(message))

  mkdirSync(config.dataDir, { recursive: true })

  const secrets = createFileKeySecretStore({ keyPath: config.secretsKeyPath })

  const ctx = createAppContext({
    databasePath: config.databasePath,
    userDataDir: config.dataDir,
    secrets,
    ...options.context
  })

  const migrated = migrateProviderSecrets(ctx)
  if (migrated.migrated.length > 0 || migrated.unreadable.length > 0) {
    log(
      `[witena] provider secrets: ${migrated.migrated.length} re-encrypted, ` +
        `${migrated.unreadable.length} unreadable`
    )
  }

  return ctx
}
