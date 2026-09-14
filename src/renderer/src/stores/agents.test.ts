/**
 * The agents store against a fake `BackendClient`.
 *
 * Same approach as `providers.test.ts`: no jsdom, no React, no Electron. Two
 * things are worth proving here and are hard to see by reading the store —
 * **the draft lifecycle** (open, edit, save, reopen; `dirty` going true and back
 * to false; a create turning into an edit of the row it produced) and
 * **`validateDraft`**, which is what disables Save and must agree with the
 * backend's own rules in `src/main/handlers/agents.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendClient, BackendMethod } from '@shared/backend'
import type { Agent, AgentInput } from '@shared/types'
import { LOCAL_USER_ID } from '@shared/types'
import { AGENT_TEMPLATES, getAgentTemplate, type AgentTemplate } from '@shared/agent-templates'
import { resetBackend, setBackend } from '../lib/backend-provider'
import {
  draftFromAgent,
  duplicateName,
  emptyAgentDraft,
  isDraftValid,
  useAgentsStore,
  validateDraft
} from './agents'

interface Call {
  method: BackendMethod
  input: unknown
}

function agentFrom(id: string, input: AgentInput): Agent {
  return { id, userId: LOCAL_USER_ID, createdAt: 0, updatedAt: 0, ...input }
}

function validDraft(overrides: Partial<AgentInput> = {}): AgentInput {
  return { ...emptyAgentDraft(), name: 'Ada', providerId: 'p1', modelId: 'gpt-4o', ...overrides }
}

function fakeBackend(initial: Agent[] = []): { client: BackendClient; calls: Call[] } {
  const calls: Call[] = []
  let rows = [...initial]
  let nextId = 1

  const client: BackendClient = {
    invoke: (async (method: BackendMethod, input: unknown) => {
      calls.push({ method, input })
      if (method === 'agents.list') return rows
      if (method === 'agents.create') {
        const created = agentFrom(`a${nextId++}`, (input as { input: AgentInput }).input)
        rows = [...rows, created]
        return created
      }
      if (method === 'agents.update') {
        const { id, patch } = input as { id: string; patch: Partial<AgentInput> }
        const updated = { ...(rows.find((row) => row.id === id) as Agent), ...patch }
        rows = rows.map((row) => (row.id === id ? updated : row))
        return updated
      }
      if (method === 'agents.delete') {
        rows = rows.filter((row) => row.id !== (input as { id: string }).id)
        return undefined
      }
      throw new Error(`unexpected method ${method}`)
    }) as BackendClient['invoke'],
    subscribe: () => () => undefined
  }

  return { client, calls }
}

/** The store is a module singleton; every test starts from the same blank slate. */
function resetStore(): void {
  useAgentsStore.setState({
    agents: [],
    status: 'idle',
    error: undefined,
    errorCode: undefined,
    selectedId: null,
    mode: 'idle',
    draft: null,
    dirty: false,
    saving: false
  })
}

describe('validateDraft', () => {
  it('accepts a complete draft', () => {
    expect(validateDraft(validDraft(), [], null)).toEqual({})
    expect(isDraftValid(validateDraft(validDraft(), [], null))).toBe(true)
  })

  it('reports an empty or whitespace-only name', () => {
    expect(validateDraft(validDraft({ name: '' }), [], null).name).toBe('required')
    expect(validateDraft(validDraft({ name: '   ' }), [], null).name).toBe('required')
  })

  it('reports a name containing @, which would break an @mention', () => {
    expect(validateDraft(validDraft({ name: 'Ada@work' }), [], null).name).toBe('at')
  })

  it('reports a name another agent holds, ignoring case, but not the agent itself', () => {
    const ada = agentFrom('a1', validDraft({ name: 'Ada' }))

    expect(validateDraft(validDraft({ name: 'ada' }), [ada], null).name).toBe('taken')
    expect(validateDraft(validDraft({ name: 'Ada' }), [ada], 'a1').name).toBeUndefined()
  })

  it('reports a missing provider and a missing model', () => {
    const errors = validateDraft(validDraft({ providerId: '', modelId: ' ' }), [], null)

    expect(errors).toEqual({ providerId: 'required', modelId: 'required' })
  })

  it('says nothing about the sampling parameters the form no longer offers', () => {
    // S5.9 removed the two controls. A value can still reach a draft — from a
    // record saved before the change — and it is not the form's to complain
    // about; `agents.create` / `agents.update` still bound both fields for any
    // caller that sets them.
    expect(validateDraft(validDraft({ params: { temperature: 2.1 } }), [], null)).toEqual({})
    expect(validateDraft(validDraft({ params: { maxTokens: 0 } }), [], null)).toEqual({})
    expect(validateDraft(validDraft({ params: {} }), [], null)).toEqual({})
  })
})

