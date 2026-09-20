/**
 * `integrations.*` against a fake `IdeClients` (S10.4).
 *
 * The handlers hold the policy — what "connected" and "stale" mean, that
 * connecting opens the door, that a repair is a removal and an addition — and
 * the fake below is what lets every one of those be asserted without a coding
 * agent on the machine. The real CLI vectors are
 * `../integrations/ide-clients.test.ts`; **no test in this suite may run a real
 * `claude` or `codex`**, because `mcp add` and `mcp remove` write files that
 * belong to whoever is running the suite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_APP_SETTINGS, type IdeClientId } from '@shared/types'
import type { AppContext } from '../app-context'
import { createTestDatabase, type TestDatabase } from '../db/testing'
import type { IdeClients } from '../integrations/ide-clients'
import { createTestAppContext } from '../testing'
import { buildHandlers } from './index'

const LAUNCHER = '/Applications/Witena.app/Contents/Resources/bin/witena-mcp'
const OLD_LAUNCHER = '/Volumes/Old Disk/Witena.app/Contents/Resources/bin/witena-mcp'

interface FakeIdeClients extends IdeClients {
  /** Every method call, in order, as `<method>:<client>[:<command>]`. */
  calls: string[]
  /** What each client currently has registered; mutated by register/unregister. */
  commands: Partial<Record<IdeClientId, string>>
}

/**
 * An `IdeClients` that remembers what it was told.
 *
 * It is stateful rather than canned because the two interesting handler paths
 * are sequences: connect must *not* re-register a client that is already right,
 * and must remove before adding when it is wrong.
 */
function fakeIdeClients(options: {
  installed?: IdeClientId[]
  registered?: Partial<Record<IdeClientId, string>>
  failOn?: 'register' | 'unregister'
}): FakeIdeClients {
  const installed = new Set(options.installed ?? [])
  const commands: Partial<Record<IdeClientId, string>> = { ...options.registered }
  const calls: string[] = []

  return {
    calls,
    commands,
    detect: (id) => {
      calls.push(`detect:${id}`)
      return Promise.resolve(installed.has(id))
    },
    registered: (id) => {
      calls.push(`registered:${id}`)
      return Promise.resolve(commands[id] ?? null)
    },
    register: (id, command) => {
      calls.push(`register:${id}:${command}`)
      if (options.failOn === 'register') return Promise.reject(new Error('CLI said no'))
      commands[id] = command
      return Promise.resolve()
    },
    unregister: (id) => {
      calls.push(`unregister:${id}`)
      if (options.failOn === 'unregister') return Promise.reject(new Error('CLI said no'))
      delete commands[id]
      return Promise.resolve()
    }
  }
}

