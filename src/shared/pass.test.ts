/**
 * The `[PASS]` rules, which two different layers depend on being identical: the
 * main process decides a message's status with `isPassOnly`, and both the
 * renderer and the history transform decide what to show with
 * `stripTrailingPass`.
 *
 * The interesting cases are the boundary between the two: exactly the token is
 * an abstention and must survive untouched, the token *after* real content is a
 * sign-off and must be removed.
 */
import { describe, expect, it } from 'vitest'
import { isPassOnly, PASS_TOKEN, stripTrailingPass } from './pass'

describe('isPassOnly', () => {
  it('accepts the bare token, with or without surrounding whitespace', () => {
    expect(isPassOnly(PASS_TOKEN)).toBe(true)
    expect(isPassOnly(`\n  ${PASS_TOKEN}  \n`)).toBe(true)
  })

  it('rejects an answer that merely ends with it', () => {
    expect(isPassOnly(`I agree with Ada. ${PASS_TOKEN}`)).toBe(false)
  })

  it('rejects everything else', () => {
    expect(isPassOnly('')).toBe(false)
    expect(isPassOnly('pass')).toBe(false)
    expect(isPassOnly(`${PASS_TOKEN} but actually`)).toBe(false)
  })
})

describe('stripTrailingPass', () => {
  it('removes the marker from the end of a real answer', () => {
    expect(stripTrailingPass(`Use exponential backoff. ${PASS_TOKEN}`)).toBe(
      'Use exponential backoff.'
    )
  })

  it('removes it across a line break, which is how models usually write it', () => {
    expect(stripTrailingPass(`Use exponential backoff.\n\n${PASS_TOKEN}`)).toBe(
      'Use exponential backoff.'
    )
  })

  it('removes a marker the model punctuated like prose', () => {
    expect(stripTrailingPass(`Nothing further. ${PASS_TOKEN}.`)).toBe('Nothing further.')
  })

  it('leaves a pure abstention alone, so it is still recognisable as one', () => {
    expect(stripTrailingPass(PASS_TOKEN)).toBe(PASS_TOKEN)
    expect(stripTrailingPass(`  ${PASS_TOKEN}  `)).toBe(`  ${PASS_TOKEN}  `)
  })

  it('leaves the marker alone anywhere but the end', () => {
    const text = `The rule is: answer, or reply ${PASS_TOKEN} and say nothing else.`

    expect(stripTrailingPass(text)).toBe(text)
  })

  it('leaves text without a marker untouched', () => {
    expect(stripTrailingPass('Just an answer.')).toBe('Just an answer.')
    expect(stripTrailingPass('')).toBe('')
  })
})
