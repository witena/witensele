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
      toolTimeoutMs: 90_000,
      permissionTimeoutMs: DEFAULT_APP_SETTINGS.timeouts.permissionTimeoutMs
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

  it('carries the first-run flag through a write, and defaults it for an old row', () => {
    // S7.5 added `onboardingDismissed` with no migration: reads merge the stored
    // object over the defaults, so a row written before it existed simply
    // answers `false` — which is the row the test above inserts.
    expect(database.repos.settings.get().onboardingDismissed).toBe(false)

    expect(database.repos.settings.update({ onboardingDismissed: true }).onboardingDismissed).toBe(
      true
    )
    expect(database.repos.settings.get().onboardingDismissed).toBe(true)
    // A later write of something else must not take the flag back off.
    expect(database.repos.settings.update({ language: 'en' }).onboardingDismissed).toBe(true)
  })

  it('stores an executor patch and merges it field by field, on write and on read', () => {
    // S5.15: the sandbox switch. A write of something else must not reset it,
    // and it has to survive a reopen — it is the setting that decides whether
    // a command may write outside the folder.
    const updated = database.repos.settings.update({ executor: { sandbox: 'off' } })
    expect(updated).toEqual({ ...DEFAULT_APP_SETTINGS, executor: { sandbox: 'off' } })

    expect(database.repos.settings.update({ language: 'en' }).executor).toEqual({ sandbox: 'off' })
    expect(database.repos.settings.update({ executor: {} }).executor).toEqual({ sandbox: 'off' })

    database.reopen()
    expect(database.repos.settings.get().executor).toEqual({ sandbox: 'off' })
  })

  it('defaults the executor group for a row that has none, or half of one', () => {
    database.handle.sqlite
      .prepare('INSERT INTO settings (user_id, data, updated_at) VALUES (?, ?, ?)')
      .run('local', JSON.stringify({ language: 'en', executor: {} }), Date.now())

    expect(database.repos.settings.get().executor).toEqual(DEFAULT_APP_SETTINGS.executor)
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