describe('integrations.*', () => {
  const handlers = buildHandlers()
  let database: TestDatabase
  let ctx: AppContext
  let ide: FakeIdeClients

  /**
   * A context with a launcher and the given client state.
   *
   * It replaces the one `beforeEach` built, and the old one is stopped first:
   * two contexts over one database would leave a second `AgentSupervisor`
   * ticking against a handle the first one's `close()` is about to release.
   */
  function withClients(
    options: Parameters<typeof fakeIdeClients>[0],
    launcherPath: string | null = LAUNCHER
  ): AppContext {
    ctx.supervisor.stop()
    ide = fakeIdeClients(options)
    ctx = createTestAppContext(database, { ideClients: ide, mcpLauncherPath: launcherPath }).ctx
    return ctx
  }

  beforeEach(() => {
    database = createTestDatabase()
    // Replaced by `withClients` in every case but the last describe block, which
    // is about this default context on purpose.
    ctx = createTestAppContext(database).ctx
  })

  afterEach(() => {
    ctx.close()
  })

  describe('integrations.status', () => {
    it('reports a machine with neither client installed, and asks nothing more of them', async () => {
      const context = withClients({})

      await expect(handlers['integrations.status'](context)).resolves.toEqual({
        endpoint: { enabled: false, listening: false },
        launcherPath: LAUNCHER,
        clients: [
          { id: 'claude-code', installed: false, connected: false, stale: false },
          { id: 'codex', installed: false, connected: false, stale: false }
        ]
      })

      // A client that is not there is asked once and then left alone: every read
      // is a child process, and the settings page asks on every mount.
      expect(ide.calls).toEqual(['detect:claude-code', 'detect:codex'])
    })

    it('separates installed from connected', async () => {
      const context = withClients({
        installed: ['claude-code', 'codex'],
        registered: { 'claude-code': LAUNCHER }
      })

      const status = await handlers['integrations.status'](context)

      expect(status.clients).toEqual([
        { id: 'claude-code', installed: true, connected: true, command: LAUNCHER, stale: false },
        { id: 'codex', installed: true, connected: false, stale: false }
      ])
    })

    it('flags a registration that names another installation as stale', async () => {
      const context = withClients({
        installed: ['codex'],
        registered: { codex: OLD_LAUNCHER }
      })

      const status = await handlers['integrations.status'](context)

      expect(status.clients[1]).toEqual({
        id: 'codex',
        installed: true,
        connected: true,
        command: OLD_LAUNCHER,
        stale: true
      })
    })

    it('never calls a hand-written command stale in a build that ships no launcher', async () => {
      // A checkout has nothing to compare against, and offering a Repair that
      // could only fail would be worse than saying nothing.
      const context = withClients(
        { installed: ['claude-code'], registered: { 'claude-code': 'node /repo/witena-mcp.cjs' } },
        null
      )

      const status = await handlers['integrations.status'](context)

      expect(status.launcherPath).toBeNull()
      expect(status.clients[0]).toMatchObject({ connected: true, stale: false })
    })

    it('reports the stored switch and the listening socket separately', async () => {
      const context = withClients({})

      // `ctx.mcpEndpoint` is null in every test and on the Node host, so this is
      // the honest disagreement the two fields exist for: the user asked for the
      // door to be open, and nothing in this process is listening.
      await handlers['settings.update'](context, { patch: { mcpEndpoint: { enabled: true } } })

      await expect(handlers['integrations.status'](context)).resolves.toMatchObject({
        endpoint: { enabled: true, listening: false }
      })
    })

    it('never rejects for any of the states the section draws', async () => {
      const context = withClients({ installed: ['claude-code'] })
      await expect(handlers['integrations.status'](context)).resolves.toBeDefined()
    })
  })

  describe('integrations.connect', () => {
    it('opens the endpoint and registers the launcher', async () => {
      const context = withClients({ installed: ['claude-code'] })

      const status = await handlers['integrations.connect'](context, { client: 'claude-code' })

      expect(status.endpoint.enabled).toBe(true)
      expect(status.clients[0]).toEqual({
        id: 'claude-code',
        installed: true,
        connected: true,
        command: LAUNCHER,
        stale: false
      })
      // The setting is stored, not only reported: an IDE pointed at a door that
      // closes again on the next launch is not connected.
      expect(context.repos.settings.get(context.userId).mcpEndpoint.enabled).toBe(true)
      expect(ide.calls).toContain(`register:claude-code:${LAUNCHER}`)
    })

    it('enables the endpoint before it registers anything', async () => {
      const context = withClients({ installed: ['codex'] })
      const order: string[] = []
      const settings = context.repos.settings
      const spy: AppContext = {
        ...context,
        repos: {
          ...context.repos,
          settings: {
            ...settings,
            update: (patch, userId) => {
              order.push('settings')
              return settings.update(patch, userId)
            }
          }
        }
      }
      ide.register = (id, command) => {
        order.push('register')
        ide.commands[id] = command
        return Promise.resolve()
      }

      await handlers['integrations.connect'](spy, { client: 'codex' })

      expect(order).toEqual(['settings', 'register'])
    })

    it('is idempotent: a client already pointed at this launcher is left alone', async () => {
      const context = withClients({
        installed: ['codex'],
        registered: { codex: LAUNCHER }
      })

      await handlers['integrations.connect'](context, { client: 'codex' })

      // `mcp add` over an existing name is an error in both CLIs, so the right
      // answer to "already correct" is to do nothing at all.
      expect(ide.calls.filter((call) => call.startsWith('register:'))).toEqual([])
      expect(ide.calls.filter((call) => call.startsWith('unregister:'))).toEqual([])
    })

    it('repairs a stale registration by removing it and adding it again', async () => {
      const context = withClients({
        installed: ['claude-code'],
        registered: { 'claude-code': OLD_LAUNCHER }
      })

      const status = await handlers['integrations.connect'](context, { client: 'claude-code' })

      expect(ide.calls).toEqual([
        'detect:claude-code',
        'registered:claude-code',
        'unregister:claude-code',
        `register:claude-code:${LAUNCHER}`,
        // The status read that builds the answer.
        'detect:claude-code',
        'registered:claude-code',
        'detect:codex'
      ])
      expect(status.clients[0]).toMatchObject({ command: LAUNCHER, stale: false })
    })

    it('refuses in a build that ships no launcher, and touches nothing', async () => {
      const context = withClients({ installed: ['claude-code'] }, null)

      await expect(
        handlers['integrations.connect'](context, { client: 'claude-code' })
      ).rejects.toMatchObject({
        code: 'validation',
        details: { reason: 'integrations_no_launcher' }
      })

      expect(ide.calls).toEqual([])
      expect(context.repos.settings.get(context.userId).mcpEndpoint.enabled).toBe(false)
    })

    it('refuses a client that is not installed, before opening the endpoint', async () => {
      const context = withClients({ installed: ['claude-code'] })

      await expect(
        handlers['integrations.connect'](context, { client: 'codex' })
      ).rejects.toMatchObject({
        code: 'validation',
        details: { reason: 'integrations_client_not_installed', client: 'codex' }
      })

      // Nothing was switched on for a connection that could not be made.
      expect(context.repos.settings.get(context.userId).mcpEndpoint.enabled).toBe(false)
    })

    it('refuses a client id it does not know', async () => {
      const context = withClients({})

      for (const client of ['cursor', '', undefined]) {
        await expect(
          handlers['integrations.connect'](context, { client } as never)
        ).rejects.toMatchObject({ code: 'validation' })
      }
    })

    it('lets a CLI that refused surface rather than reporting a connection', async () => {
      const context = withClients({ installed: ['codex'], failOn: 'register' })

      await expect(handlers['integrations.connect'](context, { client: 'codex' })).rejects.toThrow(
        'CLI said no'
      )
    })
  })

  describe('integrations.disconnect', () => {
    it('removes the registration and leaves the endpoint listening', async () => {
      const context = withClients({ installed: ['codex'], registered: { codex: LAUNCHER } })
      await handlers['settings.update'](context, { patch: { mcpEndpoint: { enabled: true } } })

      const status = await handlers['integrations.disconnect'](context, { client: 'codex' })

      expect(ide.calls).toContain('unregister:codex')
      expect(status.clients[1]).toEqual({ id: 'codex', installed: true, connected: false, stale: false })
      // Another client, or a hand-written configuration, may still be pointed at
      // the endpoint; the switch is how the user closes it.
      expect(status.endpoint.enabled).toBe(true)
    })

    it('is idempotent when nothing is registered', async () => {
      const context = withClients({ installed: ['codex'] })

      await expect(
        handlers['integrations.disconnect'](context, { client: 'codex' })
      ).resolves.toMatchObject({ launcherPath: LAUNCHER })

      expect(ide.calls.filter((call) => call.startsWith('unregister:'))).toEqual([])
    })

    it('refuses a client that is not installed', async () => {
      const context = withClients({})

      await expect(
        handlers['integrations.disconnect'](context, { client: 'claude-code' })
      ).rejects.toMatchObject({
        code: 'validation',
        details: { reason: 'integrations_client_not_installed' }
      })
    })
  })

  describe('the default context', () => {
    it('reaches no coding agent at all, which is what the Node host and every other suite get', async () => {
      // `createTestAppContext` injects `absentIdeClients()` on purpose: a suite
      // that spawned the developer's own `claude` would be a suite whose result
      // depended on whose machine it ran on — and `connect` would write their
      // `~/.claude.json`.
      const status = await handlers['integrations.status'](ctx)

      expect(status).toEqual({
        endpoint: { enabled: DEFAULT_APP_SETTINGS.mcpEndpoint.enabled, listening: false },
        launcherPath: null,
        clients: [
          { id: 'claude-code', installed: false, connected: false, stale: false },
          { id: 'codex', installed: false, connected: false, stale: false }
        ]
      })
      await expect(
        handlers['integrations.connect'](ctx, { client: 'claude-code' })
      ).rejects.toMatchObject({ details: { reason: 'integrations_no_launcher' } })
    })
  })
})
