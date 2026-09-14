/**
 * The S7.5 acceptance test: an empty `userData` reaches a streamed reply
 * **through the first-run card alone**.
 *
 * Nothing here touches Settings. The point of the step is that a new user never
 * has to find the provider screen, so a spec that navigated there would prove
 * the opposite of what it is for: every click below is on the card in the
 * middle column of the chat page.
 *
 * Like `chat.spec.ts`, the whole file is **skipped when
 * `http://localhost:11434/v1/models` does not answer** — an acceptance sentence
 * ending in "a streamed reply" cannot be faked — and the skip is explicit in
 * the report rather than a silent pass. The model is typed in as
 * `qwen2.5:1.5b` rather than fetched, for the reason `providers.spec.ts`
 * records: a developer machine commonly also holds a 40 GB model, and a run
 * that picked it would spend minutes loading weights before failing a timeout.
 *
 * The last test is the other half of S7.5 and needs no model: Settings → About
 * shows the version, the repository and the generated licence list.
 *
 * Every assertion is on a `data-testid` or a `data-*` value rather than on
 * rendered copy, so none of them depends on the active language — and no
 * Chinese appears in this file (CLAUDE.md rule #1).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createUserDataDir, launchWitena, removeUserDataDir, repoRoot } from './helpers'

/**
 * Serial, because the tests walk one installation from empty to a finished
 * exchange: each step is the previous one's result. Serial mode also makes a
 * failure readable — the rest are skipped rather than re-run against a fresh
 * `userData`, which would relaunch on an empty database and bury the real
 * failure.
 */
test.describe.configure({ mode: 'serial' })

/** Ollama's OpenAI-compatible endpoint, the same URL the `ollama` preset stores. */
const OLLAMA_MODELS_URL = 'http://localhost:11434/v1/models'

/** Small, fast, and present on any machine that has pulled anything at all. */
const MODEL_ID = 'qwen2.5:1.5b'

/** A cold Ollama has to load the weights before the first token appears. */
const COLD_START_MS = 90_000

let app: ElectronApplication | undefined
let window: Page
let userDataDir: string
let ollamaUp = false

async function probeOllama(): Promise<boolean> {
  try {
    const response = await fetch(OLLAMA_MODELS_URL, { signal: AbortSignal.timeout(2_000) })
    return response.ok
  } catch {
    return false
  }
}

test.beforeAll(async () => {
  ollamaUp = await probeOllama()
  userDataDir = createUserDataDir()
  ;({ app, window } = await launchWitena(userDataDir))
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) removeUserDataDir(userDataDir)
})

const card = () => window.getByTestId('onboarding')
const step = (name: string) => window.locator(`[data-testid="onboarding-step"][data-step="${name}"]`)

test('an empty installation opens on the first-run card, not on an empty state', async () => {
  // The card replaces the conversation column's "no chat selected" placeholder,
  // which on a fresh install is true and useless.
  await expect(card()).toBeVisible()
  await expect(card()).toHaveAttribute('data-step', 'preset')
  await expect(step('preset')).toHaveAttribute('data-state', 'current')
  await expect(step('chat')).toHaveAttribute('data-state', 'todo')
  // Skip is on screen from the first step, not only at the end.
  await expect(window.getByTestId('onboarding-skip')).toBeVisible()
})

test('picking the Ollama preset advances past the key step on its own', async () => {
  await window.getByTestId('preset-ollama').click()

  // A local preset needs no key, so the credential step is satisfied by the
  // choice itself and the card moves on rather than showing a field that would
  // have to be left empty.
  await expect(step('preset')).toHaveAttribute('data-state', 'done')
  await expect(step('credential')).toHaveAttribute('data-state', 'done')
  await expect(card()).toHaveAttribute('data-step', 'models')
})

test('the model is typed in and the provider saved from the card', async () => {
  test.skip(!ollamaUp, `${OLLAMA_MODELS_URL} did not answer; the card cannot reach a model.`)

  // The same control the settings editor uses — it is one component, not a copy.
  await window.getByTestId('provider-add-model').click()
  await window.getByTestId('provider-add-model-input').fill(MODEL_ID)
  await window.getByTestId('provider-add-model-input').press('Enter')
  await expect(window.getByTestId('provider-model-chip').first()).toHaveText(MODEL_ID)

  await window.getByTestId('onboarding-save-provider').click()

  await expect(step('models')).toHaveAttribute('data-state', 'done')
  await expect(card()).toHaveAttribute('data-step', 'agent')
})