describe('duplicateName', () => {
  it('appends the suffix, then a number until the name is free', () => {
    expect(duplicateName('Architect', [])).toBe('Architect copy')
    expect(duplicateName('Architect', ['Architect copy'])).toBe('Architect copy 2')
    expect(duplicateName('Architect', ['architect copy', 'Architect copy 2'])).toBe(
      'Architect copy 3'
    )
  })
})

describe('agents store', () => {
  afterEach(() => {
    resetBackend()
    resetStore()
  })

  beforeEach(() => {
    resetStore()
  })

  it('loads the list', async () => {
    const ada = agentFrom('a1', validDraft())
    setBackend(fakeBackend([ada]).client)

    await useAgentsStore.getState().load()

    expect(useAgentsStore.getState().agents).toEqual([ada])
    expect(useAgentsStore.getState().status).toBe('ready')
  })

  it('opens a create draft that is dirty but not yet valid', () => {
    setBackend(fakeBackend().client)

    useAgentsStore.getState().startCreate()

    const state = useAgentsStore.getState()
    expect(state.mode).toBe('create')
    expect(state.selectedId).toBeNull()
    expect(state.dirty).toBe(true)
    expect(isDraftValid(state.draftErrors())).toBe(false)
  })

  it('turns a saved create into an edit of the row it produced', async () => {
    const { client, calls } = fakeBackend()
    setBackend(client)

    useAgentsStore.getState().startCreate()
    useAgentsStore.getState().patchDraft({ name: 'Ada', providerId: 'p1', modelId: 'gpt-4o' })
    const created = await useAgentsStore.getState().saveDraft()

    expect(created).toMatchObject({ id: 'a1', name: 'Ada' })
    const state = useAgentsStore.getState()
    expect(state.mode).toBe('edit')
    expect(state.selectedId).toBe('a1')
    expect(state.dirty).toBe(false)
    expect(state.agents).toHaveLength(1)
    expect(calls.map((call) => call.method)).toEqual(['agents.create'])
  })

  it('derives the avatar monogram from the name when none was typed', async () => {
    setBackend(fakeBackend().client)

    useAgentsStore.getState().startCreate()
    useAgentsStore.getState().patchDraft({ name: 'reviewer', providerId: 'p1', modelId: 'm' })
    const created = await useAgentsStore.getState().saveDraft()

    expect(created?.avatar.text).toBe('R')
  })

  it('goes dirty on a change and clean again after saving', async () => {
    const ada = agentFrom('a1', validDraft())
    setBackend(fakeBackend([ada]).client)
    await useAgentsStore.getState().load()

    useAgentsStore.getState().startEdit('a1')
    expect(useAgentsStore.getState().dirty).toBe(false)

    useAgentsStore.getState().patchDraft({ description: 'Systems thinker' })
    expect(useAgentsStore.getState().dirty).toBe(true)

    await useAgentsStore.getState().saveDraft()
    expect(useAgentsStore.getState().dirty).toBe(false)
    expect(useAgentsStore.getState().agents[0]?.description).toBe('Systems thinker')
  })

  it('goes clean again when a change is typed back to the stored value', async () => {
    const ada = agentFrom('a1', validDraft({ description: 'first' }))
    setBackend(fakeBackend([ada]).client)
    await useAgentsStore.getState().load()

    useAgentsStore.getState().startEdit('a1')
    useAgentsStore.getState().patchDraft({ description: 'second' })
    useAgentsStore.getState().patchDraft({ description: 'first' })

    expect(useAgentsStore.getState().dirty).toBe(false)
  })

  it('refuses to save an invalid draft without calling the backend', async () => {
    const { client, calls } = fakeBackend()
    setBackend(client)

    useAgentsStore.getState().startCreate()
    useAgentsStore.getState().patchDraft({ name: 'Ada@work', providerId: 'p1', modelId: 'm' })

    await expect(useAgentsStore.getState().saveDraft()).resolves.toBeNull()
    expect(calls).toEqual([])
  })

  it('removes a params field rather than storing undefined', () => {
    setBackend(fakeBackend().client)

    useAgentsStore.getState().startCreate()
    useAgentsStore.getState().patchParams({ reasoning: true })
    expect(useAgentsStore.getState().draft?.params).toEqual({ reasoning: true })

    useAgentsStore.getState().patchParams({ reasoning: undefined })
    expect(Object.keys(useAgentsStore.getState().draft?.params ?? {})).toEqual([])
  })

  it('carries a stored temperature through the draft untouched', () => {
    // The form cannot write one any more, but editing an agent that has one must
    // not drop it: the draft is what `saveDraft` sends back.
    const { client } = fakeBackend()
    setBackend(client)

    const tuned = agentFrom('a1', validDraft({ params: { temperature: 0.2, maxTokens: 64 } }))
    useAgentsStore.setState({ agents: [tuned], status: 'ready' })
    useAgentsStore.getState().startEdit('a1')

    expect(useAgentsStore.getState().draft?.params).toEqual({ temperature: 0.2, maxTokens: 64 })

    useAgentsStore.getState().patchDraft({ description: 'edited' })
    expect(useAgentsStore.getState().draft?.params).toEqual({ temperature: 0.2, maxTokens: 64 })
    expect(useAgentsStore.getState().dirty).toBe(true)
  })

  it('picks an avatar colour pair from the palette', () => {
    setBackend(fakeBackend().client)

    useAgentsStore.getState().startCreate()
    const before = useAgentsStore.getState().draft?.avatar.color
    useAgentsStore.getState().pickAvatarColor(3)

    const after = useAgentsStore.getState().draft?.avatar
    expect(after?.color).not.toBe(before)
    expect(after?.textColor).toBeDefined()
  })

  it('duplicates an agent under a free name and opens the copy', async () => {
    const architect = agentFrom('a1', validDraft({ name: 'Architect' }))
    setBackend(fakeBackend([architect]).client)
    await useAgentsStore.getState().load()

    const copy = await useAgentsStore.getState().duplicate('a1')

    expect(copy?.name).toBe('Architect copy')
    expect(useAgentsStore.getState().selectedId).toBe(copy?.id)
    expect(useAgentsStore.getState().mode).toBe('edit')
    expect(useAgentsStore.getState().dirty).toBe(false)
  })

  it('closes the editor when the agent it was editing is deleted', async () => {
    const ada = agentFrom('a1', validDraft())
    setBackend(fakeBackend([ada]).client)
    await useAgentsStore.getState().load()
    useAgentsStore.getState().startEdit('a1')

    await useAgentsStore.getState().remove('a1')

    const state = useAgentsStore.getState()
    expect(state.agents).toEqual([])
    expect(state.mode).toBe('idle')
    expect(state.draft).toBeNull()
  })

  it('copies the record rather than aliasing it when an edit starts', async () => {
    const ada = agentFrom('a1', validDraft({ skillNames: ['review'] }))
    setBackend(fakeBackend([ada]).client)
    await useAgentsStore.getState().load()

    useAgentsStore.getState().startEdit('a1')
    useAgentsStore.getState().patchDraft({ name: 'Changed' })

    expect(useAgentsStore.getState().agents[0]?.name).toBe('Ada')
    expect(draftFromAgent(ada).skillNames).not.toBe(ada.skillNames)
  })
})

