/**
 * The executor's built-in tools, and the briefing that tells it they exist.
 *
 * Seven tools over one folder — the chat's `workdir` (S5.2) — in two families:
 *
 * | Read-only, runs immediately | Side effects, asks first |
 * |---|---|
 * | `read_file`, `list_dir`, `search_files`, `git_diff` | `write_file`, `edit_file`, `run_command` |
 *
 * The split is PLAN.md's ("confirm before every write or command"), and it is
 * data rather than a convention: `GATED_EXECUTOR_TOOLS` is the set, every tool in
 * it goes through `PermissionGate.ask` before it touches anything, and
 * `docs/features/executor/` explains why each member is in the column it is in.
 *
 * ## What a tool returns
 *
 * An **object**, not a rendered string, unlike the MCP wrapper in
 * `mcp/tools.ts`. Two consumers read a tool result and they want different
 * things: the model wants prose it can reason about, and S5.5 wants the unified
 * diff of a write so it can append a `DiffPart` to the message. A JSON object
 * with a `patch` field serves both — the model reads JSON perfectly well, and
 * the renderer does not have to parse a sentence back apart.
 *
 * The diffs come from the `diff` package (`createPatch`), never from a
 * hand-rolled comparison: a unified diff has a specification, a hand-rolled one
 * has whatever the author remembered of it, and this one is shown to the user as
 * the record of what an agent did to their files.
 *
 * ## Confinement and cancellation
 *
 * Every path argument goes through `paths.ts` on **every** call, including the
 * second call of the same turn: the folder can be renamed between two tool calls,
 * and a stale resolution is how a write lands somewhere nobody expected. Every
 * child process is killed when the turn's signal aborts, so Stop leaves nothing
 * running.
 *
 * No electron (CLAUDE.md rule #5); `node:fs` and `node:child_process` are the
 * point of the module.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { createPatch } from 'diff'
import { jsonSchema, tool, type ToolSet } from 'ai'
import type { ChatGoal } from '@shared/types'
import { isBackendFailure, validation } from '../errors'
import { resolveInWorkdir, realWorkdir, type ResolvedPath } from './paths'
import type { PermissionGate, PermissionOutcome } from './permissions'

export const READ_FILE_TOOL = 'read_file'
export const LIST_DIR_TOOL = 'list_dir'
export const SEARCH_FILES_TOOL = 'search_files'
export const WRITE_FILE_TOOL = 'write_file'
export const EDIT_FILE_TOOL = 'edit_file'
export const RUN_COMMAND_TOOL = 'run_command'
export const GIT_DIFF_TOOL = 'git_diff'

/** Every tool an executor gets, in the order the briefing lists them. */
export const EXECUTOR_TOOLS = [
  READ_FILE_TOOL,
  LIST_DIR_TOOL,
  SEARCH_FILES_TOOL,
  WRITE_FILE_TOOL,
  EDIT_FILE_TOOL,
  RUN_COMMAND_TOOL,
  GIT_DIFF_TOOL
] as const

/**
 * The tools that ask before they run.
 *
 * `write_file` and `edit_file` change the user's files; `run_command` can do
 * anything at all. The other four only read, and a prompt per read would train
 * the user to click Allow without looking — which is how a permission prompt
 * stops being a permission prompt.
 */
export const GATED_EXECUTOR_TOOLS: ReadonlySet<string> = new Set([
  WRITE_FILE_TOOL,
  EDIT_FILE_TOOL,
  RUN_COMMAND_TOOL
])

/**
 * The four tools that only read, derived from the gate rather than listed again.
 *
 * S5.11 attaches exactly these to **every** member of a chat with a `workdir`
 * (PLAN.md: "discussion agents are read-only"), so the list has to stay the
 * complement of `GATED_EXECUTOR_TOOLS` by construction. A tool moved into the
 * gated set stops being handed to participants in the same edit, which is the
 * property a hand-written second list would not have.
 */
export const READ_ONLY_EXECUTOR_TOOLS: readonly string[] = EXECUTOR_TOOLS.filter(
  (name) => !GATED_EXECUTOR_TOOLS.has(name)
)

/** Largest file `read_file` returns, in bytes. Past it the text is cut and marked. */
export const MAX_READ_BYTES = 200 * 1024

/** Largest amount of `run_command` output kept, per stream, in characters. */
export const MAX_OUTPUT_CHARS = 32 * 1024

/** How many entries `list_dir` returns. */
export const MAX_DIR_ENTRIES = 500

