/**
 * The connector gallery: the MCP servers "Add server" offers as a starting point.
 *
 * Shaped exactly like `presets.ts`, and for the same reason — a preset is
 * **static data, not a record**. It carries no id of a stored row and no user: it
 * only prefills the editor's draft (transport, command, arguments, the variables
 * the server needs, and the side-effects flag) so that registering the GitHub
 * server is a click plus a token rather than a command typed from memory.
 *
 * Two differences from `ProviderPreset` are worth stating, because both are
 * deliberate:
 *
 * - **A preset id is not stored anywhere.** `McpServer` has no `presetId` column,
 *   unlike `Provider`. Nothing downstream needs to know which tile a server came
 *   from — there is no logo to pick again and no "local server" rule to derive —
 *   so the gallery's selection is view state in the editor, not a column and not
 *   a migration.
 * - **`env` values are empty on purpose.** A preset lists the variables a server
 *   needs (`GITHUB_PERSONAL_ACCESS_TOKEN: ''`), so that picking the tile opens
 *   the environment box already showing the `KEY=` lines the user has to fill
 *   in. A preset never carries a secret, and an empty value is the difference
 *   between "you need this variable" and a silent failure to start.
 *
 * It lives in `src/shared/` because the renderer renders the grid straight from
 * `MCP_PRESETS` — there is deliberately no `mcp.presets` backend method, a round
 * trip for a frozen array being pure ceremony. Nothing here may import electron,
 * node built-ins or renderer code.
 *
 * Package names and command lines age: an MCP server that is renamed or moved
 * makes an entry a **cosmetic** bug, because everything a preset writes is
 * visible and editable in the form before Save. The `sideEffects` flag is the one
 * field that is not cosmetic — it decides whether a participant agent may ever
 * see the server's tools (`collectAgentTools`) — so it is set from what the
 * server's tools *can* do, never from what a given user intends to use them for.
 */
import type { McpTransport } from './types'

/** The runner a preset's command needs on `PATH`, named on the tile as a hint. */
export type McpRunner = 'npx' | 'uvx' | 'docker'

/** One entry of the connector gallery. */
export interface McpPreset {
  /** Stable identifier: the tile's test id, its description key, and the default server name. */
  id: string
  /** Brand name, shown as-is. Not translated — `custom` is labelled by the UI. */
  name: string
  transport: McpTransport
  /** stdio: the executable. Absent only for `custom`, which is the blank form. */
  command?: string
  args?: readonly string[]
  /** Variables the server needs, with **empty** values. Never a secret. */
  env?: Readonly<Record<string, string>>
  /** http: the endpoint. */
  url?: string
  /** True when the server's tools change the outside world; drives the rule in `collectAgentTools`. */
  sideEffects: boolean
  /** Where the server documents its own setup. Data only today — nothing renders it yet. */
  docsUrl: string
  /** Which runner the command needs, so the tile can warn before the probe does. */
  requires?: McpRunner
}

/**
 * Every preset, in the order the gallery shows them: the read-only servers a
 * user can try immediately, then the ones that need a key or a token, then the
 * ones that write, and finally the empty "type it yourself" entry.
 *
 * The order is not alphabetical on purpose — the first tiles should be the ones
 * that work with nothing but a runner on `PATH`.
 */
export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: 'everything',
    name: 'Everything',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    sideEffects: false,
    requires: 'npx',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything'
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    sideEffects: false,
    requires: 'npx',
    docsUrl:
      'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking'
  },
  {
    id: 'fetch',
    name: 'Fetch',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    sideEffects: false,
    requires: 'uvx',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch'
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: '' },
    sideEffects: false,
    requires: 'npx',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search'
  },
  {
    id: 'git',
    name: 'Git',
    transport: 'stdio',
    command: 'uvx',
    // No `--repository`: the server takes a repo path per call, so leaving it out
    // keeps one registration usable from more than one chat's working directory.
    args: ['mcp-server-git'],
    // `git_add` / `git_commit` write to the repository, which is exactly the case
    // the rule exists for — even though most of this server's tools only read.
    sideEffects: true,
    requires: 'uvx',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git'
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    transport: 'stdio',
    command: 'npx',
    // The last argument is a placeholder the user replaces: the server refuses
    // every path outside the directories named on its command line, so a preset
    // cannot guess it and must not silently grant the home directory.
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/project'],
    sideEffects: true,
    requires: 'npx',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem'
  },
  {
    id: 'github',
    name: 'GitHub',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    sideEffects: true,
    requires: 'npx',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github'
  },
  {
    id: 'slack',
    name: 'Slack',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    env: { SLACK_BOT_TOKEN: '', SLACK_TEAM_ID: '' },
    sideEffects: true,
    requires: 'npx',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack'
  },
  {
    id: 'notion',
    name: 'Notion',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    env: { NOTION_TOKEN: '' },
    sideEffects: true,
    requires: 'npx',
    docsUrl: 'https://github.com/makenotion/notion-mcp-server'
  },
  {
    id: 'playwright',
    name: 'Playwright',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    // Driving a browser submits forms and clicks buttons on the live web.
    sideEffects: true,
    requires: 'npx',
    docsUrl: 'https://github.com/microsoft/playwright-mcp'
  },
  {
    id: 'custom',
    // The only entry whose name is a UI concept rather than a brand, so the
    // renderer labels it with `settings.mcp.presetCustom` instead.
    name: 'Custom',
    transport: 'stdio',
    // Deliberately no command, no arguments and no variables: this is the tile
    // that clears the form back to an empty stdio draft.
    sideEffects: false,
    docsUrl: 'https://modelcontextprotocol.io/docs/concepts/transports'
  }
]

/** The preset with this id, or `undefined` for an unknown one. */
export function getMcpPreset(id: string | undefined): McpPreset | undefined {
  if (!id) return undefined
  return MCP_PRESETS.find((preset) => preset.id === id)
}
