/**
 * The S1.3 acceptance test: both directions of the transport, through the real
 * stack — Electron main, the preload bridge, the renderer's `BackendClient` and
 * SQLite.
 *
 * It runs against the built output in `out/`, which is why `npm run e2e` is
 * `npm run build && playwright test`.
 *
 * `WITENA_USER_DATA` points the app at a fresh temporary directory, so the test
 * can never read, write or delete the developer's real `witena.db`.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = join(repoRoot, 'out', 'main', 'index.js')

let app: ElectronApplication
let window: Page
let userDataDir: string

test.beforeAll(async () => {
  if (!existsSync(mainEntry)) {
    throw new Error(`${mainEntry} is missing. Run "npm run build" first, or use "npm run e2e".`)
  }

  userDataDir = mkdtempSync(join(tmpdir(), 'witena-e2e-'))
  app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: { ...process.env, WITENA_USER_DATA: userDataDir }
  })
  window = await app.firstWindow()
})

// Always tear the app down, including when a test above failed, so no Electron
// process survives the run.
test.afterAll(async () => {
  await app?.close()
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
})

test('the renderer reaches the backend and receives its events', async () => {
  // Request/response: renderer -> preload -> ipcMain -> handler.
  await expect(window.getByTestId('ping')).toHaveText('backend: pong')

  // Request/response that touches storage: the settings row does not exist yet in
  // the fresh userData directory, so the repository answers with the default.
  await expect(window.getByTestId('language')).toHaveText('language: system')

  // Push: the handler emits on the bus, main forwards it to every window, the
  // preload relays it and the client's subscribeTo filters it.
  await expect(window.getByTestId('last-event')).toHaveText('last event: —')
  await window.getByTestId('emit-test-event').click()
  await expect(window.getByTestId('last-event')).toContainText(/last event: hello-\d+/)

  // Nothing failed on the way.
  await expect(window.getByTestId('error')).toHaveCount(0)
})

test('the database was created inside the overridden userData directory', async () => {
  expect(existsSync(join(userDataDir, 'witena.db'))).toBe(true)
})
