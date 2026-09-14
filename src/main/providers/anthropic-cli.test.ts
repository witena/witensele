/**
 * `anthropic-cli.ts` against a **fake `ant`**.
 *
 * The fake is a real executable shell script written into a temporary directory
 * that is put first on the `PATH` the module is given. That is deliberate and it
 * is the whole point of this file: the risky part of this feature is not the
 * parsing, it is spawning a process, finding it on a `PATH` a packaged app does
 * not inherit, telling ENOENT from a non-zero exit, and never letting a token
 * reach an error message. A stubbed `spawn` would prove none of that.
 *
 * Nothing here runs the real `ant`, and no test depends on whether the developer
 * happens to be signed in: every case names the script it wants.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BackendFailure } from '../errors'
import {
  ANT_BINARY_ENV,
  createAnthropicCli,
  defaultFallbackDirs,
  resolveAntBinary,
  TOKEN_EXPIRY_MARGIN_MS
} from './anthropic-cli'

const directories: string[] = []

afterEach(() => {
  while (directories.length > 0) {
    const dir = directories.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

/** A temporary directory holding an executable `ant` with the given body. */
function fakeAntDir(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'witena-ant-'))
  directories.push(dir)
  const script = join(dir, 'ant')
  writeFileSync(script, `#!/bin/sh\n${body}\n`)
  chmodSync(script, 0o755)
  return dir
}

/** An empty directory, so `PATH` points somewhere real that has no `ant`. */
function emptyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'witena-noant-'))
  directories.push(dir)
  return dir
}

/** The credentials payload `ant auth print-credentials` prints, as JSON. */
function credentials(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: '1.0',
    type: 'oauth_token',
    access_token: 'sk-ant-oat-secret',
    expires_at: 2_000_000_000,
    refresh_token: 'sk-ant-ort-secret',
    scope: 'user:inference',
    organization_uuid: 'org-uuid',
    organization_name: 'Test Org',
    account_email: 'person@example.com',
    workspace_id: 'wrkspc-1',
    workspace_name: 'Default',
    ...overrides
  })
}

/**
 * A CLI whose `PATH` holds only `dir`.
 *
 * `fallbackDirs` is emptied on purpose: the developer's own `/opt/homebrew/bin`
 * must never decide the outcome of a test.
 */
function cliWith(dir: string, extra: Record<string, unknown> = {}) {
  return createAnthropicCli({
    env: { PATH: dir },
    fallbackDirs: [],
    commandTimeoutMs: 5_000,
    loginTimeoutMs: 5_000,
    ...extra
  })
}

describe('resolveAntBinary', () => {
  it('finds the binary on PATH', () => {
    const dir = fakeAntDir('exit 0')
    expect(resolveAntBinary({ PATH: dir }, [])).toBe(join(dir, 'ant'))
  })

  it('falls back to the install locations a packaged app does not inherit', () => {
    const dir = fakeAntDir('exit 0')
    expect(resolveAntBinary({ PATH: emptyDir() }, [dir])).toBe(join(dir, 'ant'))
  })

  it(`prefers ${ANT_BINARY_ENV} over the whole search`, () => {
    expect(resolveAntBinary({ [ANT_BINARY_ENV]: '/opt/elsewhere/ant', PATH: '/usr/bin' }, [])).toBe(
      '/opt/elsewhere/ant'
    )
  })

  it('reports ant_missing when there is nothing to run', () => {
    expect(() => resolveAntBinary({ PATH: emptyDir() }, [])).toThrowError(
      expect.objectContaining({ code: 'ant_missing' })
    )
  })

  it('names the three macOS locations by default', () => {
    expect(defaultFallbackDirs('/Users/someone')).toEqual([
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/Users/someone/go/bin'
    ])
  })
})

describe('status', () => {
  it('reports not-installed rather than failing when there is no binary', async () => {
    await expect(cliWith(emptyDir()).status()).resolves.toEqual({ state: 'not-installed' })
  })

  it('reports not-installed when the configured path does not exist', async () => {
    const cli = createAnthropicCli({
      env: { [ANT_BINARY_ENV]: join(emptyDir(), 'nope'), PATH: emptyDir() },
      fallbackDirs: []
    })

    await expect(cli.status()).resolves.toEqual({ state: 'not-installed' })
  })

  it('reports signed-out when no profile is logged in', async () => {
    const dir = fakeAntDir('echo "no profile is logged in" >&2\nexit 1')

    await expect(cliWith(dir).status()).resolves.toEqual({ state: 'signed-out' })
  })

  it('reports the account, organisation, workspace and expiry when signed in', async () => {
    const dir = fakeAntDir(`echo '${credentials()}'`)

    await expect(cliWith(dir).status()).resolves.toEqual({
      state: 'signed-in',
      organizationName: 'Test Org',
      account: 'person@example.com',
      workspaceName: 'Default',
      // Unix seconds in, epoch milliseconds out: every timestamp in Witena is ms.
      expiresAt: 2_000_000_000_000
    })
  })

  it('never carries a token across the boundary', async () => {
    const dir = fakeAntDir(`echo '${credentials()}'`)
    const status = await cliWith(dir).status()

    expect(JSON.stringify(status)).not.toContain('secret')
    expect(Object.keys(status).sort()).toEqual([
      'account',
      'expiresAt',
      'organizationName',
      'state',
      'workspaceName'
    ])
  })

  it('asks for the credentials, not for the prose of `ant auth status`', async () => {
    const dir = fakeAntDir(`echo "$@" > "$(dirname "$0")/args.txt"\necho '${credentials()}'`)
    await cliWith(dir).status()

    expect(execFileSync('cat', [join(dir, 'args.txt')]).toString().trim()).toBe(
      'auth print-credentials'
    )
  })
})

