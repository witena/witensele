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
 * copy. What crosses IPC is an `AnthropicAuthStatus`, which carries the account,
 * organisation, workspace and expiry — and never `access_token` or
 * `refresh_token`, which do not leave this module except as an `Authorization`
 * header built in `registry.ts`.
 *
 * ## Finding the binary
 *
 * A packaged Electron app does not inherit the login shell's `PATH`: it is
 * launched by `launchd` with a minimal one, so `ant` installed by Homebrew is
 * invisible to `spawn('ant')`. The search therefore walks `PATH` and then the
 * three places the CLI is actually installed on macOS. `WITENA_ANT_BIN`
 * overrides the whole search with one absolute path, for an install somewhere
 * else — and for the end-to-end spec, which needs a run where `ant` is
 * definitively absent.
 *
 * Electron is not imported here (CLAUDE.md rule #5); `node:child_process` is,
 * which the rule says nothing about and which the main process already uses for
 * stdio MCP servers.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { ANT_INSTALL_COMMAND } from '@shared/presets'
import type { AnthropicAuthStatus } from '@shared/types'
import { BackendFailure } from '../errors'

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

/** A token is treated as expired this long before it really is. */
export const TOKEN_EXPIRY_MARGIN_MS = 60_000

/** `ant` is not installed, or not where `WITENA_ANT_BIN` says it is. */
export function antMissing(detail = 'The Anthropic CLI (ant) was not found'): BackendFailure {
  return new BackendFailure('ant_missing', detail, { install: ANT_INSTALL_COMMAND })
}

/** `ant` is installed, but no profile is logged in. */
export function antNotLoggedIn(detail = 'No Anthropic profile is logged in'): BackendFailure {
  return new BackendFailure('ant_not_logged_in', detail)
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
  status(): Promise<AnthropicAuthStatus>
  /** Runs the browser flow and resolves with the status it produced. */
  login(): Promise<AnthropicAuthStatus>
  /** Removes the active profile and resolves with the resulting status. */
  logout(): Promise<AnthropicAuthStatus>
  /**
   * A usable access token, refreshed by the CLI when needed and cached in
   * memory until shortly before it expires. Rejects `ant_missing` /
   * `ant_not_logged_in`.
   */
  accessToken(): Promise<string>
}

/** The `spawn` surface this module needs; injectable so a test can watch it. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { stdio: ['ignore', 'pipe', 'pipe'] }
) => ChildProcess

export interface AnthropicCliOptions {
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

/** The fields of `ant auth print-credentials` this module reads. */
interface AntCredentials {
  accessToken: string
  /** Epoch milliseconds, converted from the CLI's unix seconds. */
  expiresAt?: number
  organizationName?: string
  accountEmail?: string
  workspaceName?: string
}

interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The absolute path of the `ant` binary, or a rejection saying it is missing.
 *
 * `WITENA_ANT_BIN` wins outright and is returned **without** an existence check,
 * so a path that is set but wrong fails at `spawn` with the same `ant_missing`
 * code rather than in two different ways.
 */
export function resolveAntBinary(
  env: Record<string, string | undefined>,
  fallbackDirs: readonly string[]
): string {
  const override = env[ANT_BINARY_ENV]?.trim()
  if (override) return override

  const fromPath = (env['PATH'] ?? '').split(delimiter).filter((entry) => entry.length > 0)
  for (const dir of [...fromPath, ...fallbackDirs]) {
    const candidate = join(dir, ANT_BINARY)
    if (isExecutable(candidate)) return candidate
  }
  throw antMissing(`${ANT_BINARY} was not found on PATH or in ${fallbackDirs.join(', ')}`)
}

/** Trimmed and bounded, so a CLI that prints an essay cannot fill a log line. */
function detailOf(stderr: string): string {
  return stderr.trim().slice(0, 200)
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
    ...optionalField('accountEmail', text('account_email')),
    ...optionalField('workspaceName', text('workspace_name'))
  }
}

/** `exactOptionalPropertyTypes` wants the key absent, not present and undefined. */
function optionalField<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: string }
}

/**
 * The real implementation: one child process per command, nothing cached but the
 * access token and its expiry.
 */
export function createAnthropicCli(options: AnthropicCliOptions = {}): AnthropicCli {
  const spawnImpl = options.spawn ?? (nodeSpawn as unknown as SpawnFn)
  const env = options.env ?? (process.env as Record<string, string | undefined>)
  const fallbackDirs = options.fallbackDirs ?? defaultFallbackDirs()
  const clock = options.now ?? Date.now
  const commandTimeoutMs = options.commandTimeoutMs ?? ANT_COMMAND_TIMEOUT_MS
  const loginTimeoutMs = options.loginTimeoutMs ?? ANT_LOGIN_TIMEOUT_MS

  /** The one piece of state: a token and when it stops being usable. */
  let cached: { token: string; expiresAt: number } | undefined

  async function run(args: readonly string[], timeoutMs: number): Promise<CommandResult> {
    const binary = resolveAntBinary(env, fallbackDirs)

    return await new Promise<CommandResult>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawnImpl(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        reject(antMissing(`Could not run ${binary}: ${String(error)}`))
        return
      }

      let stdout = ''
      let stderr = ''
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill()
        reject(
          new BackendFailure(
            'internal',
            `ant ${args.join(' ')} did not finish within ${timeoutMs} ms`
          )
        )
      }, timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      child.on('error', (error: NodeJS.ErrnoException) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // ENOENT is the whole reason the search above exists: it also happens
        // when `WITENA_ANT_BIN` points at nothing.
        if (error.code === 'ENOENT') reject(antMissing(`${binary} could not be executed`))
        else reject(new BackendFailure('internal', `Could not run ant: ${error.message}`))
      })

      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code: code ?? 1, stdout, stderr })
      })
    })
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

  async function status(): Promise<AnthropicAuthStatus> {
    try {
      const credentials = await readCredentials()
      return {
        state: 'signed-in',
        ...optionalField('organizationName', credentials.organizationName),
        ...optionalField('accountEmail', credentials.accountEmail),
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
