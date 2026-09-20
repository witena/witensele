/**
 * Pure display rules for Settings → Integrations: what a client card says, which
 * button it offers, and the two configuration snippets.
 *
 * Separated from the section for the same reason as `mcp-display.ts`: these are
 * the parts worth a unit test, and a test that has to mount React to check that a
 * connected-but-stale client offers Repair rather than Disconnect is a test
 * nobody writes. The renderer suite runs in plain `node`, with no DOM.
 *
 * The labels are written as a `switch` of **literal** `t()` calls, the discipline
 * `i18n/errors.ts` and `lib/updates.ts` already follow, for the two reasons that
 * file states: `t(KEYS[state])` is invisible to `used-keys.test.ts`, so a typo
 * would ship; and a `switch` with no `default` makes the compiler prove the
 * mapping is total when a state is added.
 *
 * The **snippets are not copy.** A command and the JSON or TOML around it are the
 * same in every language — a translated `mcpServers` key would be wrong in both —
 * so they are built here as data and printed verbatim, exactly as Settings →
 * About prints the version string. The sentence *around* them goes through
 * `t()` like everything else (`docs/features/mcp-endpoint/frontend.md`, WP-9).
 */
import { MCP_SERVER_NAME } from '@shared/mcp-tools'
import type { IdeClientId, IdeClientStatus, IntegrationStatus } from '@shared/types'
import type { StatusTone } from '../ui'

/** The subset of i18next's `t` this module needs; keeps it testable with a stub. */
export type TranslateFn = (key: string, params: Record<string, unknown>) => string

/**
 * What a client card is showing, collapsed from the three booleans WP-11 sends.
 *
 * `stale` is a state of its own rather than a modifier of `connected`, because it
 * is the one case where the card's sentence *and* its button both change: the
 * client is registered, but with another installation's command, and the offer is
 * to repair it rather than to take it away.
 */
export type IdeClientState = 'not-installed' | 'not-connected' | 'connected' | 'stale'

/** The one call a card offers, or `null` when it offers none. */
export type IdeClientAction = 'connect' | 'disconnect' | 'repair'

/** How the endpoint line reads: the two facts WP-11 reports, as one state. */
export type EndpointState = 'off' | 'listening' | 'not-listening'

export function ideClientState(client: IdeClientStatus): IdeClientState {
  if (!client.installed) return 'not-installed'
  if (!client.connected) return 'not-connected'
  return client.stale ? 'stale' : 'connected'
}

/**
 * Which call the button makes.
 *
 * Repair is `integrations.connect`, the same method Connect calls — that is
 * WP-11's rule, and the reason the two cannot drift apart (a registration naming
 * another installation is removed and added again inside the handler). A client
 * that is not installed offers nothing: there is no CLI to run, and the snippet
 * block below the cards is the fallback for every other client anyway.
 */
export function ideClientAction(state: IdeClientState): IdeClientAction | null {
  switch (state) {
    case 'not-installed':
      return null
    case 'not-connected':
      return 'connect'
    case 'connected':
      return 'disconnect'
    case 'stale':
      return 'repair'
  }
}

export function ideClientTone(state: IdeClientState): StatusTone {
  switch (state) {
    case 'connected':
      return 'ok'
    case 'stale':
      return 'warn'
    case 'not-installed':
    case 'not-connected':
      return 'idle'
  }
}

export function ideClientStateLabel(t: TranslateFn, state: IdeClientState): string {
  switch (state) {
    case 'not-installed':
      return t('settings.integrations.clientNotInstalled', {})
    case 'not-connected':
      return t('settings.integrations.clientNotConnected', {})
    case 'connected':
      return t('settings.integrations.clientConnected', {})
    case 'stale':
      return t('settings.integrations.clientStale', {})
  }
}

export function ideClientActionLabel(t: TranslateFn, action: IdeClientAction): string {
  switch (action) {
    case 'connect':
      return t('settings.integrations.connect', {})
    case 'disconnect':
      return t('settings.integrations.disconnect', {})
    case 'repair':
      return t('settings.integrations.repair', {})
  }
}

/**
 * The client's own name.
 *
 * Through `t()` like every other label, and identical in both locale files: a
 * product is called Claude Code in Chinese too, and `locales.test.ts` allows a
 * value that is deliberately the same on both sides. Keeping it a key rather
 * than a literal is what stops the next client being hard-coded into the JSX.
 */
export function ideClientName(t: TranslateFn, id: IdeClientId): string {
  switch (id) {
    case 'claude-code':
      return t('settings.integrations.clientClaudeCode', {})
    case 'codex':
      return t('settings.integrations.clientCodex', {})
  }
}

/**
 * The endpoint's two facts as one state.
 *
 * `enabled` is the switch's position and `listening` is whether this process has
 * a socket; they agree in the desktop app and disagree wherever the host could
 * not start. A line that showed only one of them would be wrong in exactly the
 * case a user reports (WP-7).
 */
export function endpointState(endpoint: IntegrationStatus['endpoint']): EndpointState {
  if (!endpoint.enabled) return 'off'
  return endpoint.listening ? 'listening' : 'not-listening'
}

export function endpointStateLabel(t: TranslateFn, endpoint: IntegrationStatus['endpoint']): string {
  switch (endpointState(endpoint)) {
    case 'off':
      return t('settings.integrations.endpointOff', {})
    case 'listening':
      return t('settings.integrations.endpointListening', { port: endpoint.port ?? 0 })
    case 'not-listening':
      return t('settings.integrations.endpointNotListening', {})
  }
}

export function endpointTone(endpoint: IntegrationStatus['endpoint']): StatusTone {
  switch (endpointState(endpoint)) {
    case 'listening':
      return 'ok'
    case 'not-listening':
      return 'warn'
    case 'off':
      return 'idle'
  }
}

/**
 * The command a client is pointed at when this build ships no launcher.
 *
 * A development checkout has no bundle, so there is no stable path to print
 * (`frontend.md`, WP-9). The honest command is the built shim run by plain
 * `node`, and the only part this window cannot know is where the checkout is —
 * so it is left as a placeholder that `settings.integrations.snippetDevNote`
 * explains, rather than guessed at or silently omitted.
 */
export const REPO_PLACEHOLDER = '<witena-repo>'

/** What `npm run build` and `npm run mcp-shim:build` both emit. */
export const DEV_LAUNCHER_COMMAND = `node ${REPO_PLACEHOLDER}/out/mcp-shim/witena-mcp.cjs`

/** The command the snippets register: the shipped launcher, or the dev fallback. */
export function launcherCommand(launcherPath: string | null): string {
  return launcherPath ?? DEV_LAUNCHER_COMMAND
}

/**
 * The `mcpServers` entry Claude Code and every client with its JSON shape take.
 *
 * Built with `JSON.stringify` rather than a template, so a path containing a
 * quote or a backslash is escaped by the thing that defines the escaping.
 */
export function claudeSnippet(command: string): string {
  return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command } } }, null, 2)
}

/** A TOML basic string: only `\` and `"` need escaping in a single-line one. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** The `[mcp_servers.witena]` table Codex's `config.toml` takes. */
export function codexSnippet(command: string): string {
  return `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = ${tomlString(command)}\n`
}
