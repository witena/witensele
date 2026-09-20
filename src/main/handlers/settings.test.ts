/**
 * `settings.*` — the row, and the one setting that is also a running thing.
 *
 * Most of this file is about `mcpEndpoint` (S10.3), because it is the first
 * setting whose write has a side effect: storing `enabled` and waiting for a
 * restart would be a switch that appears to do nothing, so `settings.update`
 * starts or stops `ctx.mcpEndpoint` afterwards. The host is a fake — whether a
 * socket really comes up is `mcp-endpoint/host.test.ts`'s question, and no
 * handler suite may open a port.
 *
 * The rest pins the two properties every other setting relies on: defaults
 * underneath a read, and a patch that merges rather than replaces.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_APP_SETTINGS } from '@shared/types'
import type { AppContext } from '../app-context'
import { createTestDatabase, type TestDatabase } from '../db/testing'
import type { McpEndpointHost } from '../mcp-endpoint/host'
import { createTestAppContext } from '../testing'
import { buildHandlers } from './index'

/** A host that records what it was asked to do and opens nothing. */
function fakeHost(): McpEndpointHost & { calls: string[] } {
  const calls: string[] = []
  let port: number | null = null
  return {
    calls,
    get state() {
      return port === null ? { listening: false as const } : { listening: true as const, port }
    },
    async start() {
      calls.push('start')
      port = 51_234
    },
    async stop() {
      calls.push('stop')
      port = null
    }
  }
}

describe('handlers/settings', () => {
  let database: TestDatabase
  let ctx: AppContext
  const handlers = buildHandlers()

  beforeEach(() => {
    database = createTestDatabase()
    ctx = createTestAppContext(database).ctx
  })

  afterEach(() => {
    ctx.close()
  })

  describe('settings.get', () => {
    it('answers the defaults for an installation that never wrote a row', async () => {
      await expect(handlers['settings.get'](ctx)).resolves.toEqual(DEFAULT_APP_SETTINGS)
    })

    it('leaves the MCP endpoint switched off', async () => {
      const settings = await handlers['settings.get'](ctx)
      expect(settings.mcpEndpoint).toEqual({ enabled: false })
    })

    it('fills in a group a row written by an older version does not have', async () => {
      // Exactly what an installation that predates S10.3 holds: every other
      // field, and no `mcpEndpoint` at all. It must not start listening because
      // the user updated.
      const { mcpEndpoint: _absent, ...older } = DEFAULT_APP_SETTINGS
      database.handle.db.run(
        `insert into settings (user_id, data, updated_at) values ('local', '${JSON.stringify({ ...older, theme: 'dark' })}', 1)`
      )

      const settings = await handlers['settings.get'](ctx)
      expect(settings.theme).toBe('dark')
      expect(settings.mcpEndpoint).toEqual({ enabled: false })
    })
  })

  describe('settings.update', () => {
    it('merges a patch over the stored row', async () => {
      await handlers['settings.update'](ctx, { patch: { theme: 'dark' } })
      const settings = await handlers['settings.update'](ctx, {
        patch: { mcpEndpoint: { enabled: true } }
      })

      expect(settings.theme).toBe('dark')
      expect(settings.mcpEndpoint).toEqual({ enabled: true })
      expect(settings.timeouts).toEqual(DEFAULT_APP_SETTINGS.timeouts)
      await expect(handlers['settings.get'](ctx)).resolves.toEqual(settings)
    })

    it('refuses a key it does not know', async () => {
      await expect(
        handlers['settings.update'](ctx, { patch: { nonsense: true } as never })
      ).rejects.toThrow(/unknown keys: nonsense/)
    })

    it('refuses an mcpEndpoint patch that is not the shape it claims', async () => {
      await expect(
        handlers['settings.update'](ctx, { patch: { mcpEndpoint: { enabled: 'yes' } as never } })
      ).rejects.toThrow(/mcpEndpoint.enabled must be a boolean/)
      await expect(
        handlers['settings.update'](ctx, { patch: { mcpEndpoint: true as never } })
      ).rejects.toThrow(/mcpEndpoint must be an object/)
      await expect(
        handlers['settings.update'](ctx, { patch: { mcpEndpoint: { port: 1 } as never } })
      ).rejects.toThrow(/mcpEndpoint received unknown keys: port/)

      // Refused before the write, so nothing was stored either.
      await expect(handlers['settings.get'](ctx)).resolves.toEqual(DEFAULT_APP_SETTINGS)
    })

    it('stores the switch on a context that has no endpoint to switch', async () => {
      // The Node host, and every other suite: `ctx.mcpEndpoint` is null, the row
      // is written, and nothing listens. The setting is not desktop-only; the
      // door is.
      expect(ctx.mcpEndpoint).toBeNull()

      const settings = await handlers['settings.update'](ctx, {
        patch: { mcpEndpoint: { enabled: true } }
      })
      expect(settings.mcpEndpoint.enabled).toBe(true)
    })

    it('starts and stops the host as the switch is thrown', async () => {
      const host = fakeHost()
      ctx.mcpEndpoint = host

      await handlers['settings.update'](ctx, { patch: { mcpEndpoint: { enabled: true } } })
      expect(host.calls).toEqual(['start'])
      expect(host.state).toEqual({ listening: true, port: 51_234 })

      await handlers['settings.update'](ctx, { patch: { mcpEndpoint: { enabled: false } } })
      expect(host.calls).toEqual(['start', 'stop'])
      expect(host.state).toEqual({ listening: false })
    })

    it('acts on the stored value, not on the patch', async () => {
      const host = fakeHost()
      ctx.mcpEndpoint = host
      await handlers['settings.update'](ctx, { patch: { mcpEndpoint: { enabled: true } } })
      host.calls.length = 0

      // A patch that carries the group but changes nothing in it still means
      // "make the process match the row" — which is `start`, because the row
      // says on.
      await handlers['settings.update'](ctx, { patch: { mcpEndpoint: {} } })
      expect(host.calls).toEqual(['start'])
    })

    it('leaves the host alone for a patch that is about something else', async () => {
      const host = fakeHost()
      ctx.mcpEndpoint = host

      await handlers['settings.update'](ctx, { patch: { theme: 'light' } })
      await handlers['settings.update'](ctx, { patch: { timeouts: { toolTimeoutMs: 1000 } } })

      expect(host.calls).toEqual([])
    })

    it('stores the setting even when the host refuses to start', async () => {
      // The user's intent is the row; whether a socket came up is a fact about
      // this launch, and `integrations.status` (WP-11) reports that from the
      // host. A rejection here would revert the switch in the UI while the row
      // said the opposite.
      ctx.mcpEndpoint = {
        get state() {
          return { listening: false as const }
        },
        start: () => Promise.reject(new Error('EADDRINUSE')),
        stop: () => Promise.resolve()
      }

      const settings = await handlers['settings.update'](ctx, {
        patch: { mcpEndpoint: { enabled: true } }
      })
      expect(settings.mcpEndpoint.enabled).toBe(true)
    })
  })
})
