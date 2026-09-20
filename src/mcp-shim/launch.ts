/**
 * Waking Witena up, when an IDE calls a tool and the app is not running.
 *
 * PLAN.md's decision table puts a stdio shim in front of the endpoint partly
 * because "only a process can launch the app when it is not running". This is
 * that process: one `open(1)` call and a poll of the discovery file, with every
 * dependency injected so the whole thing can be tested without a bundle, a
 * timer or a Dock icon.
 *
 * The launch is deliberately a *background* one — `open -g -j … --args
 * --background` — so a coding agent that asks a question does not steal the
 * user's focus or open a window in front of what they are doing. WP-8 makes
 * `--background` mean "start without a window"; until then the flag is simply
 * ignored by the app, which is harmless.
 *
 * ### What WP-0a measured, and what it buys this file
 *
 * | Measured (2026-09-20) | Consequence here |
 * |---|---|
 * | Cold start `open` → app usable: 2.9 s worst, ~0.7 s warm | `LAUNCH_TIMEOUT_MS` of 20 s is a factor of seven of headroom |
 * | `--background` arrives verbatim in a packaged `process.argv` | The argument vector below is the one WP-8 parses |
 * | `open -g -j` keeps the frontmost application | Nothing here has to restore focus |
 * | `open -a` on an *already running* bundle starts nothing and cannot pass env | A second launch is harmless, so no locking is needed — but the discovery file, not `open`, is the proof that the app is up |
 * | `process.execPath` inside the bundle is `…/Contents/MacOS/Witena` | `bundlePathFor` is a suffix match on exactly that shape |
 *
 * macOS only, like the rest of the app: `open` is the only launcher that starts
 * a bundle rather than an executable, and it is what gives the app its
 * LaunchServices identity (Dock icon, `activate`, the `witena://` handler).
 */
import type { McpDiscovery } from '@shared/mcp-discovery'

/**
 * How long to wait for a launched app to publish its discovery file.
 *
 * WP-0a's worst cold start, measured on a freshly built bundle macOS had not
 * yet validated, was 2.9 s from `open` to a usable app; a warm one is ~0.7 s.
 * Twenty seconds is the generous end of that, chosen so that a first launch
 * after an update — Gatekeeper re-validating a new bundle, a cold disk — still
 * succeeds, and so that the *failure* is still fast enough for a caller to be
 * told about rather than to time out on.
 */
export const LAUNCH_TIMEOUT_MS = 20_000

/** How often to look for the discovery file while waiting. */
export const LAUNCH_POLL_MS = 250

/**
 * `process.execPath` inside an application bundle.
 *
 * WP-9's `bin/witena-mcp` resolves its own symlinks, derives
 * `<bundle>/Contents/MacOS/Witena` and `exec`s it with `ELECTRON_RUN_AS_NODE=1`,
 * so the shim's `execPath` *is* the bundle's binary — WP-0a confirmed it, from
 * both the locally signed and the notarized bundle. Anything else (plain `node`
 * in development, `node out/mcp-shim/witena-mcp.cjs` in a test) has no bundle to
 * launch, which is a different error message rather than a failure.
 */
const BUNDLE_EXEC = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/

/**
 * The `.app` bundle this shim is running from, or `null` when it is not running
 * from one.
 *
 * `null` is not an error: it is the development case, where the answer to "the
 * app is not up" is to tell the calling model so rather than to guess at a
 * bundle that may not exist.
 */
export function bundlePathFor(execPath: string): string | null {
  const match = BUNDLE_EXEC.exec(execPath)
  return match === null ? null : (match[1] as string)
}

/** Just enough of `node:child_process`'s `spawn` for one detached `open`. */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: 'ignore' }
) => { unref: () => void }

export interface LaunchOptions {
  /** The bundle to open, as `bundlePathFor` derived it. */
  bundlePath: string
  /**
   * `WITENA_USER_DATA`, when the shim was given one.
   *
   * Without it a launched app would use the default directory while the shim
   * keeps watching the overridden one, and the wait could only ever time out.
   * WP-0a used `open --env` successfully on this platform; it is passed *only*
   * when the override is set, so the ordinary launch is the plain command the
   * work package specifies.
   */
  userDataDirOverride?: string | undefined
  spawn: SpawnLike
  /** What the shim is waiting for: the discovery file, read and validated. */
  probe: () => Promise<McpDiscovery | null>
  now: () => number
  sleep: (ms: number) => Promise<void>
  log: (line: string) => void
  timeoutMs?: number | undefined
  pollMs?: number | undefined
}

/**
 * The argument vector, split out so a test can read it rather than a spy's
 * recording of it.
 *
 * `-g` keeps the frontmost application, `-j` starts the app hidden, and
 * everything after `--args` reaches `process.argv` of the new instance.
 */
export function openArgsFor(bundlePath: string, userDataDirOverride?: string): string[] {
  return [
    '-g',
    '-j',
    ...(userDataDirOverride !== undefined && userDataDirOverride.length > 0
      ? ['--env', `WITENA_USER_DATA=${userDataDirOverride}`]
      : []),
    '-a',
    bundlePath,
    '--args',
    '--background'
  ]
}

/**
 * Starts Witena in the background and waits for it to publish its endpoint.
 *
 * Returns the discovery file's contents, or `null` if the file never appeared —
 * which the caller turns into one of two sentences, because "the app did not
 * start" and "the app started with the endpoint switched off" are different
 * things for the user to do something about.
 *
 * The `open` process is detached with its output discarded: it exits as soon as
 * LaunchServices has taken the request, and the shim must not hold a pipe open
 * to a process it does not read.
 */
export async function launch(o: LaunchOptions): Promise<McpDiscovery | null> {
  const timeoutMs = o.timeoutMs ?? LAUNCH_TIMEOUT_MS
  const pollMs = o.pollMs ?? LAUNCH_POLL_MS
  const args = openArgsFor(o.bundlePath, o.userDataDirOverride)

  try {
    o.log(`launching ${o.bundlePath} in the background`)
    o.spawn('open', args, { detached: true, stdio: 'ignore' }).unref()
  } catch (cause) {
    // `open` missing, or the bundle path refused: nothing has been started, so
    // waiting for a file would only spend the caller's timeout.
    o.log(`could not run open: ${cause instanceof Error ? cause.message : String(cause)}`)
    return null
  }

  const deadline = o.now() + timeoutMs
  for (;;) {
    await o.sleep(pollMs)
    const found = await o.probe()
    if (found !== null) {
      o.log(`Witena is up on 127.0.0.1:${found.port}`)
      return found
    }
    if (o.now() >= deadline) {
      o.log(`no discovery file ${timeoutMs} ms after launching`)
      return null
    }
  }
}
