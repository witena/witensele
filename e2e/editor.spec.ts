/**
 * Open in editor (S5.7): the Editor setting, and the chips the detector draws.
 *
 * **Entirely offline.** Nothing here sends a prompt to a model: the provider is
 * added by typing the model id (the pattern every agent spec uses), and the only
 * message in the transcript is the one the user types, which `chat.send` stores
 * and renders before the run it schedules has done anything. That message body
 * goes through `Markdown` exactly like an agent's, so it is where the path
 * detector can be observed without a local model — and it means this file always
 * runs, rather than being skipped on a machine without Ollama.
 *
 * ## The click is asserted as far as it can honestly be
 *
 * Clicking a chip calls `system.openInEditor`, whose whole job is to hand a
 * `vscode://` URL to the platform — which on a developer's machine launches VS
 * Code, and in CI silently does nothing. There is no test hook in the developer
 * settings to stub the method (S5.7 allows for one and none exists), and
 * `window.witena` is a `contextBridge` object whose properties cannot be replaced
 * from the page, so the call cannot be intercepted either.
 *
 * So the click itself is **not** driven here, deliberately. What is asserted is
 * everything on either side of it: that the chip is a real button with the path
 * and line on it, that the backend accepts that exact call, and that it refuses
 * the two calls it is supposed to refuse. `src/main/editor/open.test.ts` and
 * `src/renderer/src/components/chat/file-refs.test.ts` cover the rest.
 *
 * Every assertion is on a `data-testid` or a `data-*` value rather than on
 * rendered copy, so none of them depends on the active language and no Chinese
 * appears in this file (CLAUDE.md rule #1).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import {
  addOllamaProvider,
  createUserDataDir,
  launchWitena,
  openAgents,
  openDeveloperSettings,
  removeUserDataDir
} from './helpers'

/** Serial: one app, and each test builds on what the last one left behind. */
test.describe.configure({ mode: 'serial' })

const MODEL = 'qwen2.5:1.5b'

let app: ElectronApplication | undefined
let window: Page
let userDataDir: string
/** A real folder with a real file in it, for the chat to be bound to. */
let workdir: string

/** The preload bridge's envelope, restated here: `e2e/` may not import preload. */
type Envelope = { ok: true; value: unknown } | { ok: false; error: { code: string; details?: unknown } }

/** Calls a backend method from inside the page, resolving with the envelope. */
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

async function selectedChatId(): Promise<string> {
  const envelope = await call('chats.list')
  expect(envelope.ok).toBe(true)
  return ((envelope as { value: { id: string }[] }).value[0]?.id ?? '') as string
}

test.beforeAll(async () => {
  userDataDir = createUserDataDir()
  // Realpathed: macOS puts `tmpdir()` behind the `/var` -> `/private/var`
  // symlink, and the backend answers in resolved paths.
  workdir = realpathSync(mkdtempSync(join(tmpdir(), 'witena-editordir-')))
  mkdirSync(join(workdir, 'src'), { recursive: true })
  writeFileSync(join(workdir, 'src', 'main.ts'), 'export const answer = 42\n', 'utf8')
  ;({ app, window } = await launchWitena(userDataDir))

  await addOllamaProvider(window, [MODEL])
  await openAgents(window)
  await window.getByTestId('agents-new').click()
  await window.getByTestId('agent-name').fill('Ada')
  await window.getByTestId('agent-provider').selectOption({ index: 1 })
  await window.getByTestId('agent-model').selectOption(MODEL)
  await window.getByTestId('agent-save').click()
  await expect(window.getByTestId('agent-save')).toBeDisabled()
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) removeUserDataDir(userDataDir)
  if (workdir) rmSync(workdir, { recursive: true, force: true })
})

test('the Editor block offers three kinds and only shows the template for custom', async () => {
  await openDeveloperSettings(window)

  const block = window.getByTestId('settings-editor')
  await expect(block).toBeVisible()
  // VS Code on a fresh installation, and no command field with it.
  await expect(window.getByTestId('editor-vscode')).toHaveAttribute('aria-pressed', 'true')
  await expect(window.getByTestId('settings-editor-command')).toHaveCount(0)

  await window.getByTestId('editor-custom').click()
  const command = window.getByTestId('settings-editor-command')
  await expect(command).toBeVisible()
  await expect(command).toHaveValue('code -g {path}:{line}')

  await command.fill('subl {path}:{line}')
  await command.press('Enter')

  await window.getByTestId('editor-vscode').click()
  await expect(window.getByTestId('settings-editor-command')).toHaveCount(0)
})