/** How many matching lines `search_files` returns. */
export const MAX_SEARCH_HITS = 100

/** How many files `search_files` opens before it gives up walking. */
export const MAX_SEARCH_FILES = 5_000

/** How deep `search_files` walks, so a symlink loop cannot spin forever. */
const MAX_WALK_DEPTH = 12

/** Appended wherever output was cut. */
export const TRUNCATION_MARKER = '… (truncated)'

/** Directories `search_files` never walks into. */
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', 'dist', 'out', 'build', 'target', '.cache'])

/** Bytes inspected when deciding whether a file is text. */
const BINARY_SNIFF_BYTES = 8_000

/** How long a killed child gets to exit before it is killed harder, in ms. */
const SIGKILL_GRACE_MS = 2_000

/** Everything the tools need to act on one chat's folder for one turn. */
export interface ExecutorToolContext {
  /** The chat's working directory. Never empty — the caller checks first. */
  workdir: string
  chatId: string
  agentId: string
  /** The turn's signal: aborting it kills children and closes pending prompts. */
  signal: AbortSignal
  /** `AppSettings.timeouts.toolTimeoutMs`, the budget for one command. */
  timeoutMs: number
  permissions: PermissionGate
}

/**
 * Thrown when a gated call did not get permission.
 *
 * The message is what the **model** reads back as the tool error, which is why
 * it is an English sentence rather than an i18n key: it is prompt content, in
 * the same class as an MCP server's error text, not UI copy the renderer
 * translates (CLAUDE.md rule #4 governs the latter). The transcript shows it in
 * the tool card exactly as every other tool failure is shown.
 */
export class PermissionDeniedError extends Error {
  readonly reason: 'denied' | 'aborted'

  constructor(toolName: string, reason: 'denied' | 'aborted') {
    super(
      reason === 'denied'
        ? `The user declined to allow ${toolName}. Do not try the same call again; say what you wanted to do and why, and ask what they would prefer.`
        : `The permission prompt for ${toolName} was closed because the run was stopped.`
    )
    this.name = 'PermissionDeniedError'
    this.reason = reason
  }
}

/* -------------------------------------------------------------------------- */
/* The briefing                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The paragraph added to the briefing when the user pressed "Hand to executor"
 * (S5.6).
 *
 * It answers the one question the standing briefing leaves open in that moment:
 * the model has just been given a transcript full of *proposals*, and without
 * this it reads them as an invitation to add a seventh opinion. So it says the
 * discussion is over, that the conclusion above is what to build, and that the
 * report has to name paths — the review round that follows is reading the diff,
 * and a summary without file names is not something anybody can check.
 *
 * Model-facing English, not an i18n key, exactly like the rest of the section.
 */
export const HANDOFF_BRIEFING = [
  'The discussion above has finished and the user has handed it to you. Implement the conclusion the group reached, in this working directory, now.',
  'Do not re-open the debate, do not ask which option to take, and do not propose an alternative: if the conclusion is genuinely ambiguous, implement the smallest reading of it and say what you assumed.',
  'When you are done, report what you changed file by file, with the path of each one, so the others can review it.'
].join(' ')

/**
 * The `Executor` section of the system prompt.
 *
 * Model-facing text, so it is English only and not an i18n key — the same rule
 * the group briefing and the skills section follow. Three things have to be in
 * it or the executor misbehaves in a way that looks like a bug: the folder it is
 * bound to, what each tool is for, and what to do at the end (summarize, ask for
 * review) — PLAN.md's review loop only works if the executor closes its turn
 * with something the others can review.
 *
 * `handoff` appends `HANDOFF_BRIEFING` for the one turn "Hand to executor"
 * schedules. It is a *suffix* rather than a different section so the folder and
 * the tool list are described once, in one order, in both situations. Since
 * S5.10 that suffix also names the chat's deliverable or its change
 * (`goalHandoffLine`), which is the difference between "implement the
 * conclusion" and "write `docs/report.md`".
 */
/**
 * The one sentence the hand-off briefing gains from the chat's goal (S5.10).
 *
 * `HANDOFF_BRIEFING` says "implement the conclusion the group reached", which is
 * exactly right for a discussion and one sentence short of useful when the chat
 * has a goal: a `document` chat has a file it is supposed to end with, and a
 * `codebase` chat has a change the user described before anyone spoke. Naming
 * the deliverable is what stops an executor from writing its summary into the
 * transcript and calling it done.
 *
 * What it must *not* do is restate the goal in full — the goal is already in the
 * group briefing this same prompt carries, and a model given the same
 * instruction twice in two wordings follows neither reliably. So this is the
 * pointer, not the brief.
 */
