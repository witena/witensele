/**
 * Installing Witena into a coding agent, by driving that agent's own CLI.
 *
 * ## Why the CLI and not the file
 *
 * Both clients keep their MCP servers in a file — Claude Code in the
 * `mcpServers` object of `~/.claude.json`, Codex in `[mcp_servers.<name>]` of
 * `~/.codex/config.toml` — and writing those files directly would be one
 * `readFileSync` and one `writeFileSync`. It is not done, for one reason that
 * decides it: **those files belong to somebody else.** WP-0b measured Codex
 * rewriting the whole of `config.toml` on every `mcp add`, normalising unrelated
 * entries as it went (`120` became `120.0`, an `args = []` line disappeared),
 * and the Codex app holds the file open while it runs. A third party editing
 * that file is a corruption waiting for a race; the CLI is the interface its
 * author supports, and it is the thing that will be updated when the format is.
 *
 * ## The exact forms, as WP-0b measured them
 *
 * Recorded in `docs/features/mcp-endpoint/context.md`, "What the spike found →
 * WP-0b clients", and reproduced here as argument vectors — never a shell line,
 * so a bundle path containing a space needs no quoting and can never be
 * re-split.
 *
 * | | Claude Code | Codex |
 * |---|---|---|
 * | installed | `claude --version` | `codex --version` |
 * | read | `claude mcp get witena` | `codex mcp list --json` |
 * | register | `claude mcp add witena --scope user -- <command>` | `codex mcp add witena -- <command>` |
 * | unregister | `claude mcp remove witena -s user` | `codex mcp remove witena` |
 *
 * Three findings shape the reads:
 *
 * - Claude Code has **no `--json`**, so `mcp get` is parsed from its own
 *   `  Command: <command>` line. Its exit status is the primary answer: `1` and
 *   *No MCP server named "witena"* mean "not registered", which is a state and
 *   not a failure.
 * - Codex's human-readable `mcp get` / `mcp list` **mask every env value** as
 *   `*****`, so only the `--json` form may be parsed. `mcp list --json` also
 *   reports servers injected by Codex plugins that are in no config file at all,
 *   so the entry is found **by name** and nothing is inferred from the count.
 * - `codex mcp add` has no scope flag: it is always global. `claude mcp add`
 *   needs `--scope user`, or the registration lands in whatever directory the
 *   process happened to be in.
 *
 * ## Finding the binary
 *
 * Neither CLI is on the `PATH` of a packaged Electron app — WP-0b found neither
 * on the *login* shell's `PATH` either — so the search is the one
 * `providers/cli-process.ts` already does for `ant` and `gcloud`: an environment
 * override, then `PATH`, then the places the software actually installs itself.
 * Claude Code's is a versioned directory, so its candidates are globbed and
 * sorted highest-first; Codex ships inside the ChatGPT application bundle.
 *
 * Claude Code's binary is a multi-call executable, so "a file is there" is not
 * proof that it is the CLI: `detect` confirms with `--version` and reads the
 * exit status, exactly as WP-0b did.
 *
 * Electron is not imported (CLAUDE.md rule #5), and neither is anything under
 * `src/main/` but the two shared helpers — the whole module is a function of an
 * injected `execFile`, an injected environment and an injected home directory,
 * which is what lets the unit tests assert argument vectors without ever running
 * a real CLI.
 */
import { execFile as nodeExecFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MCP_SERVER_NAME } from '@shared/mcp-tools'
import { IDE_CLIENT_IDS, type IdeClientId, type ValidationReason } from '@shared/types'
import { BackendFailure } from '../errors'
import { resolveCliBinary } from '../providers/cli-process'

/** One command's exit status and both of its streams. */
export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * The `execFile` surface this module needs.
 *
 * It resolves for a **non-zero exit** rather than rejecting, because a non-zero
 * exit is an answer here and not a crash: `claude mcp get witena` exits 1 to say
 * "nothing is registered", which is precisely the state the settings section
 * draws. It rejects only when the binary could not be run at all or outran its
 * budget.
 */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number }
) => Promise<ExecResult>