test('the editor choice and its template survive a restart', async () => {
  await app?.close()
  ;({ app, window } = await launchWitena(userDataDir))
  await openDeveloperSettings(window)

  await expect(window.getByTestId('editor-vscode')).toHaveAttribute('aria-pressed', 'true')
  // Switching back to custom shows the template that was typed before the
  // restart, not the default: the two fields are stored independently.
  await window.getByTestId('editor-custom').click()
  await expect(window.getByTestId('settings-editor-command')).toHaveValue('subl {path}:{line}')
  await window.getByTestId('editor-vscode').click()
})

test('a path inside the chat folder becomes a chip, and one outside it does not', async () => {
  await window.getByTestId('nav-chats').click()
  await window.getByTestId('chats-new').click()
  await expect(window.getByTestId('composer-input')).toBeEnabled()

  await window.getByTestId('member-add').click()
  await window.getByTestId('member-candidate').first().click()
  await expect(window.getByTestId('member-row')).toHaveCount(1)

  const chatId = await selectedChatId()
  // The folder picker is a native modal Playwright cannot answer, so the binding
  // is written the way the product writes it (see `executor.spec.ts`).
  expect((await call('chats.update', { id: chatId, patch: { workdir } })).ok).toBe(true)
  await expect(window.getByTestId('chat-workdir')).toHaveAttribute('data-path', workdir)

  await window
    .getByTestId('composer-input')
    .fill('Look at src/main.ts:12 and not at /etc/passwd:1 or 1.2:3')
  await window.getByTestId('composer-input').press('Enter')

  const userMessage = window.locator('[data-testid="message-item"][data-sender="user"]')
  await expect(userMessage).toHaveCount(1)

  // Nothing is sent to a model by this file, and the run this scheduled cannot
  // reach one; stopping it keeps the app quiet for the rest of the spec.
  await call('chat.stop', { chatId })

  const chips = userMessage.getByTestId('file-ref')
  await expect(chips).toHaveCount(1)
  await expect(chips.first()).toHaveAttribute('data-path', 'src/main.ts')
  await expect(chips.first()).toHaveAttribute('data-line', '12')
  await expect(chips.first()).toHaveAttribute('data-openable', 'true')
})

test('the backend really runs the call that chip would make', async () => {
  const chatId = await selectedChatId()
  const marker = join(workdir, 'opened.txt')

  // A **custom** editor rather than the default one, for two reasons: a
  // `vscode://` URL would open the developer's real editor in the middle of a
  // test run, and on a machine with no handler registered for the scheme
  // `shell.openExternal` rejects — which would make this assertion a question
  // about what is installed. A command line is observable and harmless.
  expect(
    (
      await call('settings.update', {
        patch: { editor: { kind: 'custom', command: `cp {path} '${marker}'` } }
      })
    ).ok
  ).toBe(true)

  const opened = await call('system.openInEditor', {
    path: join(workdir, 'src', 'main.ts'),
    line: 12,
    chatId
  })
  expect(opened.ok).toBe(true)

  // The child is detached by design, so the file it writes is what has to be
  // waited for rather than the call.
  await expect
    .poll(() => existsSync(marker), { timeout: 10_000 })
    .toBe(true)
  expect(readFileSync(marker, 'utf8')).toBe('export const answer = 42\n')

  await call('settings.update', { patch: { editor: { kind: 'vscode' } } })
})

test('the backend refuses a path outside the folder and one that is not absolute', async () => {
  const chatId = await selectedChatId()

  expect(await call('system.openInEditor', { path: '/etc/passwd', line: 1, chatId })).toMatchObject({
    error: { code: 'validation', details: { reason: 'editor_path_outside_workdir' } }
  })

  expect(await call('system.openInEditor', { path: 'src/main.ts', chatId })).toMatchObject({
    error: { code: 'validation', details: { reason: 'editor_path_not_absolute' } }
  })
})

test('no chip is drawn in a chat that is not bound to a folder', async () => {
  const chatId = await selectedChatId()
  expect((await call('chats.update', { id: chatId, patch: { workdir: null } })).ok).toBe(true)

  await expect(window.getByTestId('chat-workdir')).toHaveAttribute('data-path', '')
  await expect(window.getByTestId('file-ref')).toHaveCount(0)
})
