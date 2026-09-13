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
import { providerRequiresApiKey } from '@shared/presets'
import type { ConnectionTestResult, Provider, ProviderType } from '@shared/types'
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
 * The four states a card can be in.
 *
 * `untested` is not in the artboard, which only draws the three outcomes of a
 * probe. It exists because the honest answer for a provider nobody has tested yet
 * is "we do not know", and painting it green would be a lie the user only
 * discovers in the middle of a chat.
 */
export type ProviderStatus = 'connected' | 'failed' | 'no-key' | 'untested'

/** Combines the stored record with this session's probe result. */
export function providerStatus(
  provider: Provider,
  result: ConnectionTestResult | undefined
): ProviderStatus {
  if (!provider.hasApiKey && providerRequiresApiKey(provider)) return 'no-key'
  if (!result) return 'untested'
  return result.ok ? 'connected' : 'failed'
}

/** Which `StatusPill` tone a status wears. Total over `ProviderStatus`. */
export function providerStatusTone(status: ProviderStatus): StatusTone {
  switch (status) {
    case 'connected':
      return 'ok'
    case 'failed':
      return 'warn'
    case 'no-key':
    case 'untested':
      return 'idle'
  }
}
