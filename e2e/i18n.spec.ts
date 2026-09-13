/**
 * The S1.4 acceptance test: the language switch takes effect immediately and
 * survives a restart.
 *
 * Both halves need the real stack — the choice goes renderer → store →
 * `BackendClient` → IPC → SQLite, and comes back the same way on the next launch
 * — so this cannot be a unit test.
 *
 * The expected copy is read out of the locale files rather than repeated here:
 * the assertion then tracks a wording change, and no Chinese ends up in a
 * committed file other than `zh-CN.json` (CLAUDE.md rule #1).
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createUserDataDir, launchWitena, locale, removeUserDataDir } from './helpers'

const en = locale('en')
const zhCN = locale('zh-CN')

let app: ElectronApplication | undefined
let window: Page
let userDataDir: string

test.beforeAll(async () => {
  userDataDir = createUserDataDir()
  ;({ app, window } = await launchWitena(userDataDir))
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) removeUserDataDir(userDataDir)
})

test('switching the language re-renders the UI immediately', async () => {
  // First launch: the setting is `system`, and the active language is whatever
  // this machine resolves to. Which of the two it is depends on the developer's
  // OS, so only the resolution itself is asserted.
  await expect(window.getByTestId('language')).toHaveText('system')
  await expect(window.getByTestId('resolved-language')).toHaveText(/^(en|zh-CN)$/)

  await window.getByTestId('lang-en').click()
  await expect(window.getByTestId('language')).toHaveText('en')
  await expect(window.getByTestId('resolved-language')).toHaveText('en')
  await expect(window.getByTestId('smoke-title')).toHaveText(en.smoke['title'] as string)

  await window.getByTestId('lang-zh-CN').click()
  await expect(window.getByTestId('language')).toHaveText('zh-CN')
  // `resolved-language` only flips once `settings.update` has resolved, so this
  // assertion also proves the choice reached SQLite before the app is closed.
  await expect(window.getByTestId('resolved-language')).toHaveText('zh-CN')
  await expect(window.getByTestId('smoke-title')).toHaveText(zhCN.smoke['title'] as string)

  await expect(window.getByTestId('error')).toHaveCount(0)
})

test('the chosen language survives a restart', async () => {
  await app?.close()
  ;({ app, window } = await launchWitena(userDataDir))

  await expect(window.getByTestId('language')).toHaveText('zh-CN')
  await expect(window.getByTestId('resolved-language')).toHaveText('zh-CN')
  await expect(window.getByTestId('smoke-title')).toHaveText(zhCN.smoke['title'] as string)
  // The bootstrap applies the stored language before the first render, so the
  // document language is right from the first frame rather than after a switch.
  await expect(window.locator('html')).toHaveAttribute('lang', 'zh-CN')
})
