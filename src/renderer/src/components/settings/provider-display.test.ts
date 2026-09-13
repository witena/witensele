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
import { providerHost, providerStatus, providerStatusTone } from './provider-display'

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'p1',
    userId: LOCAL_USER_ID,
    createdAt: 0,
    updatedAt: 0,
    type: 'openai-compatible',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    presetId: 'deepseek',
    models: ['deepseek-chat'],
    hasApiKey: true,
    ...overrides
  }
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
  })
})
