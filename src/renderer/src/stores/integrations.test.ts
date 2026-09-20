/**
 * The integrations store against a fake `BackendClient`.
 *
 * This file is where Connect, Disconnect and Repair are proved, and it has to
 * be: on the machine this suite runs on `claude` and `codex` are really
 * installed, so an end-to-end click on one of those buttons would write
 * `~/.claude.json` and `~/.codex/config.toml` — files that belong to whoever is
 * running the tests. `e2e/integrations.spec.ts` therefore launches the app with
 * both binaries overridden to a path that does not exist, and everything that
 * happens *after* a button is pressed is asserted here instead.
 *
 * Four things are worth proving and are hard to see by reading the store:
 *
 * - **Repair is `integrations.connect`.** The same method Connect calls; a store
 *   that invented a third method would silently do nothing on a moved app.
 * - **The switch and the settings row stay in step.** The toggle writes through
 *   the settings store — which is what starts and stops the host — and a
 *   successful `connect` re-reads it, because the handler flipped that row
 *   without the switch having been touched (WP-11).
 * - **The status answered by an action replaces the mirror**, so no card is
 *   drawn from the state it was in before the click.
 * - **Nothing rejects.** A refused Connect lands in the error trio that
 *   `translateFailure` turns into a sentence.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendClient, BackendMethod } from '@shared/backend'
import type { AppSettings, IdeClientStatus, IntegrationStatus } from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/types'
import { BackendClientError } from '../lib/backend'
import { resetBackend, setBackend } from '../lib/backend-provider'
import { useIntegrationsStore } from './integrations'
import { useSettingsStore } from './settings'

function client(overrides: Partial<IdeClientStatus> = {}): IdeClientStatus {
  return { id: 'claude-code', installed: true, connected: false, stale: false, ...overrides }
}

function status(overrides: Partial<IntegrationStatus> = {}): IntegrationStatus {
  return {
    endpoint: { enabled: false, listening: false },
    launcherPath: '/Applications/Witena.app/Contents/Resources/bin/witena-mcp',
    clients: [client(), client({ id: 'codex' })],
    ...overrides
  }
}

interface Call {
  method: BackendMethod
  input: unknown
}

interface FakeOptions {
  /** The answer to `integrations.status`, and the state the two actions mutate. */
  initial?: IntegrationStatus
  /** Thrown by whichever method names it. */
  fail?: { method: BackendMethod; error: Error }
}

/**
 * A backend that behaves like WP-11's: `connect` enables the endpoint and
 * registers, `disconnect` unregisters and leaves the endpoint alone, and both
 * answer with the whole status rather than a fragment.
 */
function fakeBackend(options: FakeOptions = {}): {
  client: BackendClient
  calls: Call[]
  settings: () => AppSettings
} {
  const calls: Call[] = []
  let current = options.initial ?? status()
  let settings: AppSettings = { ...DEFAULT_APP_SETTINGS }

  const withClient = (id: string, patch: Partial<IdeClientStatus>): IdeClientStatus[] =>
    current.clients.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry))

  const backend: BackendClient = {
    invoke: (async (method: BackendMethod, input: unknown) => {
      calls.push({ method, input })
      if (options.fail?.method === method) throw options.fail.error

      if (method === 'integrations.status') return current
      if (method === 'settings.get') return settings
      if (method === 'settings.update') {
        const patch = (input as { patch: { mcpEndpoint?: { enabled?: boolean } } }).patch
        const enabled = patch.mcpEndpoint?.enabled
        if (enabled !== undefined) {
          settings = { ...settings, mcpEndpoint: { enabled } }
          // The toggle is live: the host starts and stops with the row (WP-7).
          current = { ...current, endpoint: { enabled, listening: enabled, port: 51789 } }
        }
        return settings
      }
      if (method === 'integrations.connect') {
        const id = (input as { client: string }).client
        settings = { ...settings, mcpEndpoint: { enabled: true } }
        current = {
          ...current,
          endpoint: { enabled: true, listening: true, port: 51789 },
          clients: withClient(id, {
            connected: true,
            stale: false,
            command: current.launcherPath ?? ''
          })
        }
        return current
      }
      if (method === 'integrations.disconnect') {
        const id = (input as { client: string }).client
        current = {
          ...current,
          // `command` is dropped rather than set to `undefined`: the contract
          // omits the field for a client with nothing registered.
          clients: current.clients.map((entry) =>
            entry.id === id
              ? { id: entry.id, installed: entry.installed, connected: false, stale: false }
              : entry
          )
        }
        return current
      }
      throw new Error(`unexpected method: ${method}`)
    }) as BackendClient['invoke'],
    subscribe: () => () => undefined
  }

  return { client: backend, calls, settings: () => settings }
}