/** Budget for one CLI call. `claude mcp get` health-checks the server it finds. */
export const IDE_CLIENT_TIMEOUT_MS = 60_000

/** Environment variable that replaces Claude Code's whole binary search. */
export const CLAUDE_BINARY_ENV = 'WITENA_CLAUDE_BIN'

/** Environment variable that replaces Codex's whole binary search. */
export const CODEX_BINARY_ENV = 'WITENA_CODEX_BIN'

/** Where Claude Code keeps its versioned installations, under the user's home. */
export const CLAUDE_CODE_ROOT = ['Library', 'Application Support', 'Claude', 'claude-code']

/** The folder Codex ships in, inside the ChatGPT application bundle. */
export const CODEX_BUNDLE_DIR = '/Applications/ChatGPT.app/Contents/Resources'

/**
 * Version directory names, newest first.
 *
 * Compared segment by segment as numbers so `2.1.275` sorts above `2.1.10` and
 * above `2.1.9`, which a string sort gets wrong in both directions. A name with
 * a non-numeric segment (a pre-release, a stray folder) sorts last rather than
 * throwing: it is still a candidate, just not the one to try first.
 */
export function newestVersionFirst(names: readonly string[]): string[] {
  const parts = (name: string): number[] =>
    name.split('.').map((segment) => {
      const value = Number.parseInt(segment, 10)
      return Number.isNaN(value) ? -1 : value
    })

  return [...names].sort((left, right) => {
    const a = parts(left)
    const b = parts(right)
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const difference = (b[index] ?? -1) - (a[index] ?? -1)
      if (difference !== 0) return difference
    }
    return left < right ? 1 : left > right ? -1 : 0
  })
}

/**
 * The directories a `claude` binary might be in, newest installation first.
 *
 * Empty when the root does not exist, which is every machine that never
 * installed Claude Code — and the reason this reads the directory rather than
 * guessing a version: the number changes with every automatic update.
 */
export function claudeCodeDirs(home: string): string[] {
  const root = join(home, ...CLAUDE_CODE_ROOT)
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  return newestVersionFirst(entries).map((version) =>
    join(root, version, 'claude.app', 'Contents', 'MacOS')
  )
}

/** Everything that differs between the two clients, as data. */
interface IdeClientCli {
  id: IdeClientId
  /** The executable's name on `PATH`. */
  binary: string
  binaryEnv: string
  /** Searched after `PATH`, because a packaged app does not inherit the shell's. */
  fallbackDirs: (home: string) => string[]
  /** `mcp add`'s vector, without the binary. */
  addArgs: (command: string) => string[]
  /** `mcp remove`'s vector, without the binary. */
  removeArgs: () => string[]
  /** The read, and how to turn its result into a registered command. */
  readArgs: () => string[]
  readCommand: (result: ExecResult) => string | null
}

/**
 * `  Command: <command>` out of `claude mcp get <name>`.
 *
 * The output is a block of two-space-indented `Label: value` lines (`Scope`,
 * `Status`, `Type`, `Command`, `Args`, …). Only the first `Command:` is read,
 * and only when the call succeeded: an exit of 1 is *No MCP server named
 * "witena"*, which is "not registered" and must not be mistaken for a command
 * that happens to be empty.
 */
export function parseClaudeCommand(result: ExecResult): string | null {
  if (result.code !== 0) return null
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*Command:\s*(.+?)\s*$/.exec(line)
    if (match) return match[1] as string
  }
  return null
}

/**
 * The `witena` entry of `codex mcp list --json`, by name.
 *
 * By name and never by position: WP-0b measured the list including servers
 * injected by Codex plugins that are in no configuration file, so neither the
 * order nor the count says anything. Unparsable output is "not registered"
 * rather than a throw — the section has to draw something, and a Codex that
 * printed something unexpected is not a reason to fail a status read.
 */
