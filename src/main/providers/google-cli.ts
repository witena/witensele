/**
 * Signing in to Google, by delegating to Google's own CLI (`gcloud`).
 *
 * The mirror of `anthropic-cli.ts`, and for the same reason: the OAuth flow
 * needs a registered client, a redirect the vendor accepts and a place to keep a
 * refresh token that survives a restart, and the Google Cloud SDK already has
 * all three. Witena runs it and reads what it prints:
 *
 * | Command | Used for |
 * |---|---|
 * | `gcloud auth application-default print-access-token --format=json` | The status *and* the access token *and* the quota project. Prints one JSON object and refreshes the token when it is near expiry; exits 1 when there are no application-default credentials |
 * | `gcloud config list --format=json` | The fallback account and project, for a machine whose ADC carries neither |
 * | `gcloud auth application-default login` | Opens the system browser itself and exits when the flow finishes |
 * | `gcloud auth application-default revoke --quiet` | Deletes the local credential file |
 * | `gcloud auth application-default set-quota-project <id>` | Writes the project the requests are billed to into that same file |
 *
 * Every command that is *read* is asked for `--format=json`; nothing here parses
 * human-readable output. That rules out `gcloud config get-value account`, whose
 * unset answer is the word `(unset)` on stderr and an empty line on stdout, in
 * favour of `config list --format=json`, which simply omits the key. Verified
 * against Google Cloud SDK 553.0.0 on macOS.
 *
 * ## What is deliberately not used
 *
 * The Gemini CLI / Antigravity OAuth client and the `cloudcode-pa.googleapis.com`
 * Code Assist endpoint. Those tokens are first-party to Google's own tools, and
 * reusing somebody else's client id is the same shape of mistake as reusing
 * Claude Code's. Witena speaks the **public Gemini API** with credentials the
 * user's own CLI holds, which is a thing the user is entitled to do with them.
 *
 * ## The three states, and why a missing project is not a fourth
 *
 * `not-installed` and `signed-out` are states the panel renders, exactly as in
 * S5.3 — they are the ordinary condition of a machine that has never used the
 * SDK. A **missing quota project** is different: the user *is* signed in, the
 * panel says so and offers a field to fix it, but a request cannot be made,
 * because the Gemini API refuses an end-user credential that carries no
 * `x-goog-user-project`. So it is reported as `state: 'signed-in'` with no
 * `project`, and `gcloud_no_project` is raised only when something actually has
 * to send a request — the fetch wrapper, and Save.
 *
 * ## Credentials never leave this module
 *
 * `stdout` from `print-access-token` holds a live access token, a refresh token
 * and an id token. It is parsed and dropped; only `stderr` is ever quoted into
 * an error message, and what crosses IPC is a `ProviderAuthStatus` carrying the
 * account, the project and the expiry.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { GCLOUD_INSTALL_COMMAND } from '@shared/presets'
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

/** The executable's name on `PATH`. */
export const GCLOUD_BINARY = 'gcloud'

/** Environment variable that replaces the whole search with one absolute path. */
export const GCLOUD_BINARY_ENV = 'WITENA_GCLOUD_BIN'

/**
 * Searched after `PATH`, because a packaged app does not inherit the shell's.
 *
 * The cask puts `gcloud` in `/opt/homebrew/bin` (or `/usr/local/bin` on Intel);
 * the tarball install from Google unpacks to `~/google-cloud-sdk/bin`.
 */
export function defaultGcloudFallbackDirs(home: string = homedir()): string[] {
  return ['/opt/homebrew/bin', '/usr/local/bin', join(home, 'google-cloud-sdk', 'bin')]
}

/**
 * Budget for the commands that only read.
 *
 * Longer than the Anthropic CLI's 30 s on purpose: with no ADC present `gcloud`
 * probes the Compute Engine metadata server three times before giving up, which
 * takes about ten seconds on a laptop that is not in Google's cloud, and a
 * token refresh happens after that.
 */
export const GCLOUD_COMMAND_TIMEOUT_MS = 60_000

/** Budget for the login, which waits for a human in a browser. */
export const GCLOUD_LOGIN_TIMEOUT_MS = 5 * 60_000

/**
 * Assumed lifetime of a token whose expiry `gcloud` did not print.
 *
 * Google issues one-hour access tokens; five minutes of that is given away
 * rather than trusting an unknown. (The margin in `cli-process.ts` applies on
 * top, so the real cache window is 54 minutes.)
 */
export const ASSUMED_TOKEN_LIFETIME_MS = 55 * 60_000

/** `gcloud` is not installed, or not where `WITENA_GCLOUD_BIN` says it is. */
export function gcloudMissing(
  detail = 'The Google Cloud SDK (gcloud) was not found'
): BackendFailure {
  return new BackendFailure('gcloud_missing', detail, { install: GCLOUD_INSTALL_COMMAND })
}

/** `gcloud` is installed, but there are no application-default credentials. */
export function gcloudNotLoggedIn(
  detail = 'No Google application-default credentials are present'
): BackendFailure {
  return new BackendFailure('gcloud_not_logged_in', detail)
}

