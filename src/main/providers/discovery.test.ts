/**
 * Model discovery and the connection probe, entirely offline.
 *
 * `fetchModels` takes its `fetch` as a parameter and `testConnection` takes its
 * model factory and its `generateText`, so every case here — success, HTTP 401,
 * timeout — is driven by a function this file defines. Nothing in `npm test` may
 * open a socket: a suite that depends on api.openai.com being up is a suite that
 * fails on a plane.
 *
 * The probe is exercised through the **real** `generateText` from the AI SDK,
 * with `MockLanguageModelV4` (from `ai/test`, matching the `LanguageModelV4`
 * interface these provider packages implement) standing in for the model. That
 * keeps the call-option names in `discovery.ts` honest: a renamed option would
 * fail here rather than in production.
 */
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_USER_ID } from '@shared/types'
import { BackendFailure } from '../errors'
import {
  FETCH_MODELS_TIMEOUT_MS,
  fetchModels,
  testConnection,
  type FetchImpl
} from './discovery'
import type { ResolvedProvider } from './registry'

/**
 * Overrides that may explicitly set a field back to `undefined`.
 * `Partial<T>` cannot express that under `exactOptionalPropertyTypes`, and
 * "this provider has no key / no base URL" is exactly what several cases need.
 */
type ProviderOverrides = { [K in keyof ResolvedProvider]?: ResolvedProvider[K] | undefined }

function provider(overrides: ProviderOverrides = {}): ResolvedProvider {
  return {
    id: 'p1',
    userId: LOCAL_USER_ID,
    createdAt: 0,
    updatedAt: 0,
    type: 'openai',
    name: 'OpenAI',
    models: ['gpt-4o'],
    hasApiKey: true,
    apiKey: 'sk-test',
    ...overrides
  } as ResolvedProvider
}

interface Call {
  url: string
  headers: Record<string, string>
}

/** A `fetch` that records the request and answers with the given JSON. */
function jsonFetch(payload: unknown, calls: Call[] = []): { impl: FetchImpl; calls: Call[] } {
  const impl: FetchImpl = (input, init) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> })
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
  }
  return { impl, calls }
}

/** A `fetch` that answers with an HTTP failure, like a wrong key would. */
function errorFetch(status: number, body = '{"error":"nope"}'): FetchImpl {
  return () => Promise.resolve(new Response(body, { status, statusText: 'Unauthorized' }))
}

/** A `fetch` that never answers until the caller's `AbortSignal` fires. */
const hangingFetch: FetchImpl = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    })
  })

afterEach(() => {
  vi.useRealTimers()
})

