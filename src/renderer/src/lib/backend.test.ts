import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '@shared/events'
import {
  BackendClientError,
  createElectronBackendClient,
  type InvokeResponse,
  type WitenaBridge
} from './backend'

type Call = { method: string; input: unknown }

/**
 * A stand-in for the preload bridge.
 *
 * The client is the layer that decodes the envelope and fans events out, so it
 * can be tested without electron, a window or a real main process — which is the
 * whole point of keeping preload dumb.
 */
function fakeBridge(respond: (call: Call) => InvokeResponse): {
  bridge: WitenaBridge
  calls: Call[]
  listenerCount: () => number
  push: (event: BackendEvent) => void
} {
  const calls: Call[] = []
  const listeners = new Set<(event: BackendEvent) => void>()

  return {
    calls,
    listenerCount: () => listeners.size,
    push: (event) => {
      for (const listener of [...listeners]) listener(event)
    },
    bridge: {
      async invoke(method, input) {
        const call = { method, input }
        calls.push(call)
        return respond(call)
      },
      onEvent(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    }
  }
}

const ok = (value: unknown): InvokeResponse => ({ ok: true, value })

describe('lib/backend invoke', () => {
  it('resolves with the value inside the envelope', async () => {
    const { bridge } = fakeBridge(() => ok('pong'))
    const client = createElectronBackendClient(bridge)

    await expect(client.invoke('system.ping')).resolves.toBe('pong')
  })

  it('forwards the single object argument as the input', async () => {
    const { bridge, calls } = fakeBridge(() => ok(undefined))
    const client = createElectronBackendClient(bridge)

    await client.invoke('system.emitTestEvent', { payload: 'hello-1' })

    expect(calls).toEqual([{ method: 'system.emitTestEvent', input: { payload: 'hello-1' } }])
  })

  it('sends undefined as the input for an argument-free method', async () => {
    const { bridge, calls } = fakeBridge(() => ok('pong'))
    const client = createElectronBackendClient(bridge)

    await client.invoke('system.ping')

    expect(calls).toEqual([{ method: 'system.ping', input: undefined }])
  })

  it('rejects with a BackendClientError carrying the code and details', async () => {
    const { bridge } = fakeBridge(() => ({
      ok: false,
      error: { code: 'not_found', message: 'chat not found: 42', details: { id: '42' } }
    }))
    const client = createElectronBackendClient(bridge)

    const rejection = client.invoke('chats.get', { id: '42' })

    await expect(rejection).rejects.toBeInstanceOf(BackendClientError)
    await expect(rejection).rejects.toMatchObject({
      name: 'BackendClientError',
      code: 'not_found',
      message: 'chat not found: 42',
      details: { id: '42' }
    })
  })

  it('leaves details undefined when the error carried none', async () => {
    const { bridge } = fakeBridge(() => ({
      ok: false,
      error: { code: 'validation', message: 'bad input' }
    }))
    const client = createElectronBackendClient(bridge)

    const error = await client.invoke('settings.update', { patch: {} }).catch((cause) => cause)

    expect(error).toBeInstanceOf(BackendClientError)
    expect((error as BackendClientError).details).toBeUndefined()
  })

  it('rejects with internal when the bridge answers something that is not an envelope', async () => {
    const { bridge } = fakeBridge(() => 'nonsense' as unknown as InvokeResponse)
    const client = createElectronBackendClient(bridge)

    await expect(client.invoke('system.ping')).rejects.toMatchObject({ code: 'internal' })
  })
})

describe('lib/backend subscribe', () => {
  const event: BackendEvent = { type: 'system.test', payload: 'hello-1' }

  it('delivers every event and unsubscribes through the returned function', () => {
    const { bridge, push, listenerCount } = fakeBridge(() => ok(undefined))
    const client = createElectronBackendClient(bridge)
    const listener = vi.fn()

    const unsubscribe = client.subscribe(listener)
    push(event)
    expect(listener).toHaveBeenCalledWith(event)

    unsubscribe()
    push(event)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listenerCount()).toBe(0)
  })

  it('subscribeTo delivers only the matching event type', () => {
    const { bridge, push } = fakeBridge(() => ok(undefined))
    const client = createElectronBackendClient(bridge)
    const listener = vi.fn()

    const unsubscribe = client.subscribeTo('system.test', listener)

    push({ type: 'chat.deleted', chatId: 'c1' })
    push(event)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(event)

    unsubscribe()
    push(event)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('two subscribers are independent', () => {
    const { bridge, push, listenerCount } = fakeBridge(() => ok(undefined))
    const client = createElectronBackendClient(bridge)
    const first = vi.fn()
    const second = vi.fn()

    const stopFirst = client.subscribe(first)
    client.subscribe(second)
    expect(listenerCount()).toBe(2)

    stopFirst()
    push(event)

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
