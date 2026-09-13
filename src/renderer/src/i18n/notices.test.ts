/**
 * `translateNotice` — the renderer half of the "the backend sends keys, not
 * sentences" contract.
 *
 * The real i18next instance is used rather than a fake `t`, so the test also
 * proves that the key prefix and the parameter names match what is actually in
 * the locale files, and that i18next's `t` satisfies `TranslateFn`.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { SystemNoticePart } from '@shared/types'
import { i18n, initI18n } from './index'
import { translateNotice } from './notices'

const notice = (key: string, params?: SystemNoticePart['params']): SystemNoticePart => ({
  type: 'system-notice',
  key,
  ...(params ? { params } : {})
})

beforeAll(() => {
  initI18n('en')
})

describe('translateNotice', () => {
  it('translates a key under the notices namespace', async () => {
    await i18n.changeLanguage('en')

    expect(translateNotice(i18n.t, notice('runStopped'))).toBe('The run was stopped')
  })

  it('interpolates the parameters the backend sent', async () => {
    await i18n.changeLanguage('en')

    expect(translateNotice(i18n.t, notice('agentSkipped', { agent: 'Kai' }))).toBe(
      'Kai did not respond and was skipped this round'
    )
    expect(translateNotice(i18n.t, notice('maxRoundsReached', { max: 3 }))).toContain('3')
  })

  it('follows the active language, so a stored notice is never stale', async () => {
    await i18n.changeLanguage('zh-CN')
    const chinese = translateNotice(i18n.t, notice('agentSkipped', { agent: 'Kai' }))

    await i18n.changeLanguage('en')
    const english = translateNotice(i18n.t, notice('agentSkipped', { agent: 'Kai' }))

    expect(chinese).not.toBe(english)
    expect(chinese).toContain('Kai')
  })

  it('falls back to the raw key when the renderer has no copy for it', async () => {
    await i18n.changeLanguage('en')

    expect(translateNotice(i18n.t, notice('somethingNobodyTranslated'))).toBe(
      'somethingNobodyTranslated'
    )
  })
})
