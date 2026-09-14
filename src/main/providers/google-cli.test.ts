/**
 * `google-cli.ts` against a **fake `gcloud`**.
 *
 * The same discipline as `anthropic-cli.test.ts`, and for the same reason: the
 * risky part is not the parsing, it is spawning a process, finding it on a
 * `PATH` a packaged app does not inherit, telling ENOENT from a non-zero exit,
 * and never letting a credential reach an error message. So the fake is a real
 * executable shell script written into a temporary directory that is put first
 * on the `PATH` the module is given, and the **real** implementation drives it.
 *
 * Nothing here runs the real `gcloud`, and no test depends on whether the
 * developer happens to have application-default credentials: every case names
 * the script it wants.
 *
 * The payload shapes are the ones verified on Google Cloud SDK 553.0.0 —
 * `print-access-token --format=json` prints one object whose token field is
 * `token` (not `access_token`), whose `expiry.datetime` is a **naive UTC**
 * timestamp, and whose `quota_project_id` is `null` until someone sets one.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BackendFailure } from '../errors'
import { TOKEN_EXPIRY_MARGIN_MS } from './cli-process'
import {
  ASSUMED_TOKEN_LIFETIME_MS,
  createGoogleCli,
  defaultGcloudFallbackDirs,
  GCLOUD_BINARY_ENV,
  parseExpiry,
  resolveGcloudBinary
} from './google-cli'

const directories: string[] = []

afterEach(() => {
  while (directories.length > 0) {
    const dir = directories.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

/** A temporary directory holding an executable `gcloud` with the given body. */
function fakeGcloudDir(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'witena-gcloud-'))
  directories.push(dir)
  const script = join(dir, 'gcloud')
  writeFileSync(script, `#!/bin/sh\n${body}\n`)
  chmodSync(script, 0o755)
  return dir
}

/** An empty directory, so `PATH` points somewhere real that has no `gcloud`. */
function emptyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'witena-nogcloud-'))
  directories.push(dir)
  return dir
}

/** What `print-access-token --format=json` prints, as one JSON object. */
function adc(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    account: '',
    client_id: '764086051850-example.apps.googleusercontent.com',
    expired: false,
    expiry: { datetime: '2033-05-18 03:33:20.000000' },
    id_token: 'header.payload.signature',
    quota_project_id: 'witena-dev',
    refresh_token: 'refresh-secret',
    token: 'ya29-secret',
    universe_domain: 'googleapis.com',
    valid: true,
    ...overrides
  })
}

/**
 * A script that answers `print-access-token` with `payload` and `config list`
 * with `core`, and exits 0 for everything else (login, revoke, set-quota-project).
 */
function credentialScript(payload: string, core = '{}'): string {
  return (
    `if [ "$3" = "print-access-token" ]; then echo '${payload}'; exit 0; fi\n` +
    `if [ "$1" = "config" ]; then echo '{"core":${core}}'; exit 0; fi\n` +
    `exit 0`
  )
}

/**
 * A CLI whose `PATH` holds only `dir`.
 *
 * `fallbackDirs` is emptied on purpose: the developer's own `/opt/homebrew/bin`
 * has a real `gcloud` on it and must never decide the outcome of a test.
 */
function cliWith(dir: string, extra: Record<string, unknown> = {}) {
  return createGoogleCli({
    env: { PATH: dir },
    fallbackDirs: [],
    commandTimeoutMs: 5_000,
    loginTimeoutMs: 5_000,
    ...extra
  })
}

describe('resolveGcloudBinary', () => {
  it('finds the binary on PATH', () => {
    const dir = fakeGcloudDir('exit 0')
    expect(resolveGcloudBinary({ PATH: dir }, [])).toBe(join(dir, 'gcloud'))
  })

  it('falls back to the install locations a packaged app does not inherit', () => {
    const dir = fakeGcloudDir('exit 0')
    expect(resolveGcloudBinary({ PATH: emptyDir() }, [dir])).toBe(join(dir, 'gcloud'))
  })

  it(`prefers ${GCLOUD_BINARY_ENV} over the whole search`, () => {
    expect(
      resolveGcloudBinary({ [GCLOUD_BINARY_ENV]: '/opt/elsewhere/gcloud', PATH: '/usr/bin' }, [])
    ).toBe('/opt/elsewhere/gcloud')
  })

  it('reports gcloud_missing when there is nothing to run', () => {
    expect(() => resolveGcloudBinary({ PATH: emptyDir() }, [])).toThrowError(
      expect.objectContaining({ code: 'gcloud_missing' })
    )
  })

  it('names the three macOS locations by default', () => {
    expect(defaultGcloudFallbackDirs('/Users/someone')).toEqual([
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/Users/someone/google-cloud-sdk/bin'
    ])
  })
})

