/**
 * The seven executor tools against a real temporary directory and a real shell.
 *
 * `buildExecutorTools` returns AI SDK `tool()` objects, so each case calls the
 * tool's own `execute` the way `streamText` would. Nothing is mocked but the
 * permission gate's *answer* — a stub that says yes or no without a user — since
 * the gate itself has its own suite next door.
 *
 * `run_command` really spawns `/bin/sh`. It is the one tool whose bugs are
 * invisible in a fake (a timeout that does not kill, an abort that leaves a
 * child behind), and the commands here are `echo` and `sleep`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolSet } from 'ai'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatGoal, ExecutorSandboxMode } from '@shared/types'
import type { PermissionGate, PermissionRequest } from './permissions'
import {
  EDIT_FILE_TOOL,
  EXECUTOR_TOOLS,
  GATED_EXECUTOR_TOOLS,
  GIT_DIFF_TOOL,
  LIST_DIR_TOOL,
  MAX_OUTPUT_CHARS,
  READ_FILE_TOOL,
  RUN_COMMAND_TOOL,
  SEARCH_FILES_TOOL,
  TRUNCATION_MARKER,
  WRITE_FILE_TOOL,
  buildExecutorSection,
  buildExecutorTools,
  cap,
  goalHandoffLine
} from './tools'

let workdir: string
let outside: string
let controller: AbortController
/** Every `ask` the tools made, in order. */
let asked: PermissionRequest[]
/** Every `notices.*` line the tools raised (S5.15). */
let notices: { key: string; params?: Record<string, string | number> }[]

/** A gate that answers without a user. `ask` records what it was asked. */
function stubGate(answer: 'allow' | 'deny' | 'aborted'): PermissionGate {
  return {
    ask: async (request) => {
      asked.push(request)
      if (answer === 'allow') return { allowed: true, remembered: false }
      return { allowed: false, reason: answer === 'deny' ? 'denied' : 'aborted' }
    },
    reply: () => undefined,
    pending: () => [],
    abortAll: () => undefined
  }
}

function tools(
  answer: 'allow' | 'deny' | 'aborted' = 'allow',
  timeoutMs = 10_000,
  options: { sandbox?: ExecutorSandboxMode } = {}
): ToolSet {
  return buildExecutorTools({
    workdir,
    chatId: 'chat-1',
    agentId: 'agent-1',
    signal: controller.signal,
    timeoutMs,
    permissions: stubGate(answer),
    // S5.15: the sandbox is on by default, so the existing cases exercise the
    // path the product actually takes. The temporary working directory is
    // writable under the generated profile, which is the point of it.
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    notice: (key, params) => notices.push({ key, ...(params ? { params } : {}) })
  })
}

/** Calls one tool the way the AI SDK would, and returns its result. */
async function call<T = Record<string, unknown>>(
  set: ToolSet,
  name: string,
  input: unknown
): Promise<T> {
  const definition = set[name]
  if (!definition?.execute) throw new Error(`No such tool: ${name}`)
  // The SDK passes a second options argument the executor tools never read.
  return (await definition.execute(input as never, {
    toolCallId: 'call-1',
    messages: [],
    context: undefined
  })) as T
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'witena-executor-'))
  workdir = join(root, 'project')
  outside = join(root, 'secrets')
  mkdirSync(workdir, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'key.txt'), 'hunter2\n', 'utf8')
  writeFileSync(join(workdir, 'README.md'), '# Project\n\nHello.\n', 'utf8')
  mkdirSync(join(workdir, 'src'))
  writeFileSync(join(workdir, 'src', 'index.ts'), "export const answer = 42\n", 'utf8')
  controller = new AbortController()
  asked = []
  notices = []
})

afterEach(() => {
  controller.abort()
  rmSync(join(workdir, '..'), { recursive: true, force: true })
})

