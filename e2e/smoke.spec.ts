/**
 * The S1.3 acceptance test: both directions of the transport, through the real
 * stack — Electron main, the preload bridge, the renderer's `BackendClient` and
 * SQLite.
 *
 * It runs against the built output in `out/`, which is why `npm run e2e` is
 * `npm run build && playwright test`.
 *
 * Each `data-testid` wraps a value with no label (S1.4 translated the labels), so
 * these assertions are independent of the language the machine resolves to.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createUserDataDir, launchWitena, removeUserDataDir } from './helpers'

let app: ElectronApplication
let window: Page
let userDataDir: string

test.beforeAll(async () => {
  userDataDir = createUserDataDir()
  ;({ app, window } = await launchWitena(userDataDir))
})

// Always tear the app down, including when a test above failed, so no Electron
// process survives the run.
test.afterAll(async () => {
  await app?.close()
  if (userDataDir) removeUserDataDir(userDataDir)
})

test('the renderer reaches the backend and receives its events', async () => {
  // Request/response: renderer -> preload -> ipcMain -> handler.
  await expect(window.getByTestId('ping')).toHaveText('pong')

  // Request/response that touches storage: the settings row does not exist yet in
  // the fresh userData directory, so the repository answers with the default.
  await expect(window.getByTestId('language')).toHaveText('system')

  // Push: the handler emits on the bus, main forwards it to every window, the
  // preload relays it and the client's subscription filters it.
  await expect(window.getByTestId('last-event')).toHaveText('—')
  await window.getByTestId('emit-test-event').click()
  await expect(window.getByTestId('last-event')).toContainText(/hello-\d+/)

  // Nothing failed on the way.
  await expect(window.getByTestId('error')).toHaveCount(0)
})

test('the database was created inside the overridden userData directory', async () => {
  expect(existsSync(join(userDataDir, 'witena.db'))).toBe(true)
})
