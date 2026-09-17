/**
 * The server's configuration, read from the environment.
 *
 * The desktop build asks electron where things live; the server asks the
 * environment, and this module is the only place that reads `process.env`. Every
 * other file under `src/server/` takes a `ServerConfig`, which is what lets the
 * HTTP contract test build one by hand and start the whole server on an ephemeral
 * port without touching the machine's environment.
 *
 * No electron, by construction and by test (`no-electron.test.ts`).
 */
import { join, resolve } from 'node:path'
import { SECRETS_KEY_FILE } from '../main/secrets'

/** `PORT`: the TCP port to listen on. `0` asks the OS for a free one. */
export const ENV_PORT = 'PORT'
/** `HOST`: the interface to bind. Defaults to loopback, never `0.0.0.0` by accident. */
export const ENV_HOST = 'HOST'
/** `WITENA_DATA_DIR`: the server's equivalent of electron's `userData`. */
export const ENV_DATA_DIR = 'WITENA_DATA_DIR'
/** `WITENA_SECRETS_KEY`: absolute path of the `FileKeySecretStore` key file. */
export const ENV_SECRETS_KEY = 'WITENA_SECRETS_KEY'
/** `DATABASE_URL`: a Postgres connection string. See `postgres` in the docs. */
export const ENV_DATABASE_URL = 'DATABASE_URL'

/** File name of the SQLite database inside the data directory, as on the desktop. */
export const DATABASE_FILE = 'witena.db'

/** The port used when `PORT` is not set. */
export const DEFAULT_PORT = 4317

/** The interface used when `HOST` is not set. */
export const DEFAULT_HOST = '127.0.0.1'

export interface ServerConfig {
  host: string
  /** `0` means "any free port", which is how the tests start a server. */
  port: number
  /** Absolute path of the data directory: the database, `skills/` and `memory/`. */
  dataDir: string
  /** Absolute path of the SQLite file inside `dataDir`. */
  databasePath: string
  /** Absolute path of the encryption key file `FileKeySecretStore` holds. */
  secretsKeyPath: string
  /**
   * The Postgres connection string, when one is set.
   *
   * Present in the configuration because `docker-compose.yml`, the Postgres
   * migrator and the dual-dialect test fixture all read it. The server host
   * itself still opens SQLite: `Repositories` is a **synchronous** interface
   * (better-sqlite3) and drizzle's Postgres driver is asynchronous, so the
   * handlers cannot run on Postgres until that interface goes async. `startup`
   * says so out loud rather than silently ignoring the variable — see
   * `docs/features/server/context.md`, "Postgres is not the server's database
   * yet".
   */
  databaseUrl?: string
}

/** Reads one integer environment variable, falling back when it is absent or junk. */
function readPort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`${ENV_PORT} must be an integer from 0 to 65535, got ${JSON.stringify(raw)}`)
  }
  return value
}

/**
 * Builds the configuration from an environment-shaped record.
 *
 * Takes the record rather than reading `process.env` itself so a test can pass a
 * literal; `src/server/index.ts` passes `process.env`.
 *
 * The data directory defaults to `.witena-data` **relative to the working
 * directory**, which is right for `npm run server` on a laptop and wrong for a
 * container — which is why the container sets `WITENA_DATA_DIR` and the default
 * is deliberately local rather than something like `/var/lib/witena` that would
 * look production-ready without being it.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = resolve(env[ENV_DATA_DIR] ?? '.witena-data')
  const databaseUrl = env[ENV_DATABASE_URL]?.trim()
  return {
    host: env[ENV_HOST]?.trim() || DEFAULT_HOST,
    port: readPort(env[ENV_PORT], DEFAULT_PORT),
    dataDir,
    databasePath: join(dataDir, DATABASE_FILE),
    secretsKeyPath: resolve(env[ENV_SECRETS_KEY] ?? join(dataDir, SECRETS_KEY_FILE)),
    ...(databaseUrl ? { databaseUrl } : {})
  }
}
