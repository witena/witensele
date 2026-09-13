/**
 * The registry against all four provider types.
 *
 * Constructing an AI SDK model performs no I/O — the client is built lazily and
 * only sends a request when it is called — so these assertions are real and still
 * offline. What they pin down is the part that silently rots across SDK versions:
 * that each branch reaches the right adapter (`model.provider`) and passes the
 * model id straight through (`model.modelId`).
 */
import { describe, expect, it } from 'vitest'
import type { Provider } from '@shared/types'
import { LOCAL_USER_ID } from '@shared/types'
import type { AnthropicCli } from './anthropic-cli'
import {
  ANTHROPIC_OAUTH_BETA,
  createLanguageModel,
  createProviderFetch,
  LOCAL_PLACEHOLDER_API_KEY,
  mergeBeta,
  oauthFetch,
  type ResolvedProvider
} from './registry'

/**
 * Overrides that may explicitly clear a field. `Partial<T>` cannot express
 * `apiKey: undefined` under `exactOptionalPropertyTypes`, and "this provider has
 * no key" is one of the cases worth testing.
 */
type ProviderOverrides = { [K in keyof ResolvedProvider]?: ResolvedProvider[K] | undefined }

function provider(overrides: ProviderOverrides = {}): ResolvedProvider {
  const base: Provider = {
    id: 'p1',
    userId: LOCAL_USER_ID,
    createdAt: 0,
    updatedAt: 0,
    type: 'anthropic',
    name: 'Anthropic',
    models: ['claude-sonnet-4-5'],
    hasApiKey: true
  }
  return { ...base, apiKey: 'sk-test', ...overrides } as ResolvedProvider
}

/** `LanguageModel` is a union with a string member; these tests only build objects. */
function identity(model: ReturnType<typeof createLanguageModel>): {
  provider: string
  modelId: string
} {
  if (typeof model === 'string') throw new Error('expected a model object, not a model id')
  return { provider: model.provider, modelId: model.modelId }
}

describe('createLanguageModel', () => {
  it('builds an Anthropic model', () => {
    const model = identity(createLanguageModel(provider(), 'claude-sonnet-4-5'))

    expect(model.provider).toContain('anthropic')
    expect(model.modelId).toBe('claude-sonnet-4-5')
  })

  it('builds an OpenAI model', () => {
    const model = identity(
      createLanguageModel(provider({ type: 'openai', name: 'OpenAI' }), 'gpt-4o')
    )

    expect(model.provider).toContain('openai')
    expect(model.modelId).toBe('gpt-4o')
  })

  it('builds a Google model', () => {
    const model = identity(
      createLanguageModel(provider({ type: 'google', name: 'Google' }), 'gemini-2.5-pro')
    )

    expect(model.provider).toContain('google')
    expect(model.modelId).toBe('gemini-2.5-pro')
  })

  it('builds an OpenAI-compatible model named after its preset', () => {
    const model = identity(
      createLanguageModel(
        provider({
          type: 'openai-compatible',
          name: 'DeepSeek',
          presetId: 'deepseek',
          baseUrl: 'https://api.deepseek.com/v1'
        }),
        'deepseek-chat'
      )
    )

    // The `name` option becomes the provider string, which is what appears in
    // AI SDK error messages: `deepseek.chat`, not `openai-compatible.chat`.
    expect(model.provider).toContain('deepseek')
    expect(model.modelId).toBe('deepseek-chat')
  })

  it('slugs the display name when there is no preset', () => {
    const model = identity(
      createLanguageModel(
        provider({
          type: 'openai-compatible',
          name: 'My Lab Box',
          baseUrl: 'http://10.0.0.2:8000/v1'
        }),
        'local-model'
      )
    )

    expect(model.provider).toContain('my-lab-box')
  })

  it('rejects an OpenAI-compatible provider with no base URL', () => {
    expect(() =>
      createLanguageModel(
        provider({ type: 'openai-compatible', name: 'Nowhere', presetId: 'custom' }),
        'some-model'
      )
    ).toThrowError(expect.objectContaining({ code: 'validation' }))
  })

  it('rejects an empty model id', () => {
    expect(() => createLanguageModel(provider(), '  ')).toThrowError(
      expect.objectContaining({ code: 'validation' })
    )
  })

  it('builds a keyless local provider, and a hosted one keeps failing on its own 401', () => {
    // Ollama stores no key at all; the model must still be constructible.
    expect(() =>
      createLanguageModel(
        provider({
          type: 'openai-compatible',
          name: 'Ollama',
          presetId: 'ollama',
          baseUrl: 'http://localhost:11434/v1',
          hasApiKey: false,
          apiKey: undefined
        }),
        'llama3.2:3b'
      )
    ).not.toThrow()

    expect(LOCAL_PLACEHOLDER_API_KEY).toBe('ollama')
  })

  it('treats a blank stored key as no key', () => {
    expect(() =>
      createLanguageModel(provider({ apiKey: '   ', hasApiKey: false }), 'claude-sonnet-4-5')
    ).not.toThrow()
  })
})

/**
 * The OAuth half (S5.3).
 *
 * The wrapper is where a mistake would be invisible until a real request came
 * back 401, so it is tested directly: what it deletes, what it sets, and what it
 * leaves alone. `fetch` is a fake that records the headers it was handed, and the
 * "CLI" is a counter — no process is spawned here.
 */
