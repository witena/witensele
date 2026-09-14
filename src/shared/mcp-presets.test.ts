/**
 * The gallery is data, so its test is a set of invariants rather than a set of
 * examples: everything the editor assumes about an entry is asserted here once,
 * and a preset that breaks an assumption fails before it reaches a screen.
 *
 * The one assertion that is *not* here is that every preset has a description in
 * both locale files — that lives in `src/renderer/src/i18n/locales.test.ts`,
 * where the two locale trees are already loaded and flattened.
 */
import { describe, expect, it } from 'vitest'
import { MCP_PRESETS, getMcpPreset, type McpPreset } from './mcp-presets'

const byId = (id: string): McpPreset => {
  const preset = getMcpPreset(id)
  if (!preset) throw new Error(`missing preset: ${id}`)
  return preset
}

describe('MCP_PRESETS', () => {
  it('has unique ids', () => {
    const ids = MCP_PRESETS.map((preset) => preset.id)
    expect(ids).toEqual([...new Set(ids)])
  })

  it('ships the connectors the plan names', () => {
    const ids = MCP_PRESETS.map((preset) => preset.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'everything',
        'filesystem',
        'git',
        'github',
        'fetch',
        'brave-search',
        'sequential-thinking',
        'slack',
        'notion',
        'playwright'
      ])
    )
  })

  it('gives every preset a non-empty name, a transport and a docs link', () => {
    for (const preset of MCP_PRESETS) {
      expect(preset.name.trim(), preset.id).not.toBe('')
      expect(['stdio', 'http'], preset.id).toContain(preset.transport)
      expect(preset.docsUrl, preset.id).toMatch(/^https:\/\//)
    }
  })

  it('gives every stdio preset except `custom` a command, and every http one a URL', () => {
    for (const preset of MCP_PRESETS) {
      if (preset.id === 'custom') continue
      if (preset.transport === 'stdio') {
        expect(preset.command?.trim(), preset.id).toBeTruthy()
        expect(preset.url, preset.id).toBeUndefined()
      } else {
        expect(preset.url, preset.id).toMatch(/^https?:\/\//)
        expect(preset.command, preset.id).toBeUndefined()
      }
    }
    // `custom` is precisely the entry the user fills in themselves.
    expect(byId('custom').command).toBeUndefined()
    expect(byId('custom').url).toBeUndefined()
  })

  it('names the runner of every command that needs one', () => {
    for (const preset of MCP_PRESETS) {
      if (!preset.command) continue
      expect(preset.requires, preset.id).toBe(preset.command)
      expect(['npx', 'uvx', 'docker'], preset.id).toContain(preset.requires)
    }
  })

  it('carries no argument that is empty or padded', () => {
    for (const preset of MCP_PRESETS) {
      for (const arg of preset.args ?? []) {
        // `textToArgs` would drop or trim it, so the draft would not be what the
        // preset says it is.
        expect(arg, preset.id).toBe(arg.trim())
        expect(arg.length, preset.id).toBeGreaterThan(0)
      }
    }
  })

  it('lists the variables a server needs with empty values', () => {
    // A preset that shipped a value would be shipping a secret; an empty value is
    // what turns the environment box into a form to fill in.
    for (const preset of MCP_PRESETS) {
      for (const [key, value] of Object.entries(preset.env ?? {})) {
        expect(key.trim(), preset.id).not.toBe('')
        expect(value, `${preset.id}.${key}`).toBe('')
      }
    }
    expect(byId('github').env).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: '' })
    expect(byId('slack').env).toEqual({ SLACK_BOT_TOKEN: '', SLACK_TEAM_ID: '' })
  })

  it('flags the connectors that write and only those', () => {
    const writing = MCP_PRESETS.filter((preset) => preset.sideEffects).map((preset) => preset.id)
    expect(writing.sort()).toEqual(
      ['filesystem', 'git', 'github', 'notion', 'playwright', 'slack'].sort()
    )
  })

  it('prefills GitHub exactly as the step requires', () => {
    // The acceptance sentence of S5.1, asserted rather than described.
    expect(byId('github')).toMatchObject({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      sideEffects: true
    })
    expect(byId('fetch').sideEffects).toBe(false)
  })
})

describe('getMcpPreset', () => {
  it('finds a preset by id', () => {
    expect(getMcpPreset('everything')?.command).toBe('npx')
  })

  it('answers undefined for an unknown or absent id rather than throwing', () => {
    expect(getMcpPreset('nope')).toBeUndefined()
    expect(getMcpPreset(undefined)).toBeUndefined()
    expect(getMcpPreset('')).toBeUndefined()
  })
})
