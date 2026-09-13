/**
 * The S5.2 acceptance test: the executor role and the chat's working directory.
 *
 * Offline like `members.spec.ts` and `agents.spec.ts` — no message is ever sent,
 * because everything here is configuration. The executor's *tools* arrive in
 * S5.3 and its permission prompt in S5.4; this file is about the two reserved
 * fields becoming real, and it is where those steps extend.
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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

let app: ElectronApplication | undefined
let window: Page
let userDataDir: string
/** A real directory to bind the chat to, and a real file that is not one. */
let workdir: string
let notAFolder: string

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

test.beforeAll(async () => {
  userDataDir = createUserDataDir()
  workdir = mkdtempSync(join(tmpdir(), 'witena-workdir-'))
  notAFolder = join(workdir, 'notes.md')
  writeFileSync(notAFolder, '# not a folder\n')
  ;({ app, window } = await launchWitena(userDataDir))

  await addOllamaProvider(window, [MODEL])
  await openAgents(window)
  await createAgent('Reviewer', 'participant')
  await createAgent('Hands', 'executor')
  await createAgent('Builder', 'executor')
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) removeUserDataDir(userDataDir)
  if (workdir) rmSync(workdir, { recursive: true, force: true })
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
