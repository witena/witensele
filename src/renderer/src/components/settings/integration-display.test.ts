/**
 * The display rules of Settings → Integrations, state by state.
 *
 * This is where the card's behaviour is proved, and deliberately so: the e2e
 * spec must never press Connect, Disconnect or Repair, because on the machine
 * this suite runs on `claude` and `codex` really are installed and a click would
 * write `~/.claude.json` and `~/.codex/config.toml` — files that belong to
 * whoever is running the tests, not to the tests. So the mapping from the three
 * booleans WP-11 sends to the sentence and the button is asserted here, and
 * `stores/integrations.test.ts` asserts which call that button makes against a
 * fake backend.
 *
 * `t` is a stub that answers with the key, so the assertions name the key rather
 * than the copy and nothing here breaks when a sentence is rewritten — and no
 * Chinese appears in a committed file (CLAUDE.md rule #1).
 */
import { describe, expect, it } from 'vitest'
import { MCP_SERVER_NAME } from '@shared/mcp-tools'
import { IDE_CLIENT_IDS, type IdeClientStatus } from '@shared/types'
import {
  DEV_SHIM_PATH,
  REPO_PLACEHOLDER,
  claudeSnippet,
  codexSnippet,
  endpointState,
  endpointStateLabel,
  endpointTone,
  ideClientAction,
  ideClientActionLabel,
  ideClientName,
  ideClientState,
  ideClientStateLabel,
  ideClientTone,
  launcherInvocation,
  type LauncherInvocation
} from './integration-display'

/** Answers with the key, so a test names the mapping and never the copy. */
const t = (key: string): string => key

function client(overrides: Partial<IdeClientStatus> = {}): IdeClientStatus {
  return { id: 'claude-code', installed: true, connected: false, stale: false, ...overrides }
}

describe('ideClientState', () => {
  it('reads a client that is not on this machine', () => {
    expect(ideClientState(client({ installed: false }))).toBe('not-installed')
  })

  it('reads an installed client with nothing registered', () => {
    expect(ideClientState(client())).toBe('not-connected')
  })

  it('reads a client registered with this installation', () => {
    expect(ideClientState(client({ connected: true }))).toBe('connected')
  })

  it('reads a client registered with another installation', () => {
    expect(ideClientState(client({ connected: true, stale: true }))).toBe('stale')
  })

  it('ignores `connected` and `stale` when the client is absent', () => {
    // WP-11 never sends that combination, but a card that offered Disconnect for
    // a CLI that is not there would offer a call that can only be refused.
    const absent = client({ installed: false, connected: true, stale: true })
    expect(ideClientState(absent)).toBe('not-installed')
    expect(ideClientAction(ideClientState(absent))).toBeNull()
  })
})

describe('ideClientAction', () => {
  it('offers nothing for a client that is not installed', () => {
    expect(ideClientAction('not-installed')).toBeNull()
  })

  it('offers Connect, Disconnect and Repair for the other three', () => {
    expect(ideClientAction('not-connected')).toBe('connect')
    expect(ideClientAction('connected')).toBe('disconnect')
    expect(ideClientAction('stale')).toBe('repair')
  })
})

describe('labels and tones', () => {
  it('names every client state', () => {
    expect(ideClientStateLabel(t, 'not-installed')).toBe(
      'settings.integrations.clientNotInstalled'
    )
    expect(ideClientStateLabel(t, 'not-connected')).toBe('settings.integrations.clientNotConnected')
    expect(ideClientStateLabel(t, 'connected')).toBe('settings.integrations.clientConnected')
    expect(ideClientStateLabel(t, 'stale')).toBe('settings.integrations.clientStale')
  })

  it('names every action', () => {
    expect(ideClientActionLabel(t, 'connect')).toBe('settings.integrations.connect')
    expect(ideClientActionLabel(t, 'disconnect')).toBe('settings.integrations.disconnect')
    expect(ideClientActionLabel(t, 'repair')).toBe('settings.integrations.repair')
  })

  it('names every client WP-11 can report', () => {
    // Driven from `IDE_CLIENT_IDS` rather than a literal pair: a third client
    // added to the contract must fail here rather than render as an empty card.
    for (const id of IDE_CLIENT_IDS) expect(ideClientName(t, id)).toContain('settings.integrations')
  })

  it('colours a stale registration as a warning and an absent client as idle', () => {
    expect(ideClientTone('connected')).toBe('ok')
    expect(ideClientTone('stale')).toBe('warn')
    expect(ideClientTone('not-connected')).toBe('idle')
    expect(ideClientTone('not-installed')).toBe('idle')
  })
})

