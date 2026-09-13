/**
 * The S2.1 acceptance test: agents are created, configured, duplicated, deleted
 * and still there after a restart.
 *
 * Entirely **offline**, unlike `chat.spec.ts`. The step's acceptance is about the
 * records and the screen, not about tokens: the Ollama provider is added with its
 * model ids typed in rather than fetched, and nothing here ever sends a prompt.
 * That keeps the spec meaningful on a machine with no local model running.
 *
 * Every assertion is on a `data-testid` or a `data-*` value rather than on
 * rendered copy, so none of them depends on the active language — and no Chinese
 * appears in this file (CLAUDE.md rule #1).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import {
  addOllamaProvider,
  addProviderModel,
  createUserDataDir,
  launchWitena,
  locale,
  openAgents,
  openProviderSettings,
  removeUserDataDir,
  repoRoot
} from './helpers'

/** Serial: the tests share one app and each builds on what the last one stored. */
test.describe.configure({ mode: 'serial' })

const SHOTS_DIR = process.env['WITENA_SHOTS_DIR'] ?? join(repoRoot, 'test-results', 'shots')

/** The artboard size, so the screenshot lines up with the mockup. */
const WINDOW_SIZE = { width: 1440, height: 900 }

const FIRST_MODEL = 'qwen2.5:1.5b'
const SECOND_MODEL = 'llama3.2:3b'

const zhCN = locale('zh-CN')

let app: ElectronApplication | undefined
let window: Page
let userDataDir: string

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

/** Fills the editor that is currently open and saves it. */
async function fillAgent(name: string, model: string, prompt: string): Promise<void> {
  await window.getByTestId('agent-name').fill(name)
  // One provider exists, so its option is the only non-placeholder one.
  await window.getByTestId('agent-provider').selectOption({ index: 1 })
  await window.getByTestId('agent-model').selectOption(model)
  await window.getByTestId('agent-system-prompt').fill(prompt)

  await expect(window.getByTestId('agent-save')).toBeEnabled()
  await window.getByTestId('agent-save').click()
}

const agentItems = () => window.getByTestId('agent-item')

test.beforeAll(async () => {
  userDataDir = createUserDataDir()
  ;({ app, window } = await launchWitena(userDataDir))
  mkdirSync(SHOTS_DIR, { recursive: true })
  await prepare()
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) removeUserDataDir(userDataDir)
})

test('starts with an empty library and a disabled Save', async () => {
  await addOllamaProvider(window, [FIRST_MODEL])
  await openAgents(window)

  await expect(agentItems()).toHaveCount(0)

  // A brand-new draft has no name, no provider and no model, so it cannot be
  // saved — and says which field is the problem rather than only greying out.
  await window.getByTestId('agents-new').click()
  await expect(window.getByTestId('agent-save')).toBeDisabled()
  await expect(window.getByTestId('agent-name-error')).toBeVisible()
})

test('creates an agent with a provider, a model and a system prompt', async () => {
  await fillAgent('Reviewer', FIRST_MODEL, 'You review other members answers and point out risks.')

  await expect(agentItems()).toHaveCount(1)
  await expect(window.getByTestId('agent-item-name')).toHaveText('Reviewer')
  await expect(window.getByTestId('agent-item-model')).toContainText(FIRST_MODEL)
  // Saving leaves the editor on the record it produced, now clean.
  await expect(window.getByTestId('agent-save')).toBeDisabled()
})

test('rejects a second agent with the same name', async () => {
  await window.getByTestId('agents-new').click()
  await window.getByTestId('agent-name').fill('reviewer')

  await expect(window.getByTestId('agent-name-error')).toBeVisible()
  await expect(window.getByTestId('agent-save')).toBeDisabled()
})

test('creates a second agent on a second model of the same provider', async () => {
  // The model has to exist on the provider before an agent can pick it.
  await openProviderSettings(window)
  await window.getByTestId('provider-card').click()
  await addProviderModel(window, SECOND_MODEL)
  await window.getByTestId('provider-save').click()

  await openAgents(window)
  await window.getByTestId('agents-new').click()
  await fillAgent('Architect', SECOND_MODEL, 'You propose a system design and name the trade-offs.')

  await expect(agentItems()).toHaveCount(2)
  await expect(
    agentItems().filter({ hasText: 'Architect' }).getByTestId('agent-item-model')
  ).toContainText(SECOND_MODEL)

  // The acceptance screenshot: the configuration editor, filled in.
  await window.screenshot({ path: join(SHOTS_DIR, 'agents.png') })
})

test('duplicates an agent under a free name', async () => {
  await agentItems().filter({ hasText: 'Architect' }).click()
  await window.getByTestId('agent-duplicate').click()

  await expect(agentItems()).toHaveCount(3)
  await expect(agentItems().filter({ hasText: 'Architect copy' })).toHaveCount(1)
  // The copy is what the editor is now on, so the next action applies to it.
  await expect(window.getByTestId('agent-editor-name')).toHaveText('Architect copy')
})

test('deletes the copy, but only on the second click', async () => {
  await window.getByTestId('agent-delete').click()
  // The first click only arms it; nothing has been removed yet.
  await expect(agentItems()).toHaveCount(3)

  await window.getByTestId('agent-delete').click()
  await expect(agentItems()).toHaveCount(2)
  await expect(agentItems().filter({ hasText: 'Architect copy' })).toHaveCount(0)
})

test('both agents and their configuration survive a restart', async () => {
  await app?.close()
  ;({ app, window } = await launchWitena(userDataDir))
  await prepare()
  await openAgents(window)

  await expect(agentItems()).toHaveCount(2)
  await expect(agentItems().nth(0).getByTestId('agent-item-name')).toHaveText('Reviewer')
  await expect(agentItems().nth(1).getByTestId('agent-item-name')).toHaveText('Architect')

  await agentItems().nth(1).click()
  await expect(window.getByTestId('agent-model')).toHaveValue(SECOND_MODEL)
  await expect(window.getByTestId('agent-system-prompt')).toHaveValue(
    'You propose a system design and name the trade-offs.'
  )
})
