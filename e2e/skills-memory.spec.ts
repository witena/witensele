/**
 * The S3.2 and S3.3 acceptance test: the skill shipped with the build, bound to
 * an agent, read by a real model, and a fact the same model remembered surviving
 * a restart.
 *
 * ## What is real here
 *
 * Everything on disk. The `architecture-review` skill is not written by this
 * spec: it is the folder in `resources/skills/`, copied into the temporary
 * `userData` by the app's own first-launch seeding, which is the only way to
 * prove that path works. The memory files are likewise the ones a turn wrote,
 * read back by a **second launch** of the app rather than from a store the first
 * launch left in memory.
 *
 * ## The two halves, and why one of them may be marked fixme
 *
 * Everything except the two tool-call tests is offline and always runs. The tool
 * calls need a local model willing to emit one, so they are skipped when Ollama
 * is not answering, and — exactly as `mcp.spec.ts` does — retried a few times
 * before giving up. A 3B model that will not call a tool on a given day is a fact
 * about the model, not a regression in the app, so the case is marked
 * `test.fixme` rather than failing the suite; the same paths are covered
 * deterministically by `src/main/agents/agent-turn.test.ts`.
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
  openProviderSettings,
  openSkillSettings,
  removeUserDataDir,
  repoRoot
} from './helpers'

/** Serial: the tests share one app and each builds on what the last one stored. */
test.describe.configure({ mode: 'serial' })

const SHOTS_DIR = process.env['WITENA_SHOTS_DIR'] ?? join(repoRoot, 'test-results', 'shots')

/** The artboard size, so the screenshots line up with the mockup. */
const WINDOW_SIZE = { width: 1440, height: 900 }

/** The skill shipped in `resources/skills/`, seeded on first launch. */
const SKILL_NAME = 'architecture-review'

/** The file that skill bundles, which `read_skill_file` can reach. */
const SKILL_FILE = 'checklist.md'

/** Ollama's OpenAI-compatible endpoint, the same URL the `ollama` preset stores. */
const OLLAMA_MODELS_URL = 'http://localhost:11434/v1/models'

/** The smallest local model that emits tool calls with any reliability. */
const TOOL_MODEL = 'qwen2.5:3b'

/** How many times the model is given a chance to call a tool. */
const TOOL_ATTEMPTS = 3

/** A cold Ollama has to load the weights before the first token appears. */
const TOOL_CALL_MS = 120_000

/** The fact the agent is asked to remember, and looked for after the restart. */
const REMEMBERED = 'Witena'

const zhCN = locale('zh-CN')

let app: ElectronApplication | undefined
let window: Page
let userDataDir: string
let toolModelAvailable = false
/** Set by the memory test, read by the restart test that depends on it. */
let memorySaved = false

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

const agentMessages = () => window.locator('[data-testid="message-item"][data-sender="agent"]')

/**
 * Sends one prompt and waits for a tool card naming `tool`, retrying a few times.
 *
 * A small local model is not a reliable tool caller; three tries is the
 * difference between a spec that measures the feature and one that measures the
 * weather. Between attempts it waits for the reply to finish, because a second
 * message sent into a running chat would join that run instead of starting one.
 */
async function askUntilToolCalled(prompt: string, tool: string): Promise<boolean> {
  const card = window.locator(`[data-testid="tool-card"][data-tool="${tool}"]`)

  for (let attempt = 0; attempt < TOOL_ATTEMPTS; attempt += 1) {
    await window.getByTestId('composer-input').fill(prompt)
    await window.getByTestId('composer-input').press('Enter')
    try {
      await expect(card.first()).toBeVisible({ timeout: TOOL_CALL_MS })
      return true
    } catch {
      await expect(agentMessages().last()).not.toHaveAttribute('data-status', 'streaming', {
        timeout: TOOL_CALL_MS
      })
    }
  }
  return false
}

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

test('a fresh installation already has the skill shipped with the build', async () => {
  await openSkillSettings(window)

  const card = window.locator(`[data-testid="skill-card"][data-folder="${SKILL_NAME}"]`)
  await expect(card).toHaveCount(1)
  await expect(card.getByTestId('skill-card-description')).not.toBeEmpty()
  // It bundles one file, which is what `read_skill_file` will be asked for.
  await expect(card.getByTestId('skill-card-files')).not.toBeEmpty()
  // Nothing in `resources/skills/` may be unusable.
  await expect(window.getByTestId('skill-warning')).toHaveCount(0)
})

