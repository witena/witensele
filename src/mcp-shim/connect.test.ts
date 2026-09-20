/**
 * Finding the app, against real directories.
 *
 * The discovery file is a contract between two processes, so the cases worth
 * testing are the ways it can be wrong rather than the way it can be right:
 * absent, left behind by a process that is gone, written by a version that
 * means something else by the same fields, and — the one that matters most in a
 * day of ordinary use — correct yesterday and stale now, because Witena was
 * restarted and minted a new token.
 *
 * Real temporary directories and the real `node:fs` reads, because the thing
 * under test *is* a file lookup; the client factory, the launcher and the
 * liveness check are injected, because none of those may touch this machine.
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { readFile, readlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DISCOVERY_FILE, type McpDiscovery } from '@shared/mcp-discovery'
import {
  SHIM_ERROR_TEXT,
  ShimError,
  appIsRunning,
  createConnector,
  discoveryPathFor,
  isStaleEndpoint,
  probeDiscovery,
  type ConnectDeps,
  type EndpointClient
} from './connect'

/** The pid the tests call alive; everything else is dead. */
const LIVE_PID = process.pid
const DEAD_PID = 999_999

function discovery(over: Partial<McpDiscovery> = {}): McpDiscovery {
  return { version: 1, port: 51_234, token: 'first', pid: LIVE_PID, startedAt: 1, ...over }
}

/** A client that records the endpoint it was opened against. */
function fakeClient(): EndpointClient {
  return {
    callTool: async () => ({ content: [] }),
    close: async () => undefined
  }
}

/** The SDK's 401, as `StreamableHTTPClientTransport` throws it. */
function unauthorized(): Error {
  return Object.assign(new Error('Streamable HTTP error: Error POSTing to endpoint: …'), {
    code: 401
  })
}

/** `fetch`'s connection refusal, cause and all. */
function connectionRefused(): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:51234'), {
      code: 'ECONNREFUSED'
    })
  })
}

