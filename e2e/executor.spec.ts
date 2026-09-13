/**
 * The executor: the role and the chat's working directory (S5.2), then the
 * permission prompt and the diff block (S5.5).
 *
 * Everything up to the restart is **offline** — it is all configuration, and no
 * message is ever sent — and always runs. The last two tests are the S5.5
 * acceptance sentence: an executor bound to a temporary folder is asked to
 * create a file, the prompt card appears, Allow is clicked, the file is on disk
 * and its diff is in the transcript. That needs a local model that can emit a
 * tool call, so it is skipped — explicitly, in the report — when `qwen2.5:3b` is
 * not pulled, exactly as `mcp.spec.ts` does; without it the file still asserts
 * that a chat with no executor shows no card.
 *
 * Two things are deliberately not driven through the UI:
 *
 * - **The folder picker.** `system.pickFolder` opens a native modal, which
 *   Playwright cannot answer. The "Choose…" button is therefore clicked nowhere;
 *   the binding is written through the backend client the same way the product
 *   would write it, and the assertions are on what the UI does with a bound
 *   chat. "Clear" *is* clicked, because it needs no dialog.
 * - **Adding a second executor.** The picker disables that candidate, so there
 *   is no click to make. The refusal itself is asserted against the backend,
 *   which is the authority; the greyed row is asserted in the UI.
 *
 * Every assertion is on a `data-testid` or a `data-*` value rather than on
 * rendered copy, so none of them depends on the active language, and no Chinese
 * appears in this file (CLAUDE.md rule #1).
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import {
  addOllamaProvider,
  createUserDataDir,
  launchWitena,
  openAgents,
  removeUserDataDir
} from './helpers'

/** Serial: one app, and each test builds on what the last one left behind. */
test.describe.configure({ mode: 'serial' })

const MODEL = 'qwen2.5:1.5b'

/**
 * The smallest local model that emits tool calls with any reliability, and the
 * same one `mcp.spec.ts` gates its tool test on. `qwen2.5:1.5b` answers fine but
 * rarely produces a well-formed tool call, which would make this a coin toss.
 */
const TOOL_MODEL = 'qwen2.5:3b'

/** Ollama's OpenAI-compatible endpoint, the same URL the `ollama` preset stores. */
const OLLAMA_MODELS_URL = 'http://localhost:11434/v1/models'

/** How many times the model is given a chance to reach for `write_file`. */
const TOOL_ATTEMPTS = 3

/** A cold Ollama has to load the weights before the first token appears. */
const TOOL_CALL_MS = 120_000

let app: ElectronApplication | undefined
let window: Page
let userDataDir: string
/** A real directory to bind the chat to, and a real file that is not one. */
let workdir: string
let notAFolder: string
/** The folder the executor is actually let loose in, in the S5.5 tests. */
let execdir: string
let toolModelAvailable = false

/** The preload bridge's envelope, restated here: `e2e/` may not import preload. */
type Envelope = { ok: true; value: unknown } | { ok: false; error: { code: string; details?: unknown } }

/**
 * Calls a backend method from inside the page, resolving with the envelope
 * rather than throwing, because half the calls here are meant to be refused.
 *
 * `globalThis.witena`, not `window.witena`: this file's `window` is the
 * Playwright `Page`, and the name would shadow the browser global inside the
 * callback. The same helper is in `presence.spec.ts`; it is four lines of
 * transport that no page object could usefully hide.
 */
async function call(method: string, input?: unknown): Promise<Envelope> {
  return (await window.evaluate(
    async (request) =>
      await (
        globalThis as unknown as {
          witena: { invoke(method: string, input?: unknown): Promise<unknown> }
        }
      ).witena.invoke(request.method, request.input),
    { method, input }
  )) as Envelope
}

/** Creates one agent from an empty editor, with the role the segmented control sets. */
async function createAgent(name: string, role: 'participant' | 'executor'): Promise<void> {
  await window.getByTestId('agents-new').click()
  await window.getByTestId('agent-name').fill(name)
  await window.getByTestId('agent-provider').selectOption({ index: 1 })
  await window.getByTestId('agent-model').selectOption(MODEL)
  if (role === 'executor') await window.getByTestId('agent-role-executor').click()
  await window.getByTestId('agent-save').click()
  await expect(window.getByTestId('agent-save')).toBeDisabled()
}

const memberRows = (): Locator => window.getByTestId('member-row')

/** Opens the picker and adds one agent by its visible name. */
async function addMember(name: string): Promise<void> {
  const before = await memberRows().count()
  await window.getByTestId('member-add').click()
  await window
    .getByTestId('member-picker')
    .getByTestId('member-candidate')
    .filter({ hasText: name })
    .click()
  await expect(memberRows()).toHaveCount(before + 1)
}

