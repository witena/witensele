/**
 * Two questions the settings screen asks about a provider before anything is
 * saved: *which models does it offer* and *does the key actually work*.
 *
 * Both take a `ResolvedProvider` (record + plaintext key) rather than an id, so
 * the same code answers for a saved row and for the unsaved draft in the "add
 * provider" form. Neither touches the database, electron or the event bus.
 *
 * ## Why the model list is a hand-written fetch and not the AI SDK
 *
 * The AI SDK builds *model clients*; it has no "list the models" call, because
 * `/models` is not part of any provider's language-model interface. So this file
 * speaks the three raw endpoints, and `fetchImpl` is a parameter rather than a
 * direct `globalThis.fetch` call so a unit test never opens a socket.
 *
 * | Type | Request | Ids read from |
 * |---|---|---|
 * | `anthropic` | `GET {base}/v1/models`, `x-api-key` + `anthropic-version: 2023-06-01` | `data[].id` |
 * | `openai`, `openai-compatible` | `GET {base}/models`, `Authorization: Bearer` | `data[].id` |
 * | `google` | `GET {base}/models?key=…` | `models[].name`, minus the `models/` prefix |
 *
 * The connection probe *is* the AI SDK: it runs `generateText` against the real
 * model client from `registry.ts`, which is the only way to prove that the model
 * id, the endpoint and the key work together rather than merely that the host
 * answers.
 */
import { generateText, type LanguageModel } from 'ai'
import type { ConnectionTestResult } from '@shared/types'
import { BackendFailure, isBackendFailure } from '../errors'
import { toBackendError } from '../ipc-protocol'
import { createLanguageModel, type ResolvedProvider } from './registry'

/** The `fetch` shape this module needs; injected so tests never hit the network. */
export type FetchImpl = typeof globalThis.fetch

/** Budget for one `/models` request. Long enough for a cold cloud endpoint. */
export const FETCH_MODELS_TIMEOUT_MS = 10_000

/** Budget for one connection probe, which loads a model and generates 8 tokens. */
export const TEST_CONNECTION_TIMEOUT_MS = 20_000

/** Endpoint used when a provider stores no `baseUrl` of its own. */
const DEFAULT_BASE_URL: Record<ResolvedProvider['type'], string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  'openai-compatible': ''
}

/** The prompt the probe sends. Short, cheap, and answerable by any chat model. */
const PROBE_PROMPT = 'Reply with OK'

/** Output cap for the probe: enough for a word, not enough to cost anything. */
const PROBE_MAX_OUTPUT_TOKENS = 8

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * `{base}/v1/models` for Anthropic, without doubling the version segment.
 *
 * The Anthropic adapter's own default `baseURL` already ends in `/v1`, so a user
 * who pastes that value into the base URL field would otherwise get
 * `/v1/v1/models`. Accepting both spellings is cheaper than explaining one.
 */
function anthropicModelsUrl(base: string): string {
  const root = trimTrailingSlash(base)
  return root.endsWith('/v1') ? `${root}/models` : `${root}/v1/models`
}

/** A `provider_error` carrying the HTTP status, which the UI shows verbatim. */
function httpFailure(status: number, statusText: string, body: string): BackendFailure {
  const detail = body.trim().slice(0, 400)
  return new BackendFailure(
    'provider_error',
    `Provider responded ${status} ${statusText}${detail ? `: ${detail}` : ''}`,
    { status, ...(detail ? { body: detail } : {}) }
  )
}

/**
 * Runs one request under a timeout.
 *
 * `AbortController` rather than `AbortSignal.timeout` so the abort reason is ours
 * and an abort can be told apart from a network failure; a provider that never
 * answers must not leave the settings screen spinning forever.
 */
