/**
 * The real `IdeClients`, driven entirely through an injected `execFile`.
 *
 * **Nothing here runs a coding agent's CLI.** `mcp add` and `mcp remove` write
 * `~/.claude.json` and `~/.codex/config.toml`, which belong to the person
 * running the suite, so the contract this file proves is the one WP-11 can prove
 * safely: *given* a binary, which argument vector is built, and what is made of
 * the four shapes those commands answer with. Every `exec` is a recorder.
 *
 * The binary search is pinned the same way. `WITENA_CLAUDE_BIN` /
 * `WITENA_CODEX_BIN` replace the whole search with one path and are returned
 * **without** an existence check (`providers/cli-process.ts`), so a suite run on
 * a machine that really has Claude Code installed behaves identically to one
 * that does not. The two cases that are about the search itself use a temporary
 * home directory instead.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MCP_SERVER_NAME } from '@shared/mcp-tools'
import {
  CLAUDE_CODE_ROOT,
  CODEX_BUNDLE_DIR,
  claudeCodeDirs,
  createIdeClients,
  isIdeClientId,
  newestVersionFirst,
  parseClaudeCommand,
  parseCodexCommand,
  absentIdeClients,
  type ExecFileFn,
  type ExecResult
} from './ide-clients'

const CLAUDE_BIN = '/fake/bin/claude'
const CODEX_BIN = '/fake/bin/codex'
const LAUNCHER = '/Applications/My Apps/Witena.app/Contents/Resources/bin/witena-mcp'

/** An environment with no `PATH` at all, so only the overrides can answer. */
const ENV = {
  PATH: '',
  WITENA_CLAUDE_BIN: CLAUDE_BIN,
  WITENA_CODEX_BIN: CODEX_BIN
}

interface Call {
  file: string
  args: string[]
}

/**
 * A recording `execFile` that answers each call from a queue.
 *
 * A queue rather than one canned answer: the interesting sequences are two or
 * three commands long (`--version`, then a read, then a write), and asserting
 * *which* vector was built in *which* order is the whole point.
 */
function recorder(answers: Partial<ExecResult>[]): { exec: ExecFileFn; calls: Call[] } {
  const calls: Call[] = []
  let index = 0
  const exec: ExecFileFn = (file, args) => {
    calls.push({ file, args: [...args] })
    const answer = answers[index] ?? {}
    index += 1
    return Promise.resolve({ code: 0, stdout: '', stderr: '', ...answer })
  }
  return { exec, calls }
}

function clients(answers: Partial<ExecResult>[]): { api: ReturnType<typeof createIdeClients>; calls: Call[] } {
  const { exec, calls } = recorder(answers)
  return { api: createIdeClients({ execFile: exec, env: ENV, home: '/nowhere' }), calls }
}

describe('newestVersionFirst', () => {
  it('orders version directories numerically, not lexically', () => {
    // The bug a string sort makes, in both directions: `2.1.9` above `2.1.10`,
    // and `2.1.275` below `2.1.30`.
    expect(newestVersionFirst(['2.1.9', '2.1.275', '2.1.10', '2.1.30'])).toEqual([
      '2.1.275',
      '2.1.30',
      '2.1.10',
      '2.1.9'
    ])
    expect(newestVersionFirst(['1.0.0', '10.0.0', '2.0.0'])).toEqual(['10.0.0', '2.0.0', '1.0.0'])
  })

  it('keeps a name it cannot read as a version, last rather than thrown away', () => {
    expect(newestVersionFirst(['2.1.275', 'node_modules', '2.2.0'])).toEqual([
      '2.2.0',
      '2.1.275',
      'node_modules'
    ])
  })
})

describe('claudeCodeDirs', () => {
  let home: string

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('globs the versioned installations and offers the newest first', () => {
    home = mkdtempSync(join(tmpdir(), 'witena-home-'))
    const root = join(home, ...CLAUDE_CODE_ROOT)
    for (const version of ['2.1.10', '2.1.275', '2.1.9']) {
      mkdirSync(join(root, version, 'claude.app', 'Contents', 'MacOS'), { recursive: true })
    }

    expect(claudeCodeDirs(home)).toEqual([
      join(root, '2.1.275', 'claude.app', 'Contents', 'MacOS'),
      join(root, '2.1.10', 'claude.app', 'Contents', 'MacOS'),
      join(root, '2.1.9', 'claude.app', 'Contents', 'MacOS')
    ])
  })

  it('answers with nothing on a machine that never installed it', () => {
    home = mkdtempSync(join(tmpdir(), 'witena-home-'))
    expect(claudeCodeDirs(home)).toEqual([])
  })
})

