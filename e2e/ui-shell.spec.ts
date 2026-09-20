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

  // Timeouts & heartbeat: the three budgets in seconds and the colour legend.
  await window.getByTestId('settings-section-timeouts').click()
  await expect(title).toHaveText(zhCN.settings.sections['timeouts'] as string)
  await expect(window.getByTestId('settings-stall-timeout')).toHaveValue('30')
  await expect(window.getByTestId('settings-hard-timeout')).toHaveValue('120')
  await expect(window.getByTestId('settings-tool-timeout')).toHaveValue('60')
  await expect(window.getByTestId('presence-legend-dot')).toHaveCount(4)

  // Editing one field writes only that one; the other two keep their values.
  await window.getByTestId('settings-stall-timeout').fill('45')
  await window.getByTestId('settings-stall-timeout').press('Enter')
  await window.getByTestId('settings-section-appearance').click()
  await window.getByTestId('settings-section-timeouts').click()
  await expect(window.getByTestId('settings-stall-timeout')).toHaveValue('45')
  await expect(window.getByTestId('settings-hard-timeout')).toHaveValue('120')

  // The other section with real content is Developer, which still answers from
  // the real backend.
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

/**
 * Just enough of the DOM to type the one `locator.evaluate` callback below, the
 * same shim and for the same reason as `theme.spec.ts`: the callback is
 * serialised and runs **inside the renderer**, while `tsconfig.node.json` — which
 * owns `e2e/` — has no `DOM` lib, because everything else here is Node code
 * driving Electron from the outside. Adding `DOM` to that project to type two
 * lines would let every spec reach for a browser global that is not there.
 */
declare function getComputedStyle(element: object): { color: string; fill: string }

/**
 * The brand mark on the rail, in both palettes (S7.1).
 *
 * The assertion is that the mark is *there* and that its blades take their
 * colour from the palette in force — the mark carries no tile of its own, so a
 * missing `currentColor` would render it invisible against the rail rather than
 * wrong, which is the failure a screenshot alone would not name. The two crops
 * are the part a human looks at: an inlined SVG can be present, correctly
 * coloured and still mush, and only an eye can say so.
 */
test('the rail shows the brand mark in both themes', async () => {
  const rail = window.getByRole('navigation').first()
  const mark = window.getByTestId('brand-mark')

  await window.getByTestId('nav-settings').click()
  await window.getByTestId('settings-section-appearance').click()

  await window.getByTestId('theme-dark').click()
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(mark).toBeVisible()
  // 28 CSS pixels square: a whole-pixel box and a square viewBox, so the blades
  // are never scaled non-uniformly or landed on a half pixel.
  expect(await mark.boundingBox()).toMatchObject({ width: 28, height: 28 })
  await rail.screenshot({ path: join(SHOTS_DIR, 'rail-dark.png') })

  await window.getByTestId('theme-light').click()
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(mark).toBeVisible()
  await rail.screenshot({ path: join(SHOTS_DIR, 'rail-light.png') })

  // The mark inherits the rail's foreground, so it is a different ink in each
  // theme without a second asset — and the point is the same terracotta in both.
  const colours = await mark.evaluate((node) => {
    const style = getComputedStyle(node)
    const circle = node.querySelector('circle')
    return {
      blades: style.color,
      point: circle ? getComputedStyle(circle).fill : null
    }
  })
  expect(colours.point).toBe('rgb(217, 119, 87)')
  expect(colours.blades).not.toBe('rgb(217, 119, 87)')

  await window.getByTestId('theme-dark').click()
})

/**
 * The first modal primitive (S9.3).
 *
 * Here rather than in `committees.spec.ts` because what is being checked is the
 * `Dialog` itself — `role`, `aria-modal`, where focus lands, and the two ways
 * out that are not a button — and this is the spec that owns the shell. What
 * the New chat dialog *does* is `committees.spec.ts`'s subject.
 *
 * The two screenshots are review material in the habit of this file: every
 * colour in the panel is a token, so "it works in both themes" is a thing a
 * human confirms from the shots rather than something Playwright can assert.
 */
test('the New chat dialog is modal, and closes without a button', async () => {
  await window.getByTestId('nav-chats').click()
  await window.getByTestId('chats-new').click()

  const dialog = window.getByTestId('new-chat-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('role', 'dialog')
  await expect(dialog).toHaveAttribute('aria-modal', 'true')

  // Focus is inside the panel, so a keyboard user does not start their first
  // Tab at the top of a window the dialog is covering.
  // `ownerDocument`, not the `document` global: `tsconfig.node.json` compiles
  // `e2e/` without the DOM library, and only the page's own types come along.
  expect(
    await dialog.evaluate((panel) => panel.contains(panel.ownerDocument.activeElement))
  ).toBe(true)
  await window.screenshot({ path: join(SHOTS_DIR, 'new-chat-dialog-dark.png') })

  await window.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  await window.getByTestId('chats-new').click()
  await expect(dialog).toBeVisible()
  // The scrim, not the panel: a press that *starts* outside dismisses.
  await window.getByTestId('new-chat-dialog-backdrop').click({ position: { x: 6, y: 6 } })
  await expect(dialog).toHaveCount(0)

  await window.getByTestId('nav-settings').click()
  await window.getByTestId('settings-section-appearance').click()
  await window.getByTestId('theme-light').click()
  await window.getByTestId('nav-chats').click()
  await window.getByTestId('chats-new').click()
  await expect(dialog).toBeVisible()
  await window.screenshot({ path: join(SHOTS_DIR, 'new-chat-dialog-light.png') })

  await window.getByTestId('new-chat-cancel').click()
  await expect(dialog).toHaveCount(0)
  await window.getByTestId('nav-settings').click()
  await window.getByTestId('theme-dark').click()
})
