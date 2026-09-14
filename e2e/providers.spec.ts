/**
 * The S1.6 acceptance test: a provider can be added, probed, saved and found
 * again after a restart — plus S7.6's two key-survival cases and S5.3's sign-in
 * mode at the end of the file.
 *
 * Five flows, deliberately different in what they touch:
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
 * 3. **A key across a relaunch** (S7.6): a provider saved *with* a key, found
 *    again after the app is restarted on the same `userData`, and probed. That is
 *    the flow an unsigned rebuild used to break, because `safeStorage`'s Keychain
 *    item is granted per application identity; the key now lives in
 *    `userData/secrets.key`, which a relaunch and an update both leave alone.
 * 4. **A key a previous installation wrote** (S7.6), seeded into the database by
 *    hand as base64 of `v10…` while the app is closed — the exact shape the
 *    user's own rows held. Nothing can decrypt it, so the row must be left
 *    untouched and the UI must ask for the key again.
 * 5. **Sign-in mode with neither vendor CLI installed** (S5.3, S5.13), which
 *    relaunches the app with `WITENA_ANT_BIN` and `WITENA_GCLOUD_BIN` pointing
 *    at nothing. Neither browser flow is driven; the panels, the two install
 *    commands and the two refused Saves are.
 *
 * The UI is pinned to Chinese and the window to 1440×900, like `ui-shell.spec.ts`,
 * so `providers.png` is comparable with the settings artboard. Every assertion is
 * on a `data-testid` or a `data-*` value rather than on rendered copy, so none of
 * them depends on the active language — and no Chinese appears in this file
 * (CLAUDE.md rule #1).
 */
import { execFileSync } from 'node:child_process'
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
const OLLAMA_BASE_URL = 'http://localhost:11434/v1'
const OLLAMA_MODELS_URL = `${OLLAMA_BASE_URL}/models`

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

/**
 * Points the probe at a small model when the editor offers the choice.
 *
 * An Ollama install commonly holds a 70B model as well, and whichever id happens
 * to sort first is not a sensible probe target — which is why the editor offers
 * the control at all. Shared by the S1.6 flow and S7.6's restart.
 */
