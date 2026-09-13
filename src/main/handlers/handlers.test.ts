import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKEND_METHODS, type BackendMethod } from '@shared/backend'
import type { BackendEvent } from '@shared/events'
import { DEFAULT_APP_SETTINGS, LOCAL_USER_ID } from '@shared/types'
import type { AppContext } from '../app-context'
import { createEventBus } from '../events/bus'
import { createInsecureSecretStore } from '../secrets'
import { createTestDatabase, type TestDatabase } from '../db/testing'
import { buildHandlers } from './index'

/**
 * An `AppContext` backed by the S1.2 test fixture: a real temporary database
 * file, an in-process bus and the insecure secret store. Handlers take the
 * context as their first argument precisely so this is possible without electron.
 */
function createTestContext(database: TestDatabase): { ctx: AppContext; events: BackendEvent[] } {
  const bus = createEventBus()
  const events: BackendEvent[] = []
  bus.subscribe((event) => events.push(event))

  return {
    ctx: {
      db: database.handle,
      repos: database.repos,
      events: bus,
      secrets: createInsecureSecretStore(),
      userId: LOCAL_USER_ID,
      close: () => database.cleanup()
    },
    events
  }
}

describe('handlers/buildHandlers', () => {
  let database: TestDatabase
  let ctx: AppContext
  let events: BackendEvent[]
  const handlers = buildHandlers()

  beforeEach(() => {
    database = createTestDatabase()
    const created = createTestContext(database)
    ctx = created.ctx
    events = created.events
  })

  afterEach(() => {
    database.cleanup()
  })

  it('has an entry for every declared backend method', () => {
    const missing = BACKEND_METHODS.filter((method) => typeof handlers[method] !== 'function')

    expect(missing).toEqual([])
    expect(Object.keys(handlers).sort()).toEqual([...BACKEND_METHODS].sort())
  })

  it('rejects with internal and a pointer to STEPS.md for a method that is not implemented yet', async () => {
    const unimplemented: BackendMethod = 'chats.list'

    await expect(handlers[unimplemented](ctx)).rejects.toMatchObject({
      code: 'internal',
      message: 'Not implemented yet: chats.list (see docs/STEPS.md)'
    })
  })

  describe('system.ping', () => {
    it('answers pong', async () => {
      await expect(handlers['system.ping'](ctx)).resolves.toBe('pong')
    })
  })

  describe('system.emitTestEvent', () => {
    it('emits exactly one system.test event carrying the payload', async () => {
      await handlers['system.emitTestEvent'](ctx, { payload: 'hello-1' })

      expect(events).toEqual([{ type: 'system.test', payload: 'hello-1' }])
    })

    it('rejects a non-string payload with validation and emits nothing', async () => {
      await expect(
        handlers['system.emitTestEvent'](ctx, { payload: 42 } as unknown as { payload: string })
      ).rejects.toMatchObject({ code: 'validation' })

      expect(events).toEqual([])
    })
  })

  describe('settings.get / settings.update', () => {
    it('returns the defaults before anything was stored', async () => {
      await expect(handlers['settings.get'](ctx)).resolves.toEqual(DEFAULT_APP_SETTINGS)
    })

    it('merges a patch, persists it and returns the stored result', async () => {
      const updated = await handlers['settings.update'](ctx, { patch: { language: 'en' } })

      expect(updated).toEqual({ ...DEFAULT_APP_SETTINGS, language: 'en' })
      await expect(handlers['settings.get'](ctx)).resolves.toEqual(updated)
    })

    it('merges timeouts field by field', async () => {
      const updated = await handlers['settings.update'](ctx, {
        patch: { timeouts: { toolTimeoutMs: 1_000 } }
      })

      expect(updated.timeouts).toEqual({ ...DEFAULT_APP_SETTINGS.timeouts, toolTimeoutMs: 1_000 })
    })

    it('rejects a patch that is not an object', async () => {
      await expect(
        handlers['settings.update'](ctx, { patch: null as never })
      ).rejects.toMatchObject({ code: 'validation' })
    })

    it('rejects unknown keys instead of storing them', async () => {
      await expect(
        handlers['settings.update'](ctx, { patch: { nope: true } as never })
      ).rejects.toMatchObject({ code: 'validation' })

      await expect(handlers['settings.get'](ctx)).resolves.toEqual(DEFAULT_APP_SETTINGS)
    })

    it('scopes reads and writes to the context user', async () => {
      await handlers['settings.update'](ctx, { patch: { language: 'zh-CN' } })

      const other: AppContext = { ...ctx, userId: 'someone-else' }
      await expect(handlers['settings.get'](other)).resolves.toEqual(DEFAULT_APP_SETTINGS)
    })
  })
})

describe('handlers/stubs', () => {
  it('every unimplemented method rejects rather than resolving undefined', async () => {
    const handlers = buildHandlers()
    const implemented = new Set<BackendMethod>([
      'system.ping',
      'system.emitTestEvent',
      'settings.get',
      'settings.update'
    ])
    const ctx = { userId: LOCAL_USER_ID } as AppContext

    for (const method of BACKEND_METHODS) {
      if (implemented.has(method)) continue
      const call = handlers[method] as (context: AppContext, input?: unknown) => Promise<unknown>
      await expect(call(ctx, {})).rejects.toMatchObject({ code: 'internal' })
    }
  })
})

describe('handlers/secret store warning', () => {
  it('does not warn until a secret is actually handled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createInsecureSecretStore()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
