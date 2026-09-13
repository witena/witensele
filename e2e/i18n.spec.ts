/**
 * The S1.4 acceptance test: the language switch takes effect immediately and
 * survives a restart.
 *
 * Both halves need the real stack — the choice goes renderer → store →
 * `BackendClient` → IPC → SQLite, and comes back the same way on the next launch
 * — so this cannot be a unit test.
 *
 * Since S1.5 the switch lives at the bottom of the settings nav (and again, as a
 * select, inside Appearance & language), and the two read-outs live in Settings →
 * Developer, so the spec navigates there first. The rendered copy it asserts on
 * is the settings page title: it is on screen in every section, and reading the
 * expected value out of the locale files rather than repeating it keeps a wording
 * change from breaking the test — and keeps Chinese out of every committed file
 * other than `zh-CN.json` (CLAUDE.md rule #1).
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import {
  createUserDataDir,
  launchWitena,
  locale,
  openDeveloperSettings,
  removeUserDataDir
} from './helpers'

const en = locale('en')
const zhCN = locale('zh-CN')

let app: ElectronApplication | undefined
let window: Page
let userDataDir: string

test.beforeAll(async () => {
  userDataDir = createUserDataDir()
  ;({ app, window } = await launchWitena(userDataDir))
  await openDeveloperSettings(window)
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
  await expect(window.getByTestId('page-settings')).toHaveText(en.settings.title)

  await window.getByTestId('lang-zh-CN').click()
  await expect(window.getByTestId('language')).toHaveText('zh-CN')
  // `resolved-language` only flips once `settings.update` has resolved, so this
  // assertion also proves the choice reached SQLite before the app is closed.
  await expect(window.getByTestId('resolved-language')).toHaveText('zh-CN')
  await expect(window.getByTestId('page-settings')).toHaveText(zhCN.settings.title)

  await expect(window.getByTestId('error')).toHaveCount(0)
})

test('the select in Appearance & language is the same setting', async () => {
  await window.getByTestId('settings-section-appearance').click()
  const select = window.getByTestId('settings-language-select')

  // The quick toggle wrote `zh-CN` in the previous test; the select must already
  // show it rather than keeping a copy of its own.
  await expect(select).toHaveValue('zh-CN')

  await select.selectOption('en')
  await expect(window.getByTestId('settings-section-title')).toHaveText(
    en.settings.sections['appearanceLanguage'] as string
  )

  // Put it back, so the restart assertion below still has something to prove.
  await select.selectOption('zh-CN')
  await expect(window.getByTestId('settings-section-title')).toHaveText(
    zhCN.settings.sections['appearanceLanguage'] as string
  )
})

test('the chosen language survives a restart', async () => {
  await app?.close()
  ;({ app, window } = await launchWitena(userDataDir))

  // The stored language is applied before the first render, so the shell is
  // already Chinese on the page the app opens on — no navigation needed.
  await expect(window.getByTestId('page-chats')).toHaveText(zhCN.nav['chats'] as string)
  // The bootstrap sets the document language too, so screen readers, hyphenation
  // and spell-checking are right from the first frame rather than after a switch.
  await expect(window.locator('html')).toHaveAttribute('lang', 'zh-CN')

  await openDeveloperSettings(window)
  await expect(window.getByTestId('language')).toHaveText('zh-CN')
  await expect(window.getByTestId('resolved-language')).toHaveText('zh-CN')
})
