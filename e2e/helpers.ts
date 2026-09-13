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
import {
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'

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

/**
 * Opens Settings → Providers, which is the first section and therefore the one
 * Settings opens on — but only on a fresh launch. A spec that has navigated
 * elsewhere needs the explicit click, so the helper always makes both.
 */
export async function openProviderSettings(window: Page): Promise<void> {
  await window.getByTestId('nav-settings').click()
  await window.getByTestId('settings-section-providers').click()
}

/**
 * Opens Settings → MCP servers.
 *
 * Settings opens on Providers, so the section click is never optional here.
 */
export async function openMcpSettings(window: Page): Promise<void> {
  await window.getByTestId('nav-settings').click()
  await window.getByTestId('settings-section-mcp').click()
  await expect(window.getByTestId('settings-section-title')).toBeVisible()
}

/**
 * Opens the Agents page.
 *
 * Trivial today, but every S2.1 spec starts with it and the rail is exactly the
 * kind of thing a later step moves; one helper is one edit rather than three.
 */
export async function openAgents(window: Page): Promise<void> {
  await window.getByTestId('nav-agents').click()
  await expect(window.getByTestId('page-agents')).toBeVisible()
}

/**
 * Adds the local Ollama provider with the given model ids typed in by hand.
 *
 * Deliberately **not** "fetch from /models": that path is `providers.spec.ts`'s
 * subject, it needs a running Ollama, and a developer machine's fetched list can
 * contain a 40 GB model that a later probe would then try to load. Typing the ids
 * keeps the agent specs offline — they never send a prompt, they only need an
 * agent that *has* a provider and a model.
 */
export async function addOllamaProvider(window: Page, models: string[]): Promise<void> {
  await openProviderSettings(window)
  await window.getByTestId('providers-add').click()
  await window.getByTestId('preset-ollama').click()
  for (const model of models) await addProviderModel(window, model)
  await window.getByTestId('provider-save').click()
  await expect(window.getByTestId('provider-card')).toHaveCount(1)
}

/** Types one more model id into the provider editor that is currently open. */
export async function addProviderModel(window: Page, model: string): Promise<void> {
  await window.getByTestId('provider-add-model').click()
  await window.getByTestId('provider-add-model-input').fill(model)
  await window.getByTestId('provider-add-model-input').press('Enter')
  await expect(window.getByTestId('provider-model-chip').filter({ hasText: model })).toHaveCount(1)
}
