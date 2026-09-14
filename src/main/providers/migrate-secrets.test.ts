/**
 * S7.6's migration, against the real temporary database.
 *
 * The failure being reproduced is the one the user reported: rows holding
 * `safeStorage` ciphertext (`djEw…`) written by a build whose Keychain item the
 * current build cannot reach. `fakeSafeStorage('build-1')` writes them,
 * `fakeSafeStorage('build-2')` is the rebuilt app, and the assertions are about
 * what happens to the row — never overwritten when it could not be read.
 */
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppContext } from '../app-context'
import { createRepositories } from '../db/repositories'
import { createTestDatabase, type TestDatabase } from '../db/testing'
import { createFileKeySecretStore, isFileKeySecret } from '../secrets'
import { createTestAppContext, fakeSafeStorage } from '../testing'
import { migrateProviderSecrets } from './migrate-secrets'

describe('providers/migrateProviderSecrets', () => {
  let database: TestDatabase
  let ctx: AppContext
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    database = createTestDatabase()
    // The context's own store is the S7.6 one, exactly as in the app: the
    // migration's job is to move rows *onto* it.
    ctx = createTestAppContext(database, {
      secrets: createFileKeySecretStore({
        keyPath: join(database.dir, 'secrets.key'),
        wrap: false
      })
    }).ctx
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    ctx.close()
  })

  /** Writes a provider row whose ciphertext was produced by `writer`. */
  function seed(name: string, key: string, writer: { encrypt: (plain: string) => string }): string {
    const legacyRepos = createRepositories(database.handle.db, {
      encrypt: (plain) => writer.encrypt(plain)
    })
    return legacyRepos.providers.create(
      {
        type: 'openai-compatible',
        name,
        baseUrl: 'https://api.deepseek.com/v1',
        presetId: 'deepseek',
        models: ['deepseek-chat'],
        apiKey: key
      },
      ctx.userId
    ).id
  }

  function cipherOf(id: string): string | null {
    return ctx.repos.providers.getApiKeyCiphertext(id, ctx.userId)
  }

  it('re-encrypts a safeStorage row with the file key and keeps the plaintext', () => {
    const legacy = fakeSafeStorage('build-1')
    const id = seed('DeepSeek', 'sk-from-the-old-build', legacy)
    expect(cipherOf(id)?.startsWith('djEw')).toBe(true)

    const result = migrateProviderSecrets(ctx, { legacy })

    expect(result.migrated).toEqual([id])
    expect(result.unreadable).toEqual([])
    const cipher = cipherOf(id) as string
    expect(isFileKeySecret(cipher)).toBe(true)
    expect(ctx.secrets.decrypt(cipher)).toBe('sk-from-the-old-build')
    expect(ctx.unreadableSecrets.size).toBe(0)
  })

  it('re-encrypts a `plain:` row without needing any key store at all', () => {
    const id = seed('Moonshot', 'sk-was-never-encrypted', createInsecureWriter())

    const result = migrateProviderSecrets(ctx, { legacy: null })

    expect(result.migrated).toEqual([id])
    expect(ctx.secrets.decrypt(cipherOf(id) as string)).toBe('sk-was-never-encrypted')
  })

  it('leaves a row it cannot read exactly as it was, and reports the id', () => {
    const written = fakeSafeStorage('build-1')
    const id = seed('DeepSeek', 'sk-lost-with-the-keychain', written)
    const before = cipherOf(id)

    // The rebuilt app: same database, a Keychain item granted to another identity.
    const result = migrateProviderSecrets(ctx, { legacy: fakeSafeStorage('build-2') })

    expect(result.migrated).toEqual([])
    expect(result.unreadable).toEqual([id])
    // Never overwritten: the key is unreachable here, not gone from the world.
    expect(cipherOf(id)).toBe(before)
    expect(ctx.unreadableSecrets.has(id)).toBe(true)
  })

  it('reports a safeStorage row as unreadable when there is no key store at all', () => {
    const id = seed('DeepSeek', 'sk-no-keychain-here', fakeSafeStorage('build-1'))
    const before = cipherOf(id)

    const result = migrateProviderSecrets(ctx, { legacy: null })

    expect(result.unreadable).toEqual([id])
    expect(cipherOf(id)).toBe(before)
  })

  it('skips rows that already hold a file-key value, and rows with no key', () => {
    const migrated = ctx.repos.providers.create(
      {
        type: 'openai-compatible',
        name: 'Already migrated',
        baseUrl: 'https://api.deepseek.com/v1',
        models: [],
        apiKey: 'sk-current'
      },
      ctx.userId
    )
    const keyless = ctx.repos.providers.create(
      {
        type: 'openai-compatible',
        name: 'Ollama',
        baseUrl: 'http://localhost:11434/v1',
        models: []
      },
      ctx.userId
    )
    const before = cipherOf(migrated.id)

    const result = migrateProviderSecrets(ctx, { legacy: fakeSafeStorage('build-1') })

    expect(result).toEqual({ migrated: [], unreadable: [], skipped: 2 })
    // Byte-identical: a no-op migration must not even re-encrypt, or every
    // launch would rewrite every row for nothing.
    expect(cipherOf(migrated.id)).toBe(before)
    expect(cipherOf(keyless.id)).toBeNull()
  })

  it('is safe to run twice: the second pass does nothing', () => {
    const legacy = fakeSafeStorage('build-1')
    const id = seed('DeepSeek', 'sk-run-twice', legacy)

    migrateProviderSecrets(ctx, { legacy })
    const afterFirst = cipherOf(id)
    const second = migrateProviderSecrets(ctx, { legacy })

    expect(second).toEqual({ migrated: [], unreadable: [], skipped: 1 })
    expect(cipherOf(id)).toBe(afterFirst)
  })

  it('migrates what it can and reports what it cannot, in one pass', () => {
    const legacy = fakeSafeStorage('build-2')
    const readable = seed('Readable', 'sk-readable', legacy)
    const lost = seed('Lost', 'sk-lost', fakeSafeStorage('build-1'))

    const result = migrateProviderSecrets(ctx, { legacy })

    expect(result.migrated).toEqual([readable])
    expect(result.unreadable).toEqual([lost])
    expect(ctx.secrets.decrypt(cipherOf(readable) as string)).toBe('sk-readable')
  })
})

/** The `plain:` fallback's writer half, without its console warning. */
function createInsecureWriter(): { encrypt: (plain: string) => string } {
  return { encrypt: (plain) => 'plain:' + Buffer.from(plain, 'utf8').toString('base64') }
}