describe('detect', () => {
  it('confirms a Claude Code installation with --version, never with a stat', async () => {
    // WP-0b: `claude` is a multi-call executable, so the file being there is not
    // proof that this one is the CLI.
    const { api, calls } = clients([{ code: 0, stdout: '2.1.275 (Claude Code)\n' }])

    await expect(api.detect('claude-code')).resolves.toBe(true)
    expect(calls).toEqual([{ file: CLAUDE_BIN, args: ['--version'] }])
  })

  it('reports a non-zero --version as not installed', async () => {
    const { api } = clients([{ code: 127 }])
    await expect(api.detect('claude-code')).resolves.toBe(false)
  })

  it('reports a binary that cannot be run at all as not installed', async () => {
    const exec: ExecFileFn = () => Promise.reject(new Error('spawn ENOENT'))
    const api = createIdeClients({ execFile: exec, env: ENV, home: '/nowhere' })

    await expect(api.detect('codex')).resolves.toBe(false)
  })

  it('reports a client with no binary anywhere as not installed, and spawns nothing', async () => {
    const { exec, calls } = recorder([])
    // No override, no `PATH`, a home with no Claude Code under it — and Codex's
    // install location emptied, because `/Applications/ChatGPT.app` is really
    // there on a machine that has ChatGPT and this must not depend on whose.
    const api = createIdeClients({
      execFile: exec,
      env: { PATH: '' },
      home: '/nowhere',
      fallbackDirs: { codex: [] }
    })

    await expect(api.detect('claude-code')).resolves.toBe(false)
    await expect(api.detect('codex')).resolves.toBe(false)
    expect(calls).toEqual([])
  })
})

describe('registered', () => {
  it('reads Claude Code out of `mcp get`, which has no --json', async () => {
    const { api, calls } = clients([
      {
        code: 0,
        stdout: [
          'witena:',
          '  Scope: User config (available in all your projects)',
          '  Status: ✔ connected',
          '  Type: stdio',
          `  Command: ${LAUNCHER}`,
          '  Args: ',
          '',
          'To remove this server, run: claude mcp remove "witena" -s user'
        ].join('\n')
      }
    ])

    await expect(api.registered('claude-code')).resolves.toBe(LAUNCHER)
    expect(calls).toEqual([{ file: CLAUDE_BIN, args: ['mcp', 'get', MCP_SERVER_NAME] }])
  })

  it('treats Claude Code’s exit 1 as "nothing registered", not as a failure', async () => {
    const { api } = clients([
      { code: 1, stdout: 'No MCP server named "witena". Run `claude mcp add` to add one.\n' }
    ])

    await expect(api.registered('claude-code')).resolves.toBeNull()
  })

  it('reads Codex out of `mcp list --json`, by name', async () => {
    // The list also carries servers injected by Codex plugins that are in no
    // configuration file at all (WP-0b), so position and count say nothing.
    const { api, calls } = clients([
      {
        code: 0,
        stdout: JSON.stringify([
          { name: 'codex_app', transport: { type: 'stdio', command: '/plugins/launch' } },
          { name: MCP_SERVER_NAME, transport: { type: 'stdio', command: LAUNCHER, args: [] } }
        ])
      }
    ])

    await expect(api.registered('codex')).resolves.toBe(LAUNCHER)
    expect(calls).toEqual([{ file: CODEX_BIN, args: ['mcp', 'list', '--json'] }])
  })

  it('answers null for a Codex list that does not name witena', async () => {
    const { api } = clients([
      { code: 0, stdout: JSON.stringify([{ name: 'cua_repl', transport: { command: '/x' } }]) }
    ])

    await expect(api.registered('codex')).resolves.toBeNull()
  })
})