export function parseCodexCommand(result: ExecResult): string | null {
  if (result.code !== 0) return null
  let payload: unknown
  try {
    payload = JSON.parse(result.stdout)
  } catch {
    return null
  }
  if (!Array.isArray(payload)) return null
  for (const entry of payload) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as { name?: unknown; transport?: unknown }
    if (record.name !== MCP_SERVER_NAME) continue
    const transport = record.transport
    if (typeof transport !== 'object' || transport === null) return null
    const command = (transport as { command?: unknown }).command
    return typeof command === 'string' && command.length > 0 ? command : null
  }
  return null
}

const CLIS: Record<IdeClientId, IdeClientCli> = {
  'claude-code': {
    id: 'claude-code',
    binary: 'claude',
    binaryEnv: CLAUDE_BINARY_ENV,
    fallbackDirs: claudeCodeDirs,
    // `--scope user` is what makes the registration follow the user rather than
    // the directory the app happened to be launched from; `--` separates our
    // command from `claude`'s own flags, and is required even without arguments.
    addArgs: (command) => ['mcp', 'add', MCP_SERVER_NAME, '--scope', 'user', '--', command],
    removeArgs: () => ['mcp', 'remove', MCP_SERVER_NAME, '-s', 'user'],
    readArgs: () => ['mcp', 'get', MCP_SERVER_NAME],
    readCommand: parseClaudeCommand
  },
  codex: {
    id: 'codex',
    binary: 'codex',
    binaryEnv: CODEX_BINARY_ENV,
    fallbackDirs: () => [CODEX_BUNDLE_DIR],
    // No scope flag exists: `codex mcp add` is always global (WP-0b).
    addArgs: (command) => ['mcp', 'add', MCP_SERVER_NAME, '--', command],
    removeArgs: () => ['mcp', 'remove', MCP_SERVER_NAME],
    readArgs: () => ['mcp', 'list', '--json'],
    readCommand: parseCodexCommand
  }
}

/**
 * The four things the Integrations section asks of a coding agent.
 *
 * An interface rather than a class, for the same reason `AnthropicCli` is one:
 * every caller takes it by injection, so the handler tests drive the real
 * decision-making against a fake that records what it was asked, and the unit
 * tests of the real implementation assert argument vectors against an injected
 * `execFile`. **Nothing in `npm test` ever runs a real `mcp add` or
 * `mcp remove`** — those write files that belong to the user.
 */
export interface IdeClients {
  /** Whether the client's own CLI is on this machine and answers `--version`. */
  detect(id: IdeClientId): Promise<boolean>
  /** The command registered as the `witena` MCP server, or `null`. */
  registered(id: IdeClientId): Promise<string | null>
  /** Registers `command` as the `witena` MCP server, user-scoped where that exists. */
  register(id: IdeClientId, command: string): Promise<void>
  /** Removes the `witena` MCP server. */
  unregister(id: IdeClientId): Promise<void>
}

export interface IdeClientsOptions {
  /** Defaults to a promisified `node:child_process.execFile`. */
  execFile?: ExecFileFn
  /** Defaults to `process.env`; a test passes its own `PATH` and overrides. */
  env?: Record<string, string | undefined>
  /** Defaults to `os.homedir()`; a test points it at a temporary directory. */
  home?: string
  /**
   * Replaces one client's install locations, as `AnthropicCliOptions` does for
   * `ant`.
   *
   * A test needs it for the case the overrides cannot express: *no binary
   * anywhere*. `/Applications/ChatGPT.app` is a real directory on a machine that
   * has ChatGPT installed, so a suite that left the default in would pass or
   * fail depending on whose laptop it ran on.
   */
  fallbackDirs?: Partial<Record<IdeClientId, readonly string[]>>
  timeoutMs?: number
}

