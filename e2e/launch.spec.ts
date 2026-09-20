/**
 * How the app comes up when something other than a person starts it (S10.3).
 *
 * Three facts, each of which has no unit test because each of them is Electron's
 * behaviour rather than ours:
 *
 * 1. `--background` produces a **running app with no window**. This is the MCP
 *    shim's launch: a coding agent calls a Witena tool, Witena is not running,
 *    and it must come up without taking over the screen.
 * 2. The Dock still opens it. `activate` is the existing handler; the point of
 *    the assertion is that `--background` did not break the only way back in.
 * 3. The single-instance lock is keyed by `userData`, so two apps with different
 *    `WITENA_USER_DATA` values coexist. WP-0a measured this against the packaged
 *    bundle; it is pinned here because every Playwright spec in this repository
 *    depends on it — the lock landing in S10.3 must never turn a temporary
 *    directory into a shared singleton.
 *
 * Deliberately not asserted here: that a *second* instance on the **same**
 * directory quits. It does (WP-0a measured `requestSingleInstanceLock()` →
 * `false`, and the process then parks until `app.quit()` ends it), but the
 * losing process never reaches `ready`, so driving it through Playwright would
 * be a race against a teardown rather than a test.
 *
 * `launchWitena` is not used: it waits for a first window, which is exactly what
 * the first test says must not exist. Everything else comes from `helpers.ts`,
 * including the temporary `userData` directories — no spec here may ever touch
 * the developer's real database, and no app started here may outlive the file.
 */
import { existsSync } from 'node:fs'
import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createUserDataDir, mainEntry, removeUserDataDir, repoRoot } from './helpers'

/** Environment variable `src/main/index.ts` reads to relocate `userData`. */
const USER_DATA_ENV = 'WITENA_USER_DATA'

/** A chat id that is certainly not in a freshly created database. */
const UNKNOWN_CHAT = 'witena://chat/2f4a6c88-1b3d-4e5f-9a0b-7c8d9e0f1a2b'

/** Everything this file started, torn down in `afterEach` whatever happened. */
const running: ElectronApplication[] = []
const userDataDirs: string[] = []

async function launch(args: string[] = []): Promise<ElectronApplication> {
  if (!existsSync(mainEntry)) {
    throw new Error(`${mainEntry} is missing. Run "npm run build" first, or use "npm run e2e".`)
  }

  const userDataDir = createUserDataDir()
  userDataDirs.push(userDataDir)

  const app = await electron.launch({
    args: ['.', ...args],
    cwd: repoRoot,
    env: { ...process.env, [USER_DATA_ENV]: userDataDir }
  })
  running.push(app)

  // `electron.launch` resolves as soon as the process is drivable, which is
  // before `whenReady` has run. Everything below asks about decisions the ready
  // handler makes, so wait for it rather than for a window that may not come.
  await app.evaluate(async ({ app: electronApp }) => {
    await electronApp.whenReady()
  })

  return app
}

test.afterEach(async () => {
  // Close every app this test started, including on failure: a Witena left
  // running would hold a temporary directory open and, worse, outlive the run.
  for (const app of running.splice(0)) await app.close().catch(() => undefined)
  for (const directory of userDataDirs.splice(0)) removeUserDataDir(directory)
})

test('--background starts the app with no window, and the Dock still opens one', async () => {
  const app = await launch(['--background'])

  // The ready handler has run and deliberately created nothing.
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0)
  expect(app.windows()).toHaveLength(0)

  // What clicking the Dock icon does. The handler is the one that was already
  // there for "the user closed the window on macOS"; `--background` simply
  // arrives at the same state by a different route.
  await app.evaluate(({ app: electronApp }) => {
    electronApp.emit('activate')
  })

  const window = await app.firstWindow()
  await expect(window.getByTestId('nav-chats')).toBeVisible()
})

test('a chat link opens a window on a background instance and selects nothing unknown', async () => {
  const app = await launch(['--background'])
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0)

  // What macOS does when a user clicks a `witena://` link while the app is
  // running: `open-url`, not a new process. The event object is the platform's;
  // only `preventDefault` is read.
  await app.evaluate(({ app: electronApp }, url) => {
    electronApp.emit('open-url', { preventDefault: () => undefined }, url)
  }, UNKNOWN_CHAT)

  // A link is a request to see the app, so the window comes up even though this
  // particular chat does not exist in a database that was created seconds ago.
  const window = await app.firstWindow()
  await expect(window.getByTestId('nav-chats')).toBeVisible()

  // And the unknown id left no error behind — an unrecognised link is not the
  // user's mistake to be told about. That it also selects nothing is asserted
  // where it can be asserted in any language:
  // `src/renderer/src/stores/chats.test.ts`, "ui.open-chat".
  await expect(window.getByTestId('chats-error')).toHaveCount(0)
})

test('two instances with different userData directories both run', async () => {
  const first = await launch()
  const second = await launch()

  const firstWindow = await first.firstWindow()
  const secondWindow = await second.firstWindow()

  await expect(firstWindow.getByTestId('nav-chats')).toBeVisible()
  await expect(secondWindow.getByTestId('nav-chats')).toBeVisible()

  // Both processes really are alive: a losing instance would have quit rather
  // than answered.
  for (const app of [first, second]) {
    expect(await app.evaluate(({ app: electronApp }) => electronApp.isReady())).toBe(true)
  }
})
