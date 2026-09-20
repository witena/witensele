/**
 * The MCP endpoint, end to end through the built shim (S10.3, WP-10).
 *
 * Every other test of this feature holds one half still. `contract.test.ts`
 * drives the real tools over a socket but builds the endpoint itself;
 * `shim.spawn.test.ts` drives the real bundled shim but points it at a stub
 * registry and a hand-written discovery file. This file is the only one where
 * **nothing is stood in for**: a real Witena, launched the way `npm run e2e`
 * launches it, publishes a real discovery file because the setting was switched
 * on through the ordinary backend call, and `out/mcp-shim/witena-mcp.cjs` — the
 * file an IDE is configured with — finds it, forwards a call, and the result of
 * that call shows up in the window a person is looking at.
 *
 * Four claims, in the order the tests make them:
 *
 * | Claim | Why only this file can make it |
 * |---|---|
 * | The switch publishes a discovery file a separate process can read | `host.test.ts` calls `start()` directly; here the only input is `settings.update`, through IPC, in the app |
 * | `tools/list` crosses the stdio hop | Proved offline elsewhere; here it is answered by a shim that has an app to talk to |
 * | `list_chats` answers with a chat the app really has | The chat is seeded through the backend client, so both halves are reading one database |
 * | A `start_discussion` message lands in the open window | The MCP call and the renderer meet on the same event bus, which no unit test has |
 *
 * ## How it stays honest, and safe on a shared machine
 *
 * - The app is launched by `helpers.ts` against a **fresh temporary `userData`
 *   directory**, so it can never see the developer's real `witena.db` — and,
 *   because the single-instance lock is keyed by `userData` (WP-8,
 *   `e2e/launch.spec.ts`), it cannot collide with the Witena the developer has
 *   open.
 * - The shim is spawned with **plain `node`** (`process.execPath` in a
 *   Playwright worker) and the same `WITENA_USER_DATA`. That is deliberate
 *   twice over: it is how `shim.spawn.test.ts` runs it, and under bare `node`
 *   `bundlePathFor` answers `null`, so a shim that failed to find the endpoint
 *   would report it rather than `open`ing a second Witena on a machine several
 *   agents share.
 * - `--background` is not passed. The last claim above is about a window.
 * - Every shim child is closed in `afterEach` and the app in `afterAll`,
 *   whatever happened.
 *
 * There is no launch-time override for the setting: `mcpEndpoint.enabled`
 * defaults to `false` and the only way to change it is `settings.update`, which
 * is what `setEndpoint` does. That is a feature of the test rather than a
 * limitation — the toggle being live is the thing WP-7 promised.
 *
 * Assertions are on `data-testid` values and on `SHIM_ERROR_TEXT`, never on
 * rendered copy, so nothing here depends on the active language and no Chinese
 * appears in this file (CLAUDE.md rule #1).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment
} from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { DISCOVERY_FILE } from '@shared/mcp-discovery'
import { MCP_TOOL_NAMES } from '@shared/mcp-tools'
import { SHIM_ERROR_TEXT } from '../src/mcp-shim/connect'
import { createUserDataDir, launchWitena, removeUserDataDir, repoRoot } from './helpers'

/** Serial: one app, one database, and each test builds on the last one's state. */
test.describe.configure({ mode: 'serial' })

/** The artefact `npm run build` emits and an IDE is pointed at. */
const SHIM = join(repoRoot, 'out', 'mcp-shim', 'witena-mcp.cjs')

/** A provider nothing answers on: the discussion must not need a model to run. */
const DEAD_BASE_URL = 'http://127.0.0.1:9/v1'
const MODEL = 'offline-model'
const AGENT = 'Ada'
const CHAT_TITLE = 'Cache eviction'
const QUESTION = 'Which cache do we evict first?'

let app: ElectronApplication | undefined
let window: Page
let userDataDir: string
let chatId: string

/** Every shim this test started, closed in `afterEach` whatever happened. */
const shims: Client[] = []

/** The preload bridge's envelope, restated here: `e2e/` may not import preload. */
type Envelope =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; details?: unknown } }

/**
 * Calls a backend method from inside the page.
 *
 * `globalThis.witena`, not `window.witena`: this file's `window` is the
 * Playwright page handle, and the bridge lives on the renderer's global.
 */
async function call(method: string, input?: unknown): Promise<unknown> {
  const envelope = (await window.evaluate(
    async (request) =>
      await (
        globalThis as unknown as {
          witena: { invoke(method: string, input?: unknown): Promise<unknown> }
        }
      ).witena.invoke(request.method, request.input),
    { method, input }
  )) as Envelope
  expect(envelope, `${method} failed`).toMatchObject({ ok: true })
  return (envelope as { value: unknown }).value
}

/** Where the app publishes the port and the token the shim needs. */
function discoveryPath(): string {
  return join(userDataDir, DISCOVERY_FILE)
}

/**
 * Throws the switch and waits for the app to have acted on it.
 *
 * The file is written only after `listen` resolves and removed by `stop()`, so
 * its presence is the one externally visible fact that says the door is open —
 * and it is exactly what the shim will go looking for.
 */
