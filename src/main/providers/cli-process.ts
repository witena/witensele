/**
 * The plumbing both vendor CLI wrappers need: find the binary, run one command,
 * quote only what is safe to quote.
 *
 * Extracted in S5.13, when `google-cli.ts` turned out to need the same sixty
 * lines `anthropic-cli.ts` had written for `ant` in S5.3. The two wrappers differ
 * in *what they ask their CLI* and in which `BackendErrorCode` a missing binary
 * maps to; they do not differ in how a child process is spawned, timed out or
 * read, and two copies of that would drift the first time one of them learned
 * something.
 *
 * ## Finding the binary
 *
 * A packaged Electron app does not inherit the login shell's `PATH`: `launchd`
 * gives it a minimal one, so a Homebrew install is invisible to `spawn('ant')`
 * or `spawn('gcloud')`. The search therefore walks `PATH` and then the places
 * the CLI is actually installed on macOS, which each wrapper names for itself.
 * An environment override (`WITENA_ANT_BIN`, `WITENA_GCLOUD_BIN`) replaces the
 * whole search with one absolute path — for an unusual install, and for the
 * end-to-end specs, which need a run where the CLI is definitively absent on a
 * machine that has it.
 *
 * Electron is not imported here (CLAUDE.md rule #5); `node:child_process` is,
 * which the rule says nothing about and which the main process already uses for
 * stdio MCP servers.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { BackendFailure } from '../errors'

/** A token is treated as expired this long before it really is. */
export const TOKEN_EXPIRY_MARGIN_MS = 60_000

/** The `spawn` surface these wrappers need; injectable so a test can watch it. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { stdio: ['ignore', 'pipe', 'pipe'] }
) => ChildProcess

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Everything a wrapper has to tell this module about its own CLI.
 *
 * `missing` is a factory rather than a code string because the failure carries
 * the vendor's install command in `details`, which only the wrapper knows.
 */
export interface CliProcess {
  /** The executable's name on `PATH`, e.g. `ant`. */
  binary: string
  /** Environment variable that replaces the whole search, e.g. `WITENA_ANT_BIN`. */
  binaryEnv: string
  /** Builds this vendor's "the binary is not there" failure. */
  missing: (detail: string) => BackendFailure
  env: Record<string, string | undefined>
  /** Searched after `PATH`, because a packaged app does not inherit the shell's. */
  fallbackDirs: readonly string[]
  spawn: SpawnFn
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
 * The absolute path of the CLI, or a throw saying it is missing.
 *
 * The override wins outright and is returned **without** an existence check, so
 * a path that is set but wrong fails at `spawn` with the same code rather than
 * in two different ways.
 */
export function resolveCliBinary(
  binary: string,
  binaryEnv: string,
  env: Record<string, string | undefined>,
  fallbackDirs: readonly string[],
  missing: (detail: string) => BackendFailure
): string {
  const override = env[binaryEnv]?.trim()
  if (override) return override

  const fromPath = (env['PATH'] ?? '').split(delimiter).filter((entry) => entry.length > 0)
  for (const dir of [...fromPath, ...fallbackDirs]) {
    const candidate = join(dir, binary)
    if (isExecutable(candidate)) return candidate
  }
  throw missing(`${binary} was not found on PATH or in ${fallbackDirs.join(', ')}`)
}

/**
 * Runs one command and resolves with its exit code and both streams.
 *
 * It never rejects for a non-zero exit — that is an answer the caller has to
 * interpret ("no profile is logged in" is not a crash) — only for a binary that
 * could not be run at all, or one that outran its budget.
 */
export async function runCliCommand(
  cli: CliProcess,
  args: readonly string[],
  timeoutMs: number
): Promise<CommandResult> {
  const binary = resolveCliBinary(cli.binary, cli.binaryEnv, cli.env, cli.fallbackDirs, cli.missing)

  return await new Promise<CommandResult>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = cli.spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(cli.missing(`Could not run ${binary}: ${String(error)}`))
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
          `${cli.binary} ${args.join(' ')} did not finish within ${timeoutMs} ms`
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
      // ENOENT is the whole reason the search above exists: it also happens when
      // the override variable points at nothing.
      if (error.code === 'ENOENT') reject(cli.missing(`${binary} could not be executed`))
      else reject(new BackendFailure('internal', `Could not run ${cli.binary}: ${error.message}`))
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
 * Trimmed and bounded, so a CLI that prints an essay cannot fill a log line.
 *
 * Only ever applied to `stderr`. `stdout` is where both CLIs print credentials,
 * so it is parsed and dropped and never reaches a message, a log or an event.
 */
export function detailOf(stderr: string): string {
  return stderr.trim().slice(0, 200)
}

/** `exactOptionalPropertyTypes` wants the key absent, not present and undefined. */
export function optionalField<K extends string>(
  key: K,
  value: string | undefined
): { [P in K]?: string } {
  return (value === undefined || value.length === 0 ? {} : { [key]: value }) as { [P in K]?: string }
}

/** The platform `spawn`, as the type this module uses. Defaulted by both wrappers. */
export const defaultSpawn = nodeSpawn as unknown as SpawnFn