/** The id of the one chat this spec creates; read once it exists. */
async function selectedChatId(): Promise<string> {
  const envelope = await call('chats.list')
  expect(envelope.ok).toBe(true)
  const chats = (envelope as { value: { id: string }[] }).value
  return chats[0]?.id ?? ''
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

test.beforeAll(async () => {
  userDataDir = createUserDataDir()
  workdir = mkdtempSync(join(tmpdir(), 'witena-workdir-'))
  execdir = mkdtempSync(join(tmpdir(), 'witena-execdir-'))
  notAFolder = join(workdir, 'notes.md')
  writeFileSync(notAFolder, '# not a folder\n')
  toolModelAvailable = await probeOllamaModel(TOOL_MODEL)
  ;({ app, window } = await launchWitena(userDataDir))

  // Both models are typed in rather than fetched, like every other spec: the
  // second one is only used by the two tests at the end, and typing it costs
  // nothing when they are skipped.
  await addOllamaProvider(window, [MODEL, TOOL_MODEL])
  await openAgents(window)
  await createAgent('Reviewer', 'participant')
  await createAgent('Hands', 'executor')
  await createAgent('Builder', 'executor')
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) removeUserDataDir(userDataDir)
  if (workdir) rmSync(workdir, { recursive: true, force: true })
  if (execdir) rmSync(execdir, { recursive: true, force: true })
})

test('the agent list tags the executors and only the executors', async () => {
  await openAgents(window)

  await expect(window.getByTestId('agent-item')).toHaveCount(3)
  await expect(window.getByTestId('agent-item-executor')).toHaveCount(2)
  await expect(
    window.getByTestId('agent-item').filter({ hasText: 'Reviewer' }).getByTestId('agent-item-executor')
  ).toHaveCount(0)

  // The role survived the save, and the editor's explanation is on screen.
  await window.getByTestId('agent-item').filter({ hasText: 'Hands' }).click()
  await expect(window.getByTestId('agent-role-executor')).toHaveAttribute('aria-pressed', 'true')
  await expect(window.getByTestId('agent-role-hint')).toBeVisible()
})

test('an executor member shows the badge in the member panel', async () => {
  await window.getByTestId('nav-chats').click()
  await window.getByTestId('chats-new').click()
  await expect(window.getByTestId('chat-item')).toHaveCount(1)

  await addMember('Reviewer')
  await addMember('Hands')

  await expect(memberRows()).toHaveCount(2)
  await expect(window.getByTestId('member-executor')).toHaveCount(1)
  await expect(
    memberRows().filter({ hasText: 'Hands' }).getByTestId('member-executor')
  ).toBeVisible()
})

test('the picker greys the second executor, and the backend refuses it outright', async () => {
  await window.getByTestId('member-add').click()
  const candidate = window.getByTestId('member-candidate').filter({ hasText: 'Builder' })

  await expect(candidate).toHaveAttribute('data-blocked', 'true')
  await expect(candidate).toBeDisabled()
  await window.getByTestId('member-add').click()

  // The picker is the explanation; this is the rule. A second window, or a
  // future HTTP client, meets the same refusal.
  const chatId = await selectedChatId()
  const agents = (await call('agents.list')) as { value: { id: string; name: string }[] }
  const ids = agents.value
    .filter((agent) => agent.name !== 'Reviewer')
    .map((agent) => agent.id)
  const refused = await call('chats.members.set', { chatId, agentIds: ids })

  expect(refused.ok).toBe(false)
  expect(refused).toMatchObject({ error: { code: 'validation', details: { reason: 'second_executor' } } })
  await expect(memberRows()).toHaveCount(2)
})

test('binding a folder shows its name as a chip, and Clear removes it', async () => {
  const chatId = await selectedChatId()

  await expect(window.getByTestId('chat-workdir-chip')).toHaveCount(0)
  expect((await call('chats.update', { id: chatId, patch: { workdir } })).ok).toBe(true)

  // The `chat.updated` event is what re-renders the header, with no reload.
  const chip = window.getByTestId('chat-workdir-chip')
  await expect(chip).toHaveText(basename(workdir))
  await expect(chip).toHaveAttribute('title', workdir)
  await expect(window.getByTestId('chat-workdir')).toHaveAttribute('data-path', workdir)

  await window.getByTestId('chat-workdir-clear').click()
  await expect(window.getByTestId('chat-workdir-chip')).toHaveCount(0)
  await expect(window.getByTestId('chat-workdir')).toHaveAttribute('data-path', '')
})

test('an invalid path is refused with a reason the renderer can translate', async () => {
  const chatId = await selectedChatId()

  const relative = await call('chats.update', { id: chatId, patch: { workdir: 'code/witena' } })
  expect(relative).toMatchObject({
    error: { code: 'validation', details: { reason: 'workdir_not_absolute' } }
  })

  const missing = await call('chats.update', {
    id: chatId,
    patch: { workdir: join(workdir, 'gone') }
  })
  expect(missing).toMatchObject({
    error: { code: 'validation', details: { reason: 'workdir_missing' } }
  })

  const file = await call('chats.update', { id: chatId, patch: { workdir: notAFolder } })
  expect(file).toMatchObject({
    error: { code: 'validation', details: { reason: 'workdir_not_directory' } }
  })

  await expect(window.getByTestId('chat-workdir-chip')).toHaveCount(0)
})