/** Signed in, but no project is named to bill the request to. */
export function gcloudNoProject(
  detail = 'No Google Cloud quota project is set for the application-default credentials'
): BackendFailure {
  return new BackendFailure('gcloud_no_project', detail)
}

/** The absolute path of the `gcloud` binary, or a throw saying it is missing. */
export function resolveGcloudBinary(
  env: Record<string, string | undefined>,
  fallbackDirs: readonly string[]
): string {
  return resolveCliBinary(GCLOUD_BINARY, GCLOUD_BINARY_ENV, env, fallbackDirs, gcloudMissing)
}

/**
 * The five things Witena asks of the CLI.
 *
 * An interface rather than a class so the registry, the handlers and every test
 * take the capability by injection: the unit tests drive the **real**
 * implementation against a fake `gcloud` script on `PATH`, while a handler test
 * that only cares about validation hands in a stub.
 */
export interface GoogleCli {
  /** Never rejects for "not installed" or "signed out": both are states. */
  status(): Promise<ProviderAuthStatus>
  /** Runs the browser flow and resolves with the status it produced. */
  login(): Promise<ProviderAuthStatus>
  /** Revokes the ADC and resolves with the resulting status. */
  logout(): Promise<ProviderAuthStatus>
  /**
   * A usable access token, refreshed by the CLI when needed and cached in
   * memory until shortly before it expires. Rejects `gcloud_missing` /
   * `gcloud_not_logged_in`.
   */
  accessToken(): Promise<string>
  /**
   * The quota project every request must name. Rejects `gcloud_no_project`
   * when there is none — a request without it is refused by the API, so
   * guessing or omitting would only move the failure somewhere less explicable.
   */
  project(): Promise<string>
  /** Writes the quota project into the ADC file and reports the new status. */
  setQuotaProject(project: string): Promise<ProviderAuthStatus>
}

export interface GoogleCliOptions {
  /** Defaults to `node:child_process.spawn`. */
  spawn?: SpawnFn
  /** Defaults to `process.env`; a test passes its own `PATH`. */
  env?: Record<string, string | undefined>
  /** Searched after `PATH`. Defaults to the three macOS install locations. */
  fallbackDirs?: readonly string[]
  /** Defaults to `Date.now`; a test moves it to expire the cached token. */
  now?: () => number
  commandTimeoutMs?: number
  loginTimeoutMs?: number
}

/** What one `print-access-token --format=json` call yields, after parsing. */
interface GoogleCredentials {
  accessToken: string
  /** Epoch milliseconds. */
  expiresAt: number
  account?: string
  project?: string
}

/**
 * `expiry.datetime` as epoch milliseconds.
 *
 * The SDK prints a **naive UTC** timestamp (`2026-09-14 05:14:51.579879`, with
 * `date -u` reading `2026-09-14 04:14:51` an hour earlier), so the `Z` is added
 * rather than left to the platform's local zone — which would be wrong by the
 * offset on every machine outside UTC. An unparseable value is no value: the
 * caller then assumes the documented one-hour lifetime.
 */
export function parseExpiry(datetime: unknown): number | undefined {
  if (typeof datetime !== 'string' || datetime.length === 0) return undefined
  const parsed = Date.parse(`${datetime.trim().replace(' ', 'T')}Z`)
  return Number.isNaN(parsed) ? undefined : parsed
}

function textField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * The real implementation: one child process per command, nothing cached but
 * the access token, its expiry and the two labels printed alongside it.
 */
