/**
 * The S1.6 acceptance test: a provider can be added, probed, saved and found
 * again after a restart.
 *
 * Two flows, deliberately different in what they touch:
 *
 * 1. **Ollama**, which is the only provider that can be probed for real without a
 *    secret — it runs on localhost and needs no key. The spec checks whether
 *    `http://localhost:11434/v1/models` answers before it launches the app and
 *    skips *only the two network assertions* when it does not, because the rest
 *    of the flow (preset → form → save → restart) must be proven on every
 *    machine.
 * 2. **The `custom` preset**, entirely offline: a fake endpoint and a fake key,
 *    saved and reopened, to prove the write-only key contract — the key never
 *    comes back, and the form says one is stored instead of showing a fake value.
 *
 * The UI is pinned to Chinese and the window to 1440×900, like `ui-shell.spec.ts`,
 * so `providers.png` is comparable with the settings artboard. Every assertion is
 * on a `data-testid` or a `data-*` value rather than on rendered copy, so none of
 * them depends on the active language — and no Chinese appears in this file
 * (CLAUDE.md rule #1).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import {
  createUserDataDir,
  launchWitena,
  locale,
  openProviderSettings,
  removeUserDataDir,
  repoRoot
} from './helpers'

const SHOTS_DIR = process.env['WITENA_SHOTS_DIR'] ?? join(repoRoot, 'test-results', 'shots')

/** The artboard size, so the screenshot lines up with the mockup. */
const WINDOW_SIZE = { width: 1440, height: 900 }

/** Ollama's OpenAI-compatible endpoint, the same URL the `ollama` preset stores. */
const OLLAMA_MODELS_URL = 'http://localhost:11434/v1/models'

const zhCN = locale('zh-CN')

let app: ElectronApplication | undefined
let window: Page
let userDataDir: string

/** Whether a local Ollama answered before the run started. */
let ollamaUp = false

async function probeOllama(): Promise<boolean> {
  try {
    const response = await fetch(OLLAMA_MODELS_URL, {
      signal: AbortSignal.timeout(2_000)
    })
    return response.ok
  } catch {
    return false
  }
}

/** Pins the window size and the UI language so the screenshots are comparable. */
async function prepare(): Promise<void> {
  await app?.evaluate(({ BrowserWindow }, size) => {
    const [main] = BrowserWindow.getAllWindows()
    main?.setContentSize(size.width, size.height)
  }, WINDOW_SIZE)

  await window.getByTestId('nav-settings').click()
  await window.getByTestId('lang-zh-CN').click()
  await expect(window.getByTestId('page-settings')).toHaveText(zhCN.settings.title)
}

test.beforeAll(async () => {
  ollamaUp = await probeOllama()
  userDataDir = createUserDataDir()
  ;({ app, window } = await launchWitena(userDataDir))
  mkdirSync(SHOTS_DIR, { recursive: true })
  await prepare()
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) removeUserDataDir(userDataDir)
})

test('adds the Ollama preset, fetches its models and saves it', async () => {
  await openProviderSettings(window)
  await expect(window.getByTestId('settings-section-title')).toHaveText(
    zhCN.settings.sections['providers'] as string
  )

  // Nothing is stored yet, so the list is empty and the editor is a placeholder.
  await expect(window.getByTestId('provider-card')).toHaveCount(0)
  await expect(window.getByTestId('provider-editor')).toHaveCount(0)

  await window.getByTestId('providers-add').click()
  await expect(window.getByTestId('provider-editor')).toBeVisible()

  await window.getByTestId('preset-ollama').click()
  // The preset fills the form: name from the preset, base URL from its endpoint.
  await expect(window.getByTestId('provider-name-input')).toHaveValue('Ollama')
  await expect(window.getByTestId('provider-base-url-input')).toHaveValue(
    'http://localhost:11434/v1'
  )
  // A local preset needs no key, so Save must be reachable with the field empty.
  await expect(window.getByTestId('provider-api-key-input')).toHaveValue('')

  if (ollamaUp) {
    await window.getByTestId('provider-fetch-models').click()
    // One chip per model the local server has pulled.
    await expect(window.getByTestId('provider-model-chip').first()).toBeVisible({ timeout: 20_000 })
    expect(await window.getByTestId('provider-model-chip').count()).toBeGreaterThan(0)

    // Pick a small model on purpose. An Ollama install commonly holds a 70B model
    // as well, and whichever id happens to sort first is not a sensible probe
    // target — which is exactly why the editor offers this control at all.
    const probe = window.getByTestId('provider-probe-model')
    if ((await probe.count()) > 0) {
      // Read the labels rather than the DOM values: `e2e/` is type-checked by
      // `tsconfig.node.json`, which has no DOM lib, and the option's label is the
      // model id anyway.
      const values = await probe.locator('option').allTextContents()
      const small = values.find((value) => /:(1|1\.5|2|3|4)b\b/i.test(value))
      if (small) await probe.selectOption(small)
    }

    // The probe runs a real `generateText` against the chosen model.
    await window.getByTestId('provider-test').click()
    await expect(window.getByTestId('provider-test-result')).toHaveAttribute('data-ok', 'true', {
      timeout: 40_000
    })
  } else {
    // Recorded rather than silently passed: the reviewer has to know which half ran.
    test.info().annotations.push({
      type: 'skipped',
      description: `${OLLAMA_MODELS_URL} did not answer; the fetch-models and test-connection assertions were skipped.`
    })
    // Save still needs a model, so supply one by hand.
    await window.getByTestId('provider-add-model').click()
    await window.getByTestId('provider-add-model-input').fill('llama3.2:3b')
    await window.getByTestId('provider-add-model-input').press('Enter')
    await expect(window.getByTestId('provider-model-chip').first()).toBeVisible()
  }

  await window.getByTestId('provider-save').click()

  const card = window.getByTestId('provider-card')
  await expect(card).toHaveCount(1)
  await expect(card.getByTestId('provider-card-host')).toHaveText('localhost:11434')
  // Saving keeps the editor on the record it just created.
  await expect(window.getByTestId('provider-editor')).toBeVisible()
})

