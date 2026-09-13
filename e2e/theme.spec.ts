/**
 * The S5.8 acceptance test: the three-way control, and a readable light app.
 *
 * Two things only an end-to-end run can show. The first is that `data-theme`
 * really repaints: the unit tests prove the attribute is stamped and that the CSS
 * defines an override for every token, but only a real browser resolves the
 * cascade and can be asked what `body` is actually painted. The second is the
 * "follow the system" branch — `page.emulateMedia` is the only way to flip
 * `prefers-color-scheme` at will, and a `matchMedia` listener is exactly the kind
 * of code that works in a fake and not in Chromium.
 *
 * The screenshots are the part a human has to look at, as in `ui-shell.spec.ts`:
 * "every screen is readable in light mode" is not something Playwright asserts.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import {
  addOllamaProvider,
  createUserDataDir,
  launchWitena,
  openAgents,
  removeUserDataDir,
  repoRoot
} from './helpers'

/** Same default as `ui-shell.spec.ts`, and the same override for a reviewer. */
const SHOTS_DIR = process.env['WITENA_SHOTS_DIR'] ?? join(repoRoot, 'test-results', 'shots')

/** The artboard size, so the light shots are comparable with the dark ones. */
const WINDOW_SIZE = { width: 1440, height: 900 }

let app: ElectronApplication
let window: Page
let userDataDir: string

/**
 * Just enough of the DOM to type the two `page.evaluate` callbacks below.
 *
 * Those callbacks are serialised and run **inside the renderer**, where both
 * globals obviously exist — but `tsconfig.node.json`, which owns `e2e/`, has no
 * `DOM` lib, because everything else in this directory is Node code driving
 * Electron from the outside. Adding `DOM` to that project to type two lines
 * would let every spec reach for a browser global that is not there.
 */
declare const document: {
  documentElement: { getAttribute(name: string): string | null }
  body: object
}
declare function getComputedStyle(element: object): { backgroundColor: string }

/** The `data-theme` attribute the light palette in `index.css` keys off. */
function theme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute('data-theme'))
}

/**
 * `body`'s painted background, as three numbers.
 *
 * Asserting the exact token value would be a change-detector; what matters is
 * light versus dark, so the test sums the channels. `bg-base` is `#171614`
 * (sum 69) in dark and `#f7f4ef` (sum 738) in light — the gap is not close.
 */
async function backgroundBrightness(page: Page): Promise<number> {
  const color = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const channels = color.match(/\d+/g) ?? []
  return channels.slice(0, 3).reduce((sum: number, value: string) => sum + Number(value), 0)
}

async function openAppearanceSettings(page: Page): Promise<void> {
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-section-appearance').click()
  await expect(page.getByTestId('theme-system')).toBeVisible()
}

test.beforeAll(async () => {
  userDataDir = createUserDataDir()
  ;({ app, window } = await launchWitena(userDataDir))
  mkdirSync(SHOTS_DIR, { recursive: true })

  await app.evaluate(({ BrowserWindow }, size) => {
    const [main] = BrowserWindow.getAllWindows()
    main?.setContentSize(size.width, size.height)
  }, WINDOW_SIZE)

  // English, so the shots read for any reviewer and the spec never depends on
  // the machine's OS language.
  await window.getByTestId('nav-settings').click()
  await window.getByTestId('lang-en').click()
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) removeUserDataDir(userDataDir)
})

test('the three-segment control switches the theme', async () => {
  await openAppearanceSettings(window)

  await window.getByTestId('theme-light').click()
  await expect.poll(() => theme(window)).toBe('light')
  expect(await backgroundBrightness(window)).toBeGreaterThan(600)

  await window.getByTestId('theme-dark').click()
  await expect.poll(() => theme(window)).toBe('dark')
  expect(await backgroundBrightness(window)).toBeLessThan(200)

  // The stored setting is what the control highlights, so the segment the user
  // picked stays pressed rather than the theme it resolved to.
  await expect(window.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true')
  await expect(window.getByTestId('theme-light')).toHaveAttribute('aria-pressed', 'false')
})

test('"system" follows prefers-color-scheme, and keeps following it', async () => {
  await openAppearanceSettings(window)

  await window.emulateMedia({ colorScheme: 'dark' })
  await window.getByTestId('theme-system').click()
  await expect.poll(() => theme(window)).toBe('dark')

  // No reload: the `matchMedia` listener has to do this on its own.
  await window.emulateMedia({ colorScheme: 'light' })
  await expect.poll(() => theme(window)).toBe('light')

  await window.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => theme(window)).toBe('dark')

  // An explicit choice must stop following the machine.
  await window.getByTestId('theme-light').click()
  await expect.poll(() => theme(window)).toBe('light')
  await window.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => theme(window)).toBe('light')
})

test('light mode is readable on the chat and settings pages', async () => {
  await openAppearanceSettings(window)
  await window.getByTestId('theme-light').click()
  await expect.poll(() => theme(window)).toBe('light')
  await window.screenshot({ path: join(SHOTS_DIR, 'light-settings.png') })

  await window.getByTestId('nav-chats').click()
  await expect(window.getByTestId('page-chats')).toBeVisible()
  await window.screenshot({ path: join(SHOTS_DIR, 'light-chats.png') })

  await window.getByTestId('nav-agents').click()
  await expect(window.getByTestId('page-agents')).toBeVisible()
  await window.screenshot({ path: join(SHOTS_DIR, 'light-agents.png') })
})

test('light mode is readable on the screens that have content in them', async () => {
  // Empty states are the easy case: they are two lines of `fg-muted` on a panel.
  // The screens worth looking at are the ones with cards, badges, status pills,
  // form controls and a `<select>` — every token that is not a background. No
  // model is involved: the ids are typed in, as `addOllamaProvider` explains.
  await addOllamaProvider(window, ['qwen2.5:3b'])
  await window.screenshot({ path: join(SHOTS_DIR, 'light-providers.png') })

  await openAgents(window)
  await window.getByTestId('agents-new').click()
  await expect(window.getByTestId('agent-name')).toBeVisible()
  await window.screenshot({ path: join(SHOTS_DIR, 'light-agent-editor.png') })
})

test('the choice survives a restart, first frame included', async () => {
  // Left on `light` by the previous test and written through `settings.update`.
  await app.close()
  ;({ app, window } = await launchWitena(userDataDir))

  await expect.poll(() => theme(window)).toBe('light')
  expect(await backgroundBrightness(window)).toBeGreaterThan(600)

  // The window itself — the frame painted before the renderer exists — was
  // created in the stored theme rather than in the hard-coded dark it used to be.
  const background = await app.evaluate(({ BrowserWindow }) => {
    const [main] = BrowserWindow.getAllWindows()
    return main?.getBackgroundColor()
  })
  expect(background?.toLowerCase()).toBe('#f7f4ef')

  await app.evaluate(({ BrowserWindow }, size) => {
    const [main] = BrowserWindow.getAllWindows()
    main?.setContentSize(size.width, size.height)
  }, WINDOW_SIZE)
})
