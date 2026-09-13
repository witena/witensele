/**
 * The S2.3 acceptance test: two agents, several rounds, against real models.
 *
 * `chat.spec.ts` proves one agent can answer; this one proves the **engine** —
 * round-robin over two members, sequential and parallel speaking, `mention-only`
 * with an `@mention`, and the notice a mention-only message with no mention
 * produces. Mock models cannot prove any of it: the whole point is that two
 * different providers stream at the same time and that a real reply's text is
 * what schedules the next round.
 *
 * The file is **skipped when `http://localhost:11434/v1/models` does not answer
 * or does not hold both models**, and the skip is explicit in the report rather
 * than a silent pass.
 *
 * Two small models on purpose (`qwen2.5:1.5b` and `llama3.2:3b`), typed in by
 * hand rather than fetched: a developer machine commonly also holds a 40 GB
 * model, and a run that picked it would spend minutes loading weights.
 *
 * Every assertion is on a `data-testid` or a `data-*` value, never on rendered
 * copy, so none of them depends on the active language — and no Chinese appears
 * in this file (CLAUDE.md rule #1).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import {
  addOllamaProvider,
  createUserDataDir,
  launchWitena,
  locale,
  openAgents,
  removeUserDataDir,
  repoRoot
} from './helpers'

/** Serial: one app, one chat, and each test continues the conversation. */
test.describe.configure({ mode: 'serial' })

const SHOTS_DIR = process.env['WITENA_SHOTS_DIR'] ?? join(repoRoot, 'test-results', 'shots')

/** The artboard size, so the screenshot lines up with the mockup. */
const WINDOW_SIZE = { width: 1440, height: 900 }

const OLLAMA_MODELS_URL = 'http://localhost:11434/v1/models'

const REVIEWER_MODEL = 'qwen2.5:1.5b'
const ARCHITECT_MODEL = 'llama3.2:3b'

/** Two cold models, two rounds: the budget has to cover loading both. */
const REPLY_MS = 90_000
const TEST_MS = 240_000

const zhCN = locale('zh-CN')

let app: ElectronApplication | undefined
let window: Page
let userDataDir: string
let ready = false