export function createGoogleCli(options: GoogleCliOptions = {}): GoogleCli {
  const spawnImpl = options.spawn ?? defaultSpawn
  const env = options.env ?? (process.env as Record<string, string | undefined>)
  const fallbackDirs = options.fallbackDirs ?? defaultGcloudFallbackDirs()
  const clock = options.now ?? Date.now
  const commandTimeoutMs = options.commandTimeoutMs ?? GCLOUD_COMMAND_TIMEOUT_MS
  const loginTimeoutMs = options.loginTimeoutMs ?? GCLOUD_LOGIN_TIMEOUT_MS

  const cli: CliProcess = {
    binary: GCLOUD_BINARY,
    binaryEnv: GCLOUD_BINARY_ENV,
    missing: gcloudMissing,
    env,
    fallbackDirs,
    spawn: spawnImpl
  }

  /** The one piece of state: a credential and when it stops being usable. */
  let cached: GoogleCredentials | undefined

  async function run(args: readonly string[], timeoutMs: number): Promise<CommandResult> {
    return await runCliCommand(cli, args, timeoutMs)
  }

  /**
   * `gcloud config list --format=json`, for the account and project a machine
   * configured with `gcloud auth login` has but the ADC file does not.
   *
   * One call for both values rather than two `config get-value` spawns. A
   * failure here is not a failure of anything: the caller simply has no label
   * to print, so it answers with an empty record.
   */
  async function configCore(): Promise<Record<string, unknown>> {
    try {
      const result = await run(['config', 'list', '--format=json'], commandTimeoutMs)
      if (result.code !== 0) return {}
      const payload: unknown = JSON.parse(result.stdout)
      if (typeof payload !== 'object' || payload === null) return {}
      const core = (payload as { core?: unknown }).core
      return typeof core === 'object' && core !== null ? (core as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  /**
   * The ADC, refreshed by the CLI if it was near expiry.
   *
   * `stdout` holds a live access token, a refresh token and an id token, and
   * therefore never reaches an error message, a log line or an event — only
   * `stderr` is ever quoted.
   */
  async function readCredentials(): Promise<GoogleCredentials> {
    const result = await run(
      ['auth', 'application-default', 'print-access-token', '--format=json'],
      commandTimeoutMs
    )
    if (result.code !== 0) {
      throw gcloudNotLoggedIn(
        detailOf(result.stderr) || 'gcloud printed no application-default credentials'
      )
    }

    let payload: unknown
    try {
      payload = JSON.parse(result.stdout)
    } catch {
      throw new BackendFailure('internal', 'gcloud printed credentials that are not JSON')
    }
    if (typeof payload !== 'object' || payload === null) {
      throw new BackendFailure('internal', 'gcloud printed credentials in an unexpected shape')
    }

    const record = payload as Record<string, unknown>
    // The field is `token`, not `access_token`: this is the SDK's own credential
    // object, not an OAuth response body.
    const token = textField(record, 'token')
    if (!token) {
      throw new BackendFailure('internal', 'gcloud printed credentials without an access token')
    }

    const expiry = parseExpiry((record['expiry'] as { datetime?: unknown } | undefined)?.datetime)
    let account = textField(record, 'account')
    let project = textField(record, 'quota_project_id')

    if (!account || !project) {
      // Only then: an extra spawn for two labels is worth it once, and not at all
      // for a machine whose ADC already carries them.
      const core = await configCore()
      account ??= textField(core, 'account')
      project ??= textField(core, 'project')
    }

    // Cached on the way out rather than by the caller: every path that reads a
    // credential wants the next one to be free, and one place to remember it is
    // one place to forget it.
    cached = {
      accessToken: token,
      expiresAt: expiry ?? clock() + ASSUMED_TOKEN_LIFETIME_MS,
      ...optionalField('account', account),
      ...optionalField('project', project)
    }
    return cached
  }

  /** The cached credential while it is still good, otherwise a fresh one. */
  async function credentials(): Promise<GoogleCredentials> {
    const nowMs = clock()
    if (cached && nowMs < cached.expiresAt - TOKEN_EXPIRY_MARGIN_MS) return cached
    return await readCredentials()
  }

  /**
   * Always a fresh read, never the cache.
   *
   * The panel's "Sign in" doubles as "look again" for a user who installed the
   * SDK or logged in in another window, and a cached answer would make that
   * button do nothing for the best part of an hour. The read refreshes the cache
   * on its way through, so the honesty costs one spawn rather than every
   * subsequent request.
   */
  async function status(): Promise<ProviderAuthStatus> {
    try {
      const current = await readCredentials()
      return {
        state: 'signed-in',
        ...optionalField('account', current.account),
        ...optionalField('project', current.project),
        expiresAt: current.expiresAt
      }
    } catch (error) {
      const code = error instanceof BackendFailure ? error.code : undefined
      if (code === 'gcloud_missing') return { state: 'not-installed' }
      if (code === 'gcloud_not_logged_in') return { state: 'signed-out' }
      throw error
    }
  }

  return {
    status,

    async login() {
      cached = undefined
      const result = await run(['auth', 'application-default', 'login'], loginTimeoutMs)
      if (result.code !== 0) {
        // The usual cause is a flow the user closed or abandoned, which is not an
        // app failure — it is "still signed out", said precisely.
        throw gcloudNotLoggedIn(
          detailOf(result.stderr) || 'gcloud auth application-default login did not complete'
        )
      }
      return await status()
    },

    async logout() {
      cached = undefined
      // A non-zero exit here means "there was nothing to revoke", which is the
      // state the caller asked for anyway. `status()` reports the truth.
      await run(['auth', 'application-default', 'revoke', '--quiet'], commandTimeoutMs).catch(
        (error: unknown) => {
          if (error instanceof BackendFailure && error.code === 'gcloud_missing') throw error
          return undefined
        }
      )
      return await status()
    },

    async accessToken() {
      return (await credentials()).accessToken
    },

    async project() {
      const project = (await credentials()).project
      if (!project) throw gcloudNoProject()
      return project
    },

    async setQuotaProject(project: string) {
      const id = project.trim()
      if (id.length === 0) throw gcloudNoProject('A Google Cloud project id is required')

      const result = await run(
        ['auth', 'application-default', 'set-quota-project', id],
        commandTimeoutMs
      )
      // Dropped whether it worked or not: the file underneath just changed.
      cached = undefined
      if (result.code !== 0) {
        throw gcloudNoProject(
          detailOf(result.stderr) || `gcloud could not set the quota project to ${id}`
        )
      }
      return await status()
    }
  }
}