async function requestJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchImpl,
  timeoutMs: number
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw httpFailure(response.status, response.statusText, body)
    }
    return await response.json()
  } catch (error) {
    if (isBackendFailure(error)) throw error
    if (controller.signal.aborted) {
      throw new BackendFailure('provider_error', `Provider did not answer within ${timeoutMs} ms`, {
        timeoutMs
      })
    }
    throw new BackendFailure('provider_error', `Could not reach the provider: ${message(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `data[].id` from an OpenAI-shaped list response, ignoring malformed entries. */
function openAiStyleIds(payload: unknown): string[] {
  const data = (payload as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  return data
    .map((entry) => (entry as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}

/** `models[].name` from Google, with the `models/` prefix stripped. */
function googleModelIds(payload: unknown): string[] {
  const models = (payload as { models?: unknown })?.models
  if (!Array.isArray(models)) return []
  return models
    .map((entry) => (entry as { name?: unknown })?.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
    .map((name) => (name.startsWith('models/') ? name.slice('models/'.length) : name))
}

/** Sorted and de-duplicated: the list is a picker, so a stable order is the point. */
function normalize(ids: string[]): string[] {
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}

/**
 * Reads the provider's model list. Does not persist anything — the caller decides
 * whether the answer replaces `Provider.models`.
 *
 * Rejects with a `provider_error` `BackendFailure` for any HTTP failure, timeout
 * or unreachable host; the status is in `details.status` so the renderer can tell
 * "wrong key" (401) from "wrong URL" (404) without parsing a sentence.
 */
export async function fetchModels(
  resolved: ResolvedProvider,
  fetchImpl: FetchImpl = globalThis.fetch
): Promise<string[]> {
  const apiKey = resolved.apiKey?.trim()
  const base = trimTrailingSlash(resolved.baseUrl?.trim() || DEFAULT_BASE_URL[resolved.type])

  if (!base) {
    throw new BackendFailure('validation', 'An OpenAI-compatible provider requires a base URL', {
      providerId: resolved.id
    })
  }

  switch (resolved.type) {
    case 'anthropic': {
      const payload = await requestJson(
        anthropicModelsUrl(base),
        {
          ...(apiKey ? { 'x-api-key': apiKey } : {}),
          'anthropic-version': '2023-06-01'
        },
        fetchImpl,
        FETCH_MODELS_TIMEOUT_MS
      )
      return normalize(openAiStyleIds(payload))
    }

    case 'google': {
      // Google authenticates the REST list endpoint with a query parameter; it
      // has no `Authorization` header form.
      const url = `${base}/models?key=${encodeURIComponent(apiKey ?? '')}`
      const payload = await requestJson(url, {}, fetchImpl, FETCH_MODELS_TIMEOUT_MS)
      return normalize(googleModelIds(payload))
    }

    case 'openai':
    case 'openai-compatible': {
      const payload = await requestJson(
        `${base}/models`,
        apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        fetchImpl,
        FETCH_MODELS_TIMEOUT_MS
      )
      return normalize(openAiStyleIds(payload))
    }
  }
}

/** The `generateText` surface the probe uses; injectable for unit tests. */
export type GenerateProbe = (options: {
  model: LanguageModel
  prompt: string
  maxOutputTokens: number
  abortSignal: AbortSignal
}) => Promise<{ text: string }>

export interface ConnectionTestOptions {
  /** Model to probe with. Defaults to the provider's first known model. */
  modelId?: string
  timeoutMs?: number
  /** Injected by tests so no real client is built. Defaults to the registry. */
  createModel?: (provider: ResolvedProvider, modelId: string) => LanguageModel
  /** Injected by tests. Defaults to the AI SDK's `generateText`. */
  generate?: GenerateProbe
}

/**
 * Sends one tiny request and reports whether it came back.
 *
 * **Never throws.** A failed probe is an ordinary outcome of pressing "Test
 * connection" — a wrong key, a typo in the URL, a model the endpoint does not
 * serve — so it is a value (`{ ok: false, error }`), not an exception. The
 * renderer switches on `error.code` for the message and shows `error.message` as
 * developer detail.
 *
 * AI SDK v7 names used here, verified in `node_modules/ai/dist/index.d.ts`:
 * `generateText({ model, prompt, maxOutputTokens, abortSignal })`, resolving to a
 * result whose `text` is the generated string.
 */
export async function testConnection(
  resolved: ResolvedProvider,
  options: ConnectionTestOptions = {}
): Promise<ConnectionTestResult> {
  const {
    timeoutMs = TEST_CONNECTION_TIMEOUT_MS,
    createModel = createLanguageModel,
    generate = (args) => generateText(args)
  } = options

  const modelId = options.modelId?.trim() || resolved.models[0]
  if (!modelId) {
    return {
      ok: false,
      error: {
        code: 'validation',
        message: 'The provider has no model to test against. Fetch or add one first.'
      }
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()

  try {
    const model = createModel(resolved, modelId)
    await generate({
      model,
      prompt: PROBE_PROMPT,
      maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
      abortSignal: controller.signal
    })
    return { ok: true, latencyMs: Date.now() - startedAt, model: modelId }
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        error: {
          code: 'provider_error',
          message: `The provider did not answer within ${timeoutMs} ms`,
          details: { timeoutMs, model: modelId }
        }
      }
    }
    // A thrown `BackendFailure` keeps its code; anything the AI SDK throws is a
    // provider failure by definition, so it is re-coded rather than left
    // `internal` — the renderer's error copy has to be about the provider.
    const backendError = toBackendError(error)
    return {
      ok: false,
      error: isBackendFailure(error) ? backendError : { ...backendError, code: 'provider_error' }
    }
  } finally {
    clearTimeout(timer)
  }
}
