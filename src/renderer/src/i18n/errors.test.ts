/**
 * The error-code mapping, against the real English tree.
 *
 * `used-keys.test.ts` already proves every literal key in `errors.ts` exists.
 * What is left to prove is that the mapping is *total*: every `BackendErrorCode`
 * produces a distinct, non-empty sentence, so a code added to the shared union
 * cannot reach the screen as a blank line.
 */
import { describe, expect, it } from 'vitest'
import type { BackendErrorCode } from '@shared/types'
import en from '../locales/en.json'
import { errorMessage, translateError } from './errors'

const CODES: BackendErrorCode[] = [
  'not_found',
  'validation',
  'provider_error',
  'mcp_error',
  'aborted',
  'unauthorized',
  'internal'
]

/** Resolves a key against the English tree, the way i18next would. */
const t = (key: string): string => {
  const leaf = key.split('.').reduce<unknown>(
    (node, segment) =>
      typeof node === 'object' && node !== null
        ? (node as Record<string, unknown>)[segment]
        : undefined,
    en
  )
  return typeof leaf === 'string' ? leaf : key
}

describe('errorMessage', () => {
  it('resolves every failure class to real copy', () => {
    for (const code of CODES) {
      const message = errorMessage(t, code)
      expect(message, code).not.toBe(`errors.${code}`)
      expect(message.trim(), code).not.toBe('')
    }
  })

  it('gives each class its own wording', () => {
    const messages = CODES.map((code) => errorMessage(t, code))
    expect(new Set(messages).size).toBe(CODES.length)
  })

  it('covers exactly the codes the locale file defines', () => {
    expect(Object.keys(en.errors).sort()).toEqual([...CODES].sort())
  })
})

describe('translateError', () => {
  it('renders the code, never the developer-facing message', () => {
    const message = translateError(t, {
      code: 'provider_error',
      message: 'Provider responded 401 Unauthorized'
    })

    expect(message).toBe(en.errors.provider_error)
    expect(message).not.toContain('401')
  })
})