describe('the tool set', () => {
  it('offers exactly the seven tools of S5.4', () => {
    expect(Object.keys(tools()).sort()).toEqual([...EXECUTOR_TOOLS].sort())
  })

  it('gates the three that change something and no others', () => {
    expect([...GATED_EXECUTOR_TOOLS].sort()).toEqual(['edit_file', 'run_command', 'write_file'])
  })
})

describe('read_file', () => {
  it('reads a file inside the folder', async () => {
    const result = await call(tools(), READ_FILE_TOOL, { path: 'README.md' })
    expect(result).toEqual({ path: 'README.md', content: '# Project\n\nHello.\n' })
    expect(asked).toEqual([])
  })

  it('refuses a path that leaves the folder', async () => {
    await expect(call(tools(), READ_FILE_TOOL, { path: '../secrets/key.txt' })).rejects.toThrow(
      /outside the working directory/
    )
  })

  it('refuses a symlink that leaves the folder', async () => {
    symlinkSync(join(outside, 'key.txt'), join(workdir, 'key.txt'))
    await expect(call(tools(), READ_FILE_TOOL, { path: 'key.txt' })).rejects.toThrow(
      /outside the working directory/
    )
  })

  it('reports a missing file rather than throwing something opaque', async () => {
    await expect(call(tools(), READ_FILE_TOOL, { path: 'nope.md' })).rejects.toThrow(/No such file/)
  })

  it('refuses a binary file', async () => {
    writeFileSync(join(workdir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]))
    await expect(call(tools(), READ_FILE_TOOL, { path: 'blob.bin' })).rejects.toThrow(/binary/)
  })

  it('points a directory at list_dir', async () => {
    await expect(call(tools(), READ_FILE_TOOL, { path: 'src' })).rejects.toThrow(/list_dir/)
  })
})

describe('list_dir', () => {
  it('lists the folder itself when no path is given', async () => {
    const result = await call<{ path: string; entries: string[] }>(tools(), LIST_DIR_TOOL, {})
    expect(result.path).toBe('.')
    expect(result.entries).toEqual(['README.md', 'src/'])
  })

  it('marks directories with a trailing slash', async () => {
    mkdirSync(join(workdir, 'src', 'deep'))
    const result = await call<{ entries: string[] }>(tools(), LIST_DIR_TOOL, { path: 'src' })
    expect(result.entries).toEqual(['deep/', 'index.ts'])
  })

  it('refuses a directory outside the folder', async () => {
    await expect(call(tools(), LIST_DIR_TOOL, { path: '../secrets' })).rejects.toThrow(
      /outside the working directory/
    )
  })
})

