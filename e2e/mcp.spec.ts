/**
 * The S3.1 acceptance test: a real MCP server, registered through the UI, bound
 * to an agent, and — if a local model that can use tools is available — actually
 * called from a chat.
 *
 * ## What is real here
 *
 * `@modelcontextprotocol/server-everything` is spawned for real, over stdio, by
 * `npx`. That is the point of the step: the unit suite already proves the manager
 * against an in-process server (`src/main/mcp/manager.test.ts`), so what is left
 * to prove is the part only a shipped app can show — a child process spawned from
 * a packaged main process, with the user's `PATH`, talking MCP over pipes.
 *
 * The first run downloads the package, hence the generous budget on the probe.
 *
 * Since S5.1 the server is registered **through the connector gallery** — the
 * `everything` tile, then Test, then Save — so the spec also proves that what a
 * preset writes into the draft is a configuration that actually connects, which
 * is the one claim a unit test over static data cannot make.
 *
 * ## The two halves, and why one of them may be skipped
 *
 * Everything up to and including the restart is **offline** and always runs.
 * The last test needs a local model that can emit a tool call, so it is skipped —
 * explicitly, in the report — when Ollama is not answering or the model is not
 * pulled. Small local models are also genuinely unreliable at tool calling, so it
 * retries a few times before giving up rather than failing the suite on a model's
 * bad day.
 *
 * Every assertion is on a `data-testid` or a `data-*` value rather than on
 * rendered copy, so none of them depends on the active language — and no Chinese
 * appears in this file (CLAUDE.md rule #1).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import {
  createUserDataDir,
  launchWitena,
  locale,
  openAgents,
  openMcpSettings,
  openProviderSettings,
  removeUserDataDir,
  repoRoot
} from './helpers'

/** Serial: the tests share one app and each builds on what the last one stored. */
test.describe.configure({ mode: 'serial' })

const SHOTS_DIR = process.env['WITENA_SHOTS_DIR'] ?? join(repoRoot, 'test-results', 'shots')

/** The artboard size, so the screenshot lines up with the mockup. */
const WINDOW_SIZE = { width: 1440, height: 900 }

/**
 * The reference server from PLAN.md's milestone list, which S5.1 made the first
 * tile of the connector gallery. The name is the preset **id**, because that is
 * what `applyPreset` writes into an untouched name field.
 */
const SERVER_NAME = 'everything'
const SERVER_COMMAND = 'npx'
const SERVER_ARG_FLAG = '-y'
const SERVER_ARG_PACKAGE = '@modelcontextprotocol/server-everything'
const SERVER_ARGS = [SERVER_ARG_FLAG, SERVER_ARG_PACKAGE].join('\n')

/** The first probe may have to download the package before it can spawn it. */
const FIRST_CONNECT_MS = 120_000

/** Ollama's OpenAI-compatible endpoint, the same URL the `ollama` preset stores. */
const OLLAMA_MODELS_URL = 'http://localhost:11434/v1/models'

/**
 * The smallest local model that emits tool calls with any reliability.
 *
 * `qwen2.5:1.5b` — what the other specs use — answers fine but rarely produces a
 * well-formed tool call, so the tool test would be a coin toss. 3B is the step up
 * that makes it usually work; "usually" is why the test retries.
 */
const TOOL_MODEL = 'qwen2.5:3b'

/** How many times the model is given a chance to call the tool. */
const TOOL_ATTEMPTS = 3

/** A cold Ollama has to load the weights before the first token appears. */
const TOOL_CALL_MS = 120_000

const zhCN = locale('zh-CN')

let app: ElectronApplication | undefined
let window: Page
let userDataDir: string
let toolModelAvailable = false

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

const serverCards = () => window.getByTestId('mcp-card')
const agentMessages = () => window.locator('[data-testid="message-item"][data-sender="agent"]')

test.beforeAll(async () => {
  toolModelAvailable = await probeOllamaModel(TOOL_MODEL)
  userDataDir = createUserDataDir()
  ;({ app, window } = await launchWitena(userDataDir))
  mkdirSync(SHOTS_DIR, { recursive: true })
  await prepare()
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) removeUserDataDir(userDataDir)
})

