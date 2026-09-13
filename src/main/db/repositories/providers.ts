/**
 * Provider records.
 *
 * The API key is the reason this repository is more than CRUD. The database
 * stores **ciphertext only**, in `providers.api_key_encrypted`, and the mapping
 * to `Provider` reports nothing but `hasApiKey`. Encryption itself is injected as
 * an `encrypt(plain)` callback, so the repository never imports electron's
 * `safeStorage` and stays testable; decryption is deliberately *not* here — the
 * main process reads the ciphertext through `getApiKeyCiphertext()` and decrypts
 * it right before constructing a model client.
 */
import { and, asc, eq } from 'drizzle-orm'
import type { Provider, ProviderInput, UserId } from '@shared/types'
import { LOCAL_USER_ID } from '@shared/types'
import type { DrizzleDb } from '../database'
import type { ProviderRow } from '../schema'
import { providers } from '../schema'
import { notFound } from '../../errors'
import { newId, now, nullable, optional } from './common'

/** Turns a plaintext API key into the ciphertext stored in the database. */
export type Encrypt = (plain: string) => string

export interface ProviderRepository {
  list(userId?: UserId): Provider[]
  get(id: string, userId?: UserId): Provider
  create(input: ProviderInput, userId?: UserId): Provider
  /**
   * Patch semantics for `apiKey`: absent keeps the stored key, `''` clears it,
   * any other string replaces it with `encrypt(value)`. `baseUrl` and `presetId`
   * follow the same shape, with `''` meaning "clear". `auth` is a union and has
   * no "clear" spelling: absent keeps it, `'apiKey'` puts it back.
   */
  update(id: string, patch: Partial<ProviderInput>, userId?: UserId): Provider
  delete(id: string, userId?: UserId): void
  /**
   * The stored ciphertext, or `null` when no key is set. The only way a key ever
   * leaves this layer, and the caller must be the main process, never the renderer.
   */
  getApiKeyCiphertext(id: string, userId?: UserId): string | null
}

function toProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    userId: row.userId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    type: row.type,
    name: row.name,
    ...optional('baseUrl', row.baseUrl),
    ...optional('presetId', row.presetId),
    models: row.models,
    hasApiKey: row.apiKeyEncrypted !== null && row.apiKeyEncrypted.length > 0,
    ...optional('auth', row.auth)
  }
}

export function createProviderRepository(db: DrizzleDb, encrypt: Encrypt): ProviderRepository {
  function row(id: string, userId: UserId): ProviderRow {
    const found = db
      .select()
      .from(providers)
      .where(and(eq(providers.id, id), eq(providers.userId, userId)))
      .get()
    if (!found) throw notFound('provider', id)
    return found
  }

  return {
    list(userId = LOCAL_USER_ID) {
      return db
        .select()
        .from(providers)
        .where(eq(providers.userId, userId))
        .orderBy(asc(providers.createdAt))
        .all()
        .map(toProvider)
    },

    get(id, userId = LOCAL_USER_ID) {
      return toProvider(row(id, userId))
    },

    create(input, userId = LOCAL_USER_ID) {
      const timestamp = now()
      const inserted: ProviderRow = {
        id: newId(),
        userId,
        type: input.type,
        name: input.name,
        baseUrl: nullable(input.baseUrl),
        presetId: nullable(input.presetId),
        models: input.models,
        apiKeyEncrypted: input.apiKey ? encrypt(input.apiKey) : null,
        auth: nullable(input.auth),
        createdAt: timestamp,
        updatedAt: timestamp
      }
      db.insert(providers).values(inserted).run()
      return toProvider(inserted)
    },

    update(id, patch, userId = LOCAL_USER_ID) {
      const current = row(id, userId)
      const next: Partial<ProviderRow> = { updatedAt: now() }
      if (patch.type !== undefined) next.type = patch.type
      if (patch.name !== undefined) next.name = patch.name
      if (patch.models !== undefined) next.models = patch.models
      if (patch.baseUrl !== undefined) next.baseUrl = patch.baseUrl === '' ? null : patch.baseUrl
      if (patch.presetId !== undefined) next.presetId = patch.presetId === '' ? null : patch.presetId
      // `auth` is a closed union, so there is no `''` spelling of "clear it":
      // the way back to key authentication is `auth: 'apiKey'`, which is what
      // the editor's control sends.
      if (patch.auth !== undefined) next.auth = patch.auth
      if (patch.apiKey !== undefined) {
        next.apiKeyEncrypted = patch.apiKey === '' ? null : encrypt(patch.apiKey)
      }
      db.update(providers).set(next).where(eq(providers.id, current.id)).run()
      return toProvider(row(id, userId))
    },

    delete(id, userId = LOCAL_USER_ID) {
      const current = row(id, userId)
      db.delete(providers).where(eq(providers.id, current.id)).run()
    },

    getApiKeyCiphertext(id, userId = LOCAL_USER_ID) {
      return row(id, userId).apiKeyEncrypted
    }
  }
}
