/**
 * The S4.4 acceptance test: the **packaged** application, launched from the
 * binary inside `Witena.app`, not from `out/`.
 *
 * ## Why this file is not part of `npm run e2e`
 *
 * Every other spec runs the dev build in `out/`, which any checkout can produce
 * in seconds. This one needs a dmg that `npm run dist` has already built,
 * mounted and copied somewhere writable, which is a twelve-minute step nobody
 * wants in front of the everyday command. So `playwright.config.ts` ignores the
 * file and `npm run e2e:packaged` runs it through
 * `playwright.packaged.config.ts` instead.
 *
 * ## How to run it
 *
 * ```sh
 * npm run dist
 * hdiutil attach dist/Witena-<version>-arm64.dmg -mountpoint /tmp/witena-dmg
 * cp -R /tmp/witena-dmg/Witena.app /tmp/witena-app/
 * hdiutil detach /tmp/witena-dmg
 * WITENA_APP_PATH=/tmp/witena-app/Witena.app npm run e2e:packaged
 * ```
 *
 * The copy off the mounted image matters: a dmg is mounted read-only, and the
 * first launch of a macOS app writes into its own bundle.
 *
 * ## What only this file can prove
 *
 * Three things that are true of the repository checkout whether or not the
 * packaging config is right, and therefore have to be re-asserted against the
 * shipped bundle:
 *
 * | Assertion | What would break it |
 * |---|---|
 * | The shell renders | `files` missing the renderer, or the asar not being found |
 * | The shipped skill is listed under Settings → Skills | `extraResources` missing, or `bundledSkillsDir()` resolving to the wrong path under `app.isPackaged` |
 * | One real model reply completes | `better-sqlite3` still inside the asar (`dlopen` cannot read one), or the migrations not reaching the bundle |
 *
 * The reply is the strongest of the three: it writes messages, so the database
 * had to open, the migrations had to run and the native module had to load.
 *
 * Every assertion is on a `data-testid` or a `data-*` value, never on rendered
 * copy, so none of them depends on the active language — and no Chinese appears
 * in this file (CLAUDE.md rule #1).
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import {
  addOllamaProvider,
  createChat,
  createUserDataDir,
  removeUserDataDir,
  repoRoot
} from './helpers'

/** Serial: one app, and each test continues where the last one left off. */
test.describe.configure({ mode: 'serial' })

const SHOTS_DIR = process.env['WITENA_SHOTS_DIR'] ?? join(repoRoot, 'test-results', 'shots')

/** Path of the copied `Witena.app`; see the header for how to produce it. */
const APP_PATH_ENV = 'WITENA_APP_PATH'

/** Environment variable `src/main/index.ts` reads to relocate `userData`. */
const USER_DATA_ENV = 'WITENA_USER_DATA'

/** The skill shipped in `resources/skills/`, seeded into an empty library. */
const SKILL_NAME = 'architecture-review'

const OLLAMA_BASE_URL = 'http://localhost:11434/v1'
const OLLAMA_MODELS_URL = `${OLLAMA_BASE_URL}/models`

/** The smallest model on a machine that has pulled anything at all. */
const REPLY_MODEL = 'qwen2.5:1.5b'

/** A warm 1.5B model still has to produce a whole sentence. */
const REPLY_MS = 120_000

let app: ElectronApplication | undefined
let window: Page
let userDataDir = ''
let appPath = ''
let modelAvailable = false

/** The executable inside the bundle, which is what Playwright has to launch. */
function executableInside(bundle: string): string {
  return join(bundle, 'Contents', 'MacOS', 'Witena')
}

async function probeOllamaModel(model: string): Promise<boolean> {
  try {
    const response = await fetch(OLLAMA_MODELS_URL, { signal: AbortSignal.timeout(2_000) })
    if (!response.ok) return false
    const body = (await response.json()) as { data?: { id?: string }[] }
    return (body.data ?? []).some((entry) => entry.id === model)
  } catch {
    return false
  }
}

