/**
 * Shared plumbing for the Playwright Electron specs.
 *
 * Every spec launches the built app in `out/` against a **fresh temporary
 * `userData` directory**, so a test run can never read, write or delete the
 * developer's real `witena.db`, and so a spec that asserts first-launch behaviour
 * gets a genuinely empty database.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The built main entry `npm run build` produces; `npm run e2e` builds first. */
export const mainEntry = join(repoRoot, 'out', 'main', 'index.js')

/** Environment variable `src/main/index.ts` reads to relocate `userData`. */
const USER_DATA_ENV = 'WITENA_USER_DATA'

/** A fresh temporary `userData` directory. Remove it with `removeUserDataDir`. */
export function createUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'witena-e2e-'))
}

export function removeUserDataDir(directory: string): void {
  rmSync(directory, { recursive: true, force: true })
}

/**
 * Launches the built app against `userDataDir` and waits for its first window.
 *
 * Passing the same directory twice is how a spec restarts the app and asserts
 * that something was persisted.
 */
export async function launchWitena(
  userDataDir: string
): Promise<{ app: ElectronApplication; window: Page }> {
  if (!existsSync(mainEntry)) {
    throw new Error(`${mainEntry} is missing. Run "npm run build" first, or use "npm run e2e".`)
  }

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: { ...process.env, [USER_DATA_ENV]: userDataDir }
  })

  return { app, window: await app.firstWindow() }
}

/** The part of a locale file the specs assert against. */
export interface LocaleFile {
  nav: Record<string, string>
  chat: Record<string, string>
  agents: Record<string, string>
  settings: {
    title: string
    sections: Record<string, string>
  }
}

/**
 * Reads a locale file from source.
 *
 * The specs compare rendered text against these values instead of repeating the
 * copy, which keeps a translation change from breaking the tests — and keeps
 * Chinese out of every committed file except `zh-CN.json` (CLAUDE.md rule #1).
 */
export function locale(language: 'en' | 'zh-CN'): LocaleFile {
  const path = join(repoRoot, 'src', 'renderer', 'src', 'locales', `${language}.json`)
  return JSON.parse(readFileSync(path, 'utf8')) as LocaleFile
}

/**
 * Opens Settings → Developer, where the transport smoke widgets live.
 *
 * S1.5 replaced the standalone smoke screen with the real shell, so `ping`,
 * `last-event` and the two language read-outs are no longer on the first screen:
 * every spec that asserts on them has to navigate there first. Keeping that walk
 * in one helper means a later change to the settings nav breaks one function
 * rather than three specs.
 */
export async function openDeveloperSettings(window: Page): Promise<void> {
  await window.getByTestId('nav-settings').click()
  await window.getByTestId('settings-section-developer').click()
}