const methods = (calls: Call[]): BackendMethod[] => calls.map((call) => call.method)

beforeEach(() => {
  useIntegrationsStore.setState({
    status: null,
    loadStatus: 'idle',
    busyClient: null,
    togglingEndpoint: false,
    error: undefined,
    errorCode: undefined,
    errorDetails: undefined
  })
  useSettingsStore.setState({ settings: null, status: 'idle', error: undefined })
})

afterEach(() => {
  resetBackend()
})

describe('load', () => {
  it('mirrors the whole picture in one call', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)

    await useIntegrationsStore.getState().load()

    const state = useIntegrationsStore.getState()
    expect(state.loadStatus).toBe('ready')
    expect(state.status?.clients).toHaveLength(2)
    expect(state.status?.launcherPath).toContain('witena-mcp')
    expect(methods(backend.calls)).toEqual(['integrations.status'])
  })

  it('keeps a failed read as state rather than rejecting', async () => {
    setBackend(
      fakeBackend({
        fail: {
          method: 'integrations.status',
          error: new BackendClientError({ code: 'internal', message: 'no context' })
        }
      }).client
    )

    await expect(useIntegrationsStore.getState().load()).resolves.toBeUndefined()

    const state = useIntegrationsStore.getState()
    expect(state.loadStatus).toBe('error')
    expect(state.errorCode).toBe('internal')
    expect(state.error).toBe('no context')
  })
})

describe('setEndpointEnabled', () => {
  it('writes the row through the settings store and re-reads the status', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)
    await useIntegrationsStore.getState().load()

    await useIntegrationsStore.getState().setEndpointEnabled(true)

    // The order matters: the write is what starts the host, and `listening` is
    // only knowable afterwards.
    expect(methods(backend.calls)).toEqual([
      'integrations.status',
      'settings.update',
      'integrations.status'
    ])
    expect(backend.calls[1]?.input).toEqual({ patch: { mcpEndpoint: { enabled: true } } })
    expect(useIntegrationsStore.getState().status?.endpoint).toEqual({
      enabled: true,
      listening: true,
      port: 51789
    })
    // The app-wide mirror of the row followed.
    expect(useSettingsStore.getState().settings?.mcpEndpoint.enabled).toBe(true)
    expect(useIntegrationsStore.getState().togglingEndpoint).toBe(false)
  })

  it('closes the door again', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)
    await useIntegrationsStore.getState().setEndpointEnabled(true)

    await useIntegrationsStore.getState().setEndpointEnabled(false)

    expect(useIntegrationsStore.getState().status?.endpoint.enabled).toBe(false)
    expect(useIntegrationsStore.getState().status?.endpoint.listening).toBe(false)
    expect(useSettingsStore.getState().settings?.mcpEndpoint.enabled).toBe(false)
  })

  it('records a refused write and clears the in-flight flag', async () => {
    setBackend(
      fakeBackend({
        fail: {
          method: 'settings.update',
          error: new BackendClientError({ code: 'internal', message: 'disk is full' })
        }
      }).client
    )

    await expect(useIntegrationsStore.getState().setEndpointEnabled(true)).resolves.toBeUndefined()

    expect(useIntegrationsStore.getState().error).toBe('disk is full')
    expect(useIntegrationsStore.getState().togglingEndpoint).toBe(false)
  })
})