describe('fetchModels', () => {
  it('reads OpenAI ids from data[].id, sorted and de-duplicated', async () => {
    const { impl, calls } = jsonFetch({
      data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }, { id: 'gpt-4o' }, { nope: true }]
    })

    await expect(fetchModels(provider(), impl)).resolves.toEqual(['gpt-4o', 'gpt-4o-mini'])
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/models')
    expect(calls[0]?.headers['Authorization']).toBe('Bearer sk-test')
  })

  it('reads an OpenAI-compatible endpoint from its own base URL', async () => {
    const { impl, calls } = jsonFetch({ data: [{ id: 'llama3.2:3b' }] })

    await expect(
      fetchModels(
        provider({
          type: 'openai-compatible',
          presetId: 'ollama',
          baseUrl: 'http://localhost:11434/v1/',
          apiKey: undefined,
          hasApiKey: false
        }),
        impl
      )
    ).resolves.toEqual(['llama3.2:3b'])

    // The trailing slash of the stored base URL must not double up.
    expect(calls[0]?.url).toBe('http://localhost:11434/v1/models')
    // A keyless local server gets no Authorization header at all.
    expect(calls[0]?.headers['Authorization']).toBeUndefined()
  })

  it('reads Anthropic ids with the versioned header', async () => {
    const { impl, calls } = jsonFetch({ data: [{ id: 'claude-sonnet-4-5' }] })

    await expect(fetchModels(provider({ type: 'anthropic' }), impl)).resolves.toEqual([
      'claude-sonnet-4-5'
    ])
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/models')
    expect(calls[0]?.headers['x-api-key']).toBe('sk-test')
    expect(calls[0]?.headers['anthropic-version']).toBe('2023-06-01')
  })

  it('does not double the /v1 segment when the base URL already carries it', async () => {
    const { impl, calls } = jsonFetch({ data: [] })

    await fetchModels(
      provider({ type: 'anthropic', baseUrl: 'https://proxy.example.com/v1' }),
      impl
    )

    expect(calls[0]?.url).toBe('https://proxy.example.com/v1/models')
  })

  it('reads Google names and strips the models/ prefix', async () => {
    const { impl, calls } = jsonFetch({
      models: [{ name: 'models/gemini-2.5-pro' }, { name: 'models/gemini-2.5-flash' }]
    })

    await expect(fetchModels(provider({ type: 'google' }), impl)).resolves.toEqual([
      'gemini-2.5-flash',
      'gemini-2.5-pro'
    ])
    expect(calls[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?key=sk-test'
    )
  })

  it('maps an HTTP 401 to provider_error and keeps the status in details', async () => {
    await expect(fetchModels(provider(), errorFetch(401))).rejects.toMatchObject({
      code: 'provider_error',
      details: { status: 401 }
    })
  })

  it('maps an HTTP 404 the same way, so the renderer can tell them apart', async () => {
    await expect(fetchModels(provider(), errorFetch(404))).rejects.toMatchObject({
      code: 'provider_error',
      details: { status: 404 }
    })
  })

  it('aborts after the timeout instead of hanging the settings screen', async () => {
    vi.useFakeTimers()
    const pending = fetchModels(provider(), hangingFetch)
    // Assert before advancing: an unhandled rejection would otherwise be reported
    // between the two statements.
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'provider_error',
      details: { timeoutMs: FETCH_MODELS_TIMEOUT_MS }
    })
    await vi.advanceTimersByTimeAsync(FETCH_MODELS_TIMEOUT_MS + 1)
    await assertion
  })

  it('reports an unreachable host as a provider error rather than crashing', async () => {
    const failing: FetchImpl = () => Promise.reject(new TypeError('fetch failed'))

    await expect(fetchModels(provider(), failing)).rejects.toMatchObject({
      code: 'provider_error'
    })
  })

  it('refuses an OpenAI-compatible provider with no base URL', async () => {
    await expect(
      fetchModels(provider({ type: 'openai-compatible', baseUrl: undefined }), jsonFetch({}).impl)
    ).rejects.toMatchObject({ code: 'validation' })
  })
})

/** A mock model that answers "OK" without a network call. */
function okModel(modelId = 'gpt-4o'): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId,
    // The V4 result shape: `finishReason` and `usage` are structured objects, not
    // a bare string and three numbers as in earlier specification versions.
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: 'OK' }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 }
      },
      warnings: []
    })
  })
}

describe('testConnection', () => {
  it('reports ok with a latency and the model it probed', async () => {
    const result = await testConnection(provider(), { createModel: () => okModel() })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected a successful probe')
    expect(result.model).toBe('gpt-4o')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('passes the probe prompt and the output cap to the model', async () => {
    const model = okModel()
    await testConnection(provider(), { createModel: () => model })

    const call = model.doGenerateCalls[0]
    expect(call?.maxOutputTokens).toBe(8)
    expect(JSON.stringify(call?.prompt)).toContain('Reply with OK')
    expect(call?.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('probes the explicitly requested model instead of the first one', async () => {
    const result = await testConnection(provider({ models: ['a', 'b'] }), {
      modelId: 'b',
      createModel: (_resolved, modelId) => okModel(modelId)
    })

    expect(result).toMatchObject({ ok: true, model: 'b' })
  })

  it('never throws: a provider failure comes back as a value', async () => {
    const result = await testConnection(provider(), {
      createModel: () => okModel(),
      generate: () => Promise.reject(new Error('401 Unauthorized'))
    })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'provider_error', message: '401 Unauthorized' }
    })
  })

  it('keeps a deliberate BackendFailure code instead of re-labelling it', async () => {
    const result = await testConnection(provider(), {
      createModel: () => {
        throw new BackendFailure('validation', 'An OpenAI-compatible provider requires a base URL')
      }
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'validation' } })
  })

  it('refuses to probe a provider that has no model at all', async () => {
    const result = await testConnection(provider({ models: [] }), {
      createModel: () => okModel()
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'validation' } })
  })

  it('gives up after the timeout', async () => {
    vi.useFakeTimers()
    const pending = testConnection(provider(), {
      timeoutMs: 20_000,
      createModel: () => okModel(),
      generate: ({ abortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal.addEventListener('abort', () => reject(new Error('aborted')))
        })
    })
    await vi.advanceTimersByTimeAsync(20_001)

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_error', details: { timeoutMs: 20_000 } }
    })
  })
})