describe('parseExpiry', () => {
  it('reads the naive timestamp as UTC, which is what the SDK prints', () => {
    // Verified on this machine: `expiry.datetime` read 05:14:51 while `date -u`
    // read 04:14:51, so the value is UTC and the local zone must not be applied.
    expect(parseExpiry('2026-09-14 05:14:51.579879')).toBe(Date.UTC(2026, 8, 14, 5, 14, 51, 579))
  })

  it('answers nothing for a value it cannot read', () => {
    expect(parseExpiry(undefined)).toBeUndefined()
    expect(parseExpiry('')).toBeUndefined()
    expect(parseExpiry('not a date')).toBeUndefined()
  })
})

describe('status', () => {
  it('reports not-installed rather than failing when there is no binary', async () => {
    await expect(cliWith(emptyDir()).status()).resolves.toEqual({ state: 'not-installed' })
  })

  it('reports not-installed when the configured path does not exist', async () => {
    const cli = createGoogleCli({
      env: { [GCLOUD_BINARY_ENV]: join(emptyDir(), 'nope'), PATH: emptyDir() },
      fallbackDirs: []
    })

    await expect(cli.status()).resolves.toEqual({ state: 'not-installed' })
  })

  it('reports signed-out when there are no application-default credentials', async () => {
    const dir = fakeGcloudDir(
      'echo "ERROR: Your default credentials were not found." >&2\nexit 1'
    )

    await expect(cliWith(dir).status()).resolves.toEqual({ state: 'signed-out' })
  })

  it('reports the account, the quota project and the expiry when signed in', async () => {
    const dir = fakeGcloudDir(credentialScript(adc({ account: 'person@example.com' })))

    await expect(cliWith(dir).status()).resolves.toEqual({
      state: 'signed-in',
      account: 'person@example.com',
      project: 'witena-dev',
      expiresAt: Date.UTC(2033, 4, 18, 3, 33, 20)
    })
  })

  it('falls back to `gcloud config` for labels the ADC file does not carry', async () => {
    // The ordinary state of a machine where only `application-default login` was
    // run: the ADC has an empty account and a null quota project.
    const dir = fakeGcloudDir(
      credentialScript(
        adc({ account: '', quota_project_id: null }),
        '{"account":"person@example.com","project":"from-config"}'
      )
    )

    await expect(cliWith(dir).status()).resolves.toMatchObject({
      state: 'signed-in',
      account: 'person@example.com',
      project: 'from-config'
    })
  })

  it('reports signed-in with no project when nothing names one', async () => {
    const dir = fakeGcloudDir(credentialScript(adc({ account: '', quota_project_id: null })))
    const status = await cliWith(dir).status()

    // A gap the panel offers to fill, not a fourth state and not a rejection.
    expect(status.state).toBe('signed-in')
    expect(status.project).toBeUndefined()
  })

  it('never carries a credential across the boundary', async () => {
    const dir = fakeGcloudDir(credentialScript(adc()))
    const status = await cliWith(dir).status()

    expect(JSON.stringify(status)).not.toContain('secret')
    expect(Object.keys(status).sort()).toEqual(['expiresAt', 'project', 'state'])
  })

  it('asks for JSON, never for the human-readable form', async () => {
    const dir = fakeGcloudDir(
      `echo "$@" >> "$(dirname "$0")/args.txt"\n` +
        credentialScript(adc({ account: 'person@example.com' }))
    )
    await cliWith(dir).status()

    // One spawn, and every flag on it is a machine-readable one. An ADC that
    // already carries both labels is never followed by a `config list`.
    expect(execFileSync('cat', [join(dir, 'args.txt')]).toString().trim()).toBe(
      'auth application-default print-access-token --format=json'
    )
  })

  it('asks `gcloud config` for JSON too, never for its printed table', async () => {
    const dir = fakeGcloudDir(
      `echo "$@" >> "$(dirname "$0")/args.txt"\n` +
        credentialScript(adc({ account: '', quota_project_id: null }))
    )
    await cliWith(dir).status()

    expect(execFileSync('cat', [join(dir, 'args.txt')]).toString().trim().split('\n')).toEqual([
      'auth application-default print-access-token --format=json',
      'config list --format=json'
    ])
  })
})

