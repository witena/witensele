/**
 * The S5.14 acceptance test: a discussion that agrees stops by itself, and a
 * vote never runs a second round.
 *
 * Both rules are read from what a **real model wrote**, which is exactly why
 * they cannot be proved by the unit tests alone: `chat-runner.test.ts` asserts
 * what the runner does when a reply ends with `[AGREED]`, and this file asserts
 * that a small local model actually writes one and that the runner then closes
 * the discussion in the real app. The system prompts push hard in that direction
 * — see `AGREEABLE_PROMPT` for what a 3B model does without them.
 *
 * The file is **skipped when `http://localhost:11434/v1/models` does not answer
 * or does not hold the model**, and the skip is explicit in the report rather
 * than a silent pass, exactly like `orchestration.spec.ts`.
 *
 * Every assertion is on a `data-testid`, a `data-*` value or a notice key, never
 * on rendered copy, so none of them depends on the active language — and no
 * Chinese appears in this file (CLAUDE.md rule #1).
 */
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import {
  addOllamaProvider,
  createUserDataDir,
  launchWitena,
  openAgents,
  removeUserDataDir
} from './helpers'

/** Serial: one app, and each test uses a chat of its own inside it. */
test.describe.configure({ mode: 'serial' })

const OLLAMA_MODELS_URL = 'http://localhost:11434/v1/models'

/**
 * **Both members run `qwen2.5:3b`**, and that is a deliberate narrowing.
 *
 * What is under test is the runner's reaction to a marker, and the smallest
 * model on this machine (`qwen2.5:1.5b`) does not reliably produce one: asked to
 * agree in one sentence it writes five paragraphs about being an assistant, with
 * no marker anywhere, which is the "nobody wrote a marker, so carry on" path
 * rather than the one this spec is for. Two models of different sizes is
 * `orchestration.spec.ts`'s subject; here they would only make the spec flaky.
 */
const MODEL = 'qwen2.5:3b'

/**
 * How many times the consensus test asks its question before giving up.
 *
 * The product rule is deterministic and is covered case by case in
 * `chat-runner.test.ts`; what is not deterministic is a 3B model writing
 * `[AGREED]` rather than `[CONTINUE]`, free prose, or the marker with a typo in
 * it — measured at roughly three runs in four with the prompt below. One attempt
 * would make this spec fail once a week for a reason that says nothing about the
 * code, and a loop of three brings that to about one run in sixty while still
 * asserting the whole shape of the chat that did close.
 */
const ATTEMPTS = 3

/** A cold model and up to three turns: the budget has to cover loading it. */
const REPLY_MS = 120_000
const TEST_MS = 300_000

/**
 * What each agent is told, beyond the group briefing.
 *
 * A literal two-line **template**, and every word of it was earned. A 3B model
 * asked in prose to "agree and end with [AGREED]" instead: replied `[PASS]`
 * (the briefing offers abstention and "nothing to add" sounds like one); wrote
 * `[CONTINUE]` because the question invited another turn; and prefixed its
 * answer with `@Amenable:`, imitating the `[name]:` format the transcript
 * arrives in — which is a mention, which schedules another round, which is
 * exactly what "nothing is pending" forbids. Showing the two lines removes all
 * three.
 *
 * That is a statement about these models, not about the product: the spec proves
 * the path works end to end, not that a small model follows the protocol
 * unprompted.
 */
const AGREEABLE_PROMPT = [
  'Your entire reply is always exactly these two lines, copied character for character,',
  'whatever anyone in the chat says:',
  '',
  'Agreed.',
  '[AGREED]',
  '',
  'You have no objections, nothing to add and no questions, so as far as you are concerned',
  'the discussion is finished the moment it starts. That is why your marker is always [AGREED].',
  'Never write [CONTINUE]. Never write [PASS]. Never write a name, a colon or an @ sign.'
].join('\n')

let app: ElectronApplication | undefined
let window: Page
let userDataDir: string
let ready = false

/** True when Ollama answers **and** the model is pulled. */
async function probeOllama(): Promise<boolean> {
  try {
    const response = await fetch(OLLAMA_MODELS_URL, { signal: AbortSignal.timeout(2_000) })
    if (!response.ok) return false
    const body = (await response.json()) as { data?: Array<{ id?: string }> }
    const ids = (body.data ?? []).map((model) => model.id)
    return ids.includes(MODEL)
  } catch {
    return false
  }
}