/** Loads the weights, so the in-app request starts streaming within the budget. */
async function warmUpOllama(): Promise<void> {
  try {
    await fetch(`${OLLAMA_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: REPLY_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1
      }),
      signal: AbortSignal.timeout(120_000)
    })
  } catch {
    // A failed warm-up only costs speed; the assertions below still decide.
  }
}

const agentMessages = (): ReturnType<Page['locator']> =>
  window.locator('[data-testid="message-item"][data-sender="agent"]')

test.beforeAll(async () => {
  appPath = process.env[APP_PATH_ENV] ?? ''
  if (!appPath) return
  if (!existsSync(executableInside(appPath))) {
    throw new Error(`${APP_PATH_ENV}=${appPath} has no Contents/MacOS/Witena inside it.`)
  }

  modelAvailable = await probeOllamaModel(REPLY_MODEL)
  if (modelAvailable) await warmUpOllama()

  userDataDir = createUserDataDir()
  mkdirSync(SHOTS_DIR, { recursive: true })
  // No `args`: the bundle *is* the app, so there is nothing to point it at. The
  // userData override is the same one every other spec uses, so the packaged
  // build can never touch the developer's real database either.
  app = await electron.launch({
    executablePath: executableInside(appPath),
    args: [],
    env: { ...process.env, [USER_DATA_ENV]: userDataDir }
  })
  window = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) removeUserDataDir(userDataDir)
})

test('the packaged app launches and renders the shell', async () => {
  test.skip(!appPath, `${APP_PATH_ENV} is not set; see the header of this file.`)

  // The renderer loaded from inside the asar: the rail and the first page are up.
  await expect(window.getByTestId('nav-chats')).toBeVisible()
  await expect(window.getByTestId('nav-agents')).toBeVisible()
  await expect(window.getByTestId('nav-settings')).toBeVisible()
  await expect(window.getByTestId('page-chats')).toBeVisible()
})

test('the shipped skill was seeded from extraResources', async () => {
  test.skip(!appPath, `${APP_PATH_ENV} is not set`)

  await window.getByTestId('nav-settings').click()
  await window.getByTestId('settings-section-skills').click()

  // Nothing in this spec wrote a skill: the only way this folder can exist in a
  // fresh temporary userData is `extraResources` having shipped it and
  // `bundledSkillsDir()` having found it under `process.resourcesPath`.
  const card = window.locator(`[data-testid="skill-card"][data-folder="${SKILL_NAME}"]`)
  await expect(card).toHaveCount(1)
  await expect(card.getByTestId('skill-card-description')).not.toBeEmpty()
})

test('one real model reply completes inside the packaged build', async () => {
  test.skip(!appPath, `${APP_PATH_ENV} is not set`)
  test.skip(
    !modelAvailable,
    `${OLLAMA_MODELS_URL} did not offer ${REPLY_MODEL}; the reply proves the database and the native module, and needs a real model.`
  )

  await addOllamaProvider(window, [REPLY_MODEL])

  await window.getByTestId('nav-agents').click()
  await window.getByTestId('agents-new').click()
  await window.getByTestId('agent-name').fill('Reviewer')
  await window.getByTestId('agent-provider').selectOption({ index: 1 })
  await window.getByTestId('agent-model').selectOption(REPLY_MODEL)
  await window.getByTestId('agent-save').click()
  await expect(window.getByTestId('agent-item')).toHaveCount(1)

  await window.getByTestId('nav-chats').click()
  await createChat(window)
  // A new chat starts empty once the agents table is no longer empty
  // (`chats.create` only falls back to a default member on a virgin database),
  // so the member is added explicitly rather than assumed.
  await expect(window.getByTestId('composer-input')).toBeEnabled()
  if ((await window.getByTestId('member-row').count()) === 0) {
    await window.getByTestId('member-add').click()
    await window.getByTestId('member-candidate').first().click()
  }
  await expect(window.getByTestId('member-row')).toHaveCount(1)

  await window.getByTestId('composer-input').fill('In one short sentence, what is a mutex?')
  await window.getByTestId('composer-input').press('Enter')

  // `done` means the whole cycle ran inside the bundle: the row was inserted
  // (so `better-sqlite3` loaded out of the unpacked asar and the migrations had
  // created the table), the model streamed, and the finished parts were written
  // back.
  await expect(agentMessages()).toHaveCount(1, { timeout: REPLY_MS })
  await expect(agentMessages().first()).toHaveAttribute('data-status', 'done', {
    timeout: REPLY_MS
  })
  // `done` with an empty body would be a broken stream that still persisted, so
  // the text is asserted too: a real answer came back through the real provider.
  await expect(agentMessages().first().getByTestId('message-text')).not.toBeEmpty()
  await expect(window.getByTestId('composer-send')).toBeVisible({ timeout: REPLY_MS })

  await window.screenshot({ path: join(SHOTS_DIR, 'packaged.png') })
})
