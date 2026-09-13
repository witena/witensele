/**
 * The S1.5 acceptance test: the shell navigates, and it looks like the mockup.
 *
 * Two jobs in one spec, on purpose. The assertions prove the rail really swaps
 * pages and the settings nav really swaps sections; the screenshots are what a
 * human (or a later step) compares against the three artboards, because "matches
 * the mockup in layout and colours" is not something Playwright can assert.
 *
 * The window is resized to exactly 1440×900 — the artboard size — so the shots
 * are comparable, and the UI is switched to Chinese for the same reason: the
 * mockup is drawn in Chinese, and Chinese is also the denser of the two
 * languages, so a layout that survives it survives English.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createUserDataDir, launchWitena, locale, removeUserDataDir, repoRoot } from './helpers'

/**
 * Where the screenshots land.
 *
 * Defaults to `test-results/shots` inside the repository (gitignored);
 * `WITENA_SHOTS_DIR` overrides it so a reviewer can point the run anywhere.
 */
const SHOTS_DIR = process.env['WITENA_SHOTS_DIR'] ?? join(repoRoot, 'test-results', 'shots')

/** The artboard size the mockup is drawn at. */
const WINDOW_SIZE = { width: 1440, height: 900 }

const zhCN = locale('zh-CN')

let app: ElectronApplication
let window: Page
let userDataDir: string

test.beforeAll(async () => {
  userDataDir = createUserDataDir()
  ;({ app, window } = await launchWitena(userDataDir))
  mkdirSync(SHOTS_DIR, { recursive: true })

  // `setContentSize`, not `setSize`: the window is frameless-inset on macOS and
  // the artboard measures the content, not the frame.
  await app.evaluate(({ BrowserWindow }, size) => {
    const [main] = BrowserWindow.getAllWindows()
    main?.setContentSize(size.width, size.height)
  }, WINDOW_SIZE)

  // Pin the language so the shots do not depend on the machine's OS language.
  await window.getByTestId('nav-settings').click()
  await window.getByTestId('lang-zh-CN').click()
  await expect(window.getByTestId('page-settings')).toHaveText(zhCN.settings.title)
  await window.getByTestId('nav-chats').click()
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) removeUserDataDir(userDataDir)
})

test('the rail navigates between the three pages', async () => {
  await expect(window.getByTestId('page-chats')).toBeVisible()
  await window.screenshot({ path: join(SHOTS_DIR, 'chats.png') })

  await window.getByTestId('nav-agents').click()
  await expect(window.getByTestId('page-agents')).toBeVisible()
  // One page is mounted at a time: the previous one is gone, not hidden.
  await expect(window.getByTestId('page-chats')).toHaveCount(0)
  // `shell-agents.png`, not `agents.png`: the latter is the S2.1 acceptance shot
  // of the configuration editor, taken by `agents.spec.ts`, and this file runs
  // after it. Two specs writing one path means the last one wins.
  await window.screenshot({ path: join(SHOTS_DIR, 'shell-agents.png') })

  await window.getByTestId('nav-settings').click()
  await expect(window.getByTestId('page-settings')).toBeVisible()
  await expect(window.getByTestId('page-agents')).toHaveCount(0)
  await window.screenshot({ path: join(SHOTS_DIR, 'settings.png') })

  await window.getByTestId('nav-chats').click()
  await expect(window.getByTestId('page-chats')).toBeVisible()
})

test('the settings nav switches sections', async () => {
  await window.getByTestId('nav-settings').click()
  const title = window.getByTestId('settings-section-title')

  // Settings opens on the first section.
  await expect(title).toHaveText(zhCN.settings.sections['providers'] as string)

  await window.getByTestId('settings-section-mcp').click()
  await expect(title).toHaveText(zhCN.settings.sections['mcp'] as string)

  // Appearance & language is one of the two sections with real content.
  await window.getByTestId('settings-section-appearance').click()
  await expect(title).toHaveText(zhCN.settings.sections['appearanceLanguage'] as string)
  await expect(window.getByTestId('settings-language-select')).toBeVisible()

  // The other one is Developer, which still answers from the real backend.
  await window.getByTestId('settings-section-developer').click()
  await expect(title).toHaveText(zhCN.settings.sections['developer'] as string)
  await expect(window.getByTestId('ping')).toHaveText('pong')
})

test('the selected settings section survives leaving the page', async () => {
  await window.getByTestId('nav-chats').click()
  await expect(window.getByTestId('page-chats')).toBeVisible()

  await window.getByTestId('nav-settings').click()
  await expect(window.getByTestId('settings-section-title')).toHaveText(
    zhCN.settings.sections['developer'] as string
  )
})
