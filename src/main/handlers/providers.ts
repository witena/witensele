/**
 * `providers.*` — CRUD over the `providers` table, the two questions that need
 * the network (`fetchModels`, `testConnection`) and, since S5.3, the three that
 * ask the Anthropic CLI about the user's login (`authStatus`, `login`,
 * `logout`).
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
import { providerAuth, providerRequiresApiKey, supportsOAuth } from '@shared/presets'
import { PROVIDER_AUTH_MODES } from '@shared/types'
import type { Provider, ProviderAuth, ProviderInput, ProviderType } from '@shared/types'
import { modelOptions, providerFetch, type AppContext } from '../app-context'
import { validation } from '../errors'
import { antMissing, antNotLoggedIn } from '../providers/anthropic-cli'
import { fetchModels, testConnection } from '../providers/discovery'
import { createLanguageModel } from '../providers/registry'
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

function isProviderAuth(value: unknown): value is ProviderAuth {
  return typeof value === 'string' && (PROVIDER_AUTH_MODES as readonly string[]).includes(value)
}

/**
 * The two rules a sign-in provider has to satisfy, checked against the **merged**
 * record rather than against one patch.
 *
 * Both refusals name themselves: a `ValidationReason` travels in `details` and
 * the renderer turns it into a sentence, because "rejected as invalid" tells a
 * user who just clicked "Sign in with Anthropic" nothing they can act on
 * (S5.2 built that layer; this step reuses it rather than inventing a channel).
 */
function assertAuthRules(candidate: {
  type: ProviderType
  auth?: ProviderAuth | undefined
  baseUrl?: string | undefined
}): void {
  if (providerAuth(candidate) !== 'oauth') return

  if (!supportsOAuth(candidate.type)) {
    throw validation(`Signing in is not available for provider type ${candidate.type}`, {
      reason: 'oauth_unsupported_provider'
    })
  }
  if (candidate.baseUrl?.trim()) {
    // The account token is issued for Anthropic's own API. Pointing the same
    // credential at a proxy would send it somewhere the user never authorised.
    throw validation('A provider that signs in cannot have a custom base URL', {
      reason: 'oauth_custom_base_url'
    })
  }
}

/**
 * Refuses a sign-in provider the CLI cannot actually authenticate.
 *
 * A saved provider is a promise that an agent can speak through it, so the check
 * happens where the user can still do something about it — the editor is open,
 * the panel is right there — rather than three screens later in the middle of a
 * chat. The `ant_missing` / `ant_not_logged_in` codes are what the panel is
 * already showing; Save simply refuses to disagree with it.
 */
async function assertSignedIn(ctx: AppContext): Promise<void> {
  const status = await ctx.anthropicCli.status()
  if (status.state === 'not-installed') throw antMissing()
  if (status.state === 'signed-out') throw antNotLoggedIn()
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
  if (candidate.auth !== undefined && !isProviderAuth(candidate.auth)) {
    throw validation(`Unknown authentication mode: ${String(candidate.auth)}`)
  }
  if (candidate.type === 'openai-compatible' && !candidate.baseUrl?.trim()) {
    throw validation('An OpenAI-compatible provider requires a base URL')
  }
  assertAuthRules(candidate as ProviderInput)
  // `providerRequiresApiKey` answers `false` for a provider that signs in, which
  // is the whole point: sign-in mode is saveable with the key field empty.
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
  if (candidate.auth !== undefined && !isProviderAuth(candidate.auth)) {
    throw validation(`Unknown authentication mode: ${String(candidate.auth)}`)
  }
  if (candidate.type === 'openai-compatible' && candidate.baseUrl !== undefined) {
    if (candidate.baseUrl.trim().length === 0) {
      throw validation('An OpenAI-compatible provider requires a base URL')
    }
  }
}

/**
 * The patch applied over the stored row, for the checks that are about the
 * *result* rather than about one field.
 *
 * `auth` is exactly that kind of rule: `{ auth: 'oauth' }` alone says nothing
 * about whether the provider it lands on is an Anthropic one, and a patch that
 * only clears a base URL can make an otherwise illegal pair legal.
 */
function mergedAuthFields(
  current: Provider,
  patch: Partial<ProviderInput>
): { type: ProviderType; auth?: ProviderAuth | undefined; baseUrl?: string | undefined } {
  return {
    type: patch.type ?? current.type,
    auth: patch.auth ?? current.auth,
    baseUrl: patch.baseUrl !== undefined ? patch.baseUrl : current.baseUrl
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
    if (providerAuth(input.input) === 'oauth') await assertSignedIn(ctx)
    return ctx.repos.providers.create(input.input, ctx.userId)
  },

  'providers.update': async (ctx, input) => {
    assertId(input)
    assertProviderPatch(input.patch)
    const merged = mergedAuthFields(ctx.repos.providers.get(input.id, ctx.userId), input.patch)
    assertAuthRules(merged)
    if (providerAuth(merged) === 'oauth') await assertSignedIn(ctx)
    return ctx.repos.providers.update(input.id, input.patch, ctx.userId)
  },

  'providers.delete': async (ctx, input) => {
    assertId(input)
    ctx.repos.providers.delete(input.id, ctx.userId)
  },

  'providers.fetchModels': async (ctx, input) => {
    const resolved = resolveProvider(ctx, input.provider)
    // The same wrapper the model client gets: a signed-in provider reads its
    // model list with `Authorization: Bearer` and the beta header, never with
    // the `x-api-key` it has no key for.
    return fetchModels(resolved, providerFetch(ctx, resolved))
  },

  'providers.testConnection': async (ctx, input) => {
    const resolved = resolveProvider(ctx, input.provider)
    return testConnection(resolved, {
      createModel: (provider, modelId) =>
        createLanguageModel(provider, modelId, modelOptions(ctx)),
      // Absent means "the provider's first model", which `discovery.ts` decides.
      ...(input.modelId ? { modelId: input.modelId } : {})
    })
  },

  'providers.authStatus': async (ctx) => ctx.anthropicCli.status(),

  'providers.login': async (ctx) => ctx.anthropicCli.login(),

  'providers.logout': async (ctx) => ctx.anthropicCli.logout()
}