/** `execFile`, as the shape above: a non-zero exit is a result, not a rejection. */
export const defaultExecFile: ExecFileFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    nodeExecFile(
      file,
      [...args],
      { timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr })
          return
        }
        // A plain non-zero exit carries a numeric `code`; a signal, an ENOENT or
        // the timeout's kill carries a string one (or none), and those are the
        // cases where the command genuinely could not be run.
        const status = (error as NodeJS.ErrnoException & { code?: number | string }).code
        if (typeof status === 'number') {
          resolve({ code: status, stdout, stderr })
          return
        }
        reject(error)
      }
    )
  })

/**
 * The refusal a CLI that is not on this machine produces.
 *
 * It carries the same `ValidationReason` the handler raises after its own
 * `detect`, so a client that disappears between the two calls is reported as the
 * state it is in rather than as an internal error.
 */
function clientMissing(cli: IdeClientCli): (detail: string) => BackendFailure {
  return (detail) =>
    new BackendFailure('validation', detail, {
      reason: 'integrations_client_not_installed' satisfies ValidationReason,
      client: cli.id
    })
}

export function createIdeClients(options: IdeClientsOptions = {}): IdeClients {
  const exec = options.execFile ?? defaultExecFile
  const env = options.env ?? (process.env as Record<string, string | undefined>)
  const home = options.home ?? homedir()
  const timeoutMs = options.timeoutMs ?? IDE_CLIENT_TIMEOUT_MS

  /** The absolute path of one client's CLI, or a throw naming it. */
  function binaryOf(id: IdeClientId): string {
    const cli = CLIS[id]
    const dirs = options.fallbackDirs?.[id] ?? cli.fallbackDirs(home)
    return resolveCliBinary(cli.binary, cli.binaryEnv, env, dirs, clientMissing(cli))
  }

  async function run(id: IdeClientId, args: readonly string[]): Promise<ExecResult> {
    return await exec(binaryOf(id), args, { timeoutMs })
  }

  /** A command that had to succeed and did not: the CLI's own words, bounded. */
  function assertOk(id: IdeClientId, args: readonly string[], result: ExecResult): void {
    if (result.code === 0) return
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 200)
    throw new BackendFailure(
      'internal',
      `${CLIS[id].binary} ${args.join(' ')} exited ${result.code}${detail ? `: ${detail}` : ''}`
    )
  }

  return {
    async detect(id) {
      try {
        const result = await run(id, ['--version'])
        return result.code === 0
      } catch {
        // No binary, or one that could not be executed. Both are "not installed",
        // which is a state the section draws rather than an error it reports.
        return false
      }
    },

    async registered(id) {
      const cli = CLIS[id]
      const args = cli.readArgs()
      return cli.readCommand(await run(id, args))
    },

    async register(id, command) {
      const args = CLIS[id].addArgs(command)
      assertOk(id, args, await run(id, args))
    },

    async unregister(id) {
      const args = CLIS[id].removeArgs()
      assertOk(id, args, await run(id, args))
    }
  }
}

/**
 * An `IdeClients` with nothing behind it.
 *
 * The honest answer wherever no coding agent can be reached — the Node host, and
 * every unit test that is not about this module — and the reason it lives beside
 * the real one rather than in `testing.ts`: `src/server/` must be able to build a
 * context without reaching into a test-only file.
 */
export function absentIdeClients(): IdeClients {
  const unavailable = (): Promise<never> =>
    Promise.reject(
      new BackendFailure('validation', 'No coding agent CLI is reachable from this build')
    )
  return {
    detect: () => Promise.resolve(false),
    registered: () => Promise.resolve(null),
    register: unavailable,
    unregister: unavailable
  }
}

/** Narrows an unknown value to a client id the backend knows. */
export function isIdeClientId(value: unknown): value is IdeClientId {
  return typeof value === 'string' && (IDE_CLIENT_IDS as readonly string[]).includes(value)
}
