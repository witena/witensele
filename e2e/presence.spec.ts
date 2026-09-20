/**
 * The S2.4 acceptance test: one member whose provider never answers, watched
 * going orange, then grey, then skipped — while the member that works finishes
 * its reply and the run ends normally.
 *
 * ## Why a black hole rather than a mock
 *
 * `chat-runner.test.ts` already proves the state machine against a mock model.
 * What only an end-to-end run can prove is that the abort reaches a **real socket
 * that is hanging**: `BLACK_HOLE_URL` points at a loopback listener that accepts
 * the connection and never answers, so the request sits there until something
 * gives up. That is exactly what a dead provider looks like, and it is the case the
 * hard timeout exists for.
 *
 * The chat's own `stallTimeoutMs` / `hardTimeoutMs` are set to 2 s / 6 s through
 * `chats.update`, so the whole away → offline → skipped path plays out inside one
 * test instead of in two minutes. They are written through the preload bridge
 * rather than the UI because the per-chat *stall* override has no control of its
 * own — the group settings block offers only the hard timeout (PLAN leaves the
 * stall budget global), and inventing a second control just for a test would be
 * the tail wagging the dog.
 *
 * ## Why the real model is warmed up first
 *
 * A cold Ollama spends tens of seconds loading weights before the first token,
 * and produces no stream activity while it does — with a 6 s hard timeout the
 * *working* member would be skipped too, and the test would prove nothing. So the
 * model is loaded with one tiny request straight to Ollama before the app is even
 * launched.
 *
 * The file is **skipped when `http://localhost:11434/v1/models` does not answer
 * or does not hold the model**, and the skip is explicit in the report rather
 * than a silent pass.
 *
 * Every assertion is on a `data-testid` or a `data-*` value, never on rendered
 * copy, so none of them depends on the active language — and no Chinese appears
 * in this file (CLAUDE.md rule #1).
 */
import { mkdirSync } from 'node:fs'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import {
  addOllamaProvider,
  createChat,
  createUserDataDir,
  launchWitena,
  locale,
  openAgents,
  openProviderSettings,
  removeUserDataDir,
  repoRoot
} from './helpers'

/** Serial: one app, one chat, and each test continues where the last one left off. */
test.describe.configure({ mode: 'serial' })

const SHOTS_DIR = process.env['WITENA_SHOTS_DIR'] ?? join(repoRoot, 'test-results', 'shots')

/** The artboard size, so the screenshot lines up with the mockup. */
const WINDOW_SIZE = { width: 1440, height: 900 }

const OLLAMA_BASE_URL = 'http://localhost:11434/v1'
const OLLAMA_MODELS_URL = `${OLLAMA_BASE_URL}/models`

/** Small, fast, and present on any machine that has pulled anything at all. */
const REVIEWER_MODEL = 'qwen2.5:1.5b'

/**
 * A provider that takes the request and then goes silent.
 *
 * It used to be a non-routable address (`10.255.255.1:9999`), on the theory that
 * a TCP handshake nobody answers hangs for undici's connect timeout. That is
 * true on some networks and false on others: a gateway that answers with an
 * ICMP "unreachable" or a RST makes `fetch` fail in milliseconds, the turn ends
 * as an ordinary provider error, and the member goes back to *available*
 * instead of *offline* — which is how this spec broke the first time it ran on
 * a different Wi-Fi. So the black hole is now a real listener on the loopback
 * interface that accepts every connection and never writes a byte: deterministic
 * on every network, and torn down with the app.
 *
 * The port still matters — see the WHATWG fetch bad-port list — which is why
 * the listener takes whatever free port the OS assigns rather than a fixed low
 * one.
 */
let blackHole: Server | undefined
let BLACK_HOLE_URL = ''

