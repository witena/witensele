/**
 * Provider record → AI SDK model instance.
 *
 * This is the layer that knows which adapter a `ProviderType` maps to and how its
 * factory is spelled. Everything above it (`AgentTurn` in S1.7, the connection
 * probe next door) only ever sees a `LanguageModel`, so a provider package
 * upgrade is contained here.
 *
 * It imports no electron and reads no database: the caller hands in a provider
 * record that already carries its decrypted key (see `resolve.ts`), which is what
 * lets the whole layer be unit tested and lifted into a Node server later
 * (CLAUDE.md rule #5).
 *
 * ## AI SDK v7 option names, verified against the installed type definitions
 *
 * | Factory | Package (version) | Options used |
 * |---|---|---|
 * | `createAnthropic` | `@ai-sdk/anthropic` 4.0.53 | `apiKey`, `baseURL` |
 * | `createOpenAI` | `@ai-sdk/openai` 4.0.66 | `apiKey`, `baseURL` |
 * | `createGoogleGenerativeAI` | `@ai-sdk/google` 4.0.69 | `apiKey`, `baseURL` |
 * | `createOpenAICompatible` | `@ai-sdk/openai-compatible` 3.0.48 | `name` (**required**), `baseURL` (**required**), `apiKey`, `includeUsage` |
 *
 * Two spellings that are easy to get wrong: the option is `baseURL` (capital URL)
 * while our stored field is `baseUrl`, and `createOpenAICompatible` takes a
 * *required* `name` that becomes the model's `provider` string
 * (`deepseek.chat`, not `openai-compatible`).
 *
 * Every factory returns a provider object that is itself callable; this module
 * uses the explicit `.languageModel(modelId)` method instead, because all four
 * expose it and a call expression hides which model kind is being asked for.
 */
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { getPreset } from '@shared/presets'
import type { Provider } from '@shared/types'
import { validation } from '../errors'

/**
 * A provider record plus the plaintext key, which is the only form this layer
 * accepts. `apiKey` is absent for a local server and for a provider whose key has
 * not been entered yet.
 */
export type ResolvedProvider = Provider & { apiKey?: string }

/**
 * Sent as the key to a local server that stores none.
 *
 * Ollama ignores the value entirely, but `@ai-sdk/openai-compatible` only adds
 * the `Authorization` header when `apiKey` is set, and some OpenAI-compatible
 * servers (LM Studio among them) reject a request that has no header at all. A
 * fixed placeholder costs nothing and removes a class of "works in curl, fails in
 * the app" reports. It is only ever used for a preset marked `local`.
 */
export const LOCAL_PLACEHOLDER_API_KEY = 'ollama'

/** A non-empty stored key, or `undefined`. Treats `''` as "no key". */
function storedKey(provider: ResolvedProvider): string | undefined {
  const key = provider.apiKey?.trim()
  return key ? key : undefined
}

/**
 * The `name` an OpenAI-compatible provider is registered under.
 *
 * It ends up in `model.provider` and in AI SDK error messages, so it should read
 * like an id: the preset id when there is one, otherwise a slug of the display
 * name, and never an empty string (the factory would build `.chat` alone).
 */
function compatibleName(provider: ResolvedProvider): string {
  if (provider.presetId) return provider.presetId
  const slug = provider.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'openai-compatible'
}

/**
 * Builds the AI SDK model for one (provider, model) pair.
 *
 * Throws a `validation` failure rather than returning `null` for input the
 * adapter cannot be built from — an empty model id, or an `openai-compatible`
 * provider with no base URL, which is the one combination the SDK itself cannot
 * default (there is no canonical "compatible" endpoint).
 */
export function createLanguageModel(provider: ResolvedProvider, modelId: string): LanguageModel {
  if (typeof modelId !== 'string' || modelId.trim().length === 0) {
    throw validation('A model id is required to build a model client')
  }

  const apiKey = storedKey(provider)
  const baseUrl = provider.baseUrl?.trim()

  switch (provider.type) {
    case 'anthropic':
      return createAnthropic({
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { baseURL: baseUrl } : {})
      }).languageModel(modelId)

    case 'openai':
      return createOpenAI({
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { baseURL: baseUrl } : {})
      }).languageModel(modelId)

    case 'google':
      return createGoogleGenerativeAI({
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { baseURL: baseUrl } : {})
      }).languageModel(modelId)

    case 'openai-compatible': {
      if (!baseUrl) {
        throw validation('An OpenAI-compatible provider requires a base URL', {
          providerId: provider.id
        })
      }
      // A local server keeps working without a stored key; a hosted one is left
      // to fail with the provider's own 401, which is the message worth showing.
      const local = getPreset(provider.presetId)?.local === true
      const effectiveKey = apiKey ?? (local ? LOCAL_PLACEHOLDER_API_KEY : undefined)

      return createOpenAICompatible<string, string, string, string>({
        name: compatibleName(provider),
        baseURL: baseUrl,
        // Without this the adapter omits `stream_options: { include_usage: true }`
        // and an OpenAI-compatible endpoint streams **no usage at all** — the
        // `finish` part arrives with zeroes and S4.1's token counts stay empty
        // for every Chinese provider, OpenRouter, Ollama and LM Studio, which is
        // most of the preset list. The first-party Anthropic / OpenAI / Google
        // adapters report usage without being asked. A server that does not
        // understand the field ignores it.
        includeUsage: true,
        ...(effectiveKey ? { apiKey: effectiveKey } : {})
      }).languageModel(modelId)
    }
  }
}