export function goalHandoffLine(goal: ChatGoal | null | undefined): string | null {
  if (!goal) return null
  if (goal.kind === 'document' && goal.deliverable) {
    return `The goal of this chat is the file ${goal.deliverable}: write it, creating its parent folders if they do not exist, and report the path when you are done.`
  }
  if (goal.kind === 'codebase') {
    return `The goal of this chat is a change to the code in this working directory: ${goal.description.trim()} Make that change now.`
  }
  return null
}

export function buildExecutorSection(
  workdir: string,
  handoff = false,
  goal: ChatGoal | null = null
): string {
  return [
    'You are the executor of this chat: the one member allowed to change anything. Your working directory is:',
    '',
    workdir,
    '',
    'Every path you pass to a tool is resolved inside that directory. Nothing outside it can be read, written or listed, and a path that leaves it is refused.',
    '',
    'Your tools:',
    `- ${READ_FILE_TOOL}(path) — read a file.`,
    `- ${LIST_DIR_TOOL}(path) — list a directory; omit the path for the working directory itself.`,
    `- ${SEARCH_FILES_TOOL}(query, path) — find a string in the files under a directory.`,
    `- ${WRITE_FILE_TOOL}(path, content) — create a file or replace its whole contents.`,
    `- ${EDIT_FILE_TOOL}(path, oldString, newString) — replace one exact stretch of text.`,
    `- ${RUN_COMMAND_TOOL}(command) — run a shell command in the working directory.`,
    `- ${GIT_DIFF_TOOL}(path) — the working tree's current diff, when the folder is a git repository.`,
    '',
    `${WRITE_FILE_TOOL}, ${EDIT_FILE_TOOL} and ${RUN_COMMAND_TOOL} pause until the user allows or declines the call. A declined call is an answer, not a failure: do not retry it, say what you wanted to do and why.`,
    '',
    `Read a file before you edit it, prefer ${EDIT_FILE_TOOL} over rewriting a whole file, and make the smallest change that does the job. When you are finished, end your message with a short summary of every file you changed and what it now does, and ask the others to review it.`,
    ...(handoff ? ['', [HANDOFF_BRIEFING, goalHandoffLine(goal)].filter(Boolean).join(' ')] : [])
  ].join('\n')
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Cuts `text` to `limit` characters and marks it, or returns it unchanged. */
export function cap(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n${TRUNCATION_MARKER}`
}

/** A required non-empty string argument, or a refusal the model can read. */
function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw validation(`${name} is required and must be a string`)
  }
  return value
}

/**
 * True when the buffer looks like something a model should not be shown.
 *
 * A null byte in the first few kilobytes, which is what `git` itself uses to
 * decide that a file is binary. Exported since S5.11, where the materials
 * briefing has to make the same decision for a different reason: this file
 * refuses to *read* a binary file, and `agents/materials.ts` refuses to *inline*
 * one — both from the one probe, so the two answers cannot drift apart.
 */
export function looksBinary(buffer: Buffer): boolean {
  const window = buffer.subarray(0, BINARY_SNIFF_BYTES)
  return window.includes(0)
}

/** Reads a file as text, refusing a binary one and capping a huge one. */
function readTextFile(resolved: ResolvedPath): string {
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(resolved.absolute)
  } catch {
    throw validation(`No such file: ${resolved.relative}`, { path: resolved.relative })
  }
  if (stat.isDirectory()) {
    throw validation(`${resolved.relative} is a directory; use ${LIST_DIR_TOOL}`, {
      path: resolved.relative
    })
  }

  const buffer = readFileSync(resolved.absolute)
  if (looksBinary(buffer)) {
    throw validation(`${resolved.relative} is a binary file and cannot be read as text`, {
      path: resolved.relative
    })
  }
  if (buffer.byteLength > MAX_READ_BYTES) {
    return `${buffer.subarray(0, MAX_READ_BYTES).toString('utf8')}\n${TRUNCATION_MARKER}`
  }
  return buffer.toString('utf8')
}

/** The unified diff of one file's change, headed by its path inside the folder. */
export function unifiedDiff(path: string, before: string, after: string): string {
  return createPatch(path, before, after, undefined, undefined, { context: 3 })
}

/** One captured child process run. A non-zero exit is a result, not a failure. */
export interface CommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
  /** True when the timeout killed it; `exitCode` is then whatever the kill produced. */
  timedOut: boolean
}

/**
 * Runs a child process and captures its output.
 *
 * Three ways it can end and all three are handled here, because every one of
 * them has been the reason a desktop app leaked a process: the command exits
 * (normal), the budget runs out (`timeoutMs`), or the turn is aborted (Stop, or
 * the supervisor's hard timeout). The last two kill the child — `SIGTERM`, then
 * `SIGKILL` if it is still alive two seconds later — and a `detached` process
 * group is killed as a group, so a command that spawned its own children does
 * not leave them behind.
 */
export function runCommand(
  file: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; signal: AbortSignal }
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new Error('The run was stopped before the command started'))
      return
    }

    const child = spawn(file, [...args], {
      cwd: options.cwd,
      // Its own process group, so killing it takes the whole tree with it.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let killTimer: NodeJS.Timeout | undefined

    const kill = (): void => {
      try {
        // Negative pid: the whole process group created by `detached`.
        process.kill(-child.pid!, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      killTimer = setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }, SIGKILL_GRACE_MS)
      killTimer.unref()
    }

    const onAbort = (): void => kill()
    options.signal.addEventListener('abort', onAbort, { once: true })

    const budget = setTimeout(() => {
      timedOut = true
      kill()
    }, options.timeoutMs)
    budget.unref()

    const cleanup = (): void => {
      clearTimeout(budget)
      if (killTimer) clearTimeout(killTimer)
      options.signal.removeEventListener('abort', onAbort)
    }

    // Output is capped **as it arrives**: a command that prints a gigabyte must
    // not put a gigabyte in this process's heap on its way to being truncated.
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += chunk.toString('utf8')
    })

    child.on('error', (error) => {
      cleanup()
      reject(error)
    })

    child.on('close', (code) => {
      cleanup()
      if (options.signal.aborted) {
        reject(new Error('The run was stopped'))
        return
      }
      resolve({
        exitCode: code,
        stdout: cap(stdout, MAX_OUTPUT_CHARS),
        stderr: cap(stderr, MAX_OUTPUT_CHARS),
        timedOut
      })
    })
  })
}

/** Depth-first walk of the text files under `root`, capped and pruned. */
function walkFiles(root: string, onFile: (absolute: string) => boolean): void {
  let visited = 0

  const walk = (directory: string, depth: number): boolean => {
    if (depth > MAX_WALK_DEPTH) return true
    let entries: Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      // An unreadable directory is skipped, not fatal: a search must not fail
      // because one folder has no permissions.
      return true
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!walk(absolute, depth + 1)) return false
        continue
      }
      if (!entry.isFile()) continue
      visited += 1
      if (visited > MAX_SEARCH_FILES) return false
      if (!onFile(absolute)) return false
    }
    return true
  }

  walk(root, 0)
}

/* -------------------------------------------------------------------------- */
/* The tools                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The seven tools, bound to one chat's folder and one turn's signal.
 *
 * Attached by `collectAgentTools` only to the chat's executor, and only when the
 * chat has a `workdir`; see its doc comment for the two halves of that rule.
 */
export function buildExecutorTools(context: ExecutorToolContext): ToolSet {
  const { workdir, permissions, signal } = context

  /**
   * Asks, and turns a refusal into the error the model reads.
   *
   * The membership test is what makes `GATED_EXECUTOR_TOOLS` the source of truth
   * rather than a comment: a tool added to the set is confirmed from then on,
   * and a tool taken out of it stops asking, without a second edit here.
   */
  const gate = async (toolName: string, input: unknown): Promise<void> => {
    if (!GATED_EXECUTOR_TOOLS.has(toolName)) return
    const outcome: PermissionOutcome = await permissions.ask({
      chatId: context.chatId,
      agentId: context.agentId,
      toolName,
      input,
      signal
    })
    if (!outcome.allowed) throw new PermissionDeniedError(toolName, outcome.reason)
  }

  const resolvePath = (path: string | undefined): ResolvedPath => resolveInWorkdir(workdir, path)

  return {
    [READ_FILE_TOOL]: tool({
      description:
        'Read a text file from the working directory. Read a file before you edit it.',
      inputSchema: jsonSchema<{ path: string }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the working directory.' }
        },
        required: ['path'],
        additionalProperties: false
      }),
      execute: async ({ path }) => {
        const resolved = resolvePath(requireString(path, 'path'))
        return { path: resolved.relative, content: readTextFile(resolved) }
      }
    }),

    [LIST_DIR_TOOL]: tool({
      description:
        'List the entries of a directory in the working directory. Directories are marked with a trailing slash.',
      inputSchema: jsonSchema<{ path?: string }>({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory relative to the working directory; omit for the root.'
          }
        },
        additionalProperties: false
      }),
      execute: async ({ path }) => {
        const resolved = resolvePath(path)
        let entries: Dirent[]
        try {
          entries = readdirSync(resolved.absolute, { withFileTypes: true })
        } catch {
          throw validation(`No such directory: ${resolved.relative}`, { path: resolved.relative })
        }
        const names = entries
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
          .sort((left, right) => left.localeCompare(right))
        return {
          path: resolved.relative,
          entries: names.slice(0, MAX_DIR_ENTRIES),
          ...(names.length > MAX_DIR_ENTRIES ? { truncated: names.length - MAX_DIR_ENTRIES } : {})
        }
      }
    }),

    [SEARCH_FILES_TOOL]: tool({
      description:
        'Find a case-insensitive string in the text files under a directory of the working directory. Hidden folders, .git and node_modules are skipped.',
      inputSchema: jsonSchema<{ query: string; path?: string }>({
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The text to look for.' },
          path: {
            type: 'string',
            description: 'Directory to search; omit for the whole working directory.'
          }
        },
        required: ['query'],
        additionalProperties: false
      }),
      execute: async ({ query, path }) => {
        const needle = requireString(query, 'query').toLowerCase()
        const root = resolvePath(path)
        const hits: { path: string; line: number; text: string }[] = []
        const realRoot = realWorkdir(workdir)

        walkFiles(root.absolute, (absolute) => {
          let buffer: Buffer
          try {
            buffer = readFileSync(absolute)
          } catch {
            return true
          }
          if (looksBinary(buffer) || buffer.byteLength > MAX_READ_BYTES) return true

          const lines = buffer.toString('utf8').split('\n')
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index] as string
            if (!line.toLowerCase().includes(needle)) continue
            hits.push({
              path: relative(realRoot, absolute),
              line: index + 1,
              text: cap(line.trim(), 300)
            })
            if (hits.length >= MAX_SEARCH_HITS) return false
          }
          return true
        })

        return {
          query,
          path: root.relative,
          hits,
          ...(hits.length >= MAX_SEARCH_HITS ? { truncated: true } : {})
        }
      }
    }),

    [WRITE_FILE_TOOL]: tool({
      description:
        'Create a file or replace its whole contents. The user is asked before it runs. Returns the unified diff of the change.',
      inputSchema: jsonSchema<{ path: string; content: string }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the working directory.' },
          content: { type: 'string', description: 'The whole new contents of the file.' }
        },
        required: ['path', 'content'],
        additionalProperties: false
      }),
      execute: async ({ path, content }) => {
        const resolved = resolvePath(requireString(path, 'path'))
        if (typeof content !== 'string') throw validation('content is required and must be a string')

        // Asked with the resolved path, so the prompt shows what will actually be
        // written rather than the string the model typed.
        await gate(WRITE_FILE_TOOL, { path: resolved.relative, content })

        // Resolved again after the prompt: the user may have been looking at the
        // folder for a minute, and the state that mattered is the state now.
        const target = resolvePath(path)
        let before = ''
        let created = true
        try {
          if (statSync(target.absolute).isDirectory()) {
            throw validation(`${target.relative} is a directory`, { path: target.relative })
          }
          before = readFileSync(target.absolute, 'utf8')
          created = false
        } catch (error) {
          if (isBackendFailure(error)) throw error
        }

        mkdirSync(dirname(target.absolute), { recursive: true })
        writeFileSync(target.absolute, content, 'utf8')

        return {
          path: target.relative,
          created,
          bytes: Buffer.byteLength(content, 'utf8'),
          patch: unifiedDiff(target.relative, before, content)
        }
      }
    }),

    [EDIT_FILE_TOOL]: tool({
      description:
        'Replace one exact stretch of text in a file. oldString must appear exactly once unless replaceAll is set. The user is asked before it runs. Returns the unified diff of the change.',
      inputSchema: jsonSchema<{
        path: string
        oldString: string
        newString: string
        replaceAll?: boolean
      }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the working directory.' },
          oldString: {
            type: 'string',
            description: 'The exact text to replace, including indentation.'
          },
          newString: { type: 'string', description: 'What to put in its place.' },
          replaceAll: {
            type: 'boolean',
            description: 'Replace every occurrence instead of requiring exactly one.'
          }
        },
        required: ['path', 'oldString', 'newString'],
        additionalProperties: false
      }),
      execute: async ({ path, oldString, newString, replaceAll }) => {
        const resolved = resolvePath(requireString(path, 'path'))
        const needle = requireString(oldString, 'oldString')
        if (typeof newString !== 'string') {
          throw validation('newString is required and must be a string')
        }

        const before = readTextFile(resolved)
        if (before.endsWith(TRUNCATION_MARKER)) {
          throw validation(
            `${resolved.relative} is too large to edit safely; use ${WRITE_FILE_TOOL} or a smaller file`,
            { path: resolved.relative }
          )
        }

        const occurrences = before.split(needle).length - 1
        if (occurrences === 0) {
          throw validation(
            `That text does not appear in ${resolved.relative}. Read the file again and copy the text exactly, including indentation.`,
            { path: resolved.relative }
          )
        }
        if (occurrences > 1 && replaceAll !== true) {
          throw validation(
            `That text appears ${occurrences} times in ${resolved.relative}. Include more surrounding lines so it is unique, or set replaceAll.`,
            { path: resolved.relative }
          )
        }

        const after = replaceAll === true ? before.split(needle).join(newString) : before.replace(needle, newString)
        if (after === before) {
          return { path: resolved.relative, replacements: 0, unchanged: true, patch: '' }
        }

        await gate(EDIT_FILE_TOOL, {
          path: resolved.relative,
          patch: unifiedDiff(resolved.relative, before, after)
        })

        // Re-read after the prompt rather than writing the copy read before it: a
        // file the user edited while deciding must not be silently reverted.
        const target = resolvePath(path)
        const current = readTextFile(target)
        if (current !== before) {
          throw validation(
            `${target.relative} changed while the permission prompt was open. Read it again before editing.`,
            { path: target.relative }
          )
        }
        writeFileSync(target.absolute, after, 'utf8')

        return {
          path: target.relative,
          replacements: replaceAll === true ? occurrences : 1,
          patch: unifiedDiff(target.relative, before, after)
        }
      }
    }),

    [RUN_COMMAND_TOOL]: tool({
      description:
        'Run a shell command in the working directory. The user is asked before it runs. A non-zero exit code is returned, not thrown.',
      inputSchema: jsonSchema<{ command: string }>({
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line to run, as a shell would.' }
        },
        required: ['command'],
        additionalProperties: false
      }),
      execute: async ({ command }) => {
        const line = requireString(command, 'command')
        await gate(RUN_COMMAND_TOOL, { command: line })

        const cwd = realWorkdir(workdir)
        const result = await runCommand('/bin/sh', ['-c', line], {
          cwd,
          timeoutMs: context.timeoutMs,
          signal
        })
        return {
          command: line,
          exitCode: result.exitCode,
          ...(result.timedOut ? { timedOut: true, timeoutMs: context.timeoutMs } : {}),
          stdout: result.stdout,
          stderr: result.stderr
        }
      }
    }),

    [GIT_DIFF_TOOL]: tool({
      description:
        "The working tree's current unified diff, when the working directory is a git repository. Read-only: it runs without asking.",
      inputSchema: jsonSchema<{ path?: string; staged?: boolean }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Limit the diff to this path.' },
          staged: { type: 'boolean', description: 'Diff the index instead of the working tree.' }
        },
        additionalProperties: false
      }),
      execute: async ({ path, staged }) => {
        const cwd = realWorkdir(workdir)
        const args = ['--no-pager', 'diff']
        if (staged === true) args.push('--staged')
        if (typeof path === 'string' && path.trim().length > 0) {
          args.push('--', resolvePath(path).relative)
        }

        let result: CommandResult
        try {
          result = await runCommand('git', args, {
            cwd,
            timeoutMs: context.timeoutMs,
            signal
          })
        } catch (error) {
          // `git` not installed at all, or the run was stopped.
          throw validation(error instanceof Error ? error.message : String(error))
        }
        if (result.exitCode !== 0) {
          throw validation(result.stderr.trim() || `git diff exited with ${result.exitCode}`)
        }
        return {
          patch: result.stdout,
          ...(result.stdout.trim().length === 0 ? { empty: true } : {})
        }
      }
    })
  }
}
