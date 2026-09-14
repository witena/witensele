/**
 * The two derived values a provider card shows besides its name: the endpoint it
 * talks to, and how it is doing.
 *
 * Both are pure functions rather than fields on the record. The endpoint is
 * *derived* because the three first-party adapters store no `baseUrl` at all —
 * their endpoint is the SDK default — and the user still needs to see where their
 * key is going. The status is derived because a probe result is a fact about now:
 * it lives in the store for this session and is deliberately never persisted, so
 * a restart shows "not tested" rather than a stale green dot.
 */
import { providerAuth, providerRequiresApiKey, supportsOAuth } from '@shared/presets'
import type {
  ConnectionTestResult,
  Provider,
  ProviderAuthStatus,
  ProviderType
} from '@shared/types'
import type { StatusTone } from '../ui'

/** What each adapter talks to when the record stores no base URL of its own. */
const DEFAULT_HOST: Record<ProviderType, string> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
  google: 'generativelanguage.googleapis.com',
  'openai-compatible': ''
}

/**
 * The host (and port) a provider reaches, for the mono line under its name.
 *
 * Falls back to the raw stored string when it is not a parseable URL: a user who
 * typed `localhost:11434` without a scheme should see what they typed, not an
 * empty line, and the save path is where a bad URL gets reported.
 */
export function providerHost(provider: Pick<Provider, 'type' | 'baseUrl'>): string {
  const baseUrl = provider.baseUrl?.trim()
  if (!baseUrl) return DEFAULT_HOST[provider.type]
  try {
    // `host` is empty for a string the URL parser accepts but that names no
    // authority — `localhost:11434` parses as the scheme `localhost:`, not a host.
    return new URL(baseUrl).host || baseUrl
  } catch {
    return baseUrl
  }
}

/**
 * The five states a card can be in.
 *
 * `untested` is not in the artboard, which only draws the three outcomes of a
 * probe. It exists because the honest answer for a provider nobody has tested yet
 * is "we do not know", and painting it green would be a lie the user only
 * discovers in the middle of a chat.
 *
 * `signed-in` (S5.3) is what replaces the key indicator for a provider that
 * authenticates with the user's account: "no key" would be true and completely
 * misleading, because having no key is the *point* of that mode.
 */
export type ProviderStatus = 'connected' | 'failed' | 'no-key' | 'signed-in' | 'untested'

/** Combines the stored record with this session's probe result. */
export function providerStatus(
  provider: Provider,
  result: ConnectionTestResult | undefined
): ProviderStatus {
  if (!provider.hasApiKey && providerRequiresApiKey(provider)) return 'no-key'
  // A probe outranks the badge: it is the stronger statement, and a provider
  // that signs in can still fail for a model id or an expired login.
  if (result) return result.ok ? 'connected' : 'failed'
  if (providerAuth(provider) === 'oauth') return 'signed-in'
  return 'untested'
}

/** Which `StatusPill` tone a status wears. Total over `ProviderStatus`. */
export function providerStatusTone(status: ProviderStatus): StatusTone {
  switch (status) {
    case 'connected':
      return 'ok'
    case 'failed':
      return 'warn'
    case 'no-key':
    // Neutral rather than green on purpose, for the same reason `untested` is:
    // the record says this provider signs in, which is not a claim that the
    // login is still valid. Only a probe can say that.
    case 'signed-in':
    case 'untested':
      return 'idle'
  }
}

/**
 * Whether the editor shows the Authentication control, and whether it is live.
 *
 * Three outcomes rather than two, because "this provider will gain a sign-in
 * later" and "this provider has no account to sign in to" are different
 * statements: an `openai-compatible` endpoint is a URL somebody else operates,
 * so it gets no control at all, while OpenAI — the one first-party type with no
 * flow yet — gets a disabled one with a hint. Pure, so the rule is tested
 * without rendering the editor.
 */
export interface AuthControlState {
  shown: boolean
  available: boolean
}

export function authControl(type: ProviderType): AuthControlState {
  return { shown: type !== 'openai-compatible', available: supportsOAuth(type) }
}

/**
 * Who the user is signed in as, in one string.
 *
 * The account email is the identity a person recognises; a profile without one
 * falls back to whatever label the answering CLI did give — the Anthropic
 * workspace or organisation, the Google project — so the line never reads
 * "Signed in as ".
 */
export function signedInName(status: ProviderAuthStatus): string {
  return (
    status.account ?? status.workspaceName ?? status.organizationName ?? status.project ?? ''
  )
}

/**
 * `expiresAt` as a local date-time, or `''` when the CLI did not say.
 *
 * Formatted in the renderer rather than in the backend for the usual reason: the
 * main process does not know the UI language, and a date it formatted would be
 * frozen in whichever one was active when it was written.
 */
export function formatExpiry(expiresAt: number | undefined, locale: string): string {
  if (expiresAt === undefined) return ''
  return new Date(expiresAt).toLocaleString(locale)
}
