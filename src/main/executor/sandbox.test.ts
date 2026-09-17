/**
 * The generated profile, and two runs against the **real** `sandbox-exec`.
 *
 * A unit test that only asserted on the profile string would prove that the
 * string is the one we meant to write, which is not the claim S5.15 makes: the
 * claim is that a command cannot write outside the folder. SBPL rule order is
 * subtle (the *last* matching rule wins, so `(allow default)` before
 * `(deny file-write*)` before the allowances is load-bearing), and getting it
 * backwards produces a profile that looks right and confines nothing. So the
 * last two cases shell out.
 *
 * They are skipped, not failed, on a machine with no `sandbox-exec`: the binary
 * is macOS-only and CLAUDE.md's target is a macOS build, but a contributor on
 * Linux should still be able to run `npm test`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  SANDBOX_EXEC,
  buildSandboxProfile,
  sandboxCommand,
  sandboxAvailable,
  systemTempDirs
} from './sandbox'

describe('executor/sandbox profile', () => {
  it('denies writing and then re-allows the folder, in that order', () => {
    const profile = buildSandboxProfile({ workdir: '/tmp/demo', tempDirs: ['/private/tmp'] })
    const deny = profile.indexOf('(deny file-write*)')
    const allowFolder = profile.indexOf('(subpath "/tmp/demo")')
    expect(profile).toContain('(allow default)')
    expect(deny).toBeGreaterThan(profile.indexOf('(allow default)'))
    // The whole point: SBPL takes the last matching rule.
    expect(allowFolder).toBeGreaterThan(deny)
  })

  it('leaves the network and reading untouched', () => {
    const profile = buildSandboxProfile({ workdir: '/tmp/demo' })
    expect(profile).not.toContain('file-read')
    expect(profile).not.toContain('network')
  })

  it('allows the null-ish devices', () => {
    const profile = buildSandboxProfile({ workdir: '/tmp/demo' })
    expect(profile).toContain('(literal "/dev/null")')
    expect(profile).toContain('(literal "/dev/stderr")')
  })

  it('escapes a quote in a folder name rather than ending the literal', () => {
    const profile = buildSandboxProfile({ workdir: '/tmp/we"ird', tempDirs: [] })
    expect(profile).toContain('(subpath "/tmp/we\\"ird")')
  })

  it('lists both spellings of the temp directory', () => {
    // `/tmp` is a symlink to `/private/tmp` on macOS and the sandbox matches the
    // real path, so a profile naming only `/tmp` would deny every write to it.
    const dirs = systemTempDirs()
    expect(dirs).toContain('/tmp')
    expect(dirs.some((dir) => dir.startsWith('/private/'))).toBe(true)
  })
})

describe('executor/sandbox sandboxCommand', () => {
  it('wraps the shell rather than the first program', () => {
    // Wrapping the program would sandbox nothing a `&&` chain spawned.
    const wrapped = sandboxCommand({
      command: 'npm test && ls',
      mode: 'workdir-write',
      workdir: '/tmp/demo',
      available: true
    })
    expect(wrapped.file).toBe(SANDBOX_EXEC)
    expect(wrapped.args[0]).toBe('-p')
    expect(wrapped.args.slice(2)).toEqual(['/bin/sh', '-c', 'npm test && ls'])
    expect(wrapped.sandboxed).toBe(true)
  })

  it('runs plainly when the setting is off', () => {
    const plain = sandboxCommand({
      command: 'ls',
      mode: 'off',
      workdir: '/tmp/demo',
      available: true
    })
    expect(plain).toEqual({ file: '/bin/sh', args: ['-c', 'ls'], sandboxed: false })
  })

  it('runs plainly, and says so, when sandbox-exec is missing', () => {
    const plain = sandboxCommand({
      command: 'ls',
      mode: 'workdir-write',
      workdir: '/tmp/demo',
      available: false
    })
    expect(plain.file).toBe('/bin/sh')
    expect(plain.sandboxed).toBe(false)
  })
})

describe('executor/sandbox against the real sandbox-exec', () => {
  const runnable = sandboxAvailable()
  let workdir: string

  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), 'witena-sandbox-'))
  })

  afterAll(() => {
    if (workdir) rmSync(workdir, { recursive: true, force: true })
  })

  /** Runs one line through the real wrapper and answers with the exit code. */
  function run(command: string): { code: number; stderr: string } {
    const wrapped = sandboxCommand({
      command,
      mode: 'workdir-write',
      workdir,
      // The folder itself is under the system temp directory, so the temp
      // allowance would let every case through. Naming none isolates the rule
      // actually under test: only `workdir` is writable.
      tempDirs: [],
      available: true
    })
    try {
      execFileSync(wrapped.file, wrapped.args, { cwd: workdir, stdio: 'pipe' })
      return { code: 0, stderr: '' }
    } catch (error) {
      const failure = error as { status?: number; stderr?: Buffer }
      return { code: failure.status ?? 1, stderr: failure.stderr?.toString() ?? '' }
    }
  }

  it.runIf(runnable)('lets a command write inside the folder', () => {
    expect(run('echo inside > inside.txt').code).toBe(0)
    expect(readFileSync(join(workdir, 'inside.txt'), 'utf8').trim()).toBe('inside')
  })

  it.runIf(runnable)('refuses a write outside the folder', () => {
    const target = join(homedir(), 'witena-sandbox-probe-should-not-exist.txt')
    const result = run(`echo outside > ${JSON.stringify(target)}`)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/not permitted/i)
    expect(existsSync(target)).toBe(false)
  })

  it.runIf(runnable)('still lets a command read outside the folder', () => {
    // Stated as a test because it is the limit of the feature, not an accident:
    // the sandbox confines writes, and the permission prompt is what stands
    // between a model and the contents of the user's disk.
    expect(run('cat /etc/hosts > read.txt').code).toBe(0)
  })
})