test('the saved provider is still there after a restart', async () => {
  await app?.close()
  ;({ app, window } = await launchWitena(userDataDir))
  await prepare()
  await openProviderSettings(window)

  const card = window.getByTestId('provider-card')
  await expect(card).toHaveCount(1)
  await expect(card.getByTestId('provider-card-host')).toHaveText('localhost:11434')
  // A probe result is a fact about *now* and is never persisted, so a restored
  // card is "not tested" — and "no key" is wrong for a local provider that needs
  // none, which is exactly what the `hasApiKey` rule has to get right.
  await expect(card.getByTestId('provider-card-status')).toHaveAttribute('data-status', 'untested')
})

test('a key is stored write-only: the custom preset shows a hint, never the value', async () => {
  await window.getByTestId('providers-add').click()
  await window.getByTestId('preset-custom').click()

  await window.getByTestId('provider-name-input').fill('Fake endpoint')
  await window.getByTestId('provider-base-url-input').fill('https://example.invalid/v1')
  await window.getByTestId('provider-api-key-input').fill('sk-not-a-real-key')
  await window.getByTestId('provider-add-model').click()
  await window.getByTestId('provider-add-model-input').fill('fake-model')
  await window.getByTestId('provider-add-model-input').press('Enter')

  await window.getByTestId('provider-save').click()
  await expect(window.getByTestId('provider-card')).toHaveCount(2)

  // Reopen it from the list: the stored key must not come back into the field.
  await window.getByTestId('nav-chats').click()
  await openProviderSettings(window)
  await window.getByTestId('provider-card').nth(1).click()

  await expect(window.getByTestId('provider-api-key-input')).toHaveValue('')
  await expect(window.getByTestId('provider-api-key-stored')).toBeVisible()
  await expect(window.getByTestId('provider-base-url-input')).toHaveValue(
    'https://example.invalid/v1'
  )

  // The acceptance screenshot: saved providers in the list, editor open beside it.
  await window.screenshot({ path: join(SHOTS_DIR, 'providers.png') })
})

test('clearing a key puts the card back into the "no key" state', async () => {
  // The `custom` preset asks for no key, so the pill would stay neutral; an
  // Anthropic provider is the cheapest way to exercise the rule, and it needs no
  // network — nothing is ever sent, only stored and cleared.
  await window.getByTestId('providers-add').click()
  await window.getByTestId('preset-anthropic').click()
  await window.getByTestId('provider-api-key-input').fill('sk-ant-not-a-real-key')
  await window.getByTestId('provider-save').click()

  const card = window.getByTestId('provider-card').nth(2)
  await expect(card.getByTestId('provider-card-status')).toHaveAttribute('data-status', 'untested')

  // Emptying a field that was typed into is the documented way to remove a key.
  await window.getByTestId('provider-api-key-input').fill('x')
  await window.getByTestId('provider-api-key-input').fill('')
  await window.getByTestId('provider-save').click()

  await expect(card.getByTestId('provider-card-status')).toHaveAttribute('data-status', 'no-key')
})