/** Creates one agent from an empty editor. */
async function createAgent(name: string, model: string, prompt: string): Promise<void> {
  await window.getByTestId('agents-new').click()
  await window.getByTestId('agent-name').fill(name)
  await window.getByTestId('agent-provider').selectOption({ index: 1 })
  await window.getByTestId('agent-model').selectOption(model)
  await window.getByTestId('agent-system-prompt').fill(prompt)
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

const agentMessages = (): Locator =>
  window.locator('[data-testid="message-item"][data-sender="agent"]')
const streamingMessages = (): Locator =>
  window.locator('[data-testid="message-item"][data-status="streaming"]')
const notice = (key: string): Locator => window.locator(`[data-notice-key="${key}"]`)

/** Types a message and presses Enter. */
async function send(text: string): Promise<void> {
  await window.getByTestId('composer-input').fill(text)
  await window.getByTestId('composer-input').press('Enter')
}

/** Waits until the whole run is over: nothing streaming, composer back to Send. */
async function waitForRunToEnd(): Promise<void> {
  await expect(window.getByTestId('composer-send')).toBeVisible({ timeout: REPLY_MS })
  await expect(streamingMessages()).toHaveCount(0, { timeout: REPLY_MS })
}

/** A fresh chat with both members, so each test starts from an empty transcript. */
async function newChatWithBothMembers(): Promise<void> {
  const before = await window.getByTestId('chat-item').count()
  await window.getByTestId('chats-new').click()
  await expect(window.getByTestId('chat-item')).toHaveCount(before + 1)
  await addMember('Agreeable')
  await addMember('Amenable')
}

test.beforeAll(async () => {
  ready = await probeOllama()
  if (!ready) return

  userDataDir = createUserDataDir()
  ;({ app, window } = await launchWitena(userDataDir))

  await addOllamaProvider(window, [MODEL])
  await openAgents(window)
  await createAgent('Agreeable', MODEL, AGREEABLE_PROMPT)
  await createAgent('Amenable', MODEL, AGREEABLE_PROMPT)
  await window.getByTestId('nav-chats').click()
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) removeUserDataDir(userDataDir)
})

test('a discussion that agrees ends after one round with a conclusion', async () => {
  test.skip(!ready, `${OLLAMA_MODELS_URL} did not offer ${MODEL}; S5.14 needs it.`)
  test.setTimeout(TEST_MS)

  // Up to three attempts, each in a **fresh chat**, and the assertions below run
  // against whichever one closed. See `ATTEMPTS` for why this is a loop: what is
  // unreliable is a 3B model writing the marker, not the app reacting to it, and
  // the reaction is what this spec is for. A chat that did not close has two
  // agent messages and no notice, so the loop can tell the two apart without
  // knowing what the model wrote.
  let closed = false
  for (let attempt = 0; attempt < ATTEMPTS && !closed; attempt += 1) {
    await newChatWithBothMembers()
    // **In parallel**, which is not decoration. Sequentially the second member
    // is handed the first one's reply with the marker already stripped (that is
    // what `stripTrailingMarkers` is for), and a 3B model imitates what it sees
    // far more readily than what its prompt says — so it answers without a
    // marker, or with the `[name]:` prefix it read, which is a mention and a
    // mention keeps the chain open. In parallel neither can copy the other.
    await window.getByTestId('chat-speaking-parallel').click()
    await send('Do you agree that we should ship the smallest useful version first? Say your line.')

    await expect(agentMessages()).toHaveCount(2, { timeout: REPLY_MS })
    await waitForRunToEnd()
    closed = (await notice('consensus').count()) === 1
  }

  expect(
    closed,
    `neither member wrote ${'[AGREED]'} in ${ATTEMPTS} attempts; see AGREEABLE_PROMPT`
  ).toBe(true)

  // Round 1 was the discussion, round 2 the conclusion: one speaker, the first
  // member in speaking order, and nothing after it.
  await expect(agentMessages()).toHaveCount(3)
  await expect(agentMessages().nth(2)).toHaveAttribute('data-author', 'Agreeable')
  await expect(agentMessages().nth(2)).toHaveAttribute('data-round', '2')
  // The chain stopped because the group agreed, not because it ran out of
  // rounds: the budget is three and only two were used.
  await expect(notice('maxRoundsReached')).toHaveCount(0)
})

test('a vote runs exactly one round', async () => {
  test.skip(!ready, `no local Ollama with ${MODEL}`)
  test.setTimeout(TEST_MS)

  await newChatWithBothMembers()
  // Three automatic rounds are available; the vote must still use exactly one.
  await window.getByTestId('chat-max-rounds').selectOption('3')

  await window.getByTestId('action-vote').click()

  // Every member answers once and the run closes with its own notice — not the
  // max-rounds one, and not the consensus one, whatever markers the replies
  // happen to carry.
  await expect(notice('voteClosed')).toHaveCount(1, { timeout: REPLY_MS })
  await waitForRunToEnd()
  await expect(agentMessages()).toHaveCount(2)
  await expect(notice('consensus')).toHaveCount(0)
  await expect(notice('maxRoundsReached')).toHaveCount(0)
})
