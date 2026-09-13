import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_SETTINGS, LOCAL_USER_ID } from '@shared/types'
import { createAppContext } from './app-context'
import { createInsecureSecretStore } from './secrets'

describe('app-context', () => {
  let dir: string
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'witena-ctx-'))
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  it('opens the database, builds the repositories and defaults to the local user', () => {
    const ctx = createAppContext({
      databasePath: join(dir, 'witena.db'),
      userDataDir: dir,
      secrets: createInsecureSecretStore()
    })

    expect(ctx.userId).toBe(LOCAL_USER_ID)
    expect(ctx.repos.settings.get(ctx.userId)).toEqual(DEFAULT_APP_SETTINGS)

    ctx.close()
  })

  it('binds the repositories to the injected secret store', () => {
    const ctx = createAppContext({
      databasePath: join(dir, 'witena.db'),
      userDataDir: dir,
      secrets: createInsecureSecretStore()
    })

    const provider = ctx.repos.providers.create(
      { type: 'openai-compatible', name: 'Local', models: [], apiKey: 'sk-test' },
      ctx.userId
    )

    expect(provider.hasApiKey).toBe(true)
    const cipher = ctx.repos.providers.getApiKeyCiphertext(provider.id, ctx.userId)
    expect(cipher).not.toBeNull()
    expect(cipher).not.toContain('sk-test')
    expect(ctx.secrets.decrypt(cipher as string)).toBe('sk-test')

    ctx.close()
  })

  it('close() is idempotent', () => {
    const ctx = createAppContext({
      databasePath: join(dir, 'witena.db'),
      userDataDir: dir,
      secrets: createInsecureSecretStore()
    })

    ctx.close()
    expect(() => ctx.close()).not.toThrow()
  })
})