describe('accessToken', () => {
  it('returns the token the CLI printed', async () => {
    const dir = fakeAntDir(`echo '${credentials()}'`)

    await expect(cliWith(dir).accessToken()).resolves.toBe('sk-ant-oat-secret')
  })

  it('caches until shortly before the token expires, then asks again', async () => {
    // The script counts its own invocations, so "asked again" is observable
    // without reaching into the module.
    const dir = fakeAntDir(
      `COUNT_FILE="$(dirname "$0")/count"\n` +
        `COUNT=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)\n` +
        `COUNT=$((COUNT + 1))\n` +
        `echo $COUNT > "$COUNT_FILE"\n` +
        `echo '{"access_token":"token-'"$COUNT"'","expires_at":1000}'`
    )

    let now = 0
    const cli = cliWith(dir, { now: () => now })

    await expect(cli.accessToken()).resolves.toBe('token-1')
    // Well inside the validity window: the cache answers.
    await expect(cli.accessToken()).resolves.toBe('token-1')

    // Inside the margin, which counts as expired.
    now = 1_000_000 - TOKEN_EXPIRY_MARGIN_MS + 1
    await expect(cli.accessToken()).resolves.toBe('token-2')
  })

  it('does not cache a credential with no expiry', async () => {
    const dir = fakeAntDir(
      `COUNT_FILE="$(dirname "$0")/count"\n` +
        `COUNT=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)\n` +
        `COUNT=$((COUNT + 1))\n` +
        `echo $COUNT > "$COUNT_FILE"\n` +
        `echo '{"access_token":"token-'"$COUNT"'"}'`
    )
    const cli = cliWith(dir, { now: () => 5_000_000 })

    await expect(cli.accessToken()).resolves.toBe('token-1')
    await expect(cli.accessToken()).resolves.toBe('token-2')
  })

  it('rejects ant_not_logged_in when the CLI exits non-zero', async () => {
    const dir = fakeAntDir('echo "not logged in" >&2\nexit 1')

    await expect(cliWith(dir).accessToken()).rejects.toMatchObject({
      code: 'ant_not_logged_in'
    })
  })

  it('rejects ant_missing when there is no binary', async () => {
    await expect(cliWith(emptyDir()).accessToken()).rejects.toMatchObject({ code: 'ant_missing' })
  })

  it('rejects rather than guessing when the output is not JSON', async () => {
    const dir = fakeAntDir('echo "Usage: ant auth print-credentials"')

    await expect(cliWith(dir).accessToken()).rejects.toMatchObject({ code: 'internal' })
  })

  it('keeps stdout out of the failure it reports, because stdout is the token', async () => {
    // A CLI that prints a token *and* fails must not leak it into a message.
    const dir = fakeAntDir(`echo '${credentials()}'\necho "printed anyway" >&2\nexit 3`)

    const error = await cliWith(dir)
      .accessToken()
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(BackendFailure)
    expect((error as BackendFailure).message).not.toContain('sk-ant')
    expect((error as BackendFailure).message).toContain('printed anyway')
  })
})

describe('login and logout', () => {
  it('runs `ant auth login` and reports the status it produced', async () => {
    const dir = fakeAntDir(
      `if [ "$2" = "login" ]; then echo "opened a browser"; exit 0; fi\n` +
        `echo '${credentials()}'`
    )

    await expect(cliWith(dir).login()).resolves.toMatchObject({
      state: 'signed-in',
      account: 'person@example.com'
    })
  })

  it('reports a cancelled sign-in as ant_not_logged_in', async () => {
    const dir = fakeAntDir(
      `if [ "$2" = "login" ]; then echo "cancelled" >&2; exit 1; fi\necho '${credentials()}'`
    )

    await expect(cliWith(dir).login()).rejects.toMatchObject({ code: 'ant_not_logged_in' })
  })

  it('runs `ant auth logout` and reports signed-out afterwards', async () => {
    const dir = fakeAntDir(
      `if [ "$2" = "logout" ]; then exit 0; fi\necho "no profile" >&2\nexit 1`
    )

    await expect(cliWith(dir).logout()).resolves.toEqual({ state: 'signed-out' })
  })

  it('treats a failing logout as already signed out', async () => {
    const dir = fakeAntDir('echo "nothing to do" >&2\nexit 1')

    await expect(cliWith(dir).logout()).resolves.toEqual({ state: 'signed-out' })
  })

  it('still reports ant_missing from logout, because that is not "already out"', async () => {
    await expect(cliWith(emptyDir()).logout()).rejects.toMatchObject({ code: 'ant_missing' })
  })

  it('forgets the cached token when the profile changes', async () => {
    const dir = fakeAntDir(
      `if [ "$2" = "logout" ]; then exit 0; fi\n` +
        `COUNT_FILE="$(dirname "$0")/count"\n` +
        `COUNT=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)\n` +
        `COUNT=$((COUNT + 1))\n` +
        `echo $COUNT > "$COUNT_FILE"\n` +
        `echo '{"access_token":"token-'"$COUNT"'","expires_at":9999999999}'`
    )
    const cli = cliWith(dir)

    await expect(cli.accessToken()).resolves.toBe('token-1')
    await cli.logout()
    await expect(cli.accessToken()).resolves.toBe('token-3')
  })
})