test('an agent is created from a template, on the model the provider offers', async () => {
  test.skip(!ollamaUp, 'no local Ollama')

  const tile = window.getByTestId('onboarding-template-assistant')
  // The tile names the model it would use, which is the provider's only one here.
  await expect(tile).toHaveAttribute('data-model', MODEL_ID)
  await tile.click()

  await expect(step('agent')).toHaveAttribute('data-state', 'done')
  await expect(card()).toHaveAttribute('data-step', 'chat')

  // It is a real agent in the library, not a card-local idea of one.
  await window.getByTestId('nav-agents').click()
  await expect(window.getByTestId('agent-item')).toHaveCount(1)
  await window.getByTestId('nav-chats').click()
  await expect(card()).toBeVisible()
})

test('the card starts a chat that already has the agent in it', async () => {
  test.skip(!ollamaUp, 'no local Ollama')

  await window.getByTestId('onboarding-start-chat').click()

  // The chat exists, is selected, and has a member — which is exactly the fact
  // that ends the card, so it must be gone.
  await expect(window.getByTestId('chat-item')).toHaveCount(1)
  await expect(window.getByTestId('member-row')).toHaveCount(1)
  await expect(window.getByTestId('member-model')).toContainText(MODEL_ID)
  await expect(card()).toHaveCount(0)
})

test('the reply streams in, which is the acceptance sentence', async () => {
  test.skip(!ollamaUp, 'no local Ollama')
  test.setTimeout(COLD_START_MS + 60_000)

  await window.getByTestId('composer-input').fill('Reply with the single word hello')
  await window.getByTestId('composer-input').press('Enter')

  const reply = window.locator('[data-testid="message-item"][data-sender="agent"]').first()
  await expect(reply).toHaveAttribute('data-status', /^(streaming|done)$/, { timeout: 30_000 })
  // …and then fills in. A cold Ollama loads the weights first, hence the budget.
  await expect(reply).toHaveAttribute('data-status', 'done', { timeout: COLD_START_MS })
  await expect(reply.getByTestId('message-text')).not.toBeEmpty({ timeout: 20_000 })
})

test('the card stays gone after a restart', async () => {
  test.skip(!ollamaUp, 'no local Ollama')

  await app?.close()
  ;({ app, window } = await launchWitena(userDataDir))

  await expect(window.getByTestId('chat-item')).toHaveCount(1)
  await expect(card()).toHaveCount(0)
})

/**
 * Skip, on its own installation.
 *
 * A second `userData` rather than a step in the walk above: pressing Skip is
 * the alternative to finishing, so it cannot be tested after finishing. It
 * needs no model and therefore no Ollama.
 */
test('Skip hides the card for this installation, across a restart', async () => {
  const skipped = createUserDataDir()
  const second = await launchWitena(skipped)

  try {
    await expect(second.window.getByTestId('onboarding')).toBeVisible()
    await second.window.getByTestId('onboarding-skip').click()
    await expect(second.window.getByTestId('onboarding')).toHaveCount(0)

    await second.app.close()
    const again = await launchWitena(skipped)
    try {
      // A settings row, not browser storage: the choice belongs to the
      // installation, so it survives the process that made it.
      await expect(again.window.getByTestId('onboarding')).toHaveCount(0)
      await expect(again.window.getByTestId('chats-new')).toBeVisible()
    } finally {
      await again.app.close()
    }
  } finally {
    await second.app.close().catch(() => undefined)
    removeUserDataDir(skipped)
  }
})

test('Settings → About shows the version, the repository and the licences', async () => {
  const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    version: string
  }

  await window.getByTestId('nav-settings').click()
  await window.getByTestId('settings-section-about').click()

  // `APP_VERSION` is kept equal to the manifest by `scripts/sync-version.mjs`,
  // so the manifest is what the screen is checked against.
  await expect(window.getByTestId('about-version')).toContainText(version)
  await expect(window.getByTestId('about-repository')).toHaveAttribute(
    'href',
    /^https:\/\/github\.com\//
  )

  // The list is generated from `node_modules` at build time; what matters here
  // is that the renderer got a non-trivial one rather than an empty array.
  const count = await window.getByTestId('about-licenses-count').getAttribute('data-count')
  expect(Number(count)).toBeGreaterThan(20)
  await expect(window.getByTestId('about-license-row').first()).toBeVisible()
})
