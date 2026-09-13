import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOCAL_USER_ID } from '@shared/types'
import { BackendFailure } from '../errors'
import { createTestDatabase, fakeEncrypt, providerInput, type TestDatabase } from './testing'

describe('db/repositories/providers', () => {
  let database: TestDatabase

  beforeEach(() => {
    database = createTestDatabase()
  })

  afterEach(() => {
    database.cleanup()
  })

  it('creates, reads, lists, updates and deletes a provider', () => {
    const created = database.repos.providers.create(providerInput())
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.userId).toBe(LOCAL_USER_ID)
    expect(created.createdAt).toBe(created.updatedAt)
    expect(created.models).toEqual(['deepseek-chat'])

    expect(database.repos.providers.get(created.id)).toEqual(created)
    expect(database.repos.providers.list()).toEqual([created])

    const updated = database.repos.providers.update(created.id, {
      name: 'DeepSeek (work)',
      models: ['deepseek-chat', 'deepseek-reasoner']
    })
    expect(updated.name).toBe('DeepSeek (work)')
    expect(updated.models).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    expect(updated.createdAt).toBe(created.createdAt)

    database.repos.providers.delete(created.id)
    expect(database.repos.providers.list()).toEqual([])
  })

  it('omits absent optional columns instead of returning null', () => {
    const created = database.repos.providers.create(
      providerInput({ type: 'anthropic', name: 'Anthropic', models: ['claude-sonnet-4-5'] })
    )
    const bare = database.repos.providers.create({
      type: 'openai',
      name: 'OpenAI',
      models: ['gpt-5']
    })

    expect(created.baseUrl).toBe('https://api.deepseek.com/v1')
    expect('baseUrl' in bare).toBe(false)
    expect('presetId' in bare).toBe(false)
  })

  it('reports a key only as hasApiKey and stores ciphertext', () => {
    const created = database.repos.providers.create(providerInput({ apiKey: 'sk-secret' }))

    expect(created.hasApiKey).toBe(true)
    expect(JSON.stringify(created)).not.toContain('sk-secret')
    expect(database.repos.providers.getApiKeyCiphertext(created.id)).toBe(fakeEncrypt('sk-secret'))
  })

  it('keeps the key when apiKey is absent, clears it on an empty string, replaces it otherwise', () => {
    const created = database.repos.providers.create(providerInput({ apiKey: 'sk-first' }))

    const kept = database.repos.providers.update(created.id, { name: 'Renamed' })
    expect(kept.hasApiKey).toBe(true)
    expect(database.repos.providers.getApiKeyCiphertext(created.id)).toBe(fakeEncrypt('sk-first'))

    const replaced = database.repos.providers.update(created.id, { apiKey: 'sk-second' })
    expect(replaced.hasApiKey).toBe(true)
    expect(database.repos.providers.getApiKeyCiphertext(created.id)).toBe(fakeEncrypt('sk-second'))

    const cleared = database.repos.providers.update(created.id, { apiKey: '' })
    expect(cleared.hasApiKey).toBe(false)
    expect(database.repos.providers.getApiKeyCiphertext(created.id)).toBeNull()
  })

  it('clears baseUrl and presetId on an empty string', () => {
    const created = database.repos.providers.create(providerInput())
    const cleared = database.repos.providers.update(created.id, { baseUrl: '', presetId: '' })

    expect('baseUrl' in cleared).toBe(false)
    expect('presetId' in cleared).toBe(false)
  })

  it('stores the authentication mode, absent meaning the API key (S5.3)', () => {
    const keyed = database.repos.providers.create(providerInput({ apiKey: 'sk-secret' }))
    // A row written before the column existed reads as "no auth field", which
    // `providerAuth()` resolves to `apiKey`. Absent, not `null`, not `'apiKey'`.
    expect('auth' in keyed).toBe(false)

    const signedIn = database.repos.providers.create({
      type: 'anthropic',
      name: 'Anthropic',
      models: ['claude-sonnet-4-5'],
      auth: 'oauth'
    })
    expect(signedIn.auth).toBe('oauth')
    expect(signedIn.hasApiKey).toBe(false)

    // It survives a close and reopen like every other column.
    expect(database.repos.providers.get(signedIn.id).auth).toBe('oauth')

    // There is no `''` spelling of "clear": the way back is the other mode.
    expect(database.repos.providers.update(signedIn.id, { name: 'Renamed' }).auth).toBe('oauth')
    expect('auth' in database.repos.providers.update(signedIn.id, { auth: 'apiKey' })).toBe(true)
    expect(database.repos.providers.get(signedIn.id).auth).toBe('apiKey')
  })

  it('scopes every read by userId and throws not_found otherwise', () => {
    const mine = database.repos.providers.create(providerInput(), 'user-a')
    database.repos.providers.create(providerInput({ name: 'Theirs' }), 'user-b')

    expect(database.repos.providers.list('user-a').map((p) => p.id)).toEqual([mine.id])
    expect(database.repos.providers.list(LOCAL_USER_ID)).toEqual([])

    try {
      database.repos.providers.get(mine.id, 'user-b')
      expect.unreachable('reading another user record must fail')
    } catch (error) {
      expect(error).toBeInstanceOf(BackendFailure)
      expect((error as BackendFailure).code).toBe('not_found')
      expect((error as BackendFailure).toBackendError()).toEqual({
        code: 'not_found',
        message: `provider not found: ${mine.id}`
      })
    }
  })

  it('throws not_found when updating or deleting a missing provider', () => {
    expect(() => database.repos.providers.update('nope', { name: 'x' })).toThrowError(BackendFailure)
    expect(() => database.repos.providers.delete('nope')).toThrowError(BackendFailure)
    expect(() => database.repos.providers.getApiKeyCiphertext('nope')).toThrowError(BackendFailure)
  })
})