test('its detail pane shows the instructions and the bundled file', async () => {
  await window.locator(`[data-testid="skill-card"][data-folder="${SKILL_NAME}"]`).click()

  await expect(window.getByTestId('skill-detail-body')).toContainText('checklist', {
    ignoreCase: true
  })
  await expect(
    window.getByTestId('skill-detail-file').filter({ hasText: SKILL_FILE })
  ).toHaveCount(1)

  // The acceptance screenshot: the settings page with the real skill open.
  await window.screenshot({ path: join(SHOTS_DIR, 'skills.png') })
})

test('an agent can be given the skill and memory, and keeps both', async () => {
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

  const row = window.locator(`[data-testid="agent-skill-item"][data-skill="${SKILL_NAME}"]`)
  await expect(row).toHaveCount(1)
  await expect(row).toHaveAttribute('data-missing', 'false')
  await row.getByTestId('agent-skill-checkbox').check()

  const memoryToggle = window.getByTestId('agent-memory-toggle').getByRole('switch')
  await expect(memoryToggle).toHaveAttribute('aria-checked', 'false')
  await memoryToggle.click()
  await expect(memoryToggle).toHaveAttribute('aria-checked', 'true')

  await window.getByTestId('agent-save').click()
  await expect(window.getByTestId('agent-item')).toHaveCount(1)

  // Saved: the memory panel exists and has nothing in it yet.
  await expect(window.getByTestId('memory-index')).toBeVisible()
  await expect(window.getByTestId('memory-entry')).toHaveCount(0)
})

test('the agent reads the skill with read_skill', async () => {
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

  const called = await askUntilToolCalled(
    `Use the read_skill tool to read the ${SKILL_NAME} skill and tell me its first checklist item.`,
    'read_skill'
  )

  test.fixme(
    !called,
    `${TOOL_MODEL} did not call read_skill in ${TOOL_ATTEMPTS} attempts. The tool path is covered deterministically by src/main/agents/agent-turn.test.ts; this case measures a small local model's willingness to call tools.`
  )

  const card = window.locator('[data-testid="tool-card"][data-tool="read_skill"]').first()
  await expect(card).toHaveAttribute('data-state', 'done', { timeout: TOOL_CALL_MS })
})

test('the agent remembers a fact with memory_save', async () => {
  test.skip(
    !toolModelAvailable,
    `${TOOL_MODEL} is not available on ${OLLAMA_MODELS_URL}; the tool-call test needs a local model that can call tools.`
  )
  test.setTimeout(TOOL_ATTEMPTS * TOOL_CALL_MS + 60_000)

  const called = await askUntilToolCalled(
    `Remember that my project is called ${REMEMBERED} using the memory_save tool.`,
    'memory_save'
  )
  memorySaved = called

  test.fixme(
    !called,
    `${TOOL_MODEL} did not call memory_save in ${TOOL_ATTEMPTS} attempts. The tool path is covered deterministically by src/main/agents/agent-turn.test.ts; this case measures a small local model's willingness to call tools.`
  )

  const card = window.locator('[data-testid="tool-card"][data-tool="memory_save"]').first()
  await expect(card).toHaveAttribute('data-state', 'done', { timeout: TOOL_CALL_MS })

  await window.screenshot({ path: join(SHOTS_DIR, 'memory.png') })
})

test('the note is still there after a restart', async () => {
  test.fixme(
    !memorySaved,
    'Nothing was remembered, because the model did not call memory_save; there is no note to find.'
  )

  await app?.close()
  ;({ app, window } = await launchWitena(userDataDir))
  await prepare()

  await openAgents(window)
  await window.getByTestId('agent-item').click()

  // Read from `userData/memory/<agentId>/` by a process that has just started,
  // so nothing about this can be a store that survived in memory.
  await expect(window.getByTestId('memory-entry').first()).toBeVisible()
  await window.getByTestId('memory-entry').first().click()
  await expect(window.getByTestId('memory-content')).toContainText(REMEMBERED)
})