describe('connect', () => {
  it('registers the client and replaces the mirror with the answer', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)
    await useIntegrationsStore.getState().load()

    await useIntegrationsStore.getState().connect('codex')

    expect(backend.calls[1]).toEqual({
      method: 'integrations.connect',
      input: { client: 'codex' }
    })
    const codex = useIntegrationsStore.getState().status?.clients.find((one) => one.id === 'codex')
    expect(codex?.connected).toBe(true)
    expect(codex?.stale).toBe(false)
    expect(useIntegrationsStore.getState().busyClient).toBeNull()
  })

  it('follows the endpoint the handler switched on behind the switch', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)
    await useIntegrationsStore.getState().load()
    expect(useIntegrationsStore.getState().status?.endpoint.enabled).toBe(false)

    await useIntegrationsStore.getState().connect('claude-code')

    // Both mirrors: the one the switch is drawn from, and the app-wide row the
    // rest of the app reads. `connect` enables the endpoint server-side, so a
    // section that trusted its old copy would draw an off switch over an open
    // door.
    expect(useIntegrationsStore.getState().status?.endpoint.enabled).toBe(true)
    expect(useSettingsStore.getState().settings?.mcpEndpoint.enabled).toBe(true)
    expect(methods(backend.calls)).toEqual([
      'integrations.status',
      'integrations.connect',
      'settings.get'
    ])
  })

  it('repairs a stale registration with the very same call', async () => {
    const backend = fakeBackend({
      initial: status({
        clients: [
          client({ connected: true, stale: true, command: '/Volumes/Old/Witena.app/bin/witena-mcp' }),
          client({ id: 'codex' })
        ]
      })
    })
    setBackend(backend.client)
    await useIntegrationsStore.getState().load()

    await useIntegrationsStore.getState().connect('claude-code')

    expect(methods(backend.calls)).toContain('integrations.connect')
    const claude = useIntegrationsStore
      .getState()
      .status?.clients.find((one) => one.id === 'claude-code')
    expect(claude?.stale).toBe(false)
    expect(claude?.command).toBe('/Applications/Witena.app/Contents/Resources/bin/witena-mcp')
  })

  it('keeps the refusal of a build that ships no launcher as a reason', async () => {
    setBackend(
      fakeBackend({
        initial: status({ launcherPath: null }),
        fail: {
          method: 'integrations.connect',
          error: new BackendClientError({
            code: 'validation',
            message: 'this build ships no MCP launcher',
            details: { reason: 'integrations_no_launcher' }
          })
        }
      }).client
    )

    await expect(useIntegrationsStore.getState().connect('claude-code')).resolves.toBeUndefined()

    const state = useIntegrationsStore.getState()
    expect(state.errorCode).toBe('validation')
    // The identifier `translateFailure` needs to write the narrower sentence.
    expect(state.errorDetails).toEqual({ reason: 'integrations_no_launcher' })
    expect(state.busyClient).toBeNull()
  })

  it('keeps a CLI that ran and refused as internal, with its own words', async () => {
    setBackend(
      fakeBackend({
        fail: {
          method: 'integrations.connect',
          error: new BackendClientError({
            code: 'internal',
            message: 'claude mcp add witena exited 1: already exists'
          })
        }
      }).client
    )

    await useIntegrationsStore.getState().connect('claude-code')

    // `internal` is the sentence and the CLI's words are the dimmed detail line;
    // this store keeps them apart so the section can draw them apart.
    expect(useIntegrationsStore.getState().errorCode).toBe('internal')
    expect(useIntegrationsStore.getState().error).toContain('already exists')
    expect(useIntegrationsStore.getState().errorDetails).toBeUndefined()
  })
})

describe('disconnect', () => {
  it('removes the registration and leaves the endpoint listening', async () => {
    const backend = fakeBackend()
    setBackend(backend.client)
    await useIntegrationsStore.getState().setEndpointEnabled(true)
    await useIntegrationsStore.getState().connect('claude-code')

    await useIntegrationsStore.getState().disconnect('claude-code')

    const claude = useIntegrationsStore
      .getState()
      .status?.clients.find((one) => one.id === 'claude-code')
    expect(claude?.connected).toBe(false)
    // The switch is how the user closes the door; Disconnect is not (WP-11).
    expect(useIntegrationsStore.getState().status?.endpoint.enabled).toBe(true)
    // And no settings read: the row cannot have changed.
    expect(methods(backend.calls).filter((one) => one === 'settings.get')).toHaveLength(1)
  })

  it('records a client that disappeared between the read and the click', async () => {
    setBackend(
      fakeBackend({
        fail: {
          method: 'integrations.disconnect',
          error: new BackendClientError({
            code: 'validation',
            message: 'codex is not installed on this machine',
            details: { reason: 'integrations_client_not_installed' }
          })
        }
      }).client
    )

    await useIntegrationsStore.getState().disconnect('codex')

    expect(useIntegrationsStore.getState().errorDetails).toEqual({
      reason: 'integrations_client_not_installed'
    })
    expect(useIntegrationsStore.getState().busyClient).toBeNull()
  })
})
