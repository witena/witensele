/**
 * The write sandbox `run_command` runs inside (S5.15).
 *
 * Until S5.15 the permission prompt was the entire boundary: `cwd` was confined
 * and the command was not, so an approved `npm test` could write anywhere the
 * user could. This module closes the half of that gap that can be closed on
 * macOS without a container — **writes** — by running the command under
 * `/usr/bin/sandbox-exec` with a generated profile.
 *
 * ## What the profile says
 *
 * | Operation | Allowed |
 * |---|---|
 * | Anything not named below | yes — the profile starts from `(allow default)` |
 * | Reading | everywhere the user can read, unchanged |
 * | Network | unchanged. A build that cannot fetch its dependencies is not a build |
 * | Writing | the working directory, the system temp directories, and the null-ish devices. Nothing else |
 *
 * `(allow default)` followed by `(deny file-write*)` followed by the allowances
 * is not redundant: SBPL takes the **last** matching rule, so this reads as
 * "everything, except writing, except here".
 *
 * ## What it does not do
 *
 * It is not a sandbox in the sense a container is. Reads are untouched, so a
 * command can still print the contents of `~/.ssh/id_rsa` into the transcript —
 * that is what the permission prompt and `command-policy.ts` are for. It is
 * macOS-only, `sandbox-exec` has been formally deprecated by Apple for years
 * while remaining the only thing of its kind on the platform, and a profile that
 * is too tight breaks the command rather than the machine. Those are the reasons
 * `AppSettings.executor.sandbox` has an `'off'`.
 *
 * No electron (CLAUDE.md rule #5); `node:fs` and `node:os` are the point.
 */
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'

/** The binary macOS ships. Absent means the sandbox cannot be applied at all. */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

/**
 * Devices a command may write even though they are outside the folder.
 *
 * `/dev/null` is the one every shell script in existence redirects into, and
 * `/dev/stdout` / `/dev/stderr` / `/dev/tty` are how a program that wants to
 * bypass its own buffering talks to the terminal. Refusing these would break
 * ordinary commands while protecting nothing: none of them is a file.
 */
export const WRITABLE_DEVICES = [
  '/dev/null',
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
  '/dev/dtracehelper'
]

/** Everything the profile generator needs. All injected, so the test is pure. */
export interface SandboxProfileInput {
  /**
   * The chat's working directory.
   *
   * Realpathed here as well as by the caller, and that is not belt and braces:
   * the sandbox matches the **real** path, and a folder reached through a
   * symlink (`/tmp/x`, `/var/folders/…` — which is what `mkdtemp` hands back on
   * macOS) would otherwise produce a profile that denies every write to the very
   * directory it was built for. Both spellings are listed.
   */
  workdir: string
  /**
   * Temp directories the command may write, over and above the folder.
   *
   * Defaults to the system ones. A compiler that cannot write a temp file fails
   * in a way nobody can debug from the transcript, and `/tmp` holds nothing the
   * user would mind an executor touching.
   */
  tempDirs?: readonly string[]
}

/** Quotes a path for an SBPL string literal. */
function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * The system temp directories, realpathed.
 *
 * `/tmp` is a symlink to `/private/tmp` on macOS and the sandbox matches on the
 * **real** path, so a profile that named `/tmp` would deny every write to it.
 * Both spellings are listed anyway: it costs one line and it is the single most
 * likely thing to be wrong on a machine configured differently.
 */
export function systemTempDirs(): string[] {
  const candidates = [tmpdir(), '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp']
  const seen = new Set<string>()
  for (const candidate of candidates) {
    seen.add(candidate)
    try {
      if (existsSync(candidate)) seen.add(realpathSync(candidate))
    } catch {
      // A temp directory that cannot be realpathed is simply not added.
    }
  }
  return [...seen]
}

/**
 * The SBPL profile for one working directory.
 *
 * A string rather than a file: `sandbox-exec -p` takes the profile inline, which
 * means no temp file to create, to clean up, or to leak when a turn is killed
 * mid-command.
 */
/** A path plus its realpath, deduplicated; the second is what the sandbox matches. */
function bothSpellings(path: string): string[] {
  try {
    const real = realpathSync(path)
    return real === path ? [path] : [path, real]
  } catch {
    // A directory that does not exist has no real path; naming it is harmless.
    return [path]
  }
}

export function buildSandboxProfile(input: SandboxProfileInput): string {
  const writable = [
    ...bothSpellings(input.workdir),
    ...(input.tempDirs ?? systemTempDirs()).flatMap(bothSpellings)
  ]
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    // Guarded: `(allow file-write* )` with no filter is a syntax error, and an
    // empty list is reachable through `tempDirs: []` in a test.
    ...(writable.length > 0
      ? [`(allow file-write* ${writable.map((path) => `(subpath ${sbplString(path)})`).join(' ')})`]
      : []),
    `(allow file-write* ${WRITABLE_DEVICES.map((path) => `(literal ${sbplString(path)})`).join(' ')})`,
    // A pseudo-terminal is allocated per device node, so it cannot be named as a
    // literal; anything under `/dev/tty` and `/dev/fd` is a stream, not a file.
    '(allow file-write* (regex #"^/dev/(tty|fd|ptmx|pty)"))',
    ''
  ].join('\n')
}

/** True when this machine has `sandbox-exec` at all. */
export function sandboxAvailable(): boolean {
  return existsSync(SANDBOX_EXEC)
}

/** The program and arguments one command line should actually be spawned with. */
export interface SandboxedCommand {
  file: string
  args: string[]
  /** False when the command is running unsandboxed, whatever the setting asked. */
  sandboxed: boolean
}

export interface SandboxCommandInput extends SandboxProfileInput {
  /** The command line, exactly as the user approved it. */
  command: string
  /** `AppSettings.executor.sandbox`. `'off'` skips everything here. */
  mode: 'workdir-write' | 'off'
  /** Injectable so the "missing binary" path is testable without hiding the real one. */
  available?: boolean
}

/**
 * Wraps a command line in `sandbox-exec`, or hands it back unchanged.
 *
 * The shell is still `/bin/sh -c <line>` in both cases, and it is *inside* the
 * sandbox rather than outside it, so a `&&` chain and everything the line spawns
 * inherits the profile. Wrapping only the first program would sandbox `sh` and
 * nothing it ran.
 */
export function sandboxCommand(input: SandboxCommandInput): SandboxedCommand {
  const plain: SandboxedCommand = { file: '/bin/sh', args: ['-c', input.command], sandboxed: false }
  if (input.mode === 'off') return plain
  if (!(input.available ?? sandboxAvailable())) return plain

  return {
    file: SANDBOX_EXEC,
    args: ['-p', buildSandboxProfile(input), '/bin/sh', '-c', input.command],
    sandboxed: true
  }
}