test('starts with no servers and an editor that cannot be saved empty', async () => {
  await openMcpSettings(window)
  await expect(serverCards()).toHaveCount(0)

  await window.getByTestId('mcp-add').click()
  // A fresh draft has no name and no command, so neither Test nor Save is live.
  await expect(window.getByTestId('mcp-save')).toBeDisabled()
  await expect(window.getByTestId('mcp-test')).toBeDisabled()
  // The gallery is part of what "Add server" opens (S5.1).
  await expect(window.getByTestId(`mcp-preset-${SERVER_NAME}`)).toBeVisible()
})

test('connects to server-everything and lists its tools before saving', async () => {
  test.setTimeout(FIRST_CONNECT_MS + 60_000)

  // Registered through the gallery rather than typed from memory: one click has
  // to produce a draft that can be probed as it stands.
  await window.getByTestId(`mcp-preset-${SERVER_NAME}`).click()
  await expect(window.getByTestId('mcp-name-input')).toHaveValue(SERVER_NAME)
  await expect(window.getByTestId('mcp-command-input')).toHaveValue(SERVER_COMMAND)
  await expect(window.getByTestId('mcp-args-input')).toHaveValue(SERVER_ARGS)
  // `everything` only reads, so the preset must leave the switch alone.
  await expect(window.getByTestId('mcp-side-effects').getByRole('switch')).toHaveAttribute(
    'aria-checked',
    'false'
  )

  // The arguments box is still typed into by hand, key by key with a real Enter
  // between the two arguments, rather than with `fill`: the box once erased a
  // typed newline on the next render (the draft stores a normalised list, and
  // rendering it back dropped the empty second line), and neither a single
  // change event nor a preset ever exercises that path.
  const args = window.getByTestId('mcp-args-input')
  await args.click()
  await args.press('ControlOrMeta+a')
  await args.press('Backspace')
  await expect(args).toHaveValue('')
  await args.pressSequentially(SERVER_ARG_FLAG)
  await args.press('Enter')
  await args.pressSequentially(SERVER_ARG_PACKAGE)
  await expect(args).toHaveValue(SERVER_ARGS)

  // The probe runs against the draft: nothing has been stored yet.
  await expect(window.getByTestId('mcp-test')).toBeEnabled()
  await window.getByTestId('mcp-test').click()

  const result = window.getByTestId('mcp-test-result')
  await expect(result).toHaveAttribute('data-ok', 'true', { timeout: FIRST_CONNECT_MS })
  // `echo` is the tool the chat test below asks for by name.
  await expect(window.locator('[data-testid="mcp-tool"][data-tool="echo"]')).toHaveCount(1)

  // The acceptance screenshot: the settings page with a real tool list on it.
  await window.screenshot({ path: join(SHOTS_DIR, 'mcp.png') })
})

test('saves the server and shows it as connected with a tool count', async () => {
  await window.getByTestId('mcp-save').click()

  await expect(serverCards()).toHaveCount(1)
  await expect(window.getByTestId('mcp-card-name')).toHaveText(SERVER_NAME)
  await expect(window.getByTestId('mcp-card-transport')).toHaveText('stdio')
  // The probe that ran against the draft belongs to the row it became.
  await expect(window.getByTestId('mcp-card-status')).toHaveAttribute('data-status', 'connected')
  await expect(window.getByTestId('mcp-card-tools')).not.toBeEmpty()
  // Saving leaves the editor on the stored row, where the gallery is gone: a
  // preset rewrites a command and an environment, which is a new registration.
  await expect(window.getByTestId(`mcp-preset-${SERVER_NAME}`)).toHaveCount(0)
})

test('rejects a second server with the same name', async () => {
  await window.getByTestId('mcp-add').click()
  await window.getByTestId('mcp-name-input').fill(SERVER_NAME.toUpperCase())
  await window.getByTestId('mcp-command-input').fill(SERVER_COMMAND)
  await window.getByTestId('mcp-save').click()

  await expect(window.getByTestId('mcp-error')).toBeVisible()
  await expect(serverCards()).toHaveCount(1)
})

