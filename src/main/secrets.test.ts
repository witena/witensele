import { describe, expect, it, vi } from 'vitest'
import { createInsecureSecretStore, isInsecureSecret } from './secrets'

describe('secrets/insecure store', () => {
  it('round-trips a value and marks the ciphertext as insecure', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createInsecureSecretStore()

    const cipher = store.encrypt('sk-secret-key')

    expect(cipher).not.toContain('sk-secret-key')
    expect(isInsecureSecret(cipher)).toBe(true)
    expect(store.decrypt(cipher)).toBe('sk-secret-key')

    warn.mockRestore()
  })

  it('round-trips non-ASCII and empty values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createInsecureSecretStore()

    for (const value of ['', 'a'.repeat(4096), 'clé-Ω-🔑']) {
      expect(store.decrypt(store.encrypt(value))).toBe(value)
    }

    warn.mockRestore()
  })

  it('reports that it is not real encryption and warns exactly once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createInsecureSecretStore()

    expect(store.isAvailable()).toBe(false)

    store.encrypt('one')
    store.encrypt('two')
    store.decrypt(store.encrypt('three'))

    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