describe('accessToken and project', () => {
  it('returns the token the CLI printed', async () => {
    const dir = fakeGcloudDir(credentialScript(adc()))

    await expect(cliWith(dir).accessToken()).resolves.toBe('ya29-secret')
  })

  it('caches until shortly before the token expires, then asks again', async () => {
    // The script counts its own `print-access-token` invocations, so "asked
    // again" is observable without reaching into the module.
    const dir = fakeGcloudDir(
      `if [ "$3" = "print-access-token" ]; then\n` +
        `  COUNT_FILE="$(dirname "$0")/count"\n` +
        `  COUNT=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)\n` +
        `  COUNT=$((COUNT + 1))\n` +
        `  echo $COUNT > "$COUNT_FILE"\n` +
        `  echo '{"token":"token-'"$COUNT"'","expiry":{"datetime":"2000-01-01 00:16:40.000000"},"quota_project_id":"p"}'\n` +
        `  exit 0\n` +
        `fi\nexit 0`
    )

    const expiresAt = Date.UTC(2000, 0, 1, 0, 16, 40)
    let now = expiresAt - 3_600_000
    const cli = cliWith(dir, { now: () => now })

    await expect(cli.accessToken()).resolves.toBe('token-1')
    // Well inside the validity window: the cache answers, and `project()` reads
    // the same cached credential rather than spawning a second process.
    await expect(cli.accessToken()).resolves.toBe('token-1')
    await expect(cli.project()).resolves.toBe('p')

    // Inside the margin, which counts as expired.
    now = expiresAt - TOKEN_EXPIRY_MARGIN_MS + 1
    await expect(cli.accessToken()).resolves.toBe('token-2')
  })

  it('assumes the documented lifetime when gcloud printed no expiry', async () => {
    const dir = fakeGcloudDir(credentialScript('{"token":"ya29-secret"}'))
    const cli = cliWith(dir, { now: () => 1_000_000 })

    await expect(cli.status()).resolves.toMatchObject({
      expiresAt: 1_000_000 + ASSUMED_TOKEN_LIFETIME_MS
    })
  })

  it('rejects gcloud_no_project when nothing names a project', async () => {
    const dir = fakeGcloudDir(credentialScript(adc({ quota_project_id: null })))

    await expect(cliWith(dir).project()).rejects.toMatchObject({ code: 'gcloud_no_project' })
  })

  it('rejects gcloud_not_logged_in when the CLI exits non-zero', async () => {
    const dir = fakeGcloudDir('echo "no credentials" >&2\nexit 1')

    await expect(cliWith(dir).accessToken()).rejects.toMatchObject({
      code: 'gcloud_not_logged_in'
    })
  })

  it('rejects gcloud_missing when there is no binary', async () => {
    await expect(cliWith(emptyDir()).accessToken()).rejects.toMatchObject({
      code: 'gcloud_missing'
    })
  })

  it('rejects rather than guessing when the output is not JSON', async () => {
    const dir = fakeGcloudDir('echo "Usage: gcloud auth application-default"')

    await expect(cliWith(dir).accessToken()).rejects.toMatchObject({ code: 'internal' })
  })

  it('keeps stdout out of the failure it reports, because stdout is the token', async () => {
    // A CLI that prints a credential *and* fails must not leak it into a message.
    const dir = fakeGcloudDir(`echo '${adc()}'\necho "printed anyway" >&2\nexit 3`)

    const error = await cliWith(dir)
      .accessToken()
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(BackendFailure)
    expect((error as BackendFailure).message).not.toContain('ya29')
    expect((error as BackendFailure).message).toContain('printed anyway')
  })
})