describe('parseClaudeCommand / parseCodexCommand', () => {
  const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' })

  it('takes the first Command line and trims it', () => {
    expect(parseClaudeCommand(ok('  Type: stdio\n  Command:   /bin/witena-mcp  \n'))).toBe(
      '/bin/witena-mcp'
    )
  })

  it('keeps a command containing spaces whole', () => {
    expect(parseClaudeCommand(ok(`  Command: ${LAUNCHER}\n`))).toBe(LAUNCHER)
  })

  it('never reads a command out of a failed call', () => {
    expect(parseClaudeCommand({ code: 1, stdout: '  Command: /x\n', stderr: '' })).toBeNull()
    expect(
      parseCodexCommand({
        code: 1,
        stdout: JSON.stringify([{ name: MCP_SERVER_NAME, transport: { command: '/x' } }]),
        stderr: ''
      })
    ).toBeNull()
  })

  it('degrades to null rather than throwing on output it does not recognise', () => {
    expect(parseClaudeCommand(ok('something else entirely'))).toBeNull()
    expect(parseCodexCommand(ok('not json at all'))).toBeNull()
    expect(parseCodexCommand(ok('{"servers":[]}'))).toBeNull()
    expect(parseCodexCommand(ok(JSON.stringify([{ name: MCP_SERVER_NAME }])))).toBeNull()
    expect(
      parseCodexCommand(ok(JSON.stringify([{ name: MCP_SERVER_NAME, transport: { command: '' } }])))
    ).toBeNull()
  })
})

describe('register / unregister', () => {
  it('builds Claude Code’s user-scoped add, with the command after `--`', async () => {
    const { api, calls } = clients([{ code: 0 }])

    await api.register('claude-code', LAUNCHER)

    expect(calls).toEqual([
      {
        file: CLAUDE_BIN,
        // `--scope user` is what keeps the registration out of whatever
        // directory the app was launched from; `--` is required before a command
        // that could carry flags of its own, and the path is **one argument**,
        // so a bundle in a folder with a space needs no quoting.
        args: ['mcp', 'add', MCP_SERVER_NAME, '--scope', 'user', '--', LAUNCHER]
      }
    ])
  })

  it('builds Codex’s add, which has no scope flag because it is always global', async () => {
    const { api, calls } = clients([{ code: 0 }])

    await api.register('codex', LAUNCHER)

    expect(calls).toEqual([
      { file: CODEX_BIN, args: ['mcp', 'add', MCP_SERVER_NAME, '--', LAUNCHER] }
    ])
  })

  it('builds both removals', async () => {
    const { api, calls } = clients([{ code: 0 }, { code: 0 }])

    await api.unregister('claude-code')
    await api.unregister('codex')

    expect(calls).toEqual([
      { file: CLAUDE_BIN, args: ['mcp', 'remove', MCP_SERVER_NAME, '-s', 'user'] },
      { file: CODEX_BIN, args: ['mcp', 'remove', MCP_SERVER_NAME] }
    ])
  })

  it('surfaces a CLI that refused, quoting it and nothing else', async () => {
    const { api } = clients([{ code: 1, stderr: 'Error: an MCP server named witena already exists' }])

    await expect(api.register('codex', LAUNCHER)).rejects.toMatchObject({
      code: 'internal',
      message: expect.stringContaining('already exists') as unknown as string
    })
  })

  it('refuses with integrations_client_not_installed when there is no binary to run', async () => {
    const { exec, calls } = recorder([])
    const api = createIdeClients({
      execFile: exec,
      env: { PATH: '' },
      home: '/nowhere',
      fallbackDirs: { codex: [] }
    })

    await expect(api.register('claude-code', LAUNCHER)).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'integrations_client_not_installed', client: 'claude-code' }
    })
    expect(calls).toEqual([])
  })
})

describe('the module’s own constants', () => {
  it('names the two install locations WP-0b measured', () => {
    expect(CLAUDE_CODE_ROOT.join('/')).toBe('Library/Application Support/Claude/claude-code')
    expect(CODEX_BUNDLE_DIR).toBe('/Applications/ChatGPT.app/Contents/Resources')
  })

  it('narrows a client id and refuses anything else', () => {
    expect(isIdeClientId('claude-code')).toBe(true)
    expect(isIdeClientId('codex')).toBe(true)
    expect(isIdeClientId('cursor')).toBe(false)
    expect(isIdeClientId(undefined)).toBe(false)
  })
})

describe('absentIdeClients', () => {
  it('reports nothing installed and refuses to write anything', async () => {
    const api = absentIdeClients()

    await expect(api.detect('claude-code')).resolves.toBe(false)
    await expect(api.registered('codex')).resolves.toBeNull()
    await expect(api.register('codex', LAUNCHER)).rejects.toMatchObject({ code: 'validation' })
    await expect(api.unregister('codex')).rejects.toMatchObject({ code: 'validation' })
  })
})
