/**
 * The Phase 9 acceptance test: a committee is built, ordered, persisted,
 * convened on a topic, synced and deleted.
 *
 * S9.2 wrote the first five tests — everything up to "removes a member". S9.3
 * added the two in the middle, which are the point of the whole feature: **New
 * topic** opens the New chat dialog with this committee picked, and the member
 * panel's **Sync committee members** closes the gap a snapshot leaves behind.
 *
 * Entirely **offline**, like `agents.spec.ts` and `members.spec.ts`: a committee
 * never runs, so nothing here needs a model. The Ollama provider is added with
 * its model ids typed in rather than fetched, and no prompt is ever sent.
 *
 * Every assertion is on a `data-testid` or a `data-*` value rather than on
 * rendered copy, so none of them depends on the active language — and no Chinese
 * appears in this file (CLAUDE.md rule #1).
 */
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import {
  addOllamaProvider,
  addProviderModel,
  createUserDataDir,
  launchWitena,
  openAgents,
  openProviderSettings,
  removeUserDataDir
} from './helpers'

/** Serial: one app, and each test builds on the committee the last one left. */
test.describe.configure({ mode: 'serial' })

const FIRST_MODEL = 'qwen2.5:1.5b'
const SECOND_MODEL = 'llama3.2:3b'

let app: ElectronApplication | undefined
let window: Page
let userDataDir: string

/** Creates one agent from an empty editor. */
async function createAgent(name: string, model: string): Promise<void> {
  await window.getByTestId('agents-new').click()
  await window.getByTestId('agent-name').fill(name)
  await window.getByTestId('agent-provider').selectOption({ index: 1 })
  await window.getByTestId('agent-model').selectOption(model)
  await window.getByTestId('agent-save').click()
  await expect(window.getByTestId('agent-save')).toBeDisabled()
}

async function openCommittees(): Promise<void> {
  await window.getByTestId('nav-committees').click()
  await expect(window.getByTestId('page-committees')).toBeVisible()
}

const memberRows = (): Locator => window.getByTestId('committee-member-row')
const memberNames = (): Locator => window.getByTestId('committee-member-name')

/** Opens the committee picker and adds one agent by its visible name. */
async function addMember(name: string): Promise<void> {
  const before = await memberRows().count()
  await window.getByTestId('committee-member-add').click()
  await window
    .getByTestId('committee-member-picker')
    .getByTestId('committee-member-candidate')
    .filter({ hasText: name })
    .click()
  await expect(memberRows()).toHaveCount(before + 1)
}

