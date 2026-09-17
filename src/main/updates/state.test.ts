/**
 * The update state machine (S7.4).
 *
 * The reducer is the whole of what Settings → About says and when the notice bar
 * appears, so the walk is asserted step by step rather than through the service.
 * Nothing here touches electron, `electron-updater` or a timer.
 */
import { describe, expect, it } from 'vitest'
import { IDLE_UPDATE_STATUS, type UpdateStatus } from '@shared/updates'
import { reduceUpdate } from './state'

const NOW = 1_700_000_000_000
const now = (): number => NOW

describe('reduceUpdate', () => {
  it('walks idle → checking → available → downloading → downloaded', () => {
    let status = reduceUpdate(IDLE_UPDATE_STATUS, { kind: 'checking' }, now)
    expect(status).toEqual({ state: 'checking' })

    status = reduceUpdate(status, { kind: 'available', version: '0.2.0' }, now)
    expect(status).toEqual({ state: 'available', version: '0.2.0', checkedAt: NOW })

    status = reduceUpdate(status, { kind: 'progress', percent: 41.6 }, now)
    expect(status).toEqual({
      state: 'downloading',
      version: '0.2.0',
      percent: 42,
      checkedAt: NOW
    })

    status = reduceUpdate(status, { kind: 'downloaded', version: '0.2.0' }, now)
    expect(status).toEqual({
      state: 'downloaded',
      version: '0.2.0',
      percent: 100,
      checkedAt: NOW
    })
  })

  it('ends a fruitless check in up-to-date and stamps the time', () => {
    const checking = reduceUpdate(IDLE_UPDATE_STATUS, { kind: 'checking' }, now)
    expect(reduceUpdate(checking, { kind: 'not-available' }, now)).toEqual({
      state: 'up-to-date',
      checkedAt: NOW
    })
  })

  it('keeps the version a failed download was for', () => {
    const available: UpdateStatus = { state: 'available', version: '0.2.0', checkedAt: NOW }
    expect(reduceUpdate(available, { kind: 'error', message: 'ENOTFOUND' }, now)).toEqual({
      state: 'error',
      version: '0.2.0',
      error: 'ENOTFOUND',
      checkedAt: NOW
    })
  })

  it('drops a stale version when a new check starts', () => {
    const upToDate: UpdateStatus = { state: 'up-to-date', checkedAt: NOW }
    expect(reduceUpdate(upToDate, { kind: 'checking' }, now)).toEqual({ state: 'checking' })
  })

  it('clamps and rounds whatever percentage the updater reports', () => {
    const base: UpdateStatus = { state: 'available', version: '0.2.0' }
    const percent = (value: number): number | undefined =>
      reduceUpdate(base, { kind: 'progress', percent: value }, now).percent

    expect(percent(-3)).toBe(0)
    expect(percent(0.4)).toBe(0)
    expect(percent(99.5)).toBe(100)
    expect(percent(140)).toBe(100)
    expect(percent(Number.NaN)).toBe(0)
  })

  it('leaves a downloaded update alone when the six-hour check comes round', () => {
    // The rule the notice bar depends on: a periodic check must not take back an
    // offer the user has already been shown and can still act on.
    const downloaded: UpdateStatus = {
      state: 'downloaded',
      version: '0.2.0',
      percent: 100,
      checkedAt: NOW
    }

    expect(reduceUpdate(downloaded, { kind: 'checking' }, now)).toBe(downloaded)
    expect(reduceUpdate(downloaded, { kind: 'not-available' }, now)).toBe(downloaded)
    expect(reduceUpdate(downloaded, { kind: 'available', version: '0.2.0' }, now)).toBe(downloaded)
    expect(reduceUpdate(downloaded, { kind: 'error', message: 'offline' }, now)).toBe(downloaded)
    // Re-reporting the same version is not a transition either, which is what
    // keeps `update.downloaded` from being emitted twice.
    expect(reduceUpdate(downloaded, { kind: 'downloaded', version: '0.2.0' }, now)).toBe(downloaded)
  })

  it('replaces a downloaded update when a newer one is downloaded', () => {
    const downloaded: UpdateStatus = { state: 'downloaded', version: '0.2.0', percent: 100 }
    expect(reduceUpdate(downloaded, { kind: 'downloaded', version: '0.3.0' }, now)).toEqual({
      state: 'downloaded',
      version: '0.3.0',
      percent: 100
    })
  })

  it('never moves an unsupported build, whatever the feed says', () => {
    const unsupported: UpdateStatus = { state: 'unsupported', reason: 'unsigned' }
    for (const event of [
      { kind: 'checking' },
      { kind: 'available', version: '0.2.0' },
      { kind: 'not-available' },
      { kind: 'downloaded', version: '0.2.0' },
      { kind: 'error', message: 'nope' }
    ] as const) {
      expect(reduceUpdate(unsupported, event, now)).toBe(unsupported)
    }
  })
})
