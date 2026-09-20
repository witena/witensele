/**
 * The S2.2 acceptance test: who is in a chat, in which order, and with which
 * orchestration settings — all of it persisted.
 *
 * Offline like `agents.spec.ts`: the one message this spec sends goes to a chat
 * with **no** members and is expected to be refused, which is precisely the case
 * that needs no model. Everything else is membership and settings.
 *
 * Every assertion is on a `data-testid` or a `data-*` value rather than on
 * rendered copy, so none of them depends on the active language — and no Chinese
 * appears in this file (CLAUDE.md rule #1).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import {
  addOllamaProvider,
  addProviderModel,
  createChat,
  createUserDataDir,
  launchWitena,
  locale,
  openAgents,
  openProviderSettings,
  removeUserDataDir,
  repoRoot
} from './helpers'

/** Serial: one app, and each test builds on the chat the last one left behind. */
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

const memberRows = (): Locator => window.getByTestId('member-row')
const memberNames = (): Locator => window.getByTestId('member-name')

/** Opens the picker and adds one agent by its visible name. */
async function addMember(name: string): Promise<void> {
  const before = await memberRows().count()
  await window.getByTestId('member-add').click()
  await window.getByTestId('member-picker').getByTestId('member-candidate').filter({ hasText: name }).click()
  await expect(memberRows()).toHaveCount(before + 1)
}

/** Creates a chat through the New chat dialog and waits for it to be selected. */
async function newChat(): Promise<void> {
  const before = await window.getByTestId('chat-item').count()
  await createChat(window)
  await expect(window.getByTestId('chat-item')).toHaveCount(before + 1)
}

test.beforeAll(async () => {
  userDataDir = createUserDataDir()
  ;({ app, window } = await launchWitena(userDataDir))
  mkdirSync(SHOTS_DIR, { recursive: true })
  await prepare()

  await addOllamaProvider(window, [FIRST_MODEL])
  await openProviderSettings(window)
  await window.getByTestId('provider-card').click()
  await addProviderModel(window, SECOND_MODEL)
  await window.getByTestId('provider-save').click()

  await openAgents(window)
  await createAgent('Reviewer', FIRST_MODEL)
  await createAgent('Architect', SECOND_MODEL)
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) removeUserDataDir(userDataDir)
})

test('a new chat starts empty and refuses a message until it has a member', async () => {
  await window.getByTestId('nav-chats').click()
  await newChat()

  // The agent library is no longer empty, so no bootstrap agent is invented.
  await expect(memberRows()).toHaveCount(0)
  await expect(window.getByTestId('member-empty-hint')).toBeVisible()

  // The composer stays usable — the fix is one click away — but the send is
  // rejected rather than producing a question nobody was asked.
  await window.getByTestId('composer-input').fill('hi')
  await window.getByTestId('composer-input').press('Enter')
  await expect(window.getByTestId('composer-error')).toBeVisible()
  await expect(window.locator('[data-testid="message-item"]')).toHaveCount(0)
})

test('adds both agents and counts them', async () => {
  await addMember('Reviewer')
  await addMember('Architect')

  await expect(memberRows()).toHaveCount(2)
  await expect(memberNames().nth(0)).toHaveText('Reviewer')
  await expect(memberNames().nth(1)).toHaveText('Architect')
  // Every agent is in, so the picker has nothing left to offer.
  await window.getByTestId('member-add').click()
  await expect(window.getByTestId('member-candidate')).toHaveCount(0)
  await window.getByTestId('member-add').click()

  await window.screenshot({ path: join(SHOTS_DIR, 'members.png') })
})

test('drags Architect above Reviewer and keeps the order after a restart', async () => {
  await memberRows().nth(1).dragTo(memberRows().nth(0))

  await expect(memberNames().nth(0)).toHaveText('Architect')
  await expect(memberNames().nth(1)).toHaveText('Reviewer')

  await app?.close()
  ;({ app, window } = await launchWitena(userDataDir))
  await prepare()
  await window.getByTestId('nav-chats').click()
  await window.getByTestId('chat-item').first().click()

  await expect(memberNames().nth(0)).toHaveText('Architect')
  await expect(memberNames().nth(1)).toHaveText('Reviewer')
})

test('removes a member', async () => {
  await memberRows().filter({ hasText: 'Reviewer' }).getByTestId('member-remove').click()

  await expect(memberRows()).toHaveCount(1)
  await expect(memberNames()).toHaveText('Architect')
})

test('persists the group settings and reflects them in the header badge', async () => {
  const badge = window.getByTestId('chat-settings-badge')
  const before = await badge.textContent()

  await window.getByTestId('chat-speaking-parallel').click()
  await window.getByTestId('chat-max-rounds').selectOption('5')
  await window.getByTestId('chat-timeout').selectOption('300000')

  await expect(badge).not.toHaveText(before ?? '')
  await expect(window.getByTestId('chat-speaking-parallel')).toHaveAttribute(
    'aria-pressed',
    'true'
  )

  await app?.close()
  ;({ app, window } = await launchWitena(userDataDir))
  await prepare()
  await window.getByTestId('nav-chats').click()
  await window.getByTestId('chat-item').first().click()

  await expect(window.getByTestId('chat-speaking-parallel')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(window.getByTestId('chat-max-rounds')).toHaveValue('5')
  await expect(window.getByTestId('chat-timeout')).toHaveValue('300000')
  await expect(window.getByTestId('member-row')).toHaveCount(1)
})

test('deleting an agent removes it from the chat it was in', async () => {
  await openAgents(window)
  await window.getByTestId('agent-item').filter({ hasText: 'Architect' }).click()
  await window.getByTestId('agent-delete').click()
  await window.getByTestId('agent-delete').click()

  await window.getByTestId('nav-chats').click()
  await window.getByTestId('chat-item').first().click()
  await expect(window.getByTestId('member-row')).toHaveCount(0)
  await expect(window.getByTestId('member-empty-hint')).toBeVisible()
})
