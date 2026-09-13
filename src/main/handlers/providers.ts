/**
 * `providers.*` — CRUD over the `providers` table plus the two questions that
 * need the network (`fetchModels`, `testConnection`).
 *
 * The handlers are thin on purpose. Persistence and the key ciphertext belong to
 * `db/repositories/providers.ts`, decryption to `providers/resolve.ts`, the
 * endpoints to `providers/discovery.ts`; what is left here is **validation** —
 * the renderer is an untrusted client like any other, so nothing reaches storage
 * before the shape is checked.
 *
 * There is deliberately no `providers.presets` method: `PROVIDER_PRESETS` is
 * frozen data in `@shared/presets` and the renderer imports it directly rather
 * than paying a round trip for an array that cannot change at runtime.
 */
import { providerRequiresApiKey } from '@shared/presets'
import type { ProviderInput, ProviderType } from '@shared/types'
import { validation } from '../errors'
import { fetchModels, testConnection } from '../providers/discovery'
import { resolveProvider } from '../providers/resolve'
import type { HandlerModule } from './types'

const PROVIDER_TYPES: readonly ProviderType[] = [
  'anthropic',
  'openai',
  'google',
  'openai-compatible'
]

function isProviderType(value: unknown): value is ProviderType {
  return typeof value === 'string' && (PROVIDER_TYPES as readonly string[]).includes(value)
}

function assertId(input: unknown): asserts input is { id: string } {
  const id = (input as { id?: unknown })?.id
  if (typeof id !== 'string' || id.length === 0) {
    throw validation('A provider id is required')
  }
}

function assertModels(models: unknown): asserts models is string[] {
  if (!Array.isArray(models) || models.some((model) => typeof model !== 'string')) {
    throw validation('models must be an array of strings')
  }
}

/** Full validation, used by `create`: every field must be present and sane. */
function assertProviderInput(input: unknown): asserts input is ProviderInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw validation('providers.create requires an input object')
  }
  const candidate = input as Partial<ProviderInput>

  if (typeof candidate.name !== 'string' || candidate.name.trim().length === 0) {
    throw validation('A provider name is required')
  }
  if (!isProviderType(candidate.type)) {
    throw validation(`Unknown provider type: ${String(candidate.type)}`)
  }
  assertModels(candidate.models)
  if (candidate.type === 'openai-compatible' && !candidate.baseUrl?.trim()) {
    throw validation('An OpenAI-compatible provider requires a base URL')
  }
  if (providerRequiresApiKey(candidate as ProviderInput) && !candidate.apiKey?.trim()) {
    throw validation('This provider requires an API key')
  }
}

/**
 * Partial validation, used by `update`: only the fields actually present are
 * checked, because a patch is allowed to touch one field at a time.
 *
 * The key requirement is deliberately *not* re-checked here. Clearing a key
 * (`apiKey: ''`) is an explicit, documented operation — the user is removing a
 * credential, not creating an invalid provider — and the provider then simply
 * reports `hasApiKey: false` and fails its next probe.
 */
function assertProviderPatch(patch: unknown): asserts patch is Partial<ProviderInput> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw validation('providers.update requires a patch object')
  }
  const candidate = patch as Partial<ProviderInput>

  if (candidate.name !== undefined && candidate.name.trim().length === 0) {
    throw validation('A provider name cannot be empty')
  }
  if (candidate.type !== undefined && !isProviderType(candidate.type)) {
    throw validation(`Unknown provider type: ${String(candidate.type)}`)
  }
  if (candidate.models !== undefined) assertModels(candidate.models)
  if (candidate.type === 'openai-compatible' && candidate.baseUrl !== undefined) {
    if (candidate.baseUrl.trim().length === 0) {
      throw validation('An OpenAI-compatible provider requires a base URL')
    }
  }
}

export const providerHandlers: HandlerModule = {
  'providers.list': async (ctx) => ctx.repos.providers.list(ctx.userId),

  'providers.get': async (ctx, input) => {
    assertId(input)
    return ctx.repos.providers.get(input.id, ctx.userId)
  },

  'providers.create': async (ctx, input) => {
    assertProviderInput(input?.input)
    return ctx.repos.providers.create(input.input, ctx.userId)
  },

  'providers.update': async (ctx, input) => {
    assertId(input)
    assertProviderPatch(input.patch)
    return ctx.repos.providers.update(input.id, input.patch, ctx.userId)
  },

  'providers.delete': async (ctx, input) => {
    assertId(input)
    ctx.repos.providers.delete(input.id, ctx.userId)
  },

  'providers.fetchModels': async (ctx, input) => {
    const resolved = resolveProvider(ctx, input.provider)
    return fetchModels(resolved, ctx.fetchImpl)
  },

  'providers.testConnection': async (ctx, input) => {
    const resolved = resolveProvider(ctx, input.provider)
    return testConnection(resolved, {
      // Absent means "the provider's first model", which `discovery.ts` decides.
      ...(input.modelId ? { modelId: input.modelId } : {})
    })
  }
}
