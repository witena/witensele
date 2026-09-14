/**
 * The executor: the role and the chat's working directory (S5.2), the permission
 * prompt and the diff block (S5.5), the hand-off with its review round (S5.6),
 * the chat goal that briefs all of them (S5.10), the read-only tools plus the
 * materials briefing every member now gets (S5.11), and the goal-aware delivery
 * that closes the loop (S5.12).
 *
 * Everything up to the hand-off button's disabled states is **offline** — it is
 * all configuration, and no message is ever sent — and always runs. The three
 * tests at the end are the S5.5 and S5.6 acceptance sentences: an executor bound
 * to a temporary folder is asked to create a file, the prompt card appears,
 * Allow is clicked, the file is on disk and its diff is in the transcript; and
 * then two participants plus an executor discuss, the work is handed over, a
 * file appears and a participant reviews it. S5.11 adds a fourth: a participant
 * answers from a marked material with no tool call at all, and then reads an
 * unmarked file with `read_file`. Those need a local model that can
 * emit a tool call, so they are skipped — explicitly, in the report — when
 * `qwen2.5:3b` is not pulled, exactly as `mcp.spec.ts` does. Without it the file
 * still asserts that a chat with no executor shows no card, and that the
 * hand-off button is disabled with the reason on it.
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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

/** The token the marked material carries, which a grounded first reply repeats. */
const BRIEF_CODEWORD = 'WITENA-KITE-7'

/** …and the one only in the file nobody marked, which takes a `read_file` call. */
const SECRET_CODEWORD = 'WITENA-STRING-9'

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
/** A folder of its own for the S5.6 hand-off, so its assertions are about it. */
let handoffdir: string
/** And one for the S5.10 goal, holding the file its materials name. */
let goaldir: string
/** The S5.11 folder: one marked file and one the group has to go and read. */
let materialsdir: string
/** The S5.12 folder: empty, so the deliverable appearing in it is this chat's doing. */
let deliverdir: string
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
  handoffdir = mkdtempSync(join(tmpdir(), 'witena-handoff-'))
  goaldir = mkdtempSync(join(tmpdir(), 'witena-goaldir-'))
  writeFileSync(join(goaldir, 'notes.md'), '# material\n')
  deliverdir = mkdtempSync(join(tmpdir(), 'witena-deliver-'))
  materialsdir = mkdtempSync(join(tmpdir(), 'witena-materials-'))
  writeFileSync(
    join(materialsdir, 'BRIEF.md'),
    `# Brief\n\nThe codeword for this project is ${BRIEF_CODEWORD}.\n`
  )
  writeFileSync(
    join(materialsdir, 'SECRET.md'),
    `# Secret\n\nThe codeword in this file is ${SECRET_CODEWORD}.\n`
  )
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
  if (handoffdir) rmSync(handoffdir, { recursive: true, force: true })
  if (goaldir) rmSync(goaldir, { recursive: true, force: true })
  if (materialsdir) rmSync(materialsdir, { recursive: true, force: true })
  if (deliverdir) rmSync(deliverdir, { recursive: true, force: true })
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

/**
 * S5.6, offline half: the button is disabled without a folder or an executor and
 * enabled with both, which is the step's acceptance sentence for everything a
 * model is not needed for. The chat this runs on is the one the tests above
 * built: Reviewer + Hands, bound to `workdir`.
 */
test('the hand-off button needs a folder and an executor, and says which is missing', async () => {
  const chatId = await selectedChatId()
  const handoff = window.getByTestId('chat-handoff')

  await expect(handoff).toBeEnabled()
  await expect(handoff).toHaveAttribute('data-blocked', '')

  // No folder: the reason is on the element, so this assertion does not depend
  // on the active language.
  await window.getByTestId('chat-workdir-clear').click()
  await expect(handoff).toBeDisabled()
  await expect(handoff).toHaveAttribute('data-blocked', 'handoff_no_workdir')

  expect((await call('chats.update', { id: chatId, patch: { workdir } })).ok).toBe(true)
  await expect(handoff).toBeEnabled()

  // No executor: the folder is still bound, so this is the second rule and not
  // the first one again. The member is removed through the panel rather than
  // through `chats.members.set`, because a membership written from outside this
  // window is not pushed back into the member list today (see
  // `docs/features/chats/`); the button reads the list the panel is drawing.
  await memberRows().filter({ hasText: 'Hands' }).getByTestId('member-remove').click()
  await expect(memberRows()).toHaveCount(1)
  await expect(handoff).toBeDisabled()
  await expect(handoff).toHaveAttribute('data-blocked', 'handoff_no_executor')

  // …and the backend refuses it on the same rule, for a client that never saw
  // the disabled button.
  expect(await call('chat.handoff', { chatId })).toMatchObject({
    error: { code: 'validation', details: { reason: 'handoff_no_executor' } }
  })
})