describe('search_files', () => {
  it('finds a case-insensitive match with its path and line', async () => {
    const result = await call<{ hits: { path: string; line: number; text: string }[] }>(
      tools(),
      SEARCH_FILES_TOOL,
      { query: 'ANSWER' }
    )
    expect(result.hits).toEqual([
      { path: join('src', 'index.ts'), line: 1, text: 'export const answer = 42' }
    ])
  })

  it('searches only below the path it was given', async () => {
    const result = await call<{ hits: unknown[] }>(tools(), SEARCH_FILES_TOOL, {
      query: 'Project',
      path: 'src'
    })
    expect(result.hits).toEqual([])
  })

  it('skips node_modules and hidden folders', async () => {
    mkdirSync(join(workdir, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(workdir, 'node_modules', 'dep', 'a.js'), 'needle\n', 'utf8')
    mkdirSync(join(workdir, '.hidden'))
    writeFileSync(join(workdir, '.hidden', 'b.txt'), 'needle\n', 'utf8')

    const result = await call<{ hits: unknown[] }>(tools(), SEARCH_FILES_TOOL, { query: 'needle' })
    expect(result.hits).toEqual([])
  })
})

describe('write_file', () => {
  it('asks first, then writes the file and returns its diff', async () => {
    const result = await call<{ path: string; created: boolean; patch: string }>(
      tools('allow'),
      WRITE_FILE_TOOL,
      { path: 'src/new.ts', content: 'export const x = 1\n' }
    )

    expect(asked.map((request) => request.toolName)).toEqual([WRITE_FILE_TOOL])
    expect(readFileSync(join(workdir, 'src', 'new.ts'), 'utf8')).toBe('export const x = 1\n')
    expect(result.created).toBe(true)
    expect(result.path).toBe(join('src', 'new.ts'))
    expect(result.patch).toContain('+export const x = 1')
  })

  it('creates the parent directories a new file needs', async () => {
    await call(tools(), WRITE_FILE_TOOL, { path: 'a/b/c.txt', content: 'hi\n' })
    expect(readFileSync(join(workdir, 'a', 'b', 'c.txt'), 'utf8')).toBe('hi\n')
  })

  it('diffs a replacement against what was there', async () => {
    const result = await call<{ created: boolean; patch: string }>(tools(), WRITE_FILE_TOOL, {
      path: 'README.md',
      content: '# Project\n\nGoodbye.\n'
    })
    expect(result.created).toBe(false)
    expect(result.patch).toContain('-Hello.')
    expect(result.patch).toContain('+Goodbye.')
  })

  it('writes nothing when the user declines', async () => {
    await expect(
      call(tools('deny'), WRITE_FILE_TOOL, { path: 'src/new.ts', content: 'x' })
    ).rejects.toThrow(/declined/)
    expect(() => readFileSync(join(workdir, 'src', 'new.ts'), 'utf8')).toThrow()
  })

  it('writes nothing when the prompt was closed by a stop', async () => {
    await expect(
      call(tools('aborted'), WRITE_FILE_TOOL, { path: 'src/new.ts', content: 'x' })
    ).rejects.toThrow(/run was stopped/)
  })

  it('refuses a path outside the folder before it asks anything', async () => {
    await expect(
      call(tools(), WRITE_FILE_TOOL, { path: '../secrets/key.txt', content: 'x' })
    ).rejects.toThrow(/outside the working directory/)
    expect(asked).toEqual([])
  })
})

describe('edit_file', () => {
  it('replaces one exact string and returns the diff', async () => {
    const result = await call<{ replacements: number; patch: string }>(tools(), EDIT_FILE_TOOL, {
      path: 'README.md',
      oldString: 'Hello.',
      newString: 'Goodbye.'
    })

    expect(result.replacements).toBe(1)
    expect(result.patch).toContain('+Goodbye.')
    expect(readFileSync(join(workdir, 'README.md'), 'utf8')).toBe('# Project\n\nGoodbye.\n')
    expect(asked.map((request) => request.toolName)).toEqual([EDIT_FILE_TOOL])
  })

  it('refuses text that is not there, and says to read the file again', async () => {
    await expect(
      call(tools(), EDIT_FILE_TOOL, { path: 'README.md', oldString: 'Nope', newString: 'x' })
    ).rejects.toThrow(/does not appear/)
    expect(asked).toEqual([])
  })

  it('refuses an ambiguous match unless replaceAll is set', async () => {
    writeFileSync(join(workdir, 'twice.txt'), 'a\na\n', 'utf8')
    await expect(
      call(tools(), EDIT_FILE_TOOL, { path: 'twice.txt', oldString: 'a', newString: 'b' })
    ).rejects.toThrow(/appears 2 times/)

    const result = await call<{ replacements: number }>(tools(), EDIT_FILE_TOOL, {
      path: 'twice.txt',
      oldString: 'a',
      newString: 'b',
      replaceAll: true
    })
    expect(result.replacements).toBe(2)
    expect(readFileSync(join(workdir, 'twice.txt'), 'utf8')).toBe('b\nb\n')
  })

  it('leaves the file untouched when the user declines', async () => {
    await expect(
      call(tools('deny'), EDIT_FILE_TOOL, {
        path: 'README.md',
        oldString: 'Hello.',
        newString: 'Goodbye.'
      })
    ).rejects.toThrow(/declined/)
    expect(readFileSync(join(workdir, 'README.md'), 'utf8')).toBe('# Project\n\nHello.\n')
  })

  it('shows the diff it is about to apply in the prompt', async () => {
    await call(tools(), EDIT_FILE_TOOL, {
      path: 'README.md',
      oldString: 'Hello.',
      newString: 'Goodbye.'
    })
    const input = asked[0]?.input as { path: string; patch: string }
    expect(input.path).toBe('README.md')
    expect(input.patch).toContain('+Goodbye.')
  })
})

describe('run_command', () => {
  it('asks first, then runs in the working directory', async () => {
    const result = await call<{ exitCode: number; stdout: string }>(tools(), RUN_COMMAND_TOOL, {
      command: 'pwd && ls'
    })
    expect(asked.map((request) => request.toolName)).toEqual([RUN_COMMAND_TOOL])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('README.md')
  })

  it('returns a non-zero exit code rather than throwing', async () => {
    const result = await call<{ exitCode: number; stderr: string }>(tools(), RUN_COMMAND_TOOL, {
      command: 'echo boom >&2; exit 3'
    })
    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('boom')
  })

  it('runs nothing when the user declines', async () => {
    await expect(
      call(tools('deny'), RUN_COMMAND_TOOL, { command: `touch ${join(workdir, 'ran.txt')}` })
    ).rejects.toThrow(/declined/)
    expect(() => readFileSync(join(workdir, 'ran.txt'))).toThrow()
  })

  it('kills a command that outlives the tool timeout', async () => {
    const result = await call<{ timedOut?: boolean }>(tools('allow', 200), RUN_COMMAND_TOOL, {
      command: 'sleep 30'
    })
    expect(result.timedOut).toBe(true)
  })

  it('kills the command and rejects when the turn is stopped', async () => {
    const pending = call(tools(), RUN_COMMAND_TOOL, { command: 'sleep 30' })
    // Long enough for the child to have been spawned.
    await new Promise((resolve) => setTimeout(resolve, 100))
    controller.abort()
    await expect(pending).rejects.toThrow(/stopped/)
  })

  it('caps the output and marks where it was cut', async () => {
    const result = await call<{ stdout: string }>(tools(), RUN_COMMAND_TOOL, {
      command: `yes abcdefghij | head -c ${MAX_OUTPUT_CHARS * 2}`
    })
    expect(result.stdout.length).toBeGreaterThan(MAX_OUTPUT_CHARS)
    expect(result.stdout).toContain(TRUNCATION_MARKER)
  })
})

describe('run_command safety (S5.15)', () => {
  it('never asks and never runs a blocked command', async () => {
    const marker = join(workdir, 'blocked.txt')
    await expect(
      call(tools(), RUN_COMMAND_TOOL, { command: `sudo touch ${marker}` })
    ).rejects.toThrow(/refused before it ran/)

    // The two halves of "blocked": no card, and no shell.
    expect(asked).toEqual([])
    expect(() => readFileSync(marker)).toThrow()
  })

  it('tells the model it is a hard limit rather than a refusal it can discuss', async () => {
    await expect(call(tools(), RUN_COMMAND_TOOL, { command: 'rm -rf /' })).rejects.toThrow(
      /do not try to work around it/
    )
  })

  it('carries the verdict to the prompt for a dangerous command', async () => {
    await call(tools(), RUN_COMMAND_TOOL, { command: 'git push origin main' })
    expect(asked).toHaveLength(1)
    expect(asked[0]?.risk).toEqual({ verdict: 'dangerous', reason: 'git-push' })
  })

  it('sends a normal verdict with no reason, so the card draws no warning', async () => {
    await call(tools(), RUN_COMMAND_TOOL, { command: 'echo hello' })
    expect(asked[0]?.risk).toEqual({ verdict: 'normal', reason: null })
  })

  it('runs an approved command under the sandbox and says so', async () => {
    const result = await call<{ sandbox: string }>(tools(), RUN_COMMAND_TOOL, {
      command: 'echo inside > inside.txt'
    })
    expect(result.sandbox).toBe('workdir-write')
    expect(readFileSync(join(workdir, 'inside.txt'), 'utf8').trim()).toBe('inside')
  })

  it('fails a write outside the folder, with the folder untouched', async () => {
    // The home directory rather than `outside`: the working directory of this
    // suite is a `mkdtemp` under the system temp directory, and the profile
    // allows the temp directories on purpose (a compiler that cannot write a
    // temp file fails in a way nobody can debug from a transcript). So the only
    // honest "outside" for this assertion is somewhere that is not temp. This
    // is the sandbox and not `paths.ts`: the path never goes through
    // `resolveInWorkdir` at all.
    const target = join(homedir(), 'witena-tools-sandbox-probe-should-not-exist.txt')
    const result = await call<{ exitCode: number; stderr: string }>(tools(), RUN_COMMAND_TOOL, {
      command: `echo leaked > ${JSON.stringify(target)}`
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/not permitted/i)
    expect(() => readFileSync(target)).toThrow()
  })

  it('lets the same write through when the sandbox is off', async () => {
    // The setting has to actually do something, and this is the whole of what
    // it does. It exists for the command the profile is too tight for.
    const target = join(outside, 'allowed.txt')
    // `outside` is a sibling of the working directory, so this proves the
    // command ran rather than proving anything about the profile.
    const result = await call<{ exitCode: number; sandbox: string }>(
      tools('allow', 10_000, { sandbox: 'off' }),
      RUN_COMMAND_TOOL,
      { command: `echo fine > ${JSON.stringify(target)}` }
    )
    expect(result.exitCode).toBe(0)
    expect(result.sandbox).toBe('off')
    expect(readFileSync(target, 'utf8').trim()).toBe('fine')
    expect(notices).toEqual([])
  })
})

describe('git_diff', () => {
  it('returns the working tree diff of a repository, without asking', async () => {
    // A repository of its own, created through run_command's own runner.
    const set = tools()
    await call(set, RUN_COMMAND_TOOL, {
      command: 'git init -q && git add -A && git -c user.email=a@b -c user.name=t commit -q -m init'
    })
    asked.length = 0
    writeFileSync(join(workdir, 'README.md'), '# Project\n\nChanged.\n', 'utf8')

    const result = await call<{ patch: string; empty?: boolean }>(set, GIT_DIFF_TOOL, {})
    expect(asked).toEqual([])
    expect(result.patch).toContain('+Changed.')
    expect(result.empty).toBeUndefined()
  })

  it('reports what git said when the folder is not a repository', async () => {
    await expect(call(tools(), GIT_DIFF_TOOL, {})).rejects.toThrow(/not a git repository/i)
  })
})

describe('buildExecutorSection', () => {
  it('names the folder, every tool, and the summary the turn must end with', () => {
    const section = buildExecutorSection({ workdir: '/tmp/project' })
    expect(section).toContain('/tmp/project')
    for (const name of EXECUTOR_TOOLS) expect(section).toContain(name)
    expect(section).toMatch(/summary of every file you changed/)
    expect(section).toMatch(/review/)
  })
})

/**
 * S5.10: the hand-off briefing names what the chat is for.
 *
 * "Implement the conclusion the group reached" is exactly right for a chat with
 * no goal and one sentence short of useful for one that has a file to produce.
 */
describe('goalHandoffLine', () => {
  const goal = (patch: Partial<ChatGoal>): ChatGoal => ({
    kind: 'discussion',
    description: 'Split the runner in two',
    materials: [],
    ...patch
  })

  it('names the deliverable of a document goal, and says to create its folders', () => {
    const line = goalHandoffLine(goal({ kind: 'document', deliverable: 'docs/plan.md' }))
    expect(line).toContain('docs/plan.md')
    expect(line).toMatch(/parent folders/)
  })

  it('names the change of a codebase goal', () => {
    expect(goalHandoffLine(goal({ kind: 'codebase' }))).toContain('Split the runner in two')
  })

  it('adds nothing for a discussion, or for a chat with no goal', () => {
    // `HANDOFF_BRIEFING` already says to implement the conclusion; a discussion
    // goal has nothing more concrete to point at.
    expect(goalHandoffLine(goal({ kind: 'discussion' }))).toBeNull()
    expect(goalHandoffLine(null)).toBeNull()
    expect(goalHandoffLine(undefined)).toBeNull()
  })

  it('names the branch of a codebase goal, and asks for the changed paths (S5.12)', () => {
    const line = goalHandoffLine(goal({ kind: 'codebase' }), 'feat/split-runner') ?? ''
    expect(line).toContain('feat/split-runner')
    expect(line).toMatch(/path of every file you changed/)

    // A folder that is not a repository, or a `git` that did not answer in
    // time, costs the sentence rather than the briefing: nothing is guessed.
    expect(goalHandoffLine(goal({ kind: 'codebase' }))).not.toMatch(/branch/)
  })

  it('reaches the executor section only on the hand-off turn', () => {
    const document = goal({ kind: 'document', deliverable: 'docs/plan.md' })

    // A reviewer, and an executor a reviewer `@`-ed afterwards, are being asked
    // something specific and must not be told to go and write the deliverable.
    expect(
      buildExecutorSection({ workdir: '/tmp/project', goal: document })
    ).not.toContain('docs/plan.md')
    expect(
      buildExecutorSection({ workdir: '/tmp/project', handoff: 'implement', goal: document })
    ).toContain('docs/plan.md')
    expect(
      buildExecutorSection({ workdir: '/tmp/project', handoff: 'implement', goal: null })
    ).toMatch(/implement the conclusion/i)
  })
})

/**
 * S5.12: the second hand-off intent.
 *
 * The two paragraphs are alternatives, not a pair — a model given "implement the
 * conclusion" and "write the file" in one prompt follows neither reliably — so
 * what is asserted is as much what is *absent* as what is there.
 */
describe('buildExecutorSection (deliver)', () => {
  const document: ChatGoal = {
    kind: 'document',
    description: 'Write the quarterly report',
    deliverable: 'docs/REPORT.md',
    materials: []
  }

  it('asks for the file, its parent folders and a two-line summary', () => {
    const section = buildExecutorSection({
      workdir: '/tmp/project',
      handoff: 'deliver',
      goal: document
    })

    expect(section).toMatch(/write the deliverable of this chat now/)
    expect(section).toMatch(/creating any parent folder/)
    expect(section).toMatch(/exactly two lines/)
    // …and the path itself, which comes from `goalHandoffLine` rather than from
    // the paragraph, so the two really are composed.
    expect(section).toContain('docs/REPORT.md')
    expect(section).not.toMatch(/Implement the conclusion the group reached/)
  })

  it('keeps the implement paragraph for the other intent', () => {
    const section = buildExecutorSection({
      workdir: '/tmp/project',
      handoff: 'implement',
      goal: document
    })

    expect(section).toMatch(/Implement the conclusion the group reached/)
    expect(section).not.toMatch(/exactly two lines/)
  })

  it('leaves the folder and the tool list identical in all three shapes', () => {
    const shapes = [
      buildExecutorSection({ workdir: '/tmp/project' }),
      buildExecutorSection({ workdir: '/tmp/project', handoff: 'implement', goal: document }),
      buildExecutorSection({ workdir: '/tmp/project', handoff: 'deliver', goal: document })
    ]
    // The suffix is a suffix: everything above it is one description of the
    // folder and the tools, written once.
    const [plain] = shapes as [string, string, string]
    for (const shape of shapes) expect(shape.startsWith(plain)).toBe(true)
  })
})

describe('cap', () => {
  it('leaves short text alone', () => {
    expect(cap('abc', 10)).toBe('abc')
  })

  it('cuts long text and marks it', () => {
    expect(cap('abcdef', 3)).toBe(`abc\n${TRUNCATION_MARKER}`)
  })
})
