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
import { getPreset, providerAuth } from '@shared/presets'
import type { Provider } from '@shared/types'
import { validation } from '../errors'
import type { AnthropicCli } from './anthropic-cli'

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

/** The `fetch` shape this layer injects. Re-exported by `discovery.ts`. */
export type FetchImpl = typeof globalThis.fetch

/**
 * The beta flag an OAuth-authenticated Anthropic request must carry.
 *
 * Without it the API answers 401 for a `Bearer` token: the header is how the
 * server is told this is an account token rather than an API key.
 */
export const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20'

/** Header names, spelled once so the wrapper and its test cannot disagree. */
const AUTHORIZATION_HEADER = 'authorization'
const API_KEY_HEADER = 'x-api-key'
const BETA_HEADER = 'anthropic-beta'

/** Adds `value` to a comma-separated header list unless it is already in it. */
export function mergeBeta(existing: string | null, value: string): string {
  const flags = (existing ?? '')
    .split(',')
    .map((flag) => flag.trim())
    .filter((flag) => flag.length > 0)
  if (!flags.includes(value)) flags.push(value)
  return flags.join(',')
}

/**
 * Wraps a `fetch` so every request authenticates with an account token instead
 * of an API key.
 *
 * Three edits, all of them required by the API and none of them optional:
 * `x-api-key` is **removed** (sending both is refused), `Authorization` becomes
 * `Bearer <token>`, and `oauth-2025-04-20` is merged into `anthropic-beta`
 * rather than assigned, because the AI SDK sets that header itself for features
 * like extended output and overwriting it would silently turn them off.
 *
 * The token is fetched per request through `getToken` rather than captured, so a
 * model instance built once and used for an hour keeps working: the CLI refreshes
 * the credential and `AnthropicCli` caches it until just before it expires.
 */
export function oauthFetch(
  getToken: () => Promise<string>,
  baseFetch: FetchImpl = globalThis.fetch
): FetchImpl {
  return async (input, init) => {
    const token = await getToken()
    // `init.headers` is what both callers use (the AI SDK and `discovery.ts`);
    // a `Request` object's own headers are merged in for completeness.
    const headers = new Headers(
      input instanceof Request && init?.headers === undefined ? input.headers : init?.headers
    )
    headers.delete(API_KEY_HEADER)
    headers.set(AUTHORIZATION_HEADER, `Bearer ${token}`)
    headers.set(BETA_HEADER, mergeBeta(headers.get(BETA_HEADER), ANTHROPIC_OAUTH_BETA))
    return await baseFetch(input, { ...init, headers })
  }
}

/**
 * What a caller may hand the model layer besides the provider itself.
 *
 * Both are capabilities rather than data: the CLI that can produce an account
 * token, and the HTTP implementation the request should go through. They arrive
 * by injection for the usual reason (CLAUDE.md rule #5) — the context owns them,
 * this module only uses them.
 */
export interface ModelOptions {
  anthropicCli?: AnthropicCli | undefined
  fetchImpl?: FetchImpl | undefined
}

function requireCli(options: ModelOptions): AnthropicCli {
  if (!options.anthropicCli) {
    throw validation('A provider that signs in needs the Anthropic CLI to be injected')
  }
  return options.anthropicCli
}

/**
 * The `fetch` this provider's requests must go through.
 *
 * For everything except an Anthropic provider in sign-in mode this is simply the
 * injected implementation (or the platform's). It is exported because
 * `providers.fetchModels` speaks the REST endpoint by hand and has to pick up
 * the very same header rewriting the model client gets — one wrapper, both
 * paths, no second place for the beta flag to be forgotten.
 */
export function createProviderFetch(
  provider: ResolvedProvider,
  options: ModelOptions = {}
): FetchImpl {
  const base = options.fetchImpl ?? globalThis.fetch
  if (provider.type !== 'anthropic' || providerAuth(provider) !== 'oauth') return base
  const cli = requireCli(options)
  return oauthFetch(() => cli.accessToken(), base)
}

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
export function createLanguageModel(
  provider: ResolvedProvider,
  modelId: string,
  options: ModelOptions = {}
): LanguageModel {
  if (typeof modelId !== 'string' || modelId.trim().length === 0) {
    throw validation('A model id is required to build a model client')
  }

  const apiKey = storedKey(provider)
  const baseUrl = provider.baseUrl?.trim()

  switch (provider.type) {
    case 'anthropic':
      if (providerAuth(provider) === 'oauth') {
        // `apiKey: ''` rather than omitted: the adapter otherwise looks for
        // `ANTHROPIC_API_KEY` in the environment and throws when it is not
        // there. The empty value it then puts in `x-api-key` is deleted by the
        // wrapper before the request leaves, which is exactly what the API
        // requires — a request may carry a key or a token, never both.
        return createAnthropic({
          apiKey: '',
          fetch: createProviderFetch(provider, options),
          ...(baseUrl ? { baseURL: baseUrl } : {})
        }).languageModel(modelId)
      }
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
