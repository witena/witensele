/**
 * The `UpdateService` against a fake updater (S7.4).
 *
 * The fake is the whole point of the `Updater` port: the schedule, the emitted
 * events, the refusal an unsigned build gives and the "two clicks, one download"
 * rule are all asserted here with no electron, no network and no bundle.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '@shared/events'
import { UPDATE_CHECK_INTERVAL_MS, type UpdateEvent } from '@shared/updates'
import { isBackendFailure } from '../errors'
import { NOTHING_TO_INSTALL, UpdateService, type Updater } from './service'

/**
 * A fake `Updater` whose `check()` does whatever the test tells it to.
 *
 * `emit` is how a test plays the role of `electron-updater`: the real adapter
 * turns six library events into this union, so everything downstream of that
 * translation is exercised exactly as it runs in production.
 */
function fakeUpdater(onCheck: (emit: (event: UpdateEvent) => void) => Promise<void> | void): {
  updater: Updater
  checks: number
  installs: number
  subscribers: number
} {
  const listeners = new Set<(event: UpdateEvent) => void>()
  const state = { checks: 0, installs: 0, subscribers: 0 }

  const emit = (event: UpdateEvent): void => {
    for (const listener of listeners) listener(event)
  }

  const updater: Updater = {
    subscribe(listener) {
      listeners.add(listener)
      state.subscribers += 1
      return () => {
        listeners.delete(listener)
        state.subscribers -= 1
      }
    },
    async check() {
      state.checks += 1
      await onCheck(emit)
    },
    install() {
      state.installs += 1
    }
  }

  return {
    updater,
    get checks() {
      return state.checks
    },
    get installs() {
      return state.installs
    },
    get subscribers() {
      return state.subscribers
    }
  }
}

/** A service plus the events it emitted, which is what the renderer would see. */
function createService(
  updater: Updater | null,
  overrides: { reason?: 'unsigned' | 'development'; intervalMs?: number } = {}
): { service: UpdateService; emitted: BackendEvent[] } {
  const emitted: BackendEvent[] = []
  const service = new UpdateService({
    updater,
    emit: (event) => emitted.push(event),
    now: () => 1_700_000_000_000,
    ...overrides
  })
  return { service, emitted }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('UpdateService', () => {
  it('starts idle and reports what a check found', async () => {
    const fake = fakeUpdater((emit) => {
      emit({ kind: 'checking' })
      emit({ kind: 'available', version: '0.2.0' })
    })
    const { service, emitted } = createService(fake.updater)

    expect(service.getStatus()).toEqual({ state: 'idle' })

    const status = await service.check()
    expect(status.state).toBe('available')
    expect(status.version).toBe('0.2.0')
    // One announcement per transition, so the renderer can raise a bar on it.
    expect(emitted).toEqual([{ type: 'update.available', version: '0.2.0' }])
  })

  it('emits update.downloaded once, however often the updater repeats itself', async () => {
    const fake = fakeUpdater((emit) => {
      emit({ kind: 'available', version: '0.2.0' })
      emit({ kind: 'progress', percent: 50 })
      emit({ kind: 'downloaded', version: '0.2.0' })
      emit({ kind: 'downloaded', version: '0.2.0' })
    })
    const { service, emitted } = createService(fake.updater)

    await service.check()
    expect(service.getStatus().state).toBe('downloaded')
    expect(emitted.filter((event) => event.type === 'update.downloaded')).toHaveLength(1)
  })

  it('turns a rejected check into an error status rather than a rejection', async () => {
    const fake = fakeUpdater(() => {
      throw new Error('404 latest-mac.yml')
    })
    const { service } = createService(fake.updater)

    const status = await service.check()
    expect(status.state).toBe('error')
    expect(status.error).toContain('404')
    expect(status.checkedAt).toBe(1_700_000_000_000)
  })

  it('joins a check that is already running instead of downloading twice', async () => {
    let release: (() => void) | undefined
    // Only the first check blocks; the one after it has to be able to finish, or
    // the assertion below would be testing the fake rather than the service.
    const fake = fakeUpdater(async (emit) => {
      emit({ kind: 'checking' })
      if (!release) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      emit({ kind: 'available', version: '0.2.0' })
    })
    const { service } = createService(fake.updater)

    const first = service.check()
    const second = service.check()
    expect(fake.checks).toBe(1)

    release?.()
    await Promise.all([first, second])
    expect(fake.checks).toBe(1)

    // And a later click starts a fresh one.
    await service.check()
    expect(fake.checks).toBe(2)
  })

  it('checks on start and again every six hours', async () => {
    vi.useFakeTimers()
    const fake = fakeUpdater((emit) => {
      emit({ kind: 'not-available' })
    })
    const { service } = createService(fake.updater)

    service.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.checks).toBe(1)
    expect(fake.subscribers).toBe(1)

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(fake.checks).toBe(2)

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(fake.checks).toBe(3)

    service.stop()
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2)
    expect(fake.checks).toBe(3)
    expect(fake.subscribers).toBe(0)
  })

  it('installs only what has actually been downloaded', async () => {
    const fake = fakeUpdater((emit) => {
      emit({ kind: 'available', version: '0.2.0' })
    })
    const { service } = createService(fake.updater)

    await service.check()
    expect(() => service.install()).toThrowError(NOTHING_TO_INSTALL)
    expect(fake.installs).toBe(0)
  })

  it('restarts into a downloaded update', async () => {
    const fake = fakeUpdater((emit) => {
      emit({ kind: 'downloaded', version: '0.2.0' })
    })
    const { service } = createService(fake.updater)

    await service.check()
    service.install()
    expect(fake.installs).toBe(1)
  })

  describe('a build that cannot update itself', () => {
    it('reports why instead of rejecting, and never touches the feed', async () => {
      const { service, emitted } = createService(null, { reason: 'unsigned' })

      expect(service.getStatus()).toEqual({ state: 'unsupported', reason: 'unsigned' })

      // The button in Settings → About is disabled, but the method exists and a
      // second window, a script or a stale renderer may still call it.
      const status = await service.check()
      expect(status).toEqual({ state: 'unsupported', reason: 'unsigned' })
      expect(emitted).toEqual([])
    })

    it('starts nothing, so no timer and no subscription exist', async () => {
      vi.useFakeTimers()
      const { service } = createService(null, { reason: 'unsigned' })

      service.start()
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 3)
      expect(service.getStatus().state).toBe('unsupported')

      // `stop()` after a `start()` that did nothing must still be safe.
      expect(() => {
        service.stop()
      }).not.toThrow()
    })

    it('refuses to install with a validation failure', () => {
      const { service } = createService(null, { reason: 'development' })

      try {
        service.install()
        expect.unreachable('install should have thrown')
      } catch (error) {
        expect(isBackendFailure(error)).toBe(true)
        expect(isBackendFailure(error) && error.code).toBe('validation')
        expect((error as Error).message).toBe(NOTHING_TO_INSTALL)
      }
    })
  })
})