async function startBlackHole(): Promise<string> {
  const server = createServer((socket) => {
    // Hold the connection open and say nothing; the client is left waiting for
    // a response that never comes, exactly like a provider that hung.
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  blackHole = server
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}/v1`
}

const GHOST_MODEL = 'ghost-model'

/** The per-chat overrides this spec runs under, in milliseconds. */
const STALL_MS = 2_000
const HARD_MS = 6_000

/** Budgets for the two transitions, with room for the heartbeat's own second. */
const AWAY_MS = 15_000
const OFFLINE_MS = 25_000

/** A warm 1.5B model still has to produce a whole sentence. */
const REPLY_MS = 90_000
const TEST_MS = 240_000

const zhCN = locale('zh-CN')

let app: ElectronApplication | undefined
let window: Page
let userDataDir: string
let ready = false
let ghostId = ''
let reviewerId = ''

/** The preload bridge's envelope, restated here: `e2e/` may not import preload. */
type Envelope = { ok: true; value: unknown } | { ok: false; error: { message: string } }

/**
 * Calls a backend method from inside the page.
 *
 * `globalThis.witena`, not `window.witena`: this file's `window` is the Playwright
 * `Page`, and the name would shadow the browser global inside the callback.
 */
async function invoke<T>(method: string, input?: unknown): Promise<T> {
  const envelope = (await window.evaluate(
    async (call) =>
      await (
        globalThis as unknown as {
          witena: { invoke(method: string, input?: unknown): Promise<unknown> }
        }
      ).witena.invoke(call.method, call.input),
    { method, input }
  )) as Envelope
  if (!envelope.ok) throw new Error(`${method} failed: ${envelope.error.message}`)
  return envelope.value as T
}

/** True when Ollama answers and the reviewer's model is pulled. */
async function probeOllama(): Promise<boolean> {
  try {
    const response = await fetch(OLLAMA_MODELS_URL, { signal: AbortSignal.timeout(2_000) })
    if (!response.ok) return false
    const body = (await response.json()) as { data?: Array<{ id?: string }> }
    return (body.data ?? []).some((model) => model.id === REVIEWER_MODEL)
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
        model: REVIEWER_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1
      }),
      signal: AbortSignal.timeout(120_000)
    })
  } catch {
    // A failed warm-up only costs speed; the assertions below still decide.
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

/** Adds the second provider: a real endpoint shape pointing at nothing. */
async function addBlackHoleProvider(): Promise<void> {
  await openProviderSettings(window)
  await window.getByTestId('providers-add').click()
  await window.getByTestId('preset-custom').click()
  await window.getByTestId('provider-name-input').fill('Black hole')
  await window.getByTestId('provider-base-url-input').fill(BLACK_HOLE_URL)
  await window.getByTestId('provider-api-key-input').fill('sk-not-a-real-key')
  await window.getByTestId('provider-add-model').click()
  await window.getByTestId('provider-add-model-input').fill(GHOST_MODEL)
  await window.getByTestId('provider-add-model-input').press('Enter')
  await window.getByTestId('provider-save').click()
  await expect(window.getByTestId('provider-card')).toHaveCount(2)
}

/** Creates one agent from an empty editor, on the named provider. */
async function createAgent(name: string, provider: string, model: string): Promise<void> {
  await window.getByTestId('agents-new').click()
  await window.getByTestId('agent-name').fill(name)
  await window.getByTestId('agent-provider').selectOption({ label: provider })
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

const memberRow = (agentId: string): Locator =>
  window.locator(`[data-testid="member-row"][data-agent-id="${agentId}"]`)
const memberDot = (agentId: string): Locator =>
  memberRow(agentId).locator('[data-testid="member-presence"]')
const messagesBy = (author: string): Locator =>
  window.locator(`[data-testid="message-item"][data-author="${author}"]`)

test.beforeAll(async () => {
  ready = await probeOllama()
  if (!ready) return
  await warmUpOllama()

  BLACK_HOLE_URL = await startBlackHole()
  userDataDir = createUserDataDir()
  ;({ app, window } = await launchWitena(userDataDir))
  mkdirSync(SHOTS_DIR, { recursive: true })
  await prepare()

  await addOllamaProvider(window, [REVIEWER_MODEL])
  await addBlackHoleProvider()

  await openAgents(window)
  await createAgent('Reviewer', 'Ollama', REVIEWER_MODEL)
  await createAgent('Ghost', 'Black hole', GHOST_MODEL)

  await window.getByTestId('nav-chats').click()
  await createChat(window)
  await expect(window.getByTestId('chat-item')).toHaveCount(1)
  await addMember('Reviewer')
  await addMember('Ghost')
  // Parallel, so the silent member cannot simply delay the one that answers.
  await window.getByTestId('chat-speaking-parallel').click()

  const agents = await invoke<Array<{ id: string; name: string }>>('agents.list')
  ghostId = agents.find((agent) => agent.name === 'Ghost')?.id ?? ''
  reviewerId = agents.find((agent) => agent.name === 'Reviewer')?.id ?? ''
  expect(ghostId).not.toBe('')
  expect(reviewerId).not.toBe('')

  const chats = await invoke<Array<{ id: string }>>('chats.list')
  await invoke('chats.update', {
    id: chats[0]?.id,
    patch: { settings: { stallTimeoutMs: STALL_MS, hardTimeoutMs: HARD_MS } }
  })
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) removeUserDataDir(userDataDir)
  blackHole?.close()
})

test('a silent member turns orange, then grey, and its message is skipped', async () => {
  test.skip(!ready, `${OLLAMA_MODELS_URL} did not offer ${REVIEWER_MODEL}; S2.4 needs one real model.`)
  test.setTimeout(TEST_MS)

  // Both members start red, and stay that way while they are answering.
  await expect(memberDot(ghostId)).toHaveAttribute('data-state', 'available')

  await window.getByTestId('composer-input').fill('In one short sentence, what is a mutex?')
  await window.getByTestId('composer-input').press('Enter')

  await expect(memberDot(ghostId)).toHaveAttribute('data-state', 'working', { timeout: AWAY_MS })
  // Orange: silent for longer than the stall budget, but nothing interrupted yet.
  await expect(memberDot(ghostId)).toHaveAttribute('data-state', 'away', { timeout: AWAY_MS })
  // Grey: the hard timeout aborted the request.
  await expect(memberDot(ghostId)).toHaveAttribute('data-state', 'offline', {
    timeout: OFFLINE_MS
  })

  // The acceptance screenshot: the member panel and the message avatars both
  // carrying their coloured dots, with the silent member greyed out.
  await window.screenshot({ path: join(SHOTS_DIR, 'presence.png') })

  // The message the aborted turn was writing into is `skipped`, not `error`.
  await expect(messagesBy('Ghost')).toHaveCount(1)
  await expect(messagesBy('Ghost').first()).toHaveAttribute('data-status', 'skipped')
  // …and the group is told why, by key rather than by sentence.
  await expect(window.locator('[data-notice-key="agentSkipped"]')).toHaveCount(1)
})

test('the member that works still answers and the run finishes', async () => {
  test.skip(!ready, 'no local Ollama with the reviewer model')
  test.setTimeout(TEST_MS)

  await expect(messagesBy('Reviewer').first()).toHaveAttribute('data-status', 'done', {
    timeout: REPLY_MS
  })
  // Back to Send: the run ended rather than hanging on the member that did not
  // answer, which is what the round barrier releasing on a skip means.
  await expect(window.getByTestId('composer-send')).toBeVisible({ timeout: REPLY_MS })
  await expect(
    window.locator('[data-testid="message-item"][data-status="streaming"]')
  ).toHaveCount(0)
  // The message avatar shows the agent's *current* state, so it is grey too.
  await expect(
    messagesBy('Ghost').first().locator('[data-testid="message-presence"]')
  ).toHaveAttribute('data-state', 'offline')
})

test('retrying an offline member whose provider is still dead keeps it offline', async () => {
  test.skip(!ready, 'no local Ollama with the reviewer model')
  test.setTimeout(TEST_MS)

  const retry = memberRow(ghostId).getByTestId('member-retry')
  await expect(retry).toBeVisible()
  await retry.click()

  // The probe reads the black hole's `/models` and times out; the button comes
  // back when it does, and nothing about the member has changed.
  await expect(retry).toBeEnabled({ timeout: 40_000 })
  await expect(memberDot(ghostId)).toHaveAttribute('data-state', 'offline')
  await expect(memberRow(ghostId).getByTestId('member-model')).toHaveAttribute(
    'data-presence',
    'offline'
  )
})
