/**
 * The MCP store's draft half, in particular the connector gallery's
 * `applyPreset`.
 *
 * No fake backend here and none needed: `startCreate`, `patchDraft` and
 * `applyPreset` are pure local state, and everything that talks to the backend is
 * covered where the contract lives (`src/main/handlers/mcp.test.ts`) or end to
 * end (`e2e/mcp.spec.ts`). The store is vanilla zustand, so `getState()` drives
 * it without React.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { emptyDraft, useMcpStore } from './mcp'

const state = () => useMcpStore.getState()

beforeEach(() => {
  useMcpStore.setState({ mode: 'idle', selectedId: null, draft: null })
})

describe('applyPreset', () => {
  it('fills a fresh draft from the preset and names it after the preset id', () => {
    state().startCreate()
    state().applyPreset('github')

    expect(state().draft).toMatchObject({
      // The id, not `GitHub`: the name is also the tool prefix agents see.
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
      sideEffects: true,
      enabled: true
    })
  })

  it('keeps a name the user already typed', () => {
    state().startCreate()
    state().patchDraft({ name: 'work-github' })
    state().applyPreset('github')

    expect(state().draft?.name).toBe('work-github')
    expect(state().draft?.command).toBe('npx')
  })

  it('leaves the side-effects switch off for a read-only connector', () => {
    state().startCreate()
    state().applyPreset('github')
    state().applyPreset('fetch')

    expect(state().draft).toMatchObject({
      command: 'uvx',
      args: ['mcp-server-fetch'],
      sideEffects: false
    })
    // The previous preset's token variable must not survive the switch.
    expect(state().draft?.env).toEqual({})
  })

  it('clears the form for the custom tile', () => {
    state().startCreate()
    state().applyPreset('filesystem')
    state().applyPreset('custom')

    expect(state().draft).toMatchObject({
      transport: 'stdio',
      command: '',
      args: [],
      env: {},
      url: '',
      sideEffects: false
    })
  })

  it('copies the preset rather than sharing its arrays and maps', () => {
    state().startCreate()
    state().applyPreset('slack')
    state().patchDraft({ args: [...(state().draft?.args ?? []), '--verbose'] })

    // A second draft must start from the preset as written, not from the edit.
    state().startCreate()
    state().applyPreset('slack')
    expect(state().draft?.args).toEqual(['-y', '@modelcontextprotocol/server-slack'])
  })

  it('ignores an unknown preset id', () => {
    state().startCreate()
    state().applyPreset('nope')

    expect(state().draft).toEqual(emptyDraft())
  })

  it('does nothing when the editor is closed', () => {
    state().applyPreset('github')

    expect(state().draft).toBeNull()
  })
})