test.beforeAll(async () => {
  userDataDir = createUserDataDir()
  ;({ app, window } = await launchWitena(userDataDir))

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

test('the page starts empty and Save is disabled until the committee has a name', async () => {
  await openCommittees()
  await expect(window.getByTestId('committee-item')).toHaveCount(0)

  await window.getByTestId('committees-new').click()
  await expect(window.getByTestId('committee-save')).toBeDisabled()
  await expect(window.getByTestId('committee-name-error')).toBeVisible()

  await window.getByTestId('committee-name').fill('Architecture review')
  await expect(window.getByTestId('committee-name-error')).toHaveCount(0)
  await window.getByTestId('committee-save').click()

  await expect(window.getByTestId('committee-save')).toBeDisabled()
  await expect(window.getByTestId('committee-item')).toHaveCount(1)
})

test('adds both agents and counts them on the list row', async () => {
  await addMember('Reviewer')
  await addMember('Architect')

  await expect(memberNames().nth(0)).toHaveText('Reviewer')
  await expect(memberNames().nth(1)).toHaveText('Architect')

  // Every agent is in, so the picker has nothing left to offer.
  await window.getByTestId('committee-member-add').click()
  await expect(window.getByTestId('committee-member-candidate')).toHaveCount(0)
  await window.getByTestId('committee-member-add').click()

  await window.getByTestId('committee-save').click()
  await expect(window.getByTestId('committee-save')).toBeDisabled()
  await expect(window.getByTestId('committee-item-members')).toHaveAttribute('data-members', '2')
})

test('drags Architect above Reviewer and keeps the order after a restart', async () => {
  await memberRows().nth(1).dragTo(memberRows().nth(0))

  await expect(memberNames().nth(0)).toHaveText('Architect')
  await expect(memberNames().nth(1)).toHaveText('Reviewer')
  await window.getByTestId('committee-save').click()
  await expect(window.getByTestId('committee-save')).toBeDisabled()

  await app?.close()
  ;({ app, window } = await launchWitena(userDataDir))

  await openCommittees()
  await expect(window.getByTestId('committee-item')).toHaveCount(1)
  await window.getByTestId('committee-item').click()

  await expect(memberNames().nth(0)).toHaveText('Architect')
  await expect(memberNames().nth(1)).toHaveText('Reviewer')
})

test('moves a member with the keyboard-reachable buttons', async () => {
  // Dragging is pointer-only; these two buttons are the other way to set the
  // speaking order, and they write the same draft.
  await memberRows().nth(1).getByTestId('committee-member-up').click()

  await expect(memberNames().nth(0)).toHaveText('Reviewer')
  await expect(memberNames().nth(1)).toHaveText('Architect')

  await memberRows().nth(0).getByTestId('committee-member-down').click()
  await expect(memberNames().nth(0)).toHaveText('Architect')
})

test('removes a member and has no topics yet', async () => {
  await memberRows().filter({ hasText: 'Reviewer' }).getByTestId('committee-member-remove').click()

  await expect(memberRows()).toHaveCount(1)
  await expect(memberNames()).toHaveText('Architect')
  await window.getByTestId('committee-save').click()
  await expect(window.getByTestId('committee-save')).toBeDisabled()

  // Nothing has been convened from this committee yet; the next test does it.
  await expect(window.getByTestId('committee-topic')).toHaveCount(0)
})

test('convenes a topic from the committee, with one extra agent', async () => {
  await window.getByTestId('committee-new-topic').click()

  // The button navigates *and* arrives with this committee already picked,
  // which is the whole reason the dialog's open state lives in `stores/ui`.
  await expect(window.getByTestId('page-chats')).toBeVisible()
  const dialog = window.getByTestId('new-chat-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('new-chat-committee')).toHaveAttribute('data-selected', 'true')

  // Architect rides in with the committee: ticked, and not untickable.
  const architect = dialog.getByTestId('new-chat-agent').filter({ hasText: 'Architect' })
  await expect(architect).toHaveAttribute('data-selected', 'true')
  await expect(architect).toHaveAttribute('data-locked', 'true')
  await expect(dialog.getByTestId('new-chat-summary')).toHaveAttribute('data-members', '1')

  // Reviewer is the individual agent, on top of the committee.
  await dialog.getByTestId('new-chat-agent').filter({ hasText: 'Reviewer' }).click()
  await expect(dialog.getByTestId('new-chat-summary')).toHaveAttribute('data-members', '2')

  await window.getByTestId('new-chat-title').fill('Retrospective')
  await window.getByTestId('new-chat-create').click()
  await expect(dialog).toHaveCount(0)

  // Committee members in committee order, then the extra — the one rule
  // `mergeMembers` and the handler's `initialMembers` both state.
  await expect(window.getByTestId('member-name').nth(0)).toHaveText('Architect')
  await expect(window.getByTestId('member-name').nth(1)).toHaveText('Reviewer')

  // Provenance, in the header and on the row.
  await expect(window.getByTestId('chat-committee-chip')).toHaveText('Architecture review')
  await expect(window.getByTestId('chat-item-committee')).toHaveText('Architecture review')
  await expect(window.getByTestId('chat-item-title')).toHaveText('Retrospective')
})

test('syncing appends the member the committee has gained since', async () => {
  await openAgents(window)
  await createAgent('Scribe', FIRST_MODEL)

  await openCommittees()
  await window.getByTestId('committee-item').click()
  await addMember('Scribe')
  await window.getByTestId('committee-save').click()
  await expect(window.getByTestId('committee-save')).toBeDisabled()

  // The topic kept the snapshot it was convened with, so it is now one member
  // behind its committee. The list on this page is how we get back to it.
  await window.getByTestId('committee-topic').click()
  await expect(window.getByTestId('page-chats')).toBeVisible()

  const sync = window.getByTestId('member-sync-committee')
  await expect(sync).toHaveAttribute('data-missing', '1')
  await sync.click()

  // Appended, not reconciled: the extra the chat was convened with keeps its
  // place, and the new member joins at the end.
  await expect(window.getByTestId('member-row')).toHaveCount(3)
  await expect(window.getByTestId('member-name').nth(0)).toHaveText('Architect')
  await expect(window.getByTestId('member-name').nth(1)).toHaveText('Reviewer')
  await expect(window.getByTestId('member-name').nth(2)).toHaveText('Scribe')
  // Nothing left to sync, so the button is gone rather than disabled.
  await expect(sync).toHaveCount(0)
})

test('deleting an agent removes it from the committee', async () => {
  await openAgents(window)
  await window.getByTestId('agent-item').filter({ hasText: 'Architect' }).click()
  await window.getByTestId('agent-delete').click()
  await window.getByTestId('agent-delete').click()

  await openCommittees()
  await window.getByTestId('committee-item').click()
  // Architect is gone from the committee; Scribe, added in the previous test,
  // is not.
  await expect(memberRows()).toHaveCount(1)
  await expect(memberNames()).toHaveText('Scribe')
})

test('deletes the committee in two clicks', async () => {
  await window.getByTestId('committee-delete').click()
  await window.getByTestId('committee-delete').click()

  await expect(window.getByTestId('committee-item')).toHaveCount(0)
  // The editor closed with the record it was editing.
  await expect(window.getByTestId('committee-save')).toHaveCount(0)
})