test('the binding and the roles survive a restart', async () => {
  const chatId = await selectedChatId()
  expect((await call('chats.update', { id: chatId, patch: { workdir } })).ok).toBe(true)
  await expect(window.getByTestId('chat-workdir-chip')).toBeVisible()

  await app?.close()
  ;({ app, window } = await launchWitena(userDataDir))
  await window.getByTestId('nav-chats').click()
  await window.getByTestId('chat-item').first().click()

  await expect(window.getByTestId('chat-workdir-chip')).toHaveText(basename(workdir))
  await expect(window.getByTestId('member-executor')).toHaveCount(1)
})

/* -------------------------------------------------------------------------- */
/* S5.5: the permission prompt and the diff block                              */
/* -------------------------------------------------------------------------- */

test('a chat with no executor shows no permission card', async () => {
  // The offline half of the acceptance sentence, and the one that always runs:
  // nothing can be waiting on a chat whose members cannot write anything.
  await window.getByTestId('nav-chats').click()
  await window.getByTestId('chats-new').click()
  await addMember('Reviewer')

  await expect(memberRows()).toHaveCount(1)
  await expect(window.getByTestId('member-executor')).toHaveCount(0)
  await expect(window.getByTestId('permission-card')).toHaveCount(0)
  await expect(window.getByTestId('permission-stack')).toHaveCount(0)
})

test('the executor asks before writing, and the diff appears once it is allowed', async () => {
  test.skip(
    !toolModelAvailable,
    `${TOOL_MODEL} is not available on ${OLLAMA_MODELS_URL}; the permission-prompt test needs a local model that can call tools.`
  )
  test.setTimeout(TOOL_ATTEMPTS * TOOL_CALL_MS + 120_000)

  // A model that can call tools, and a prompt that leaves it in no doubt about
  // which one. The rest of the spec's agents keep the smaller model.
  await openAgents(window)
  await window.getByTestId('agent-item').filter({ hasText: 'Hands' }).click()
  await window.getByTestId('agent-model').selectOption(TOOL_MODEL)
  await window
    .getByTestId('agent-system-prompt')
    .fill('You write files with the write_file tool. When asked for a file, call write_file once with the path and the content, then say what you wrote.')
  await window.getByTestId('agent-save').click()
  await expect(window.getByTestId('agent-save')).toBeDisabled()

  // A chat of its own: one member, so nobody else speaks, and its own folder, so
  // the assertions are about files this test created.
  await window.getByTestId('nav-chats').click()
  await window.getByTestId('chats-new').click()
  await addMember('Hands')
  const chatId = await selectedChatId()
  expect((await call('chats.update', { id: chatId, patch: { workdir: execdir } })).ok).toBe(true)
  await expect(window.getByTestId('chat-workdir-chip')).toHaveText(basename(execdir))

  const card = window.getByTestId('permission-card')
  const agentMessages = window.locator('[data-testid="message-item"][data-sender="agent"]')
  let asked = false

  // A 3B model is not reliably a tool caller; three tries is the difference
  // between a spec that measures the feature and one that measures the weather.
  for (let attempt = 0; attempt < TOOL_ATTEMPTS && !asked; attempt += 1) {
    await window
      .getByTestId('composer-input')
      .fill('Create a file called HELLO.md containing the single line: Hello from Witena.')
    await window.getByTestId('composer-input').press('Enter')

    try {
      await expect(card.first()).toBeVisible({ timeout: TOOL_CALL_MS })
      asked = true
    } catch {
      // The reply has to have finished before the next attempt, or the second
      // message would be sent into a running chat.
      await expect(agentMessages.last()).not.toHaveAttribute('data-status', 'streaming', {
        timeout: TOOL_CALL_MS
      })
    }
  }

  expect(
    asked,
    `${TOOL_MODEL} did not reach for a gated tool in ${TOOL_ATTEMPTS} attempts. The gate itself is covered by the unit suite; this case measures a small local model's willingness to call a tool.`
  ).toBe(true)

  // Nothing has been written yet: the turn is suspended inside the tool call.
  expect(readdirSync(execdir)).toEqual([])

  await card.first().getByTestId('permission-allow').click()

  // The card goes away on `permission.resolved`, the file is on disk, and the
  // finished turn appends the diff block that says what changed.
  await expect(card).toHaveCount(0, { timeout: TOOL_CALL_MS })
  await expect
    .poll(() => readdirSync(execdir).length, { timeout: TOOL_CALL_MS })
    .toBeGreaterThan(0)

  const diff = window.getByTestId('diff-block')
  await expect(diff.first()).toBeVisible({ timeout: TOOL_CALL_MS })
  const written = readdirSync(execdir)[0] ?? ''
  expect(existsSync(join(execdir, written))).toBe(true)
  await expect(diff.first().getByTestId('diff-block-path')).toHaveText(written)

  // Collapsed by default; opening it renders the patch through the shared code
  // block in the `diff` language.
  await diff.first().getByTestId('diff-block-toggle').click()
  await expect(diff.first().getByTestId('code-block')).toHaveAttribute('data-language', 'diff')
})