describe('the endpoint line', () => {
  it('is off when the switch is off, whatever the socket says', () => {
    expect(endpointState({ enabled: false, listening: false })).toBe('off')
    expect(endpointTone({ enabled: false, listening: false })).toBe('idle')
  })

  it('names the port when something is listening', () => {
    expect(endpointStateLabel(t, { enabled: true, listening: true, port: 51789 })).toBe(
      'settings.integrations.endpointListening'
    )
    expect(endpointTone({ enabled: true, listening: true, port: 51789 })).toBe('ok')
  })

  it('warns when the switch is on and nothing is listening', () => {
    // The honest state of a host that failed to start (WP-7): the update
    // succeeded, so `enabled` is true, and no socket exists. One "on" would have
    // to lie about one of the two.
    expect(endpointState({ enabled: true, listening: false })).toBe('not-listening')
    expect(endpointStateLabel(t, { enabled: true, listening: false })).toBe(
      'settings.integrations.endpointNotListening'
    )
    expect(endpointTone({ enabled: true, listening: false })).toBe('warn')
  })
})

describe('the snippets', () => {
  const shipped = (command: string): LauncherInvocation => ({ command, args: [] })

  it('registers the shipped launcher when there is one', () => {
    const command = '/Applications/Witena.app/Contents/Resources/bin/witena-mcp'
    expect(launcherInvocation(command)).toEqual({ command, args: [] })
  })

  it('falls back to the built shim, with the checkout left as a placeholder', () => {
    // The window cannot know where the repository is, so it says so rather than
    // printing a path that would be wrong on every other machine.
    expect(launcherInvocation(null)).toEqual({ command: 'node', args: [DEV_SHIM_PATH] })
    expect(DEV_SHIM_PATH).toContain(REPO_PLACEHOLDER)
    expect(DEV_SHIM_PATH).toContain('out/mcp-shim/witena-mcp.cjs')
  })

  it('keeps the executable and its arguments apart in the fallback', () => {
    // A client looks `command` up as one file: `node /path/shim.cjs` in it would
    // never start.
    const parsed = JSON.parse(claudeSnippet(launcherInvocation(null))) as {
      mcpServers: Record<string, { command: string; args?: string[] }>
    }
    expect(parsed.mcpServers[MCP_SERVER_NAME]).toEqual({ command: 'node', args: [DEV_SHIM_PATH] })
    expect(codexSnippet(launcherInvocation(null))).toBe(
      `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "node"\nargs = ["${DEV_SHIM_PATH}"]\n`
    )
  })

  it('writes JSON a Claude-style client takes', () => {
    const parsed = JSON.parse(claudeSnippet(shipped('/bin/witena-mcp'))) as {
      mcpServers: Record<string, { command: string }>
    }
    expect(parsed.mcpServers[MCP_SERVER_NAME]).toEqual({ command: '/bin/witena-mcp' })
  })

  it('escapes a path the way JSON defines it', () => {
    // A bundle path can contain anything a file name can; the snippet is pasted
    // into a configuration file, so a broken escape is a broken installation.
    const parsed = JSON.parse(claudeSnippet(shipped('/Apps/My "Witena"\\x/witena-mcp'))) as {
      mcpServers: Record<string, { command: string }>
    }
    expect(parsed.mcpServers[MCP_SERVER_NAME]?.command).toBe('/Apps/My "Witena"\\x/witena-mcp')
  })

  it('writes the TOML table Codex keeps its servers in', () => {
    expect(codexSnippet(shipped('/bin/witena-mcp'))).toBe(
      `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "/bin/witena-mcp"\n`
    )
  })

  it('escapes a TOML basic string', () => {
    expect(codexSnippet(shipped('/Apps/My "W"\\x/witena-mcp'))).toContain(
      'command = "/Apps/My \\"W\\"\\\\x/witena-mcp"'
    )
  })

  it('quotes a path containing spaces in both snippets', () => {
    const command = '/Applications/My Apps/Witena.app/Contents/Resources/bin/witena-mcp'
    expect(claudeSnippet(shipped(command))).toContain(`"${command}"`)
    expect(codexSnippet(shipped(command))).toContain(`"${command}"`)
  })
})