describe('login, logout and the quota project', () => {
  it('runs the application-default login and reports the status it produced', async () => {
    const dir = fakeGcloudDir(
      `if [ "$3" = "login" ]; then echo "opened a browser"; exit 0; fi\n` +
        credentialScript(adc({ account: 'person@example.com' }))
    )

    await expect(cliWith(dir).login()).resolves.toMatchObject({
      state: 'signed-in',
      account: 'person@example.com'
    })
  })

  it('reports a cancelled sign-in as gcloud_not_logged_in', async () => {
    const dir = fakeGcloudDir(
      `if [ "$3" = "login" ]; then echo "cancelled" >&2; exit 1; fi\n` + credentialScript(adc())
    )

    await expect(cliWith(dir).login()).rejects.toMatchObject({ code: 'gcloud_not_logged_in' })
  })

  it('revokes the credentials and reports signed-out afterwards', async () => {
    const dir = fakeGcloudDir(
      `if [ "$3" = "revoke" ]; then exit 0; fi\necho "no credentials" >&2\nexit 1`
    )

    await expect(cliWith(dir).logout()).resolves.toEqual({ state: 'signed-out' })
  })

  it('treats a failing revoke as already signed out', async () => {
    const dir = fakeGcloudDir('echo "nothing to do" >&2\nexit 1')

    await expect(cliWith(dir).logout()).resolves.toEqual({ state: 'signed-out' })
  })

  it('still reports gcloud_missing from logout, because that is not "already out"', async () => {
    await expect(cliWith(emptyDir()).logout()).rejects.toMatchObject({ code: 'gcloud_missing' })
  })

  it('sets the quota project and reads the new status back', async () => {
    // The script remembers what it was asked to set, and then reports it.
    const dir = fakeGcloudDir(
      `STORE="$(dirname "$0")/project"\n` +
        `if [ "$3" = "set-quota-project" ]; then echo "$4" > "$STORE"; exit 0; fi\n` +
        `if [ "$3" = "print-access-token" ]; then\n` +
        `  P=$(cat "$STORE" 2>/dev/null || echo "")\n` +
        `  echo '{"token":"ya29-secret","quota_project_id":"'"$P"'"}'\n` +
        `  exit 0\n` +
        `fi\nexit 0`
    )
    const cli = cliWith(dir)

    await expect(cli.status()).resolves.toMatchObject({ state: 'signed-in' })
    await expect(cli.setQuotaProject('witena-dev')).resolves.toMatchObject({
      project: 'witena-dev'
    })
    // The cache was dropped, so the project is read again rather than remembered
    // from before the file changed.
    await expect(cli.project()).resolves.toBe('witena-dev')
  })

  it('reports a refused project as gcloud_no_project, quoting only stderr', async () => {
    const dir = fakeGcloudDir(
      `if [ "$3" = "set-quota-project" ]; then echo "PERMISSION_DENIED" >&2; exit 1; fi\n` +
        credentialScript(adc())
    )

    await expect(cliWith(dir).setQuotaProject('someone-elses')).rejects.toMatchObject({
      code: 'gcloud_no_project',
      message: 'PERMISSION_DENIED'
    })
  })

  it('refuses an empty project id without spawning anything', async () => {
    await expect(cliWith(emptyDir()).setQuotaProject('  ')).rejects.toMatchObject({
      code: 'gcloud_no_project'
    })
  })

  it('forgets the cached credential when the login changes', async () => {
    const dir = fakeGcloudDir(
      `if [ "$3" = "revoke" ]; then exit 0; fi\n` +
        `if [ "$3" = "print-access-token" ]; then\n` +
        `  COUNT_FILE="$(dirname "$0")/count"\n` +
        `  COUNT=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)\n` +
        `  COUNT=$((COUNT + 1))\n` +
        `  echo $COUNT > "$COUNT_FILE"\n` +
        `  echo '{"token":"token-'"$COUNT"'","expiry":{"datetime":"2033-05-18 03:33:20.000000"},"quota_project_id":"p"}'\n` +
        `  exit 0\n` +
        `fi\nexit 0`
    )
    const cli = cliWith(dir)

    await expect(cli.accessToken()).resolves.toBe('token-1')
    await cli.logout()

    // `token-2` rather than `token-1`: the cache was dropped on the way out, and
    // the status read that `logout` ends with is what refilled it. A stale token
    // surviving a sign-out is the bug this asserts against.
    await expect(cli.accessToken()).resolves.toBe('token-2')
  })
})
