/**
 * `ProviderRef` → `ResolvedProvider`: the one place a stored API key is
 * decrypted.
 *
 * The renderer must be able to ask about a provider it has not saved yet — "fetch
 * the model list for the endpoint and key I just typed" — so every provider call
 * takes a `ProviderRef` (`{ id }` or `{ draft }`) rather than an id. Both halves
 * end up in the same shape here, and everything downstream (`registry.ts`,
 * `discovery.ts`) is written against that shape alone and never learns which one
 * it got.
 *
 * Decryption lives here rather than in the repository on purpose: the repository
 * only ever hands out ciphertext (`getApiKeyCiphertext`), so plaintext exists for
 * the length of one call, in the main process, and can never be mapped into a
 * `Provider` that crosses IPC.
 */
import type { ProviderRef } from '@shared/backend'
import { providerRequiresApiKey } from '@shared/presets'
import { LOCAL_USER_ID, type Provider, type ProviderInput } from '@shared/types'
import type { AppContext } from '../app-context'
import { validation } from '../errors'
import type { ResolvedProvider } from './registry'

/**
 * Placeholder identity for an unsaved draft.
 *
 * `ResolvedProvider` extends `Provider`, which carries `EntityBase`; a draft has
 * no row yet. The id is a visible marker rather than an empty string so it is
 * obvious in an error message or a log line that nothing was persisted.
 */
export const DRAFT_PROVIDER_ID = 'draft'

function fromDraft(draft: ProviderInput, userId: string): ResolvedProvider {
  if (typeof draft !== 'object' || draft === null) {
    throw validation('A provider draft object is required')
  }
  const timestamp = 0
  return {
    id: DRAFT_PROVIDER_ID,
    userId,
    createdAt: timestamp,
    updatedAt: timestamp,
    type: draft.type,
    name: draft.name,
    ...(draft.baseUrl ? { baseUrl: draft.baseUrl } : {}),
    ...(draft.presetId ? { presetId: draft.presetId } : {}),
    models: Array.isArray(draft.models) ? draft.models : [],
    hasApiKey: Boolean(draft.apiKey),
    ...(draft.apiKey ? { apiKey: draft.apiKey } : {})
  }
}

function fromId(ctx: AppContext, id: string): ResolvedProvider {
  const provider: Provider = ctx.repos.providers.get(id, ctx.userId)
  const cipher = ctx.repos.providers.getApiKeyCiphertext(id, ctx.userId)
  const apiKey = cipher ? ctx.secrets.decrypt(cipher) : undefined
  return { ...provider, ...(apiKey ? { apiKey } : {}) }
}

/**
 * Loads and decrypts, or adapts the draft in the form.
 *
 * A draft that omits `apiKey` is fine: a preset with `requiresApiKey: false`
 * (Ollama, LM Studio) is expected to have none, and a hosted provider without one
 * simply fails at the provider's own 401, which is a better message than anything
 * this layer could invent.
 */
export function resolveProvider(ctx: AppContext, ref: ProviderRef): ResolvedProvider {
  if (typeof ref !== 'object' || ref === null) {
    throw validation('A provider reference is required')
  }
  if ('id' in ref) {
    if (typeof ref.id !== 'string' || ref.id.length === 0) {
      throw validation('A provider id must be a non-empty string')
    }
    return fromId(ctx, ref.id)
  }
  if ('draft' in ref) {
    return fromDraft(ref.draft, ctx.userId ?? LOCAL_USER_ID)
  }
  throw validation('A provider reference must be { id } or { draft }')
}

/** True when this provider is expected to carry a key but has none stored. */
export function isMissingRequiredKey(provider: ResolvedProvider): boolean {
  if (provider.apiKey) return false
  return providerRequiresApiKey(provider)
}
