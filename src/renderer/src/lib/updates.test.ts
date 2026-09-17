/**
 * The update copy and the button's enabled rule (S7.4).
 *
 * `t` is a fake that echoes what it was asked for, so this asserts the *mapping*
 * — every state reaches a different key, with the parameters that key needs —
 * rather than the English sentences, which belong to the locale files and to
 * `i18n/locales.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { UPDATE_STATES, type UpdateStatus } from '@shared/updates'
import en from '../locales/en.json'
import { canCheckForUpdates, unsupportedLabel, updateStateLabel } from './updates'

/** Records the key and the parameters, and answers with the key. */
function recorder(): {
  t: (key: string, params: Record<string, unknown>) => string
  last: () => { key: string; params: Record<string, unknown> }
} {
  let seen: { key: string; params: Record<string, unknown> } = { key: '', params: {} }
  return {
    t: (key, params) => {
      seen = { key, params }
      return key
    },
    last: () => seen
  }
}

describe('updateStateLabel', () => {
  it('gives every state a key of its own, and every key exists', () => {
    const { t } = recorder()
    const keys = new Set<string>()

    for (const state of UPDATE_STATES) {
      const label = updateStateLabel(t, { state } as UpdateStatus)
      keys.add(label)
      // The runtime-assembled half of CLAUDE.md rule #4: the guard in
      // `used-keys.test.ts` sees the literal calls, and this sees that the walk
      // over every state reaches one of them.
      const leaf = label.split('.').reduce<unknown>((node, part) => {
        return typeof node === 'object' && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined
      }, en)
      expect(typeof leaf, `${state} -> ${label}`).toBe('string')
    }

    // `unsupported` shares no key with any live state, and no two live states
    // share one either.
    expect(keys.size).toBe(UPDATE_STATES.length)
  })

  it('interpolates the version into the three states that name one', () => {
    for (const state of ['available', 'downloading', 'downloaded'] as const) {
      const { t, last } = recorder()
      updateStateLabel(t, { state, version: '0.2.0', percent: 40 })
      expect(last().params).toMatchObject({ version: '0.2.0' })
    }
  })

  it('carries the percentage into the downloading sentence', () => {
    const { t, last } = recorder()
    updateStateLabel(t, { state: 'downloading', version: '0.2.0', percent: 40 })
    expect(last().params).toEqual({ version: '0.2.0', percent: 40 })
  })

  it('carries the updater message into the error sentence', () => {
    const { t, last } = recorder()
    updateStateLabel(t, { state: 'error', error: '404 latest-mac.yml' })
    expect(last().params).toEqual({ message: '404 latest-mac.yml' })
  })

  it('names the version as empty rather than undefined when there is none', () => {
    const { t, last } = recorder()
    updateStateLabel(t, { state: 'downloading', percent: 3 })
    expect(last().params).toEqual({ version: '', percent: 3 })
  })
})

describe('unsupportedLabel', () => {
  it('distinguishes an unsigned build from a checkout', () => {
    const { t } = recorder()
    expect(unsupportedLabel(t, 'unsigned')).toBe('settings.about.updates.unsignedBuild')
    expect(unsupportedLabel(t, 'development')).toBe('settings.about.updates.developmentBuild')
  })

  it('treats a missing reason as a development build', () => {
    const { t } = recorder()
    // The harmless half of the pair: better "this is not a release" than
    // accusing a correctly signed bundle of being unsigned.
    expect(unsupportedLabel(t, undefined)).toBe('settings.about.updates.developmentBuild')
  })
})

describe('canCheckForUpdates', () => {
  it('is offered from every state that could produce a new answer', () => {
    for (const state of ['idle', 'available', 'downloaded', 'up-to-date', 'error'] as const) {
      expect(canCheckForUpdates({ state }, false), state).toBe(true)
    }
  })

  it('is withheld while something is already running', () => {
    expect(canCheckForUpdates({ state: 'checking' }, false)).toBe(false)
    expect(canCheckForUpdates({ state: 'downloading', percent: 10 }, false)).toBe(false)
    expect(canCheckForUpdates({ state: 'idle' }, true)).toBe(false)
  })

  it('is withheld on a build that cannot update itself', () => {
    expect(canCheckForUpdates({ state: 'unsupported', reason: 'unsigned' }, false)).toBe(false)
  })
})