describe('createFromTemplate (S7.5)', () => {
  const template = (id: string): AgentTemplate => {
    const found = getAgentTemplate(id)
    if (!found) throw new Error(`missing template: ${id}`)
    return found
  }

  it('writes the template verbatim, on the model its hints prefer', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)
    const assistant = template('assistant')

    const created = await useAgentsStore
      .getState()
      .createFromTemplate(assistant, 'p1', ['deepseek-r1:7b', 'qwen2.5:3b-instruct'])

    expect(created?.name).toBe(assistant.name)
    expect(created?.systemPrompt).toBe(assistant.systemPrompt)
    expect(created?.description).toBe(assistant.description)
    expect(created?.providerId).toBe('p1')
    // The hint wins over the provider's own order.
    expect(created?.modelId).toBe('qwen2.5:3b-instruct')
    expect(created?.role).toBe('participant')
    expect(created?.avatar.text).toBe('A')
    expect(useAgentsStore.getState().agents).toHaveLength(1)
  })

  it('leaves the editor closed, unlike every other way an agent is created', async () => {
    setBackend(fakeBackend().client)

    await useAgentsStore.getState().createFromTemplate(template('critic'), 'p1', ['x'])

    const state = useAgentsStore.getState()
    expect(state.mode).toBe('idle')
    expect(state.draft).toBeNull()
  })

  it('does not write an agent that would have no model to speak through', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)

    expect(await useAgentsStore.getState().createFromTemplate(template('planner'), 'p1', [])).toBe(
      null
    )
    expect(await useAgentsStore.getState().createFromTemplate(template('planner'), '', ['x'])).toBe(
      null
    )
    expect(backend.calls).toEqual([])
  })

  it('renames rather than colliding when the template name is taken', async () => {
    const assistant = template('assistant')
    const backend = fakeBackend([agentFrom('a1', validDraft({ name: assistant.name }))])
    setBackend(backend.client)
    await useAgentsStore.getState().load()

    const created = await useAgentsStore.getState().createFromTemplate(assistant, 'p1', ['x'])

    // `agents.create` refuses a duplicate name, and a refusal on a first-run
    // card explains nothing to the person reading it.
    expect(created?.name).toBe(`${assistant.name} copy`)
  })

  it('gives each template a different avatar colour', async () => {
    setBackend(fakeBackend().client)

    for (const entry of AGENT_TEMPLATES) {
      await useAgentsStore.getState().createFromTemplate(entry, 'p1', ['x'])
    }

    const colors = useAgentsStore.getState().agents.map((agent) => agent.avatar.color)
    expect(new Set(colors).size).toBe(AGENT_TEMPLATES.length)
  })
})
