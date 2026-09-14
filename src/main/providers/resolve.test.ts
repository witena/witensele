/**
 * `resolveProvider`, and the one thing S7.6 changed about it: what happens when
 * the stored ciphertext cannot be decrypted.
 *
 * Before S7.6 the bare `ctx.secrets.decrypt` threw whatever OpenSSL said, which
 * reached the user as a generic failed probe on a card that also claimed to have
 * no key. Now it is a `key_unreadable` `BackendError`, and the provider's id is
 * remembered so the settings screen can explain it without probing anything.
 */
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppContext } from '../app-context'
import { createTestDatabase, type TestDatabase } from '../db/testing'
import { createFileKeySecretStore } from '../secrets'
import { createTestAppContext } from '../testing'
import { resolveProvider } from './resolve'

describe('providers/resolveProvider', () => {
  let database: TestDatabase
  let ctx: AppContext

  beforeEach(() => {
    database = createTestDatabase()
    ctx = createTestAppContext(database, {
      secrets: createFileKeySecretStore({
        keyPath: join(database.dir, 'secrets.key'),
        wrap: false
      })
    }).ctx
  })

  afterEach(() => {
    ctx.close()
  })

  function create(apiKey?: string): string {
    return ctx.repos.providers.create(
      {
        type: 'openai-compatible',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        models: ['deepseek-chat'],
        ...(apiKey ? { apiKey } : {})
      },
      ctx.userId
    ).id
  }

  it('decrypts the stored key and leaves the provider readable', () => {
    const id = create('sk-readable')

    const resolved = resolveProvider(ctx, { id })

    expect(resolved.apiKey).toBe('sk-readable')
    expect(ctx.unreadableSecrets.has(id)).toBe(false)
  })

  it('reports a key this build cannot decrypt as key_unreadable, and remembers it', () => {
    const id = create('sk-written-by-another-installation')
    // Exactly the user's situation: the row is intact, the key that wrote it is
    // gone. Reaching into the row is the only way to produce it without a second
    // machine, and what it produces is a genuine `fk1:` value under another key.
    const other = createFileKeySecretStore({
      keyPath: join(database.dir, 'other.key'),
      wrap: false
    })
    database.handle.sqlite
      .prepare('UPDATE providers SET api_key_encrypted = ? WHERE id = ?')
      .run(other.encrypt('sk-written-by-another-installation'), id)

    expect(() => resolveProvider(ctx, { id })).toThrow(
      expect.objectContaining({ code: 'key_unreadable' })
    )
    expect(ctx.unreadableSecrets.has(id)).toBe(true)
  })

  it('clears the mark once the key has been replaced with a readable one', () => {
    const id = create('sk-readable')
    ctx.unreadableSecrets.add(id)

    resolveProvider(ctx, { id })

    expect(ctx.unreadableSecrets.has(id)).toBe(false)
  })

  it('says nothing about a provider that stores no key at all', () => {
    const id = create()

    const resolved = resolveProvider(ctx, { id })

    expect(resolved.apiKey).toBeUndefined()
    expect(ctx.unreadableSecrets.size).toBe(0)
  })
})