/* -------------------------------------------------------------------------- */
/* S5.10: the chat goal                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The step's acceptance sentence, offline: a `document` goal on a chat bound to
 * a folder draws a chip carrying the deliverable's name, and the chip reads
 * "delivered" once the file is really there.
 *
 * The two native dialogs behind "Choose…" and "Add…" are not driven, for the
 * same reason the folder picker is not: Playwright cannot answer a native modal.
 * The goal is written through the backend client, which is the same call the
 * panel makes, and the assertions are about what the UI does with it.
 *
 * The second `chats.update` is not a contrivance: "delivered" is a fact about
 * the filesystem, which the renderer re-reads whenever the chat changes, and
 * editing the goal is exactly such a change. S5.12 is what makes an executor
 * turn refresh it too.
 */
test('a document goal shows the deliverable, and says so once it is written', async () => {
  await window.getByTestId('nav-chats').click()
  await window.getByTestId('chats-new').click()
  await addMember('Reviewer')
  const chatId = await selectedChatId()

  // Without a folder there is nothing to write into: the two kinds that name
  // files are disabled rather than hidden, and the hint says why.
  await expect(window.getByTestId('goal-document')).toBeDisabled()
  await expect(window.getByTestId('goal-codebase')).toBeDisabled()
  await expect(window.getByTestId('goal-discussion')).toBeEnabled()
  await expect(window.getByTestId('goal-needs-workdir')).toBeVisible()
  await expect(window.getByTestId('chat-goal-chip')).toHaveCount(0)

  expect((await call('chats.update', { id: chatId, patch: { workdir: goaldir } })).ok).toBe(true)
  await expect(window.getByTestId('goal-document')).toBeEnabled()
  await expect(window.getByTestId('goal-needs-workdir')).toHaveCount(0)

  const goal = {
    kind: 'document',
    description: 'Write the release notes for the next version',
    deliverable: 'docs/NOTES.md',
    materials: ['notes.md']
  }
  expect((await call('chats.update', { id: chatId, patch: { goal } })).ok).toBe(true)

  // The chip names the file, not the path: its last segment is the half that
  // identifies it, and the rest is in the tooltip.
  const chip = window.getByTestId('chat-goal-chip')
  await expect(chip).toHaveText('NOTES.md')
  await expect(window.locator('[data-kind="document"]')).toHaveAttribute('data-delivered', 'false')

  // The panel is showing the stored goal, materials included.
  await expect(window.getByTestId('goal-document')).toHaveAttribute('aria-pressed', 'true')
  await expect(window.getByTestId('goal-deliverable')).toHaveValue('docs/NOTES.md')
  await expect(window.getByTestId('goal-material')).toHaveAttribute('data-path', 'notes.md')

  // Now the file really exists.
  mkdirSync(join(goaldir, 'docs'), { recursive: true })
  writeFileSync(join(goaldir, 'docs', 'NOTES.md'), '# Notes\n')
  expect(
    (await call('chats.update', { id: chatId, patch: { goal: { ...goal, description: `${goal.description}.` } } })).ok
  ).toBe(true)

  await expect(window.locator('[data-kind="document"]')).toHaveAttribute('data-delivered', 'true')
  await expect(chip).toContainText('NOTES.md')
})

