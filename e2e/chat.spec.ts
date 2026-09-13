/**
 * The S1.7 acceptance test: a real conversation, against a real local model.
 *
 * Everything else in `e2e/` can run offline; this one cannot, and pretending
 * otherwise would make it prove nothing — the point of the step is that tokens
 * arrive from an actual provider, that Stop reaches an actual HTTP request, and
 * that what was streamed is still there after a restart. So the whole file is
 * **skipped when `http://localhost:11434/v1/models` does not answer**, and the
 * skip is explicit in the report rather than a silent pass.
 *
 * ## Why the model is added by hand rather than fetched
 *
 * "Fetch from /models" is `providers.spec.ts`'s job and works. Here the model is
 * typed in as `qwen2.5:1.5b` on purpose: a developer machine commonly also holds
 * a 40 GB model, the fetched list is sorted alphabetically, and a run that picks
 * `deepseek-r1:70b` would spend minutes loading weights and then fail the
 * timeout. One small model, named explicitly, keeps the spec honest and fast.
 *
 * Every assertion is on a `data-testid` or a `data-*` value, never on rendered
 * copy, so none of them depends on the active language — and no Chinese appears
 * in this file (CLAUDE.md rule #1).
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

/**
 * Serial, because the tests share one app and build on each other's data: chat 1
 * is created in the second test and asserted again in the fifth. Serial mode also
 * makes a failure readable — the rest are **skipped** rather than re-run against a
 * fresh worker, which would relaunch the app on an empty userData directory and
 * bury the real failure under three misleading ones.
 */
test.describe.configure({ mode: 'serial' })

const SHOTS_DIR = process.env['WITENA_SHOTS_DIR'] ?? join(repoRoot, 'test-results', 'shots')

/** The artboard size, so the screenshot lines up with the mockup. */
const WINDOW_SIZE = { width: 1440, height: 900 }

/** Ollama's OpenAI-compatible endpoint, the same URL the `ollama` preset stores. */
const OLLAMA_MODELS_URL = 'http://localhost:11434/v1/models'

/** Small, fast, and present on any machine that has pulled anything at all. */
const MODEL_ID = 'qwen2.5:1.5b'

/** A cold Ollama has to load the weights before the first token appears. */
const COLD_START_MS = 90_000

const zhCN = locale('zh-CN')

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

/** Pins the window size and the UI language so the screenshot is comparable. */
async function prepare(): Promise<void> {
  await app?.evaluate(({ BrowserWindow }, size) => {
    const [main] = BrowserWindow.getAllWindows()
    main?.setContentSize(size.width, size.height)
  }, WINDOW_SIZE)

  await window.getByTestId('nav-settings').click()
  await window.getByTestId('lang-zh-CN').click()
  await expect(window.getByTestId('page-settings')).toHaveText(zhCN.settings.title)
}

const agentMessages = () =>
  window.locator('[data-testid="message-item"][data-sender="agent"]')
const userMessages = () => window.locator('[data-testid="message-item"][data-sender="user"]')

/**
 * Creates a chat with the "+" button, waits for it to be selected, and makes sure
 * it has a member.
 *
 * Since S2.2 only the **first** chat of an empty install gets the bootstrap agent
 * automatically; once the agent library is non-empty, a new chat starts with
 * nobody in it and picking the members is the user's job. So this helper does
 * what the user would: if the member panel is empty, it opens the picker and adds
 * the first candidate — which on this fixture is the bootstrap agent.
 */
async function newChat(): Promise<void> {
  const before = await window.getByTestId('chat-item').count()
  await window.getByTestId('chats-new').click()
  await expect(window.getByTestId('chat-item')).toHaveCount(before + 1)
  await expect(window.getByTestId('composer-input')).toBeEnabled()

  if ((await window.getByTestId('member-row').count()) === 0) {
    await window.getByTestId('member-add').click()
    await window.getByTestId('member-candidate').first().click()
    await expect(window.getByTestId('member-row')).toHaveCount(1)
  }
}

test.beforeAll(async () => {
  ollamaUp = await probeOllama()
  if (!ollamaUp) return

  userDataDir = createUserDataDir()
  ;({ app, window } = await launchWitena(userDataDir))
  mkdirSync(SHOTS_DIR, { recursive: true })
  await prepare()
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) removeUserDataDir(userDataDir)
})

test('adds the local Ollama provider with one small model', async () => {
  test.skip(!ollamaUp, `${OLLAMA_MODELS_URL} did not answer; the chat spec needs a local model.`)

  await openProviderSettings(window)
  await window.getByTestId('providers-add').click()
  await window.getByTestId('preset-ollama').click()

  // Typed in rather than fetched: see the header.
  await window.getByTestId('provider-add-model').click()
  await window.getByTestId('provider-add-model-input').fill(MODEL_ID)
  await window.getByTestId('provider-add-model-input').press('Enter')
  await expect(window.getByTestId('provider-model-chip').first()).toHaveText(MODEL_ID)

  await window.getByTestId('provider-save').click()
  await expect(window.getByTestId('provider-card')).toHaveCount(1)
})

