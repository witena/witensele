/**
 * The providers store against a fake `BackendClient`.
 *
 * Same approach as `settings.test.ts`: no jsdom, no React, no Electron — the
 * store is vanilla zustand and `getState()` drives it. The fake keeps a list in a
 * local variable and applies the documented patch semantics (an absent `apiKey`
 * keeps the stored key, `''` clears it), so the store is exercised against the
 * contract rather than against a stub that always answers the same thing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendClient, BackendMethod, ProviderRef } from '@shared/backend'
import type {
  AnthropicAuthStatus,
  ConnectionTestResult,
  Provider,
  ProviderInput
} from '@shared/types'
import { LOCAL_USER_ID } from '@shared/types'
import { resetBackend, setBackend } from '../lib/backend-provider'
import { DRAFT_TEST_KEY, useProvidersStore } from './providers'

interface Call {
  method: BackendMethod
  input: unknown
}

interface Fake {
  client: BackendClient
  calls: Call[]
  rows: () => Provider[]
  keys: () => Record<string, string>
  setModels: (models: string[]) => void
  setTestResult: (result: ConnectionTestResult) => void
  setAuthStatus: (status: AnthropicAuthStatus) => void
  fail: (error: Error | null) => void
}

function fakeBackend(initial: Provider[] = []): Fake {
  const calls: Call[] = []
  let rows = [...initial]
  // A row that reports `hasApiKey` already has one stored; the fake needs that to
  // be true of its own state too, or "an absent apiKey keeps the key" is untestable.
  const keys: Record<string, string> = Object.fromEntries(
    initial.filter((row) => row.hasApiKey).map((row) => [row.id, 'sk-existing'])
  )
  let models: string[] = []
  let testResult: ConnectionTestResult = { ok: true, latencyMs: 12, model: 'gpt-4o' }
  let authStatus: AnthropicAuthStatus = { state: 'signed-out' }
  let failure: Error | null = null
  let nextId = 1

  const client: BackendClient = {
    invoke: (async (method: BackendMethod, input: unknown) => {
      calls.push({ method, input })
      if (failure) throw failure

      if (method === 'providers.list') return rows
      if (method === 'providers.create') {
        const payload = (input as { input: ProviderInput }).input
        const created: Provider = {
          id: `p${nextId++}`,
          userId: LOCAL_USER_ID,
          createdAt: 0,
          updatedAt: 0,
          type: payload.type,
          name: payload.name,
          models: payload.models,
          hasApiKey: Boolean(payload.apiKey),
          ...(payload.baseUrl ? { baseUrl: payload.baseUrl } : {}),
          ...(payload.presetId ? { presetId: payload.presetId } : {})
        }
        if (payload.apiKey) keys[created.id] = payload.apiKey
        rows = [...rows, created]
        return created
      }
      if (method === 'providers.update') {
        const { id, patch } = input as { id: string; patch: Partial<ProviderInput> }
        const current = rows.find((row) => row.id === id)
        if (!current) throw new Error(`not found: ${id}`)
        if (patch.apiKey !== undefined) {
          if (patch.apiKey === '') delete keys[id]
          else keys[id] = patch.apiKey
        }
        const updated: Provider = {
          ...current,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.type !== undefined ? { type: patch.type } : {}),
          ...(patch.models !== undefined ? { models: patch.models } : {}),
          ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
          hasApiKey: keys[id] !== undefined
        }
        rows = rows.map((row) => (row.id === id ? updated : row))
        return updated
      }
      if (method === 'providers.delete') {
        const { id } = input as { id: string }
        rows = rows.filter((row) => row.id !== id)
        delete keys[id]
        return undefined
      }
      if (method === 'providers.fetchModels') return models
      if (method === 'providers.testConnection') return testResult
      if (method === 'providers.authStatus') return authStatus
      if (method === 'providers.login') {
        authStatus = { state: 'signed-in', accountEmail: 'person@example.com' }
        return authStatus
      }
      if (method === 'providers.logout') {
        authStatus = { state: 'signed-out' }
        return authStatus
      }

      throw new Error(`unexpected method ${method}`)
    }) as BackendClient['invoke'],
    subscribe: () => () => {}
  }

  return {
    client,
    calls,
    rows: () => rows,
    keys: () => keys,
    setModels: (next) => {
      models = next
    },
    setTestResult: (next) => {
      testResult = next
    },
    setAuthStatus: (next) => {
      authStatus = next
    },
    fail: (error) => {
      failure = error
    }
  }
}

function stored(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'p1',
    userId: LOCAL_USER_ID,
    createdAt: 0,
    updatedAt: 0,
    type: 'openai-compatible',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    presetId: 'deepseek',
    models: ['deepseek-chat'],
    hasApiKey: true,
    ...overrides
  }
}

const state = (): ReturnType<typeof useProvidersStore.getState> => useProvidersStore.getState()

beforeEach(() => {
  useProvidersStore.setState({
    providers: [],
    status: 'idle',
    error: undefined,
    selectedId: null,
    mode: 'idle',
    draft: null,
    testResults: {},
    testing: false,
    fetchingModels: false,
    saving: false,
    authStatus: null,
    authBusy: false,
    authErrorCode: undefined
  })
})

afterEach(() => {
  resetBackend()
})

describe('load', () => {
  it('mirrors providers.list', async () => {
    const backend = fakeBackend([stored()])
    setBackend(backend.client)

    await state().load()

    expect(state().status).toBe('ready')
    expect(state().providers).toEqual([stored()])
    expect(backend.calls).toEqual([{ method: 'providers.list', input: undefined }])
  })

  it('records a failure instead of throwing', async () => {
    const backend = fakeBackend()
    backend.fail(new Error('bridge is down'))
    setBackend(backend.client)

    await expect(state().load()).resolves.toBeUndefined()

    expect(state().status).toBe('error')
    expect(state().error).toBe('bridge is down')
  })
})

describe('the editor draft', () => {
  it('starts empty on create', () => {
    state().startCreate()

    expect(state().mode).toBe('create')
    expect(state().selectedId).toBeNull()
    expect(state().draft).toEqual({ type: 'openai-compatible', name: '', models: [] })
  })

  it('fills type, name, base URL and models from a preset', () => {
    state().startCreate()
    state().applyPreset('deepseek')

    expect(state().draft).toMatchObject({
      presetId: 'deepseek',
      type: 'openai-compatible',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat', 'deepseek-reasoner']
    })
  })

  it('keeps a name the user already typed when a preset is applied', () => {
    state().startCreate()
    state().patchDraft({ name: 'Work account' })
    state().applyPreset('deepseek')

    expect(state().draft?.name).toBe('Work account')
  })

  it('clears the base URL for the custom preset, which has none', () => {
    state().startCreate()
    state().applyPreset('deepseek')
    state().applyPreset('custom')

    expect(state().draft).toMatchObject({ presetId: 'custom', baseUrl: '', models: [] })
  })

  it('ignores an unknown preset id', () => {
    state().startCreate()
    state().applyPreset('nope')

    expect(state().draft).toEqual({ type: 'openai-compatible', name: '', models: [] })
  })

  it('copies a stored provider without its key, so the field means "keep"', () => {
    useProvidersStore.setState({ providers: [stored()] })

    state().startEdit('p1')

    expect(state().mode).toBe('edit')
    expect(state().selectedId).toBe('p1')
    expect(state().draft).toEqual({
      type: 'openai-compatible',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      presetId: 'deepseek',
      models: ['deepseek-chat']
    })
    expect(state().draft && 'apiKey' in state().draft!).toBe(false)
  })

  it('does nothing for an id that is not in the list', () => {
    state().startEdit('missing')

    expect(state().mode).toBe('idle')
    expect(state().draft).toBeNull()
  })

  it('adds and removes models, ignoring blanks and duplicates', () => {
    state().startCreate()
    state().addModel('gpt-4o')
    state().addModel('gpt-4o')
    state().addModel('   ')
    state().addModel(' o3-mini ')

    expect(state().draft?.models).toEqual(['gpt-4o', 'o3-mini'])

    state().removeModel('gpt-4o')
    expect(state().draft?.models).toEqual(['o3-mini'])
  })

  it('closes without touching the list', () => {
    useProvidersStore.setState({ providers: [stored()] })
    state().startEdit('p1')

    state().closeEditor()

    expect(state().mode).toBe('idle')
    expect(state().draft).toBeNull()
    expect(state().providers).toHaveLength(1)
  })
})

describe('saveDraft', () => {
  it('creates, then keeps the editor on the new record', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)

    state().startCreate()
    state().applyPreset('deepseek')
    state().patchDraft({ apiKey: 'sk-secret' })
    const saved = await state().saveDraft()

    expect(saved).toMatchObject({ name: 'DeepSeek', hasApiKey: true })
    expect(state().providers).toHaveLength(1)
    expect(state().mode).toBe('edit')
    expect(state().selectedId).toBe(saved?.id)
    // Re-seeded from the saved row: the typed key is gone from the form.
    expect(state().draft && 'apiKey' in state().draft!).toBe(false)
    expect(backend.keys()['p1']).toBe('sk-secret')
  })

  it('updates without an apiKey, which keeps the stored one', async () => {
    const backend = fakeBackend([stored()])
    setBackend(backend.client)
    await state().load()

    state().startEdit('p1')
    state().patchDraft({ name: 'DeepSeek (work)' })
    await state().saveDraft()

    const patch = backend.calls.at(-1)?.input as { patch: ProviderInput }
    expect('apiKey' in patch.patch).toBe(false)
    expect(state().providers[0]?.name).toBe('DeepSeek (work)')
    expect(state().providers[0]?.hasApiKey).toBe(true)
  })

  it('records a failure instead of rejecting, so the form stays open', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)
    state().startCreate()
    backend.fail(new Error('This provider requires an API key'))

    await expect(state().saveDraft()).resolves.toBeNull()

    expect(state().error).toBe('This provider requires an API key')
    expect(state().mode).toBe('create')
    expect(state().saving).toBe(false)
  })

  it('does nothing when the editor is closed', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)

    await expect(state().saveDraft()).resolves.toBeNull()
    expect(backend.calls).toEqual([])
  })
})

describe('remove', () => {
  it('drops the row, its probe result and the open editor', async () => {
    const backend = fakeBackend([stored()])
    setBackend(backend.client)
    await state().load()
    state().startEdit('p1')
    useProvidersStore.setState({ testResults: { p1: { ok: true, latencyMs: 5 } } })

    await state().remove('p1')

    expect(state().providers).toEqual([])
    expect(state().testResults).toEqual({})
    expect(state().mode).toBe('idle')
    expect(state().draft).toBeNull()
  })

  it('leaves an editor that is on a different provider alone', async () => {
    const backend = fakeBackend([stored(), stored({ id: 'p2', name: 'Ollama' })])
    setBackend(backend.client)
    await state().load()
    state().startEdit('p2')

    await state().remove('p1')

    expect(state().selectedId).toBe('p2')
    expect(state().mode).toBe('edit')
  })
})

describe('fetchModels', () => {
  it('replaces the draft model list with what the endpoint answered', async () => {
    const backend = fakeBackend()
    backend.setModels(['llama3.2:3b', 'qwen2.5:1.5b'])
    setBackend(backend.client)

    state().startCreate()
    state().applyPreset('deepseek')
    const models = await state().fetchModels({ draft: state().draft as ProviderInput })

    expect(models).toEqual(['llama3.2:3b', 'qwen2.5:1.5b'])
    expect(state().draft?.models).toEqual(['llama3.2:3b', 'qwen2.5:1.5b'])
    expect(state().fetchingModels).toBe(false)
  })

  it('surfaces a failure and clears the pending flag', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)
    state().startCreate()
    backend.fail(new Error('Provider responded 401 Unauthorized'))

    const ref: ProviderRef = { draft: state().draft as ProviderInput }
    await expect(state().fetchModels(ref)).rejects.toThrow('401')

    expect(state().error).toContain('401')
    expect(state().fetchingModels).toBe(false)
  })
})

describe('testConnection', () => {
  it('remembers the result under the provider id', async () => {
    const backend = fakeBackend([stored()])
    setBackend(backend.client)
    await state().load()

    const result = await state().testConnection({ id: 'p1' })

    expect(result).toMatchObject({ ok: true, latencyMs: 12 })
    expect(state().testResults['p1']).toBe(result)
    expect(state().testing).toBe(false)
  })

  it('remembers a draft result under the draft key until it has an id', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)
    state().startCreate()

    await state().testConnection({ draft: state().draft as ProviderInput })

    expect(state().testResults[DRAFT_TEST_KEY]).toMatchObject({ ok: true })
  })

  it('files a draft probe under the record being edited', async () => {
    const backend = fakeBackend([stored()])
    setBackend(backend.client)
    await state().load()
    state().startEdit('p1')

    await state().testConnection({ draft: state().draft as ProviderInput })

    expect(state().testResults['p1']).toMatchObject({ ok: true })
    expect(state().testResults[DRAFT_TEST_KEY]).toBeUndefined()
  })

  it('turns a failed probe into a value, not a rejection', async () => {
    const backend = fakeBackend([stored()])
    backend.setTestResult({
      ok: false,
      error: { code: 'provider_error', message: 'Provider responded 401 Unauthorized' }
    })
    setBackend(backend.client)
    await state().load()

    await expect(state().testConnection({ id: 'p1' })).resolves.toMatchObject({ ok: false })
    expect(state().testResults['p1']).toMatchObject({ ok: false })
  })

  it('turns a transport failure into the same shape', async () => {
    const backend = fakeBackend([stored()])
    setBackend(backend.client)
    await state().load()
    backend.fail(new Error('bridge is down'))

    const result = await state().testConnection({ id: 'p1' })

    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(state().testing).toBe(false)
  })
})

/**
 * The sign-in half (S5.3).
 *
 * The three states are values the panel renders, so the store's job is only to
 * hold the latest answer and never to leave a spinner running. The fake's login
 * flips its own state, which is what proves the store re-reads rather than
 * assuming.
 */
