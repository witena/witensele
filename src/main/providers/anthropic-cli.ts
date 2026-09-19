/**
 * Signing in to Anthropic, by delegating to Anthropic's own CLI (`ant`).
 *
 * ## Why a CLI and not an OAuth client of our own
 *
 * The OAuth flow needs a registered client, a redirect the vendor accepts, and a
 * place to keep a refresh token that survives a restart. `ant` already has all
 * three, and it is the software Anthropic supports for exactly this. So Witena
 * runs it and reads what it prints:
 *
 * | Command | Used for |
 * |---|---|
 * | `ant auth print-credentials` | Both the status *and* the access token. Prints JSON and refreshes the token when it is near expiry; exits non-zero when no profile is logged in |
 * | `ant auth login` | Opens the system browser itself and exits when the flow finishes |
 * | `ant auth logout` | Removes the active profile |
 *
 * `ant auth status` is deliberately **not** parsed: it prints prose, and the
 * global `--format json` flag does not apply to it (verified on `ant` 1.32.0).
 *
 * The consequence that matters for the rest of the app: **Witena stores no
 * token.** `SecretStore` is untouched, the database has no credential column,
 * and `ant auth logout` signs Witena out too, because there was never a second
 * copy. What crosses IPC is a `ProviderAuthStatus`, which carries the account,
 * organisation, workspace and expiry — and never `access_token` or
 * `refresh_token`, which do not leave this module except as an `Authorization`
 * header built in `registry.ts`.
 *
 * ## Finding the binary, and running it
 *
 * Both live in `cli-process.ts` since S5.13, because `google-cli.ts` needs the
 * same search and the same child-process handling. What stays here is what is
 * specific to `ant`: its name, its install locations, its two error codes and
 * the shape of what it prints. `WITENA_ANT_BIN` overrides the whole search with
 * one absolute path, for an install somewhere else — and for the end-to-end
 * spec, which needs a run where `ant` is definitively absent.
 *
 * ## The copy shipped with the app
 *
 * The build carries its own `ant` (`scripts/fetch-ant.mjs`, pinned in
 * `build/ant-release.json`), so that Sign in opens a browser on a machine that
 * never installed the CLI instead of showing a `brew install` line. The host
 * passes its folder as `bundledDir` and it is searched **last**: an `ant` the
 * user installed themselves is theirs to upgrade and is the one that wrote the
 * profile on disk, so a newer CLI's credentials are never read by an older
 * bundled one. `not-installed` remains a real state — a checkout that never
 * fetched the binary, the Node server — it is just no longer the common one.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ANT_INSTALL_COMMAND } from '@shared/presets'
import type { ProviderAuthStatus } from '@shared/types'
import { BackendFailure } from '../errors'
import {
  defaultSpawn,
  detailOf,
  optionalField,
  resolveCliBinary,
  runCliCommand,
  TOKEN_EXPIRY_MARGIN_MS,
  type CliProcess,
  type CommandResult,
  type SpawnFn
} from './cli-process'

/** Re-exported so a caller does not have to know the helper exists. */
export { TOKEN_EXPIRY_MARGIN_MS } from './cli-process'
export type { SpawnFn } from './cli-process'

/** The executable's name on `PATH`. */
export const ANT_BINARY = 'ant'

/** Environment variable that replaces the whole search with one absolute path. */
export const ANT_BINARY_ENV = 'WITENA_ANT_BIN'

/** Searched after `PATH`, because a packaged app does not inherit the shell's. */
export function defaultFallbackDirs(home: string = homedir()): string[] {
  return ['/opt/homebrew/bin', '/usr/local/bin', join(home, 'go', 'bin')]
}

/** Budget for the commands that only read: long enough for a token refresh. */
export const ANT_COMMAND_TIMEOUT_MS = 30_000

/** Budget for `ant auth login`, which waits for a human in a browser. */
export const ANT_LOGIN_TIMEOUT_MS = 5 * 60_000

/** `ant` is not installed, or not where `WITENA_ANT_BIN` says it is. */
export function antMissing(detail = 'The Anthropic CLI (ant) was not found'): BackendFailure {
  return new BackendFailure('ant_missing', detail, { install: ANT_INSTALL_COMMAND })
}

/** `ant` is installed, but no profile is logged in. */
export function antNotLoggedIn(detail = 'No Anthropic profile is logged in'): BackendFailure {
  return new BackendFailure('ant_not_logged_in', detail)
}

/**
 * The absolute path of the `ant` binary, or a throw saying it is missing.
 *
 * A thin naming of the shared resolver, kept because it is what the test and the
 * documentation call this step's binary search.
 */
export function resolveAntBinary(
  env: Record<string, string | undefined>,
  fallbackDirs: readonly string[]
): string {
  return resolveCliBinary(ANT_BINARY, ANT_BINARY_ENV, env, fallbackDirs, antMissing)
}

/**
 * The four things Witena asks of the CLI.
 *
 * An interface rather than a class so the registry, the handlers and every test
 * take the capability by injection: the unit tests drive the **real**
 * implementation against a fake `ant` script on `PATH`, while a handler test that
 * only cares about validation hands in a stub.
 */
export interface AnthropicCli {
  /** Never rejects for "not installed" or "signed out": both are states. */
  status(): Promise<ProviderAuthStatus>
  /** Runs the browser flow and resolves with the status it produced. */
  login(): Promise<ProviderAuthStatus>
  /** Removes the active profile and resolves with the resulting status. */
  logout(): Promise<ProviderAuthStatus>
  /**
   * A usable access token, refreshed by the CLI when needed and cached in
   * memory until shortly before it expires. Rejects `ant_missing` /
   * `ant_not_logged_in`.
   */
  accessToken(): Promise<string>
}