/** True when Ollama answers **and** both models are pulled. */
async function probeOllama(): Promise<boolean> {
  try {
    const response = await fetch(OLLAMA_MODELS_URL, { signal: AbortSignal.timeout(2_000) })
    if (!response.ok) return false
    const body = (await response.json()) as { data?: Array<{ id?: string }> }
    const ids = (body.data ?? []).map((model) => model.id)
    return [REVIEWER_MODEL, ARCHITECT_MODEL].every((model) => ids.includes(model))
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

/** Creates one agent from an empty editor. */
async function createAgent(name: string, model: string): Promise<void> {
  await window.getByTestId('agents-new').click()
  await window.getByTestId('agent-name').fill(name)
  await window.getByTestId('agent-provider').selectOption({ index: 1 })
  await window.getByTestId('agent-model').selectOption(model)
  await window.getByTestId('agent-save').click()
  await expect(window.getByTestId('agent-save')).toBeDisabled()
}

/** Opens the picker and adds one agent by its visible name. */
async function addMember(name: string): Promise<void> {
  const before = await window.getByTestId('member-row').count()
  await window.getByTestId('member-add').click()
  await window
    .getByTestId('member-picker')
    .getByTestId('member-candidate')
    .filter({ hasText: name })
    .click()
  await expect(window.getByTestId('member-row')).toHaveCount(before + 1)
}

const messages = (): Locator => window.locator('[data-testid="message-item"]')
const agentMessages = (): Locator =>
  window.locator('[data-testid="message-item"][data-sender="agent"]')
const systemMessages = (): Locator =>
  window.locator('[data-testid="message-item"][data-sender="system"]')
const messagesBy = (author: string): Locator =>
  window.locator(`[data-testid="message-item"][data-author="${author}"]`)
const streamingMessages = (): Locator =>
  window.locator('[data-testid="message-item"][data-status="streaming"]')

/** Types a message and presses Enter. */
async function send(text: string): Promise<void> {
  await window.getByTestId('composer-input').fill(text)
  await window.getByTestId('composer-input').press('Enter')
}

/**
 * Waits until the whole run is over: no message is still streaming and the
 * composer is back to Send.
 *
 * Counts are asserted per test rather than here, and never as "exactly N more
 * for the rest of the run": a real model that writes `@Architect` schedules
 * another round, which is the engine working, not a failure.
 */
async function waitForRunToEnd(): Promise<void> {
  await expect(window.getByTestId('composer-send')).toBeVisible({ timeout: REPLY_MS })
  await expect(streamingMessages()).toHaveCount(0, { timeout: REPLY_MS })
}

/** Asserts that the n-th agent message finished rather than failed. */
async function expectDone(index: number): Promise<void> {
  await expect(agentMessages().nth(index)).toHaveAttribute('data-status', 'done', {
    timeout: REPLY_MS
  })
}

test.beforeAll(async () => {
  ready = await probeOllama()
  if (!ready) return

  userDataDir = createUserDataDir()
  ;({ app, window } = await launchWitena(userDataDir))
  mkdirSync(SHOTS_DIR, { recursive: true })
  await prepare()

  await addOllamaProvider(window, [REVIEWER_MODEL, ARCHITECT_MODEL])
  await openAgents(window)
  await createAgent('Reviewer', REVIEWER_MODEL)
  await createAgent('Architect', ARCHITECT_MODEL)

  await window.getByTestId('nav-chats').click()
  await window.getByTestId('chats-new').click()
  await expect(window.getByTestId('chat-item')).toHaveCount(1)
  await addMember('Reviewer')
  await addMember('Architect')
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) removeUserDataDir(userDataDir)
})

test('round-robin and sequential: both members answer in round 1', async () => {
  test.skip(!ready, `${OLLAMA_MODELS_URL} did not offer both models; S2.3 needs two.`)
  test.setTimeout(TEST_MS)

  await send('In one short sentence, what is a mutex?')

  // Both members speak, in the member order, and both messages carry round 1.
  await expect(agentMessages()).toHaveCount(2, { timeout: REPLY_MS })
  await expectDone(0)
  await expectDone(1)
  await expect(agentMessages().nth(0)).toHaveAttribute('data-author', 'Reviewer')
  await expect(agentMessages().nth(1)).toHaveAttribute('data-author', 'Architect')
  for (let index = 0; index < 2; index += 1) {
    await expect(agentMessages().nth(index)).toHaveAttribute('data-round', '1')
  }
  await waitForRunToEnd()

  // The acceptance screenshot: a finished multi-agent exchange.
  await window.screenshot({ path: join(SHOTS_DIR, 'chat-multi.png') })
})

test('parallel speaking: both members answer the next question at once', async () => {
  test.skip(!ready, 'no local Ollama with both models')
  test.setTimeout(TEST_MS)

  const before = await agentMessages().count()
  await window.getByTestId('chat-speaking-parallel').click()
  await send('In one short sentence, what is a deadlock?')

  // The distinguishing fact: both rows exist and stream **at the same time**,
  // which sequential speaking can never produce.
  await expect(streamingMessages()).toHaveCount(2, { timeout: REPLY_MS })

  await expect(agentMessages()).toHaveCount(before + 2, { timeout: REPLY_MS })
  await expectDone(before)
  await expectDone(before + 1)
  // Both belong to the *same* round, whatever its number — that is what parallel
  // means. The number itself is read rather than assumed: rounds are counted
  // within a run, so this message starts a new run at round 1, and a reply that
  // names a member legitimately adds further rounds to it.
  const round = await agentMessages().nth(before).getAttribute('data-round')
  await expect(agentMessages().nth(before + 1)).toHaveAttribute('data-round', round ?? '')
  await waitForRunToEnd()
})

test('mention-only: only the mentioned member answers', async () => {
  test.skip(!ready, 'no local Ollama with both models')
  test.setTimeout(TEST_MS)

  await window.getByTestId('chat-mode').selectOption('mention-only')
  // One automatic round: a real model that answers `@Reviewer` would otherwise
  // legitimately schedule a second round, and this test is about who speaks in
  // the first one.
  await window.getByTestId('chat-max-rounds').selectOption('1')
  const agentsBefore = await agentMessages().count()
  const architectBefore = await messagesBy('Architect').count()
  const reviewerBefore = await messagesBy('Reviewer').count()

  await send('@Architect reply with the word hi and nothing else')

  await expect(agentMessages()).toHaveCount(agentsBefore + 1, { timeout: REPLY_MS })
  await expectDone(agentsBefore)
  await waitForRunToEnd()

  expect(await messagesBy('Architect').count()).toBe(architectBefore + 1)
  // The other member stayed out of it.
  expect(await messagesBy('Reviewer').count()).toBe(reviewerBefore)
})

test('mention-only: a message that mentions nobody explains itself', async () => {
  test.skip(!ready, 'no local Ollama with both models')
  test.setTimeout(TEST_MS)

  const before = await messages().count()
  const agentsBefore = await agentMessages().count()
  await send('thinking out loud, no question here')

  // No agent message at all — a system notice instead, named by its key so the
  // assertion does not depend on the active language.
  await expect(window.locator('[data-notice-key="noMentions"]')).toHaveCount(1, {
    timeout: REPLY_MS
  })
  await expect(systemMessages().last().getByTestId('message-notice')).toBeVisible()
  // The user's message plus the notice, and nobody spoke.
  await expect(messages()).toHaveCount(before + 2)
  await expect(agentMessages()).toHaveCount(agentsBefore)
  await expect(window.getByTestId('composer-send')).toBeVisible()
})