test('sends a message and streams one agent reply token by token', async () => {
  test.skip(!ollamaUp, 'no local Ollama')
  test.setTimeout(COLD_START_MS + 60_000)

  await window.getByTestId('nav-chats').click()
  await newChat()

  // The chat was created with the default agent, so the member panel has one row
  // showing the model the reply will come from.
  await expect(window.getByTestId('member-row')).toHaveCount(1)
  // Since S2.2 the row prints `model · provider · presence`, not the model alone.
  await expect(window.getByTestId('member-model')).toContainText(MODEL_ID)

  await window.getByTestId('composer-input').fill('Reply with the single word hello')
  await window.getByTestId('composer-input').press('Enter')

  // The user's message is stored and shown before anything reaches the model.
  await expect(userMessages()).toHaveCount(1)
  await expect(userMessages().first()).toContainText('Reply with the single word hello')

  // The agent's message is created empty and streaming, with a cursor on it.
  // A warm Ollama answers a one-word prompt in well under a second, so the
  // `streaming` state may already be over by the time the assertion runs: the
  // message must exist as `streaming` or `done`, and the cursor is checked only
  // while it is still streaming. What is asserted unconditionally is below.
  const reply = agentMessages().first()
  await expect(reply).toHaveAttribute('data-status', /^(streaming|done)$/, { timeout: 30_000 })
  if ((await reply.getAttribute('data-status')) === 'streaming') {
    await expect(reply.getByTestId('message-cursor')).toBeVisible()
  }

  // …and then fills in. A cold Ollama loads the weights first, hence the budget.
  await expect(reply).toHaveAttribute('data-status', 'done', { timeout: COLD_START_MS })
  await expect(reply.getByTestId('message-text')).not.toBeEmpty()
  await expect(reply.getByTestId('message-cursor')).toHaveCount(0)
  // The composer is usable again: no run, so no Stop button.
  await expect(window.getByTestId('composer-stop')).toHaveCount(0)
  await expect(window.getByTestId('composer-send')).toBeVisible()

  // The acceptance screenshot: a finished exchange in the mockup's layout.
  await window.screenshot({ path: join(SHOTS_DIR, 'chat.png') })
})

test('Stop interrupts a long reply and the message ends in error', async () => {
  test.skip(!ollamaUp, 'no local Ollama')
  test.setTimeout(120_000)

  await window.getByTestId('composer-input').fill('Count from 1 to 200 separated by spaces')
  await window.getByTestId('composer-input').press('Enter')

  // Stop is pressed as soon as the reply starts arriving rather than after a
  // fixed pause: a warm local 1.5B model can finish a short answer inside a
  // second, and a spec that waits first would be racing the model instead of
  // testing cancellation.
  const reply = agentMessages().nth(1)
  await expect(reply).toHaveAttribute('data-status', 'streaming', { timeout: 30_000 })
  const stop = window.getByTestId('composer-stop')
  await expect(stop).toBeVisible()
  await stop.click()

  await expect(reply).toHaveAttribute('data-status', 'error', { timeout: 20_000 })
  // `error: 'aborted'` renders as the "stopped" hint rather than as a failure.
  await expect(reply.getByTestId('message-status-label')).toBeVisible()
  // The run is over, so the button goes back to Send.
  await expect(stop).toHaveCount(0)
  await expect(window.getByTestId('composer-send')).toBeVisible()
})

test('a second chat keeps its own transcript', async () => {
  test.skip(!ollamaUp, 'no local Ollama')
  test.setTimeout(120_000)

  await newChat()
  // A fresh chat starts empty even though the other one has four messages.
  await expect(window.locator('[data-testid="message-item"]')).toHaveCount(0)

  await window.getByTestId('composer-input').fill('Reply with the single word ok')
  await window.getByTestId('composer-input').press('Enter')
  await expect(agentMessages().first()).toHaveAttribute('data-status', 'done', {
    timeout: COLD_START_MS
  })
})

test('every message is still there after a restart', async () => {
  test.skip(!ollamaUp, 'no local Ollama')

  await app?.close()
  ;({ app, window } = await launchWitena(userDataDir))
  await prepare()
  await window.getByTestId('nav-chats').click()

  const chats = window.getByTestId('chat-item')
  await expect(chats).toHaveCount(2)

  // The newest chat first: one exchange, both messages restored from SQLite.
  await chats.nth(0).click()
  await expect(window.locator('[data-testid="message-item"]')).toHaveCount(2)
  await expect(agentMessages().first()).toHaveAttribute('data-status', 'done')

  // The first chat: the finished reply and the stopped one are both still there.
  await chats.nth(1).click()
  await expect(window.locator('[data-testid="message-item"]')).toHaveCount(4)
  await expect(agentMessages().nth(0)).toHaveAttribute('data-status', 'done')
  await expect(agentMessages().nth(1)).toHaveAttribute('data-status', 'error')
})