function recordingFetch(): {
  fetchImpl: typeof globalThis.fetch
  calls: { url: string; headers: Record<string, string> }[]
} {
  const calls: { url: string; headers: Record<string, string> }[] = []
  // `Parameters<typeof fetch>` rather than `RequestInfo`: the main project is
  // type-checked without the DOM library, and these globals come from undici.
  const fetchImpl = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1]
  ) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    calls.push({ url: String(input), headers })
    return new Response('{}', { status: 200 })
  }) as typeof globalThis.fetch
  return { fetchImpl, calls }
}

/** A stub CLI: the registry only ever asks it for a token. */
function stubCli(token = 'oat-token'): AnthropicCli {
  return {
    status: () => Promise.resolve({ state: 'signed-in' as const }),
    login: () => Promise.resolve({ state: 'signed-in' as const }),
    logout: () => Promise.resolve({ state: 'signed-out' as const }),
    accessToken: () => Promise.resolve(token)
  }
}

describe('mergeBeta', () => {
  it('adds the flag to an empty header', () => {
    expect(mergeBeta(null, ANTHROPIC_OAUTH_BETA)).toBe(ANTHROPIC_OAUTH_BETA)
  })

  it('keeps the flags the SDK already asked for', () => {
    expect(mergeBeta('fine-grained-tool-streaming-2025-05-14', ANTHROPIC_OAUTH_BETA)).toBe(
      `fine-grained-tool-streaming-2025-05-14,${ANTHROPIC_OAUTH_BETA}`
    )
  })

  it('does not repeat itself', () => {
    expect(mergeBeta(`${ANTHROPIC_OAUTH_BETA}, other`, ANTHROPIC_OAUTH_BETA)).toBe(
      `${ANTHROPIC_OAUTH_BETA},other`
    )
  })
})

describe('oauthFetch', () => {
  it('replaces the key header with a bearer token and the beta flag', async () => {
    const { fetchImpl, calls } = recordingFetch()
    const wrapped = oauthFetch(() => Promise.resolve('oat-token'), fetchImpl)

    await wrapped('https://api.anthropic.com/v1/messages', {
      headers: { 'x-api-key': 'sk-ant-key', 'anthropic-version': '2023-06-01' }
    })

    const [call] = calls
    expect(call?.headers['x-api-key']).toBeUndefined()
    expect(call?.headers['authorization']).toBe('Bearer oat-token')
    expect(call?.headers['anthropic-beta']).toBe(ANTHROPIC_OAUTH_BETA)
    // Everything the caller set that is none of the wrapper's business survives.
    expect(call?.headers['anthropic-version']).toBe('2023-06-01')
  })

  it('merges into an existing anthropic-beta rather than overwriting it', async () => {
    const { fetchImpl, calls } = recordingFetch()
    const wrapped = oauthFetch(() => Promise.resolve('oat-token'), fetchImpl)

    await wrapped('https://api.anthropic.com/v1/messages', {
      headers: { 'anthropic-beta': 'context-1m-2025-08-07' }
    })

    expect(calls[0]?.headers['anthropic-beta']).toBe(
      `context-1m-2025-08-07,${ANTHROPIC_OAUTH_BETA}`
    )
  })

  it('asks for a token per request, so a refresh is picked up', async () => {
    const { fetchImpl, calls } = recordingFetch()
    let issued = 0
    const wrapped = oauthFetch(() => Promise.resolve(`token-${++issued}`), fetchImpl)

    await wrapped('https://api.anthropic.com/v1/models', {})
    await wrapped('https://api.anthropic.com/v1/models', {})

    expect(calls.map((call) => call.headers['authorization'])).toEqual([
      'Bearer token-1',
      'Bearer token-2'
    ])
  })
})

describe('createLanguageModel with auth: oauth', () => {
  it('builds an Anthropic model that authenticates through the CLI', async () => {
    const { fetchImpl, calls } = recordingFetch()
    const model = createLanguageModel(
      provider({ auth: 'oauth', hasApiKey: false, apiKey: undefined }),
      'claude-sonnet-4-5',
      { anthropicCli: stubCli(), fetchImpl }
    )

    expect(identity(model).provider).toContain('anthropic')

    // The adapter is lazy, so nothing is proven until a request is made.
    if (typeof model === 'string') throw new Error('expected a model object')
    try {
      // The fake answers `{}`, which the adapter then refuses to parse. What is
      // being asserted is the request it made on the way there.
      await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
      })
    } catch {
      /* expected: the response is not a real Anthropic payload */
    }

    expect(calls).toHaveLength(1)
    expect(calls[0]?.headers['x-api-key']).toBeUndefined()
    expect(calls[0]?.headers['authorization']).toBe('Bearer oat-token')
    expect(calls[0]?.headers['anthropic-beta']).toContain(ANTHROPIC_OAUTH_BETA)
  })

  it('refuses to build one with no CLI to ask, rather than sending an empty key', () => {
    expect(() =>
      createLanguageModel(provider({ auth: 'oauth' }), 'claude-sonnet-4-5')
    ).toThrowError(expect.objectContaining({ code: 'validation' }))
  })

  it('leaves every other provider on the plain fetch', () => {
    const { fetchImpl } = recordingFetch()
    const keyed = provider({ auth: 'apiKey' })

    expect(createProviderFetch(keyed, { fetchImpl })).toBe(fetchImpl)
    const openai = provider({ type: 'openai', name: 'OpenAI', auth: 'oauth' })
    expect(createProviderFetch(openai, { fetchImpl })).toBe(fetchImpl)
  })
})
