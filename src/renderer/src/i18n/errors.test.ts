/**
 * The error-code mapping, against the real English tree.
 *
 * `used-keys.test.ts` already proves every literal key in `errors.ts` exists.
 * What is left to prove is that the mapping is *total*: every `BackendErrorCode`
 * produces a distinct, non-empty sentence, so a code added to the shared union
 * cannot reach the screen as a blank line. S5.2 added the same obligation for
 * `ValidationReason`, the narrower half of the same contract.
 */
import { describe, expect, it } from 'vitest'
import type { BackendErrorCode } from '@shared/types'
import { VALIDATION_REASONS } from '@shared/types'
import en from '../locales/en.json'
import {
  errorMessage,
  translateError,
  translateFailure,
  validationReasonMessage,
  validationReasonOf
} from './errors'

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

  it('covers exactly what the locale file defines, codes plus reasons', () => {
    expect(Object.keys(en.errors).sort()).toEqual([...CODES, ...VALIDATION_REASONS].sort())
  })
})

describe('validationReasonMessage', () => {
  it('resolves every reason to real, distinct copy', () => {
    const messages = VALIDATION_REASONS.map((reason) => validationReasonMessage(t, reason))
    for (const [index, message] of messages.entries()) {
      const reason = VALIDATION_REASONS[index] as string
      expect(message, reason).not.toBe(`errors.${reason}`)
      expect(message.trim(), reason).not.toBe('')
    }
    expect(new Set(messages).size).toBe(VALIDATION_REASONS.length)
  })
})

describe('validationReasonOf', () => {
  it('narrows a known reason', () => {
    expect(validationReasonOf({ reason: 'workdir_missing' })).toBe('workdir_missing')
  })

  it('ignores everything else, so a newer backend degrades rather than leaks', () => {
    expect(validationReasonOf({ reason: 'invented_later' })).toBeUndefined()
    expect(validationReasonOf({ chatId: 'c1' })).toBeUndefined()
    expect(validationReasonOf('workdir_missing')).toBeUndefined()
    expect(validationReasonOf(null)).toBeUndefined()
    expect(validationReasonOf(undefined)).toBeUndefined()
  })
})

describe('translateFailure', () => {
  it('prefers the reason over the generic validation sentence', () => {
    expect(translateFailure(t, 'validation', { reason: 'second_executor' })).toBe(
      en.errors.second_executor
    )
  })

  it('falls back to the code when there is no reason', () => {
    expect(translateFailure(t, 'validation')).toBe(en.errors.validation)
    expect(translateFailure(t, 'validation', { chatId: 'c1' })).toBe(en.errors.validation)
  })

  it('ignores a reason that turned up on another code', () => {
    // An id in a `not_found`'s details says nothing about why it was refused.
    expect(translateFailure(t, 'not_found', { reason: 'workdir_missing' })).toBe(
      en.errors.not_found
    )
  })

  it('treats a missing code as internal, which is what a store holds before it knows', () => {
    expect(translateFailure(t, undefined)).toBe(en.errors.internal)
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

  it('reads the reason out of details when the code is validation', () => {
    const message = translateError(t, {
      code: 'validation',
      message: 'workdir does not exist: /gone',
      details: { reason: 'workdir_missing' }
    })

    expect(message).toBe(en.errors.workdir_missing)
    expect(message).not.toContain('/gone')
  })
})
