/**
 * Waking the app, without waking the app.
 *
 * WP-0a's rule for this package is explicit: `launch()` is tested with an
 * injected `spawn` and an injected clock only — never by starting the real
 * bundle, which would put a second Witena on the machine several other agents
 * are sharing and would make the suite depend on `npm run dist:dir` having been
 * run. So every test here asserts one of two things: the argument vector macOS
 * is handed, or the shape of the wait.
 */
import { describe, expect, it } from 'vitest'
import type { McpDiscovery } from '@shared/mcp-discovery'
import {
  LAUNCH_POLL_MS,
  LAUNCH_TIMEOUT_MS,
  bundlePathFor,
  launch,
  openArgsFor,
  type SpawnLike
} from './launch'

const DISCOVERY: McpDiscovery = {
  version: 1,
  port: 51_234,
  token: 'token',
  pid: 4242,
  startedAt: 1_700_000_000_000
}

/** A `spawn` that records its call and never starts anything. */
function recordingSpawn(): { spawn: SpawnLike; calls: { command: string; args: readonly string[] }[]; unrefs: number } {
  const calls: { command: string; args: readonly string[] }[] = []
  const state = { unrefs: 0 }
  const spawn: SpawnLike = (command, args) => {
    calls.push({ command, args })
    return {
      unref: () => {
        state.unrefs += 1
      }
    }
  }
  return {
    spawn,
    calls,
    get unrefs() {
      return state.unrefs
    }
  }
}

/** A clock that advances by one poll interval every time it is read. */
function tickingClock(stepMs: number): () => number {
  let at = 0
  return () => {
    const now = at
    at += stepMs
    return now
  }
}

describe('bundlePathFor', () => {
  it('finds the bundle a run-as-node shim is executing from', () => {
    // WP-0a: inside the bundle, `process.execPath` is the bundle's own binary,
    // which is exactly what `bin/witena-mcp` execs with ELECTRON_RUN_AS_NODE=1.
    expect(bundlePathFor('/Applications/Witena.app/Contents/MacOS/Witena')).toBe(
      '/Applications/Witena.app'
    )
  })

  it('handles a bundle in a path with spaces, which is where users put things', () => {
    expect(
      bundlePathFor('/Users/ada/My Apps/Witena 0.1.app/Contents/MacOS/Witena')
    ).toBe('/Users/ada/My Apps/Witena 0.1.app')
  })

  it('takes the innermost bundle when one is nested inside another', () => {
    expect(
      bundlePathFor('/Applications/Outer.app/Contents/Helpers/Inner.app/Contents/MacOS/Inner')
    ).toBe('/Applications/Outer.app/Contents/Helpers/Inner.app')
  })

  it('answers null for anything that is not inside a bundle', () => {
    // Development (`node out/mcp-shim/witena-mcp.cjs`) and the spawn test both
    // land here, and "no bundle" is a different message, not a failure.
    for (const execPath of [
      '/usr/local/bin/node',
      '/Applications/Witena.app/Contents/Resources/mcp/witena-mcp.cjs',
      '/Applications/Witena.app/Contents/MacOS/nested/Witena',
      'Witena.app/Contents/MacOS/Witena/'
    ]) {
      expect(bundlePathFor(execPath)).toBeNull()
    }
  })
})

describe('openArgsFor', () => {
  it('is the background launch WP-0a measured', () => {
    expect(openArgsFor('/Applications/Witena.app')).toEqual([
      '-g',
      '-j',
      '-a',
      '/Applications/Witena.app',
      '--args',
      '--background'
    ])
  })

  it('carries WITENA_USER_DATA through when the shim was given one', () => {
    // Without it a launched app would use the default directory while the shim
    // watched the overridden one, and the wait could only ever time out.
    expect(openArgsFor('/Applications/Witena.app', '/tmp/ud')).toEqual([
      '-g',
      '-j',
      '--env',
      'WITENA_USER_DATA=/tmp/ud',
      '-a',
      '/Applications/Witena.app',
      '--args',
      '--background'
    ])
  })

  it('leaves the plain command alone for an empty override', () => {
    expect(openArgsFor('/Applications/Witena.app', '')).not.toContain('--env')
  })
})

describe('launch', () => {
  it('runs open detached and returns the file once it appears', async () => {
    const spawned = recordingSpawn()
    const slept: number[] = []
    let probes = 0

    const found = await launch({
      bundlePath: '/Applications/Witena.app',
      spawn: spawned.spawn,
      probe: async () => {
        probes += 1
        return probes < 3 ? null : DISCOVERY
      },
      now: tickingClock(LAUNCH_POLL_MS),
      sleep: async (ms) => {
        slept.push(ms)
      },
      log: () => undefined
    })

    expect(found).toEqual(DISCOVERY)
    expect(spawned.calls).toEqual([
      { command: 'open', args: openArgsFor('/Applications/Witena.app') }
    ])
    // Detached and unreferenced: `open` exits as soon as LaunchServices has the
    // request, and the shim must not hold a handle to a process it never reads.
    expect(spawned.unrefs).toBe(1)
    expect(slept).toEqual([LAUNCH_POLL_MS, LAUNCH_POLL_MS, LAUNCH_POLL_MS])
    expect(probes).toBe(3)
  })

  it('gives up at the timeout and answers null', async () => {
    const spawned = recordingSpawn()
    let probes = 0

    const found = await launch({
      bundlePath: '/Applications/Witena.app',
      spawn: spawned.spawn,
      probe: async () => {
        probes += 1
        return null
      },
      now: tickingClock(LAUNCH_POLL_MS),
      sleep: async () => undefined,
      log: () => undefined,
      timeoutMs: 1_000,
      pollMs: LAUNCH_POLL_MS
    })

    expect(found).toBeNull()
    // The clock starts at 0 and advances one poll per read: the deadline is set
    // from the first read and compared on every later one.
    expect(probes).toBeGreaterThan(1)
    expect(probes).toBeLessThan(10)
  })

  it('keeps the default timeout WP-0a justified', () => {
    // Worst measured cold start was 2.9 s, warm ~0.7 s; 20 s is the headroom a
    // first launch after an update needs and is still short enough to report.
    expect(LAUNCH_TIMEOUT_MS).toBe(20_000)
    expect(LAUNCH_POLL_MS).toBe(250)
  })

  it('answers null without waiting when open cannot be run at all', async () => {
    let probes = 0
    const found = await launch({
      bundlePath: '/Applications/Witena.app',
      spawn: () => {
        throw new Error('spawn open ENOENT')
      },
      probe: async () => {
        probes += 1
        return null
      },
      now: () => 0,
      sleep: async () => undefined,
      log: () => undefined
    })

    expect(found).toBeNull()
    // Nothing was started, so spending the caller's twenty seconds waiting for
    // it would be twenty seconds of nothing.
    expect(probes).toBe(0)
  })

  it('never writes to stdout — every line it logs is the caller’s to place', async () => {
    const lines: string[] = []
    await launch({
      bundlePath: '/Applications/Witena.app',
      spawn: recordingSpawn().spawn,
      probe: async () => DISCOVERY,
      now: () => 0,
      sleep: async () => undefined,
      log: (line) => lines.push(line),
      timeoutMs: 10
    })
    expect(lines.some((line) => line.includes('/Applications/Witena.app'))).toBe(true)
  })
})