export interface AnthropicCliOptions {
  /** Defaults to `node:child_process.spawn`. */
  spawn?: SpawnFn
  /** Defaults to `process.env`; a test passes its own `PATH`. */
  env?: Record<string, string | undefined>
  /** Searched after `PATH`. Defaults to the three macOS install locations. */
  fallbackDirs?: readonly string[]
  /** Folder of the `ant` shipped with the app, searched after everything else. */
  bundledDir?: string
  /** Defaults to `Date.now`; a test moves it to expire the cached token. */
  now?: () => number
  commandTimeoutMs?: number
  loginTimeoutMs?: number
}

/** The fields of `ant auth print-credentials` this module reads. */
interface AntCredentials {
  accessToken: string
  /** Epoch milliseconds, converted from the CLI's unix seconds. */
  expiresAt?: number
  organizationName?: string
  account?: string
  workspaceName?: string
}

function readCredentialFields(payload: unknown): AntCredentials {
  if (typeof payload !== 'object' || payload === null) {
    throw new BackendFailure('internal', 'ant printed credentials in an unexpected shape')
  }
  const record = payload as Record<string, unknown>
  const token = record['access_token']
  if (typeof token !== 'string' || token.length === 0) {
    throw new BackendFailure('internal', 'ant printed credentials without an access token')
  }
  const expiresAt = record['expires_at']
  const text = (key: string): string | undefined => {
    const value = record[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  return {
    accessToken: token,
    // The CLI prints unix **seconds**; every timestamp in Witena is milliseconds.
    ...(typeof expiresAt === 'number' ? { expiresAt: expiresAt * 1000 } : {}),
    ...optionalField('organizationName', text('organization_name')),
    ...optionalField('account', text('account_email')),
    ...optionalField('workspaceName', text('workspace_name'))
  }
}

/**
 * The real implementation: one child process per command, nothing cached but the
 * access token and its expiry.
 */
export function createAnthropicCli(options: AnthropicCliOptions = {}): AnthropicCli {
  const spawnImpl = options.spawn ?? defaultSpawn
  const env = options.env ?? (process.env as Record<string, string | undefined>)
  const fallbackDirs = [
    ...(options.fallbackDirs ?? defaultFallbackDirs()),
    ...(options.bundledDir === undefined ? [] : [options.bundledDir])
  ]
  const clock = options.now ?? Date.now
  const commandTimeoutMs = options.commandTimeoutMs ?? ANT_COMMAND_TIMEOUT_MS
  const loginTimeoutMs = options.loginTimeoutMs ?? ANT_LOGIN_TIMEOUT_MS

  /** The one piece of state: a token and when it stops being usable. */
  let cached: { token: string; expiresAt: number } | undefined

  const cli: CliProcess = {
    binary: ANT_BINARY,
    binaryEnv: ANT_BINARY_ENV,
    missing: antMissing,
    env,
    fallbackDirs,
    spawn: spawnImpl
  }

  async function run(args: readonly string[], timeoutMs: number): Promise<CommandResult> {
    return await runCliCommand(cli, args, timeoutMs)
  }

  /**
   * The CLI's credentials, refreshed by it if they were near expiry.
   *
   * `stdout` holds a live token and therefore never reaches an error message, a
   * log line or an event — only `stderr` is ever quoted.
   */
  async function readCredentials(): Promise<AntCredentials> {
    const result = await run(['auth', 'print-credentials'], commandTimeoutMs)
    if (result.code !== 0) {
      throw antNotLoggedIn(
        detailOf(result.stderr) || 'ant auth print-credentials exited without credentials'
      )
    }
    let payload: unknown
    try {
      payload = JSON.parse(result.stdout)
    } catch {
      throw new BackendFailure('internal', 'ant printed credentials that are not JSON')
    }
    return readCredentialFields(payload)
  }

  async function status(): Promise<ProviderAuthStatus> {
    try {
      const credentials = await readCredentials()
      return {
        state: 'signed-in',
        ...optionalField('organizationName', credentials.organizationName),
        ...optionalField('account', credentials.account),
        ...optionalField('workspaceName', credentials.workspaceName),
        ...(credentials.expiresAt === undefined ? {} : { expiresAt: credentials.expiresAt })
      }
    } catch (error) {
      const code = error instanceof BackendFailure ? error.code : undefined
      if (code === 'ant_missing') return { state: 'not-installed' }
      if (code === 'ant_not_logged_in') return { state: 'signed-out' }
      throw error
    }
  }

  return {
    status,

    async login() {
      cached = undefined
      const result = await run(['auth', 'login'], loginTimeoutMs)
      if (result.code !== 0) {
        // The usual cause is a flow the user closed or abandoned, which is not
        // an app failure — it is "still signed out", said precisely.
        throw antNotLoggedIn(detailOf(result.stderr) || 'ant auth login did not complete')
      }
      return await status()
    },

    async logout() {
      cached = undefined
      // A non-zero exit here means "there was nothing to log out of", which is
      // the state the caller asked for anyway. `status()` reports the truth.
      await run(['auth', 'logout'], commandTimeoutMs).catch((error: unknown) => {
        if (error instanceof BackendFailure && error.code === 'ant_missing') throw error
        return undefined
      })
      return await status()
    },

    async accessToken() {
      const nowMs = clock()
      if (cached && nowMs < cached.expiresAt - TOKEN_EXPIRY_MARGIN_MS) return cached.token

      const credentials = await readCredentials()
      cached = {
        token: credentials.accessToken,
        // A CLI that printed no expiry gets no cache: the next call asks again
        // rather than holding a token whose lifetime is unknown.
        expiresAt: credentials.expiresAt ?? 0
      }
      return credentials.accessToken
    }
  }
}
