import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_APP_SETTINGS } from '@shared/types'
import { createTestDatabase, type TestDatabase } from './testing'

describe('db/repositories/settings', () => {
  let database: TestDatabase

  beforeEach(() => {
    database = createTestDatabase()
  })

  afterEach(() => {
    database.cleanup()
  })

  it('returns the defaults when nothing has been stored', () => {
    expect(database.repos.settings.get()).toEqual(DEFAULT_APP_SETTINGS)
  })

  it('merges a patch shallowly and persists it', () => {
    const updated = database.repos.settings.update({ language: 'zh-CN' })

    expect(updated).toEqual({ ...DEFAULT_APP_SETTINGS, language: 'zh-CN' })
    expect(database.repos.settings.get()).toEqual(updated)

    database.reopen()
    expect(database.repos.settings.get()).toEqual(updated)
  })

  it('merges timeouts field by field', () => {
    database.repos.settings.update({ timeouts: { stallTimeoutMs: 5_000 } })
    const updated = database.repos.settings.update({ timeouts: { toolTimeoutMs: 90_000 } })

    expect(updated.timeouts).toEqual({
      stallTimeoutMs: 5_000,
      hardTimeoutMs: DEFAULT_APP_SETTINGS.timeouts.hardTimeoutMs,
      toolTimeoutMs: 90_000
    })
  })

  it('fills in defaults for a setting that is missing from a stored row', () => {
    // Simulates a row written by an older version that did not know about timeouts.
    database.handle.sqlite
      .prepare('INSERT INTO settings (user_id, data, updated_at) VALUES (?, ?, ?)')
      .run('local', JSON.stringify({ language: 'en' }), Date.now())

    expect(database.repos.settings.get()).toEqual({
      ...DEFAULT_APP_SETTINGS,
      language: 'en'
    })
  })

  it('keeps one row per user', () => {
    database.repos.settings.update({ language: 'en' }, 'user-a')
    database.repos.settings.update({ language: 'zh-CN' }, 'user-b')

    expect(database.repos.settings.get('user-a').language).toBe('en')
    expect(database.repos.settings.get('user-b').language).toBe('zh-CN')
    expect(database.repos.settings.get()).toEqual(DEFAULT_APP_SETTINGS)

    const rows = database.handle.sqlite.prepare('SELECT user_id FROM settings').all()
    expect(rows).toHaveLength(2)
  })
})