async function setEndpoint(enabled: boolean): Promise<void> {
  await call('settings.update', { patch: { mcpEndpoint: { enabled } } })
  await expect
    .poll(() => existsSync(discoveryPath()), { timeout: 10_000 })
    .toBe(enabled)
}

/**
 * The shim, spawned the way an IDE spawns it, pointed at this app's directory.
 *
 * `stderr: 'pipe'` rather than inherited: the shim logs to stderr because stdout
 * is the protocol, and a passing run should not scribble on the report.
 */
async function startShim(clientName = 'witena-e2e'): Promise<Client> {
  const client = new Client({ name: clientName, version: '0.0.0-e2e' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SHIM],
    env: { ...getDefaultEnvironment(), WITENA_USER_DATA: userDataDir },
    stderr: 'pipe'
  })
  await client.connect(transport as unknown as Transport)
  shims.push(client)
  return client
}

test.beforeAll(async () => {
  userDataDir = createUserDataDir()
  ;({ app, window } = await launchWitena(userDataDir))

  // A group that exists and a chat that has it. The provider points at a closed
  // port on purpose: this file is about the plumbing between a coding agent and
  // the app, and a run that needs a model would make it about Ollama instead.
  const provider = (await call('providers.create', {
    input: {
      type: 'openai-compatible',
      name: 'Offline',
      baseUrl: DEAD_BASE_URL,
      models: [MODEL]
    }
  })) as { id: string }

  const agent = (await call('agents.create', {
    input: {
      name: AGENT,
      avatar: { kind: 'initial', text: 'A', palette: 1, color: '#c2653a' },
      description: '',
      systemPrompt: '',
      providerId: provider.id,
      modelId: MODEL,
      params: {},
      skillNames: [],
      mcpServerIds: [],
      memoryEnabled: false,
      role: 'participant'
    }
  })) as { id: string }

  const chat = (await call('chats.create', {
    input: { title: CHAT_TITLE, memberAgentIds: [agent.id] }
  })) as { id: string }
  chatId = chat.id

  // The window has to be *looking at* the chat for the last assertion to mean
  // anything: `chats.create` emits `chat.updated`, which puts the row in the
  // list, but selecting is a click nobody has made yet.
  await window.getByTestId('nav-chats').click()
  await window.getByTestId('chat-item').first().click()
  await expect(window.getByTestId('composer-input')).toBeEnabled()

  await setEndpoint(true)
})

test.afterEach(async () => {
  // Closing the SDK client closes its stdio transport, which kills the child.
  // Never a process this file did not start: the developer's own Witena is
  // running and is not ours to touch.
  for (const client of shims.splice(0)) await client.close().catch(() => undefined)
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) removeUserDataDir(userDataDir)
})

test('the shim serves the seven tools while talking to a real app', async () => {
  const client = await startShim()

  const listed = await client.listTools()
  expect(listed.tools.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES])
})

test('list_chats answers with the chat the app was seeded with', async () => {
  const client = await startShim()

  const result = await client.callTool({ name: 'list_chats', arguments: {} })
  expect(result.isError).toBeUndefined()

  // The shape WP-3 froze: an object, never a bare array, because MCP's
  // `structuredContent` has nowhere to put one.
  const structured = result.structuredContent as {
    chats: { id: string; title: string; url: string; memberNames: string[] }[]
    hint: string
  }
  expect(typeof structured.hint).toBe('string')

  const seeded = structured.chats.find((chat) => chat.id === chatId)
  expect(seeded).toBeDefined()
  expect(seeded?.title).toBe(CHAT_TITLE)
  expect(seeded?.url).toBe(`witena://chat/${chatId}`)
  expect(seeded?.memberNames).toEqual([AGENT])
})

test('a start_discussion from the shim puts the question in the open window', async () => {
  const client = await startShim('codex')

  // `maxWaitSeconds` is the floor the contract allows, because the point is the
  // message rather than the answer: the agent's provider is a closed port, so
  // whatever the run does it will not produce a conclusion. Any status is
  // accepted; what is asserted is that the question reached the transcript.
  const result = await client.callTool({
    name: 'start_discussion',
    arguments: { chatId, question: QUESTION, maxWaitSeconds: 5 }
  })
  expect(result.isError).toBeUndefined()
  expect((result.structuredContent as { chatId: string }).chatId).toBe(chatId)

  const userMessages = window.locator('[data-testid="message-item"][data-sender="user"]')
  await expect(userMessages).toHaveCount(1)
  await expect(userMessages.first()).toContainText(QUESTION)
})

test('with the endpoint switched off the shim says so, in its own words', async () => {
  await setEndpoint(false)

  // A shim started after the switch was thrown, so nothing is cached: it reads
  // no discovery file, finds `<userData>/SingletonLock` — the `<host>-<pid>`
  // symlink Electron keeps inside `userData`, which exists here because this
  // very app is holding the single-instance lock on this directory — and
  // therefore reports `endpoint-off` rather than the weaker `not-running`.
  // Asserted as exactly one of the three, not "either would do": which sentence
  // a user is shown decides whether they go looking for a switch or for an app.
  const client = await startShim()
  const result = await client.callTool({ name: 'list_chats', arguments: {} })

  expect(result.isError).toBe(true)
  expect(result.content).toEqual([{ type: 'text', text: SHIM_ERROR_TEXT['endpoint-off'] }])
})