test('binds the server to an agent and shows its tool count in the checklist', async () => {
  test.setTimeout(FIRST_CONNECT_MS + 60_000)

  // An agent needs a provider and a model before it can be saved at all.
  await openProviderSettings(window)
  await window.getByTestId('providers-add').click()
  await window.getByTestId('preset-ollama').click()
  await window.getByTestId('provider-add-model').click()
  await window.getByTestId('provider-add-model-input').fill(TOOL_MODEL)
  await window.getByTestId('provider-add-model-input').press('Enter')
  await window.getByTestId('provider-save').click()
  await expect(window.getByTestId('provider-card')).toHaveCount(1)

  await openAgents(window)
  await window.getByTestId('agents-new').click()
  await window.getByTestId('agent-name').fill('Reviewer')
  await window.getByTestId('agent-provider').selectOption({ index: 1 })
  await window.getByTestId('agent-model').selectOption(TOOL_MODEL)
  await window
    .getByTestId('agent-system-prompt')
    .fill('You use the tools you are given, then say what they returned.')

  const row = window.getByTestId('agent-mcp-item')
  await expect(row).toHaveCount(1)
  await expect(row.getByTestId('agent-mcp-name')).toHaveText(SERVER_NAME)
  // Read-only server, participant agent: the row is usable.
  await expect(row).toHaveAttribute('data-blocked', 'false')
  await row.getByTestId('agent-mcp-checkbox').check()
  await expect(row.getByTestId('agent-mcp-tools')).not.toBeEmpty({ timeout: FIRST_CONNECT_MS })

  await window.getByTestId('agent-save').click()
  await expect(window.getByTestId('agent-item')).toHaveCount(1)
})

test('the server and the binding survive a restart', async () => {
  await app?.close()
  ;({ app, window } = await launchWitena(userDataDir))
  await prepare()

  await openMcpSettings(window)
  await expect(serverCards()).toHaveCount(1)
  await expect(window.getByTestId('mcp-card-name')).toHaveText(SERVER_NAME)
  // A probe result is runtime state, so a restarted app has forgotten it.
  await expect(window.getByTestId('mcp-card-status')).toHaveAttribute('data-status', 'untested')

  await openAgents(window)
  await window.getByTestId('agent-item').click()
  await expect(
    window.getByTestId('agent-mcp-item').getByTestId('agent-mcp-checkbox')
  ).toBeChecked()
})

test('an agent calls the echo tool and a tool card appears', async () => {
  test.skip(
    !toolModelAvailable,
    `${TOOL_MODEL} is not available on ${OLLAMA_MODELS_URL}; the tool-call test needs a local model that can call tools.`
  )
  test.setTimeout(TOOL_ATTEMPTS * TOOL_CALL_MS + 60_000)

  await window.getByTestId('nav-chats').click()
  await window.getByTestId('chats-new').click()
  await expect(window.getByTestId('composer-input')).toBeEnabled()
  if ((await window.getByTestId('member-row').count()) === 0) {
    await window.getByTestId('member-add').click()
    await window.getByTestId('member-candidate').first().click()
  }
  await expect(window.getByTestId('member-row')).toHaveCount(1)

  const card = window.getByTestId('tool-card')
  let called = false

  // A 3B model is not reliably a tool caller. Three tries is the difference
  // between a spec that measures the feature and one that measures the weather.
  for (let attempt = 0; attempt < TOOL_ATTEMPTS && !called; attempt += 1) {
    await window
      .getByTestId('composer-input')
      .fill('Use the echo tool with the message WITENA-42 and then tell me what it returned.')
    await window.getByTestId('composer-input').press('Enter')

    try {
      await expect(card.first()).toBeVisible({ timeout: TOOL_CALL_MS })
      called = true
    } catch {
      // The reply has to be finished before the next attempt, or the second
      // message would be sent into a running chat.
      await expect(agentMessages().last()).not.toHaveAttribute('data-status', 'streaming', {
        timeout: TOOL_CALL_MS
      })
    }
  }

  expect(
    called,
    `${TOOL_MODEL} did not emit a tool call in ${TOOL_ATTEMPTS} attempts. The MCP path is covered by the unit suite; this case measures a small local model's willingness to call tools.`
  ).toBe(true)

  // The card names the server and the tool, and its result is not an error.
  await expect(card.first()).toHaveAttribute('data-tool', 'echo')
  await expect(card.first()).toHaveAttribute('data-server', SERVER_NAME)
  await expect(card.first()).toHaveAttribute('data-state', 'done', { timeout: TOOL_CALL_MS })

  await window.screenshot({ path: join(SHOTS_DIR, 'chat-tool.png') })
})
