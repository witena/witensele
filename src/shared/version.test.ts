import { describe, expect, it } from 'vitest'
import { APP_NAME, APP_VERSION } from '@shared/version'

describe('shared/version', () => {
  it('exposes the application name', () => {
    expect(APP_NAME).toBe('Witena')
  })

  it('exposes a semver-shaped version', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