describe('the shim finding the app', () => {
  let dir: string
  /** What `openClient` was handed, call by call. */
  let opened: { discovery: McpDiscovery; clientName: string | undefined }[]
  /** Thrown instead of returning a client, in order, until the list runs out. */
  let openFailures: Error[]
  let launched: number
  let logs: string[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'witena-shim-'))
    opened = []
    openFailures = []
    launched = 0
    logs = []
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** The deps, with a launcher that never finds anything unless `whenLaunched` is set. */
  function deps(over: Partial<ConnectDeps> = {}): ConnectDeps {
    return {
      env: { WITENA_USER_DATA: dir },
      home: '/nonexistent-home',
      readFile: (path) => readFile(path, 'utf8'),
      readLink: (path) => readlink(path),
      isAlive: (pid) => pid === LIVE_PID,
      openClient: async (found, clientName) => {
        opened.push({ discovery: found, clientName })
        const failure = openFailures.shift()
        if (failure !== undefined) throw failure
        return fakeClient()
      },
      launch: async () => {
        launched += 1
        return null
      },
      log: (line) => logs.push(line),
      ...over
    }
  }

  async function writeDiscovery(value: unknown): Promise<void> {
    await writeFile(join(dir, DISCOVERY_FILE), JSON.stringify(value), 'utf8')
  }

  /** The lock Electron keeps inside `userData`, which is how "is the app up?" is answered. */
  async function writeSingletonLock(pid: number): Promise<void> {
    await symlink(`host-${pid}`, join(dir, 'SingletonLock'))
  }

  /* ---------------------------------------------------------------------- */
  /* The path and the probe                                                  */
  /* ---------------------------------------------------------------------- */

  it('joins the discovery file onto the userData directory itself', () => {
    // WP-1's module has no `node:path` on purpose, so both halves join it.
    expect(discoveryPathFor({ WITENA_USER_DATA: '/tmp/ud' }, '/Users/ada')).toBe(
      `/tmp/ud/${DISCOVERY_FILE}`
    )
    expect(discoveryPathFor({}, '/Users/ada')).toBe(
      `/Users/ada/Library/Application Support/Witena/${DISCOVERY_FILE}`
    )
  })

  it('reads a good file', async () => {
    await writeDiscovery(discovery())
    expect(await probeDiscovery(deps())).toEqual(discovery())
  })

  it('treats a missing file, a future version and a dead pid all as "no endpoint"', async () => {
    expect(await probeDiscovery(deps())).toBeNull()

    await writeDiscovery({ ...discovery(), version: 2 })
    expect(await probeDiscovery(deps())).toBeNull()

    await writeDiscovery('not an object')
    expect(await probeDiscovery(deps())).toBeNull()

    // The case the pid check exists for: the app was killed without the chance
    // to remove its file, and something else may now own that port.
    await writeDiscovery(discovery({ pid: DEAD_PID }))
    expect(await probeDiscovery(deps())).toBeNull()
  })

  it('reads the app’s liveness from the lock Electron keeps in userData', async () => {
    expect(await appIsRunning(deps())).toBe(false)
    await writeSingletonLock(LIVE_PID)
    expect(await appIsRunning(deps())).toBe(true)

    await rm(join(dir, 'SingletonLock'))
    await writeSingletonLock(DEAD_PID)
    expect(await appIsRunning(deps())).toBe(false)
  })

  /* ---------------------------------------------------------------------- */
  /* The three refusals                                                      */
  /* ---------------------------------------------------------------------- */

  it('says Witena is not running when there is no file and no bundle to launch', async () => {
    const connector = createConnector(deps({ launch: null }))
    await expect(connector.open('codex')).rejects.toThrow(ShimError)
    await expect(connector.open('codex')).rejects.toThrow(SHIM_ERROR_TEXT['not-running'])
    expect(launched).toBe(0)
  })

  it('says the endpoint is switched off when the app is up but wrote no file', async () => {
    await writeSingletonLock(LIVE_PID)
    const connector = createConnector(deps())
    await expect(connector.open(undefined)).rejects.toThrow(SHIM_ERROR_TEXT['endpoint-off'])
    // Launching a second copy of an app that is already running would achieve
    // nothing (WP-0a: `open -a` starts nothing), so it is not attempted.
    expect(launched).toBe(0)
  })

  it('says it timed out when a launch produced no file and no app', async () => {
    const connector = createConnector(deps())
    await expect(connector.open(undefined)).rejects.toThrow(SHIM_ERROR_TEXT['launch-timeout'])
    expect(launched).toBe(1)
  })

  it('prefers the switched-off sentence when the launch did bring the app up', async () => {
    const connector = createConnector(
      deps({
        launch: async () => {
          launched += 1
          await writeSingletonLock(LIVE_PID)
          return null
        }
      })
    )
    await expect(connector.open(undefined)).rejects.toThrow(SHIM_ERROR_TEXT['endpoint-off'])
    expect(launched).toBe(1)
  })

  it('names all three refusals in English, with the next action in each', () => {
    // They are read by a coding agent, not by the user: each says what is wrong
    // *and* what to do, because a model told only "not running" retries forever.
    for (const kind of ['not-running', 'endpoint-off', 'launch-timeout'] as const) {
      expect(new ShimError(kind).kind).toBe(kind)
      expect(SHIM_ERROR_TEXT[kind]).toMatch(/call this tool again/)
    }
    expect(SHIM_ERROR_TEXT['endpoint-off']).toContain('Settings -> Integrations')
    expect(SHIM_ERROR_TEXT['launch-timeout']).toContain('20 seconds')
  })

  /* ---------------------------------------------------------------------- */
  /* Connecting, and the one retry                                           */
  /* ---------------------------------------------------------------------- */

  it('connects with the file’s numbers and the client’s own name', async () => {
    await writeDiscovery(discovery())
    const connector = createConnector(deps())
    await connector.open('claude-code')
    expect(opened).toEqual([{ discovery: discovery(), clientName: 'claude-code' }])
  })

  it('launches when there is no file, then connects to what the launch published', async () => {
    const connector = createConnector(
      deps({
        launch: async (probe) => {
          launched += 1
          await writeDiscovery(discovery({ token: 'after-launch' }))
          return probe()
        }
      })
    )
    await connector.open('codex')
    expect(opened.map((o) => o.discovery.token)).toEqual(['after-launch'])
  })

  it('reads the file once and reuses it for later calls', async () => {
    await writeDiscovery(discovery())
    let reads = 0
    const connector = createConnector(
      deps({
        readFile: async (path) => {
          reads += 1
          return readFile(path, 'utf8')
        }
      })
    )
    await connector.open(undefined)
    await connector.open(undefined)
    await connector.open(undefined)
    expect(reads).toBe(1)
    expect(opened).toHaveLength(3)
  })

  it('re-reads the file exactly once after a 401 and connects with the new token', async () => {
    // The app restarted: the cached numbers are last launch's, and the token it
    // now expects is in the file. This is the whole reason the token is not in
    // the IDE's configuration.
    await writeDiscovery(discovery())
    const connector = createConnector(deps())
    await connector.open(undefined)
    expect(opened).toHaveLength(1)

    await writeDiscovery(discovery({ token: 'second', port: 51_999 }))
    openFailures = [unauthorized()]
    await connector.open(undefined)

    expect(opened.map((o) => o.discovery.token)).toEqual(['first', 'first', 'second'])
    expect(logs.some((line) => line.includes('re-reading'))).toBe(true)
  })

  it('re-reads the file after an ECONNREFUSED too', async () => {
    await writeDiscovery(discovery())
    const connector = createConnector(deps())
    await connector.open(undefined)

    await writeDiscovery(discovery({ token: 'second' }))
    openFailures = [connectionRefused()]
    await connector.open(undefined)
    expect(opened.map((o) => o.discovery.token)).toEqual(['first', 'first', 'second'])
  })

  it('does not retry a failure that is not staleness, and drops the cache anyway', async () => {
    await writeDiscovery(discovery())
    const connector = createConnector(deps())

    openFailures = [new Error('socket hang up')]
    await expect(connector.open(undefined)).rejects.toThrow('socket hang up')
    expect(opened).toHaveLength(1)

    // The cache went with it: the next call reads the file again rather than
    // trusting numbers that have just failed.
    await connector.open(undefined)
    expect(opened).toHaveLength(2)
  })

  it('explains itself when the retry finds the app gone as well', async () => {
    await writeDiscovery(discovery())
    const connector = createConnector(deps({ launch: null }))
    await connector.open(undefined)

    await rm(join(dir, DISCOVERY_FILE))
    openFailures = [connectionRefused()]
    await expect(connector.open(undefined)).rejects.toThrow(SHIM_ERROR_TEXT['not-running'])
  })

  /* ---------------------------------------------------------------------- */
  /* The staleness test itself                                               */
  /* ---------------------------------------------------------------------- */

  it('recognises staleness in the two spellings the SDK produces', () => {
    expect(isStaleEndpoint(unauthorized())).toBe(true)
    expect(isStaleEndpoint(connectionRefused())).toBe(true)
    expect(isStaleEndpoint(new Error('connect ECONNREFUSED 127.0.0.1:1'))).toBe(true)
  })

  it('does not mistake the endpoint’s other refusals for staleness', () => {
    // A 403 is the Origin / Host guard and a 413 is the body cap: both mean the
    // request was wrong, and re-reading the file would send it again.
    expect(isStaleEndpoint(Object.assign(new Error('forbidden'), { code: 403 }))).toBe(false)
    expect(isStaleEndpoint(Object.assign(new Error('too large'), { code: 413 }))).toBe(false)
    expect(isStaleEndpoint(new Error('the group is still talking'))).toBe(false)
    expect(isStaleEndpoint(undefined)).toBe(false)
    expect(isStaleEndpoint(null)).toBe(false)
  })

  it('does not follow a cause chain for ever', () => {
    const loop: { message: string; cause?: unknown } = { message: 'a' }
    loop.cause = loop
    expect(isStaleEndpoint(loop)).toBe(false)
  })

  /* ---------------------------------------------------------------------- */
  /* The directory rule                                                      */
  /* ---------------------------------------------------------------------- */

  it('honours WITENA_USER_DATA, which is what lets a test point both halves at one directory', async () => {
    const other = await mkdtemp(join(tmpdir(), 'witena-shim-other-'))
    await mkdir(join(other, 'nested'), { recursive: true })
    await writeFile(join(other, DISCOVERY_FILE), JSON.stringify(discovery({ token: 'other' })))
    expect(await probeDiscovery(deps({ env: { WITENA_USER_DATA: other } }))).toEqual(
      discovery({ token: 'other' })
    )
    await rm(other, { recursive: true, force: true })
  })
})
