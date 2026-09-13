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
import { createLanguageModel, LOCAL_PLACEHOLDER_API_KEY, type ResolvedProvider } from './registry'

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
