/**
 * The updates store: the mirror, the two events and the dismissal rule.
 *
 * The behaviour worth pinning is the one the backend cannot enforce — that a
 * notice bar waved away stays away for *that version* and comes back for the
 * next one. Everything else is the shape every other store here has: the backend
 * owns the data, a failed call is not allowed to break a screen.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendClient, BackendMethod } from '@shared/backend'
import { IDLE_UPDATE_STATUS, type UpdateStatus } from '@shared/updates'
import { applyBackendEvent } from '../lib/event-bridge'
import { resetBackend, setBackend } from '../lib/backend-provider'
import { updateReadyVersion, useUpdatesStore } from './updates'

interface Call {
  method: BackendMethod
}

function fakeBackend(answers: Partial<Record<BackendMethod, unknown>>, failure?: Error): Call[] {
  const calls: Call[] = []
  setBackend({
    invoke: (async (method: BackendMethod) => {
      calls.push({ method })
      if (failure) throw failure
      return answers[method]
    }) as BackendClient['invoke'],
    subscribe: () => () => {}
  })
  return calls
}

/** What the bar would be showing, evaluated outside React. */
function readyVersion(): string | null {
  const { status, dismissedVersion } = useUpdatesStore.getState()
  return updateReadyVersion(status, dismissedVersion)
}

beforeEach(() => {
  useUpdatesStore.setState({
    status: IDLE_UPDATE_STATUS,
    checking: false,
    dismissedVersion: null
  })
})

afterEach(() => {
  resetBackend()
})

describe('updates store', () => {
  it('mirrors what the backend reports', async () => {
    const status: UpdateStatus = { state: 'up-to-date', checkedAt: 5 }
    const calls = fakeBackend({ 'system.updateStatus': status })

    await useUpdatesStore.getState().load()

    expect(calls.map((call) => call.method)).toEqual(['system.updateStatus'])
    expect(useUpdatesStore.getState().status).toEqual(status)
  })

  it('survives a backend that has no updater at all', async () => {
    fakeBackend({}, new Error('Not implemented yet: system.updateStatus'))

    await useUpdatesStore.getState().load()

    // Unchanged rather than thrown: a settings page must still render.
    expect(useUpdatesStore.getState().status).toEqual(IDLE_UPDATE_STATUS)
  })

  it('marks itself busy while a check the user started is running', async () => {
    let release: ((value: UpdateStatus) => void) | undefined
    setBackend({
      invoke: (() =>
        new Promise<UpdateStatus>((resolve) => {
          release = resolve
        })) as BackendClient['invoke'],
      subscribe: () => () => {}
    })

    const pending = useUpdatesStore.getState().check()
    expect(useUpdatesStore.getState().checking).toBe(true)

    release?.({ state: 'up-to-date' })
    await pending
    expect(useUpdatesStore.getState().checking).toBe(false)
    expect(useUpdatesStore.getState().status.state).toBe('up-to-date')
  })

  it('applies the two backend events through the bridge', () => {
    applyBackendEvent({ type: 'update.available', version: '0.2.0' })
    expect(useUpdatesStore.getState().status).toMatchObject({
      state: 'available',
      version: '0.2.0'
    })

    applyBackendEvent({ type: 'update.downloaded', version: '0.2.0' })
    expect(useUpdatesStore.getState().status).toMatchObject({
      state: 'downloaded',
      version: '0.2.0',
      percent: 100
    })
  })

  it('never lets an available event undo a finished download', () => {
    applyBackendEvent({ type: 'update.downloaded', version: '0.2.0' })
    applyBackendEvent({ type: 'update.available', version: '0.2.0' })

    expect(useUpdatesStore.getState().status.state).toBe('downloaded')
  })

  describe('the notice bar', () => {
    it('is raised by a downloaded update and closed by the user', () => {
      applyBackendEvent({ type: 'update.downloaded', version: '0.2.0' })
      expect(readyVersion()).toBe('0.2.0')

      useUpdatesStore.getState().dismiss()
      expect(readyVersion()).toBeNull()
    })

    it('stays closed when the same version is announced again', () => {
      applyBackendEvent({ type: 'update.downloaded', version: '0.2.0' })
      useUpdatesStore.getState().dismiss()

      applyBackendEvent({ type: 'update.downloaded', version: '0.2.0' })
      expect(readyVersion()).toBeNull()
    })

    it('opens again for a newer version', () => {
      applyBackendEvent({ type: 'update.downloaded', version: '0.2.0' })
      useUpdatesStore.getState().dismiss()

      applyBackendEvent({ type: 'update.downloaded', version: '0.3.0' })
      expect(readyVersion()).toBe('0.3.0')
    })
  })
})