async function selectSmallProbeModel(): Promise<void> {
  const probe = window.getByTestId('provider-probe-model')
  if ((await probe.count()) === 0) return
  // Read the labels rather than the DOM values: `e2e/` is type-checked by
  // `tsconfig.node.json`, which has no DOM lib, and the option's label is the
  // model id anyway.
  const values = await probe.locator('option').allTextContents()
  const small = values.find((value) => /:(1|1\.5|2|3|4)b\b/i.test(value))
  if (small) await probe.selectOption(small)
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
  await expect(window.getByTestId('provider-base-url-input')).toHaveValue(OLLAMA_BASE_URL)
  // A local preset needs no key, so Save must be reachable with the field empty.
  await expect(window.getByTestId('provider-api-key-input')).toHaveValue('')

  if (ollamaUp) {
    await window.getByTestId('provider-fetch-models').click()
    // One chip per model the local server has pulled.
    await expect(window.getByTestId('provider-model-chip').first()).toBeVisible({ timeout: 20_000 })
    expect(await window.getByTestId('provider-model-chip').count()).toBeGreaterThan(0)

    // Pick a small model on purpose, or "Test connection" becomes a
    // several-minute model load.
    await selectSmallProbeModel()

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

/**
 * S7.6, the acceptance criterion: a key saved by one launch is readable by the
 * next one from the same `userData`.
 *
 * This is the flow that used to break. `safeStorage` keys its Keychain item off
 * the application identity, so the *next* unsigned build could not decrypt what
 * this one wrote; the key now lives in `userData/secrets.key`, which a relaunch —
 * and an update — leaves alone. A relaunch is as close as an end-to-end spec can
 * get to a reinstall, and it is exactly what the file has to survive.
 *
 * The endpoint is Ollama's, reached through the `custom` preset so the provider
 * genuinely carries a key: the `ollama` preset needs none, and a provider with
 * no key proves nothing about keys. Ollama ignores the `Authorization` header,
 * which is what makes the probe runnable at all without a real secret.
 */
test('a key saved in one launch is still readable by the next', async () => {
  await window.getByTestId('providers-add').click()
  await window.getByTestId('preset-custom').click()
  await window.getByTestId('provider-name-input').fill('Key round trip')
  await window.getByTestId('provider-base-url-input').fill(OLLAMA_BASE_URL)
  await window.getByTestId('provider-api-key-input').fill('sk-file-key-round-trip')

  if (ollamaUp) {
    await window.getByTestId('provider-fetch-models').click()
    await expect(window.getByTestId('provider-model-chip').first()).toBeVisible({ timeout: 20_000 })
    await selectSmallProbeModel()
  } else {
    await window.getByTestId('provider-add-model').click()
    await window.getByTestId('provider-add-model-input').fill('llama3.2:3b')
    await window.getByTestId('provider-add-model-input').press('Enter')
  }

  await window.getByTestId('provider-save').click()
  const index = (await window.getByTestId('provider-card').count()) - 1

  await app?.close()
  ;({ app, window } = await launchWitena(userDataDir))
  await prepare()
  await openProviderSettings(window)
  // Locators are bound to a `Page`, and the relaunch produced a new one, so
  // every locator below has to be built from the current `window`.
  await window.getByTestId('provider-card').nth(index).click()

  // The key is still stored, and this build can read it: `keyState` would be
  // `unreadable` otherwise and the editor would be asking for it again.
  await expect(window.getByTestId('provider-api-key-stored')).toBeVisible()
  await expect(window.getByTestId('provider-key-unreadable')).toHaveCount(0)
  await expect(window.getByTestId('provider-card-key-unreadable')).toHaveCount(0)

  if (ollamaUp) {
    await selectSmallProbeModel()
    await window.getByTestId('provider-test').click()
    await expect(window.getByTestId('provider-test-result')).toHaveAttribute('data-ok', 'true', {
      timeout: 40_000
    })
  } else {
    test.info().annotations.push({
      type: 'skipped',
      description:
        `${OLLAMA_MODELS_URL} did not answer; the probe after the restart was ` +
        'skipped. The stored-key assertions ran.'
    })
  }
})

/**
 * S7.6, the other half: a key this build genuinely cannot read is explained.
 *
 * The row is written by hand with the `sqlite3` CLI while the app is closed,
 * holding base64 of `v10…` — the real shape of `safeStorage` output, and exactly
 * what the user's own database held after the S7.1 dmg replaced the S4.4 one.
 * Nothing can decrypt it, which is the point: the startup migration has to leave
 * it alone and the UI has to say what to do about it.
 */
test('a key from a previous installation asks to be pasted again', async () => {
  await window.getByTestId('providers-add').click()
  await window.getByTestId('preset-custom').click()
  await window.getByTestId('provider-name-input').fill('Left behind')
  await window.getByTestId('provider-base-url-input').fill('https://example.invalid/v1')
  await window.getByTestId('provider-api-key-input').fill('sk-will-be-replaced-by-hand')
  await window.getByTestId('provider-save').click()

  const index = (await window.getByTestId('provider-card').count()) - 1
  const id = await window
    .getByTestId('provider-card')
    .nth(index)
    .getAttribute('data-provider-id')
  expect(id).not.toBeNull()

  // Closed first: the write has to land in the same file the next launch opens.
  await app?.close()
  const unreadable = Buffer.from('v10-from-a-keychain-this-build-cannot-reach', 'utf8').toString(
    'base64'
  )
  expect(unreadable.startsWith('djEw')).toBe(true)
  execFileSync('sqlite3', [
    join(userDataDir, 'witena.db'),
    `UPDATE providers SET api_key_encrypted = '${unreadable}' WHERE id = '${id}';`
  ])

  ;({ app, window } = await launchWitena(userDataDir))
  await prepare()
  await openProviderSettings(window)

  // Rebuilt from the relaunched window, for the reason above.
  const card = window.getByTestId('provider-card').nth(index)
  // The card says so without anything being probed: "no key" would be false —
  // a key *is* stored — and a failed probe would blame the provider.
  await expect(card.getByTestId('provider-card-key-unreadable')).toBeVisible()
  await expect(card.getByTestId('provider-card-status')).toHaveAttribute('data-status', 'untested')

  await card.click()
  await expect(window.getByTestId('provider-key-unreadable')).toBeVisible()
  // The "a key is stored" hint would be true and reassuring, which is wrong.
  await expect(window.getByTestId('provider-api-key-stored')).toHaveCount(0)
  // The field has the focus, because pasting the key is the whole fix.
  await expect(window.getByTestId('provider-api-key-input')).toBeFocused()

  await window.getByTestId('provider-api-key-input').fill('sk-pasted-again')
  await window.getByTestId('provider-save').click()

  await expect(window.getByTestId('provider-key-unreadable')).toHaveCount(0)
  await expect(card.getByTestId('provider-card-key-unreadable')).toHaveCount(0)
  await expect(window.getByTestId('provider-api-key-stored')).toBeVisible()
})

/**
 * S5.3: sign-in mode on a machine where the Anthropic CLI is not installed.
 *
 * The app is relaunched with `WITENA_ANT_BIN` pointing at a path that does not
 * exist, which is the only way to get that state on a developer machine that
 * has `ant` — the resolver would otherwise find it in `/opt/homebrew/bin` even
 * with an empty `PATH`, exactly as it is meant to.
 *
 * The sign-in click itself is deliberately **not** driven: it opens a real
 * browser and needs an account. What is driven is everything around it — the
 * mode switch, the panel's state, the install command, and the refusal to save a
 * provider that could not possibly authenticate.
 */
test('sign-in mode explains what to install when `ant` is absent', async () => {
  await app?.close()
  ;({ app, window } = await launchWitena(userDataDir, {
    WITENA_ANT_BIN: join(userDataDir, 'no-such-ant'),
    WITENA_GCLOUD_BIN: join(userDataDir, 'no-such-gcloud')
  }))
  await prepare()
  await openProviderSettings(window)

  const before = await window.getByTestId('provider-card').count()

  await window.getByTestId('providers-add').click()
  await window.getByTestId('preset-anthropic').click()
  await window.getByTestId('provider-auth-oauth').click()

  // The key field is replaced by the panel, not hidden beside it.
  await expect(window.getByTestId('provider-api-key-input')).toHaveCount(0)
  await expect(window.getByTestId('provider-sign-in')).toHaveAttribute(
    'data-auth-state',
    'not-installed'
  )
  // The install command is data, printed verbatim in both languages.
  await expect(window.getByTestId('provider-cli-install')).toHaveText(
    'brew install anthropics/tap/ant'
  )

  await window.getByTestId('provider-save').click()

  const error = window.getByTestId('provider-error')
  await expect(error).toHaveAttribute('data-error-code', 'ant_missing')
  // Translated copy, not the backend's developer message.
  await expect(error).toContainText(zhCN.errors['ant_missing'] as string)

  // Nothing was stored: a provider that cannot authenticate is not a provider.
  await expect(window.getByTestId('provider-card')).toHaveCount(before)

  // Switching back to the key field leaves the editor exactly as it was.
  await window.getByTestId('provider-auth-apiKey').click()
  await expect(window.getByTestId('provider-sign-in')).toHaveCount(0)
  await expect(window.getByTestId('provider-api-key-input')).toBeVisible()
})

/**
 * S5.13: the same, for Google, on the run that already has no `gcloud`.
 *
 * The two vendors are separate logins and separate panels, so this is not a
 * repetition of the case above — what it proves is that the control is *live*
 * for Google at all (it was disabled with a hint until this step), that the
 * panel it opens is the Google one (its own install command, its own error
 * code), and that Save refuses with `gcloud_missing` rather than with the
 * Anthropic code, which is what a single shared status would have produced.
 */
test('sign-in mode explains what to install when `gcloud` is absent', async () => {
  const before = await window.getByTestId('provider-card').count()

  await window.getByTestId('providers-add').click()
  await window.getByTestId('preset-google').click()
  // Live rather than disabled: clicking it has to actually change the mode.
  await window.getByTestId('provider-auth-oauth').click()

  await expect(window.getByTestId('provider-api-key-input')).toHaveCount(0)
  const panel = window.getByTestId('provider-sign-in')
  await expect(panel).toHaveAttribute('data-auth-type', 'google')
  await expect(panel).toHaveAttribute('data-auth-state', 'not-installed')
  await expect(window.getByTestId('provider-cli-install')).toHaveText(
    'brew install --cask google-cloud-sdk'
  )
  // Nothing to name a project for yet: that control belongs to a signed-in panel.
  await expect(window.getByTestId('provider-project-input')).toHaveCount(0)

  await window.getByTestId('provider-save').click()

  const error = window.getByTestId('provider-error')
  await expect(error).toHaveAttribute('data-error-code', 'gcloud_missing')
  await expect(error).toContainText(zhCN.errors['gcloud_missing'] as string)

  await expect(window.getByTestId('provider-card')).toHaveCount(before)
})
