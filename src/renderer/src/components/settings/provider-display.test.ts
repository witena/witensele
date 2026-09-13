/**
 * The card's derived endpoint and status.
 *
 * These two functions decide what the user believes about a provider at a glance,
 * so the cases worth pinning down are the dishonest ones: a provider that has
 * never been probed must not look connected, and a local server that needs no key
 * must not be flagged as missing one.
 */
import { describe, expect, it } from 'vitest'
import type { Provider } from '@shared/types'
import { LOCAL_USER_ID } from '@shared/types'
import {
  authControl,
  formatExpiry,
  providerHost,
  providerStatus,
  providerStatusTone,
  signedInName
} from './provider-display'

/**
 * Overrides that may explicitly clear a field, as `registry.test.ts` does:
 * `Partial<T>` cannot express `baseUrl: undefined` under
 * `exactOptionalPropertyTypes`, and "this provider has no custom endpoint" is
 * one of the cases worth testing.
 */
type ProviderOverrides = { [K in keyof Provider]?: Provider[K] | undefined }

function provider(overrides: ProviderOverrides = {}): Provider {
  const base: Provider = {
    id: 'p1',
    userId: LOCAL_USER_ID,
    createdAt: 0,
    updatedAt: 0,
    type: 'openai-compatible',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    presetId: 'deepseek',
    models: ['deepseek-chat'],
    hasApiKey: true
  }
  return { ...base, ...overrides } as Provider
}

describe('providerHost', () => {
  it('reads the host out of a stored base URL, port included', () => {
    expect(providerHost(provider())).toBe('api.deepseek.com')
    expect(providerHost({ type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' })).toBe(
      'localhost:11434'
    )
  })

  it('falls back to the adapter default when no base URL is stored', () => {
    expect(providerHost({ type: 'anthropic' })).toBe('api.anthropic.com')
    expect(providerHost({ type: 'openai' })).toBe('api.openai.com')
    expect(providerHost({ type: 'google' })).toBe('generativelanguage.googleapis.com')
  })

  it('shows an unparseable value back rather than an empty line', () => {
    expect(providerHost({ type: 'openai-compatible', baseUrl: 'localhost:11434' })).toBe(
      'localhost:11434'
    )
  })
})

describe('providerStatus', () => {
  it('reports a missing key before anything else', () => {
    expect(providerStatus(provider({ hasApiKey: false }), { ok: true, latencyMs: 4 })).toBe('no-key')
  })

  it('never claims a local provider is missing a key', () => {
    const ollama = provider({
      hasApiKey: false,
      presetId: 'ollama',
      baseUrl: 'http://localhost:11434/v1'
    })

    expect(providerStatus(ollama, undefined)).toBe('untested')
    expect(providerStatus(ollama, { ok: true, latencyMs: 9 })).toBe('connected')
  })

  it('says "untested" until a probe has actually run', () => {
    expect(providerStatus(provider(), undefined)).toBe('untested')
  })

  it('says "signed in" for a provider that authenticates with an account', () => {
    // Not "no key": having no key is the point of that mode, and the card would
    // otherwise show a warning for a provider that is perfectly well configured.
    const signedIn = provider({
      type: 'anthropic',
      presetId: 'anthropic',
      auth: 'oauth',
      hasApiKey: false,
      baseUrl: undefined
    })

    expect(providerStatus(signedIn, undefined)).toBe('signed-in')
  })

  it('lets a probe outrank the sign-in badge', () => {
    const signedIn = provider({ type: 'anthropic', auth: 'oauth', hasApiKey: false })

    expect(providerStatus(signedIn, { ok: true, latencyMs: 12 })).toBe('connected')
  })

  it('reflects the probe outcome', () => {
    expect(providerStatus(provider(), { ok: true, latencyMs: 30 })).toBe('connected')
    expect(
      providerStatus(provider(), {
        ok: false,
        error: { code: 'provider_error', message: '401' }
      })
    ).toBe('failed')
  })
})

describe('providerStatusTone', () => {
  it('maps every status to a pill tone', () => {
    expect(providerStatusTone('connected')).toBe('ok')
    expect(providerStatusTone('failed')).toBe('warn')
    expect(providerStatusTone('no-key')).toBe('idle')
    expect(providerStatusTone('untested')).toBe('idle')
    // Neutral, not green: the record says this provider signs in, which is not a
    // claim that the login still works.
    expect(providerStatusTone('signed-in')).toBe('idle')
  })
})

/**
 * The editor's Authentication control, as a rule rather than as JSX (S5.3).
 *
 * The suite has no DOM, so the decision the component makes is a pure function
 * it calls — which is also the only way "disabled with a hint" and "absent" stay
 * distinguishable in a test.
 */
describe('authControl', () => {
  it('offers a live control for the provider that can be signed into', () => {
    expect(authControl('anthropic')).toEqual({ shown: true, available: true })
  })

  it('shows a disabled one for the providers whose sign-in is not built yet', () => {
    expect(authControl('openai')).toEqual({ shown: true, available: false })
    expect(authControl('google')).toEqual({ shown: true, available: false })
  })

  it('shows none at all for an endpoint that has no account behind it', () => {
    expect(authControl('openai-compatible')).toEqual({ shown: false, available: false })
  })
})

describe('signedInName', () => {
  it('prefers the account the user recognises', () => {
    expect(
      signedInName({
        state: 'signed-in',
        accountEmail: 'person@example.com',
        workspaceName: 'Default',
        organizationName: 'Org'
      })
    ).toBe('person@example.com')
  })

  it('falls back rather than rendering "signed in as nobody"', () => {
    expect(signedInName({ state: 'signed-in', workspaceName: 'Default' })).toBe('Default')
    expect(signedInName({ state: 'signed-in', organizationName: 'Org' })).toBe('Org')
    expect(signedInName({ state: 'signed-in' })).toBe('')
  })
})

describe('formatExpiry', () => {
  it('renders a timestamp in the viewer locale', () => {
    expect(formatExpiry(Date.UTC(2026, 8, 13, 12, 0, 0), 'en-US')).not.toBe('')
  })

  it('says nothing when the CLI did not say', () => {
    expect(formatExpiry(undefined, 'en-US')).toBe('')
  })
})
