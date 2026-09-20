/**
 * Settings → Integrations, in the running app (S10.4, WP-12).
 *
 * ## The one rule this file exists under
 *
 * **It never presses Connect, Disconnect or Repair.** On the machine this suite
 * runs on, `claude` and `codex` really are installed, and those three buttons run
 * `claude mcp add` / `codex mcp remove`, which rewrite `~/.claude.json` and
 * `~/.codex/config.toml` — files that belong to whoever is running the tests and
 * that no test may touch. So the app is launched with `WITENA_CLAUDE_BIN` and
 * `WITENA_CODEX_BIN` pointing at a path that does not exist: `resolveCliBinary`
 * returns an override without checking it exists, the `--version` probe then
 * fails, and both cards render *not installed* on every machine, with no action
 * button to click even by accident. The first test asserts exactly that, which is
 * both a check of the not-installed state and the guard that keeps this file
 * safe.
 *
 * Everything that happens *after* one of those buttons is pressed is asserted in
 * `src/renderer/src/stores/integrations.test.ts` against a fake backend, and the
 * card's state-to-button mapping in
 * `src/renderer/src/components/settings/integration-display.test.ts`.
 *
 * ## What is left for this file, and why only it can make these claims
 *
 * | Claim | Why here |
 * |---|---|
 * | The section reads the real `integrations.status` and draws one card per client | Nothing else runs the handler, the CLI probe and the renderer in one process |
 * | The switch publishes and removes the discovery file | The toggle is live (WP-7): the observable effect is a file appearing in the temporary `userData` directory, which a unit test has no app to produce |
 * | A snippet reaches the system clipboard | `navigator.clipboard` exists only in a real window; the value is read back through Electron's own `clipboard` module |
 *
 * Assertions are on `data-testid` and `data-*` values, never on rendered copy, so
 * nothing here depends on the active language and no Chinese appears in a
 * committed file (CLAUDE.md rule #1).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { DISCOVERY_FILE } from '@shared/mcp-discovery'
import { MCP_SERVER_NAME } from '@shared/mcp-tools'
import { IDE_CLIENT_IDS } from '@shared/types'
import {
  createUserDataDir,
  launchWitena,
  openIntegrationsSettings,
  removeUserDataDir
} from './helpers'

/** Serial: one app, one database, and the switch's state carries between tests. */
test.describe.configure({ mode: 'serial' })

/**
 * A path no CLI can be at.
 *
 * `resolveCliBinary` returns an environment override verbatim, without an
 * existence check, so this is the only way to get a run where both coding agents
 * are definitively absent on a machine that has them — the same trick the
 * provider sign-in spec plays with `WITENA_ANT_BIN`.
 */
const NO_CLI = '/nonexistent/witena-e2e/no-such-cli'

let app: ElectronApplication | undefined
let window: Page
let userDataDir: string

function discoveryPath(): string {
  return join(userDataDir, DISCOVERY_FILE)
}

/** The system clipboard, read through Electron's own module in the main process. */
async function readClipboard(): Promise<string> {
  return (await app?.evaluate(({ clipboard }) => clipboard.readText())) ?? ''
}

test.beforeAll(async () => {
  userDataDir = createUserDataDir()
  ;({ app, window } = await launchWitena(userDataDir, {
    WITENA_CLAUDE_BIN: NO_CLI,
    WITENA_CODEX_BIN: NO_CLI
  }))
  await openIntegrationsSettings(window)
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) removeUserDataDir(userDataDir)
})

test('draws one card per client, and offers no action for a CLI that is absent', async () => {
  const cards = window.getByTestId('integration-card')
  await expect(cards).toHaveCount(IDE_CLIENT_IDS.length)

  // The order is the contract's, so the card can be found by position.
  for (const [index, id] of IDE_CLIENT_IDS.entries()) {
    await expect(cards.nth(index)).toHaveAttribute('data-client', id)
    await expect(cards.nth(index)).toHaveAttribute('data-state', 'not-installed')
  }

  // The safety assertion: with both binaries overridden there is no Connect,
  // Disconnect or Repair anywhere on this screen to click.
  await expect(window.getByTestId('integration-card-action')).toHaveCount(0)
})

test('the switch opens the endpoint and publishes the discovery file', async () => {
  expect(existsSync(discoveryPath())).toBe(false)
  await expect(window.getByTestId('integrations-endpoint-status')).toHaveAttribute(
    'data-status',
    'off'
  )

  await window.getByTestId('integrations-endpoint-toggle').getByRole('switch').click()

  // The file is written only after `listen` resolves, so its appearance is the
  // one externally visible fact that says the door is open.
  await expect.poll(() => existsSync(discoveryPath()), { timeout: 10_000 }).toBe(true)
  await expect(window.getByTestId('integrations-endpoint-toggle')).toHaveAttribute(
    'data-enabled',
    'true'
  )
  // Two facts, not one: the row says on and this process says it has a socket.
  await expect(window.getByTestId('integrations-endpoint-status')).toHaveAttribute(
    'data-status',
    'listening'
  )
})

test('the switch closes it again and takes the file with it', async () => {
  await window.getByTestId('integrations-endpoint-toggle').getByRole('switch').click()

  await expect.poll(() => existsSync(discoveryPath()), { timeout: 10_000 }).toBe(false)
  await expect(window.getByTestId('integrations-endpoint-toggle')).toHaveAttribute(
    'data-enabled',
    'false'
  )
  await expect(window.getByTestId('integrations-endpoint-status')).toHaveAttribute(
    'data-status',
    'off'
  )
})

test('the snippets are copyable, and say so when the build ships no launcher', async () => {
  // `npm run build` produces no bundle, so `mcpLauncherPath()` is null here and
  // the section has to draw the development fallback rather than an error.
  await expect(window.getByTestId('integrations-dev-note')).toBeVisible()
  await expect(window.getByTestId('integrations-snippet-json')).toContainText(
    'out/mcp-shim/witena-mcp.cjs'
  )

  // `navigator.clipboard.writeText` refuses in a document that is not focused,
  // and the window a Playwright worker launched is behind the terminal.
  await window.bringToFront()

  await window.getByTestId('integrations-snippet-json-copy').click()
  await expect(window.getByTestId('integrations-snippet-json-copy')).toHaveAttribute(
    'data-copied',
    'true'
  )
  // Polled, not read once: `data-copied` flips synchronously with the click,
  // while `writeText` is a promise the button deliberately does not wait for.
  await expect.poll(readClipboard).toContain(`"${MCP_SERVER_NAME}"`)
  expect(JSON.parse(await readClipboard())).toMatchObject({
    mcpServers: { [MCP_SERVER_NAME]: { command: expect.stringContaining('witena-mcp.cjs') } }
  })

  await window.getByTestId('integrations-snippet-toml-copy').click()
  await expect(window.getByTestId('integrations-snippet-toml-copy')).toHaveAttribute(
    'data-copied',
    'true'
  )
  await expect.poll(readClipboard).toContain(`[mcp_servers.${MCP_SERVER_NAME}]`)
  expect(await readClipboard()).toContain('command = "node ')
})

test('the acceptance screenshot', async () => {
  // Light, so the picture is readable whatever appearance the machine is in.
  await window.getByTestId('settings-section-appearance').click()
  await window.getByTestId('theme-light').click()
  await openIntegrationsSettings(window)
  await expect(window.getByTestId('integration-card')).toHaveCount(IDE_CLIENT_IDS.length)

  // A transition has nothing to await; only time finishes it.
  await window.waitForTimeout(350)
  await window.screenshot({ path: 'test-results/integrations/light-integrations.png' })
})