describe('sign-in', () => {
  it('reads the CLI status', async () => {
    const backend = fakeBackend()
    backend.setAuthStatus({ state: 'not-installed' })
    setBackend(backend.client)

    await expect(state().loadAuthStatus()).resolves.toEqual({ state: 'not-installed' })
    expect(state().authStatus).toEqual({ state: 'not-installed' })
    expect(state().authErrorCode).toBeUndefined()
  })

  it('signs in and keeps the resulting status', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)

    await state().signIn()

    expect(state().authStatus).toMatchObject({ state: 'signed-in' })
    expect(state().authBusy).toBe(false)
    expect(backend.calls.map((call) => call.method)).toEqual(['providers.login'])
  })

  it('signs out and keeps the resulting status', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)
    await state().signIn()

    await state().signOut()

    expect(state().authStatus).toEqual({ state: 'signed-out' })
    expect(state().authBusy).toBe(false)
  })

  it('records a refused sign-in and asks the CLI what actually happened', async () => {
    const backend = fakeBackend()
    backend.setAuthStatus({ state: 'not-installed' })
    setBackend(backend.client)
    backend.fail(new Error('ant is missing'))

    await state().signIn()

    // Not a rejection: the panel keeps its shape and gains an error line.
    expect(state().authErrorCode).toBe('internal')
    expect(state().authBusy).toBe(false)
  })

  it('never leaves a transport failure looking like an install', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)
    backend.fail(new Error('bridge is down'))

    await expect(state().loadAuthStatus()).resolves.toEqual({ state: 'not-installed' })
    expect(state().authErrorCode).toBe('internal')
  })
})

describe('the draft carries the authentication mode', () => {
  it('round-trips it from a stored provider', async () => {
    const backend = fakeBackend([
      stored({ id: 'p9', type: 'anthropic', name: 'Claude', auth: 'oauth', hasApiKey: false })
    ])
    setBackend(backend.client)
    await state().load()

    state().startEdit('p9')
    expect(state().draft?.auth).toBe('oauth')

    state().patchDraft({ auth: 'apiKey' })
    expect(state().draft?.auth).toBe('apiKey')
  })

  it('leaves it absent for a provider that never had one', async () => {
    const backend = fakeBackend([stored()])
    setBackend(backend.client)
    await state().load()

    state().startEdit('p1')
    expect(state().draft && 'auth' in state().draft!).toBe(false)
  })
})