test('an invalid goal is refused with a reason, and the goal survives a restart', async () => {
  const chatId = await selectedChatId()

  // One case per class of mistake the panel can produce, each carrying the
  // identifier the renderer turns into its own sentence.
  expect(
    await call('chats.update', {
      id: chatId,
      patch: { goal: { kind: 'document', description: 'x', materials: [] } }
    })
  ).toMatchObject({ error: { code: 'validation', details: { reason: 'goal_deliverable_required' } } })

  expect(
    await call('chats.update', {
      id: chatId,
      patch: { goal: { kind: 'document', description: 'x', deliverable: '/etc/passwd', materials: [] } }
    })
  ).toMatchObject({
    error: { code: 'validation', details: { reason: 'goal_deliverable_not_relative' } }
  })

  expect(
    await call('chats.update', {
      id: chatId,
      patch: { goal: { kind: 'discussion', description: 'x', materials: ['gone.md'] } }
    })
  ).toMatchObject({ error: { code: 'validation', details: { reason: 'goal_material_missing' } } })

  await app?.close()
  ;({ app, window } = await launchWitena(userDataDir))
  await window.getByTestId('nav-chats').click()
  await window.getByTestId('chat-item').first().click()

  await expect(window.getByTestId('chat-goal-chip')).toContainText('NOTES.md')
  await expect(window.getByTestId('goal-deliverable')).toHaveValue('docs/NOTES.md')
  await expect(window.getByTestId('goal-material')).toHaveAttribute('data-path', 'notes.md')
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

/* -------------------------------------------------------------------------- */
/* S5.6: hand to executor, and the review round                                */
/* -------------------------------------------------------------------------- */

test('hands the discussion to the executor, and a participant reviews what it did', async () => {
  test.skip(
    !toolModelAvailable,
    `${TOOL_MODEL} is not available on ${OLLAMA_MODELS_URL}; the hand-off test needs a local model that can call tools.`
  )
  test.setTimeout(TOOL_ATTEMPTS * TOOL_CALL_MS + 240_000)

  // A second participant, so the review round has more than one member in it and
  // the "everybody except the executor" rule is visible rather than implied.
  await openAgents(window)
  await createAgent('Critic', 'participant')
  // The executor keeps the tool-calling model and the prompt the S5.5 test gave
  // it; both are set again here so this test does not depend on that one having
  // run first.
  await window.getByTestId('agent-item').filter({ hasText: 'Hands' }).click()
  await window.getByTestId('agent-model').selectOption(TOOL_MODEL)
  await window
    .getByTestId('agent-system-prompt')
    .fill('You write files with the write_file tool. When asked to implement something, call write_file once with the path and the content, then say what you wrote.')
  await window.getByTestId('agent-save').click()
  await expect(window.getByTestId('agent-save')).toBeDisabled()

  await window.getByTestId('nav-chats').click()
  await window.getByTestId('chats-new').click()
  await addMember('Reviewer')
  await addMember('Critic')
  await addMember('Hands')
  const chatId = await selectedChatId()
  // Two rounds is enough for both halves — one round of discussion, and the
  // hand-off's own implement + review pair — and keeps three small models from
  // talking to each other for minutes. `mention-only` keeps the discussion to
  // the two participants: the executor has a large model and a tool-calling
  // prompt, and it has nothing useful to add before it is handed the work.
  await window.getByTestId('chat-max-rounds').selectOption('2')
  await window.getByTestId('chat-mode').selectOption('mention-only')
  expect((await call('chats.update', { id: chatId, patch: { workdir: handoffdir } })).ok).toBe(true)
  await expect(window.getByTestId('chat-workdir-chip')).toHaveText(basename(handoffdir))

  // The short discussion. What it concludes does not matter; what matters is
  // that there is a transcript above the hand-off for the executor to implement.
  const stop = window.getByTestId('composer-stop')
  await window
    .getByTestId('composer-input')
    .fill('@Reviewer @Critic in one sentence each: we need a file called PLAN.md containing the single line "Build the thing". Agree or object.')
  await window.getByTestId('composer-input').press('Enter')
  // Both halves of the budget: the models have to start, and the whole
  // discussion run has to end before the hand-off can begin.
  await expect(stop).toHaveCount(0, { timeout: 2 * TOOL_CALL_MS })

  const handoff = window.getByTestId('chat-handoff')
  await expect(handoff).toBeEnabled()
  const reviews = window.locator('[data-testid="message-item"][data-author="Reviewer"]')
  const reviewsBefore = await reviews.count()
  const card = window.getByTestId('permission-card')

  // The same three-attempt budget the S5.5 test uses, and for the same reason: a
  // 3B model is not a reliable tool caller. A hand-off that produced no prompt
  // has simply finished, and the button is enabled again.
  let asked = false
  for (let attempt = 0; attempt < TOOL_ATTEMPTS && !asked; attempt += 1) {
    await handoff.click()
    // The click is recorded in the transcript as a message of its own.
    await expect(window.locator('[data-notice-key="handoff"]')).toHaveCount(attempt + 1)
    try {
      await expect(card.first()).toBeVisible({ timeout: TOOL_CALL_MS })
      asked = true
    } catch {
      await expect(stop).toHaveCount(0, { timeout: TOOL_CALL_MS })
    }
  }

  expect(
    asked,
    `${TOOL_MODEL} did not reach for a gated tool in ${TOOL_ATTEMPTS} hand-offs. The scheduling itself is covered by the unit suite; this case measures a small local model's willingness to call a tool.`
  ).toBe(true)

  await card.first().getByTestId('permission-allow').click()

  // The file is on disk…
  await expect(card).toHaveCount(0, { timeout: TOOL_CALL_MS })
  await expect
    .poll(() => readdirSync(handoffdir).length, { timeout: TOOL_CALL_MS })
    .toBeGreaterThan(0)

  // …and the review round follows: a participant speaks again, after the
  // executor, without anybody typing anything.
  await expect
    .poll(() => reviews.count(), { timeout: TOOL_CALL_MS })
    .toBeGreaterThan(reviewsBefore)
  await expect(stop).toHaveCount(0, { timeout: TOOL_CALL_MS })
})

/* -------------------------------------------------------------------------- */
/* S5.11: read-only tools for every member, and the materials briefing         */
/* -------------------------------------------------------------------------- */

/**
 * The step's acceptance sentence, end to end: a participant answers **from** a
 * marked material without fetching anything, and fetches an unmarked file when
 * it is asked about one.
 *
 * Both halves need a real model, so the whole case is behind the same
 * `qwen2.5:3b` guard as the two above — the first half needs a model that can
 * repeat a codeword it was given, and the second one needs a model that will
 * call a tool. What is being measured is that the material is *in the context*
 * (the first answer quotes it with no tool card anywhere in the transcript) and
 * that the read-only tools are really attached to an agent that is **not** the
 * executor (the second answer produces a `read_file` card).
 *
 * `mention-only` with one speaker, rather than a round of two: a second small
 * model answering the same question doubles the runtime and proves nothing the
 * first one does not. Both participants are members, which is what the chat is
 * meant to be.
 */
test('a participant answers from the materials, and reads an unmarked file when asked', async () => {
  test.skip(
    !toolModelAvailable,
    `${TOOL_MODEL} is not available on ${OLLAMA_MODELS_URL}; the materials test needs a local model that can call tools.`
  )
  test.setTimeout(2 * TOOL_ATTEMPTS * TOOL_CALL_MS + 120_000)

  await openAgents(window)
  await window.getByTestId('agents-new').click()
  await window.getByTestId('agent-name').fill('Scout')
  await window.getByTestId('agent-provider').selectOption({ index: 1 })
  await window.getByTestId('agent-model').selectOption(TOOL_MODEL)
  await window
    .getByTestId('agent-system-prompt')
    .fill(
      'Answer from the Materials section of your context when it is there. When you are asked about a file that is not in your context, call the read_file tool with its path and answer from what it returns. Keep every answer to one sentence.'
    )
  await window.getByTestId('agent-save').click()
  await expect(window.getByTestId('agent-save')).toBeDisabled()
  await createAgent('Watcher', 'participant')

  await window.getByTestId('nav-chats').click()
  await window.getByTestId('chats-new').click()
  await addMember('Scout')
  await addMember('Watcher')
  await window.getByTestId('chat-max-rounds').selectOption('1')
  await window.getByTestId('chat-mode').selectOption('mention-only')

  const chatId = await selectedChatId()
  expect((await call('chats.update', { id: chatId, patch: { workdir: materialsdir } })).ok).toBe(
    true
  )
  expect(
    (
      await call('chats.update', {
        id: chatId,
        patch: {
          goal: {
            kind: 'discussion',
            description: 'Agree on what the brief asks for',
            materials: ['BRIEF.md']
          }
        }
      })
    ).ok
  ).toBe(true)
  await expect(window.getByTestId('chat-goal-chip')).toBeVisible()

  const stop = window.getByTestId('composer-stop')
  const agentMessages = window.locator('[data-testid="message-item"][data-sender="agent"]')
  const cards = window.getByTestId('tool-card')

  // Half one: the marked file is already in the prompt, so the answer quotes it
  // and nothing was fetched.
  let quoted = false
  for (let attempt = 0; attempt < TOOL_ATTEMPTS && !quoted; attempt += 1) {
    await window
      .getByTestId('composer-input')
      .fill('@Scout what codeword does the brief give? Answer with the codeword itself.')
    await window.getByTestId('composer-input').press('Enter')
    await expect(stop).toHaveCount(0, { timeout: TOOL_CALL_MS })
    quoted = (await agentMessages.last().textContent())?.includes(BRIEF_CODEWORD) === true
  }

  expect(
    quoted,
    `${TOOL_MODEL} did not repeat the material's codeword in ${TOOL_ATTEMPTS} attempts. That the material is in the prompt is covered by the unit suite; this case measures a small local model reading it.`
  ).toBe(true)
  // The whole point: it answered from its context, not by going to the disk.
  await expect(cards).toHaveCount(0)

  // Half two: a file nobody marked. It is in the workspace tree, so the model
  // knows it exists, and `read_file` is attached even though this agent is a
  // participant.
  let called = false
  for (let attempt = 0; attempt < TOOL_ATTEMPTS && !called; attempt += 1) {
    await window
      .getByTestId('composer-input')
      .fill('@Scout use the read_file tool to read SECRET.md, then tell me the codeword in it.')
    await window.getByTestId('composer-input').press('Enter')
    try {
      await expect(cards.first()).toBeVisible({ timeout: TOOL_CALL_MS })
      called = true
    } catch {
      await expect(stop).toHaveCount(0, { timeout: TOOL_CALL_MS })
    }
  }

  expect(
    called,
    `${TOOL_MODEL} did not reach for read_file in ${TOOL_ATTEMPTS} attempts. The attachment rule is covered by the unit suite; this case measures a small local model's willingness to call a tool.`
  ).toBe(true)

  await expect(cards.first()).toHaveAttribute('data-tool', 'read_file')
  await expect(cards.first()).toHaveAttribute('data-state', 'done', { timeout: TOOL_CALL_MS })
  // A participant was never offered anything that writes: no prompt was raised.
  await expect(window.getByTestId('permission-card')).toHaveCount(0)
})

/* -------------------------------------------------------------------------- */
/* S5.12: goal-aware delivery                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The offline half: when "Write the deliverable" may be pressed.
 *
 * Its four rules are the hand-off's, in the hand-off's order, plus the goal —
 * and the reason is on the element, so none of this depends on the copy or on
 * the active language.
 */
test('the quick action needs a document goal on top of the hand-off rules', async () => {
  await window.getByTestId('nav-chats').click()
  await window.getByTestId('chats-new').click()
  await addMember('Reviewer')
  const chatId = await selectedChatId()
  const deliver = window.getByTestId('chat-write-deliverable')

  // No folder: the first rule, and the same one the hand-off button reports.
  await expect(deliver).toBeDisabled()
  await expect(deliver).toHaveAttribute('data-blocked', 'handoff_no_workdir')

  expect((await call('chats.update', { id: chatId, patch: { workdir: deliverdir } })).ok).toBe(true)
  await expect(deliver).toHaveAttribute('data-blocked', 'handoff_no_executor')

  await addMember('Hands')
  await expect(memberRows()).toHaveCount(2)
  // Folder and executor in place, but nothing to deliver yet.
  await expect(deliver).toBeDisabled()
  await expect(deliver).toHaveAttribute('data-blocked', 'handoff_no_deliverable')

  // A goal of the wrong kind is the same refusal: this chat produces no file.
  expect(
    (
      await call('chats.update', {
        id: chatId,
        patch: {
          goal: { kind: 'codebase', description: 'Change the code in here', materials: [] }
        }
      })
    ).ok
  ).toBe(true)
  await expect(deliver).toHaveAttribute('data-blocked', 'handoff_no_deliverable')

  // …and the backend refuses it on the same rule, for a client that never saw
  // the disabled button.
  expect(await call('chat.handoff', { chatId, intent: 'deliver' })).toMatchObject({
    error: { code: 'validation', details: { reason: 'handoff_no_deliverable' } }
  })

  expect(
    (
      await call('chats.update', {
        id: chatId,
        patch: {
          goal: {
            kind: 'document',
            description: 'Write a one-line release note',
            deliverable: 'docs/RELEASE.md',
            materials: []
          }
        }
      })
    ).ok
  ).toBe(true)
  await expect(deliver).toBeEnabled()
  await expect(deliver).toHaveAttribute('data-blocked', '')
  // Nothing has been written, so the chip is the "not yet" one.
  await expect(window.locator('[data-kind="document"]')).toHaveAttribute('data-delivered', 'false')
})

/**
 * S5.12's acceptance sentence, end to end: the action writes the file, the
 * header says so, and the chip is a real control carrying the path.
 *
 * The chat is the one the case above built — an executor, a participant, an
 * empty folder and a `document` goal — so what appears in `deliverdir` can only
 * be this hand-off's doing.
 *
 * The chip's **click is not driven**, for exactly the reason S5.7 recorded:
 * `shell.openExternal` would launch the developer's real editor, and
 * `window.witena` is a `contextBridge` object whose methods cannot be replaced
 * from the page. So this asserts the chip is a button carrying the deliverable's
 * path; that the backend accepts precisely that call is asserted separately by
 * `e2e/editor.spec.ts`.
 */
test('writes the deliverable, and the header chip flips to delivered', async () => {
  test.skip(
    !toolModelAvailable,
    `${TOOL_MODEL} is not available on ${OLLAMA_MODELS_URL}; the delivery test needs a local model that can call tools.`
  )
  test.setTimeout(TOOL_ATTEMPTS * TOOL_CALL_MS + 240_000)

  // The executor keeps the tool-calling model and a prompt that leaves it in no
  // doubt about which tool to use; set here so this test does not depend on the
  // order of the ones above.
  await openAgents(window)
  await window.getByTestId('agent-item').filter({ hasText: 'Hands' }).click()
  await window.getByTestId('agent-model').selectOption(TOOL_MODEL)
  await window
    .getByTestId('agent-system-prompt')
    .fill('You write files with the write_file tool. When asked to write a file, call write_file once with the path and the content, then say what you wrote.')
  await window.getByTestId('agent-save').click()
  await expect(window.getByTestId('agent-save')).toBeDisabled()

  await window.getByTestId('nav-chats').click()
  await window.getByTestId('chat-item').first().click()
  await window.getByTestId('chat-max-rounds').selectOption('2')

  const deliver = window.getByTestId('chat-write-deliverable')
  await expect(deliver).toBeEnabled()

  const card = window.getByTestId('permission-card')
  const stop = window.getByTestId('composer-stop')

  // The same three-attempt budget the other model-backed cases use, and for the
  // same reason: a 3B model is not a reliable tool caller.
  let asked = false
  for (let attempt = 0; attempt < TOOL_ATTEMPTS && !asked; attempt += 1) {
    await deliver.click()
    // The click is recorded in the transcript as a message of its own, under
    // its own notice key.
    await expect(window.locator('[data-notice-key="handoffDeliver"]')).toHaveCount(attempt + 1)
    try {
      await expect(card.first()).toBeVisible({ timeout: TOOL_CALL_MS })
      asked = true
    } catch {
      await expect(stop).toHaveCount(0, { timeout: TOOL_CALL_MS })
    }
  }

  expect(
    asked,
    `${TOOL_MODEL} did not reach for a gated tool in ${TOOL_ATTEMPTS} attempts. The hand-off itself is covered by the unit suite; this case measures a small local model's willingness to call a tool.`
  ).toBe(true)

  await card.first().getByTestId('permission-allow').click()
  await expect(card).toHaveCount(0, { timeout: TOOL_CALL_MS })

  // The file is where the goal said it would be…
  const written = join(deliverdir, 'docs', 'RELEASE.md')
  await expect.poll(() => existsSync(written), { timeout: TOOL_CALL_MS }).toBe(true)

  // …the header chip noticed without anybody touching the goal, which is the
  // moment S5.12 added…
  const chip = window.locator('[data-kind="document"]')
  await expect(chip).toHaveAttribute('data-delivered', 'true', { timeout: TOOL_CALL_MS })
  await expect(window.getByTestId('chat-goal-chip')).toContainText('RELEASE.md')

  // …and the chip is a real, openable control carrying the deliverable's path.
  // The click itself is not driven; see this test's header.
  await expect(chip).toHaveAttribute('data-path', 'docs/RELEASE.md')
  await expect(chip).toBeEnabled()

  await expect(stop).toHaveCount(0, { timeout: 2 * TOOL_CALL_MS })
})
