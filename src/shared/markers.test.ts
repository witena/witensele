/**
 * The protocol-marker rules, which two different layers depend on being
 * identical: the main process decides a message's status with `isPassOnly` and
 * whether the discussion is over with `closureMarker`, and both the renderer and
 * the history transform decide what to show with `stripTrailingMarkers`.
 *
 * The interesting cases are the boundary between the two readings: exactly
 * `[PASS]` is an abstention and must survive untouched, a marker *after* real
 * content is a sign-off and must be removed, and a marker quoted in the middle of
 * a sentence is neither.
 */
import { describe, expect, it } from 'vitest'
import {
  AGREED_TOKEN,
  closureMarker,
  CONTINUE_TOKEN,
  isPassOnly,
  PASS_TOKEN,
  stripTrailingMarkers
} from './markers'

describe('isPassOnly', () => {
  it('accepts the bare token, with or without surrounding whitespace', () => {
    expect(isPassOnly(PASS_TOKEN)).toBe(true)
    expect(isPassOnly(`\n  ${PASS_TOKEN}  \n`)).toBe(true)
  })

  it('rejects an answer that merely ends with it', () => {
    expect(isPassOnly(`I agree with Ada. ${PASS_TOKEN}`)).toBe(false)
  })

  it('rejects the closure markers, which are not abstentions', () => {
    expect(isPassOnly(AGREED_TOKEN)).toBe(false)
    expect(isPassOnly(CONTINUE_TOKEN)).toBe(false)
  })

  it('rejects everything else', () => {
    expect(isPassOnly('')).toBe(false)
    expect(isPassOnly('pass')).toBe(false)
    expect(isPassOnly(`${PASS_TOKEN} but actually`)).toBe(false)
  })
})

describe('closureMarker', () => {
  it('reads the marker a real answer ends with', () => {
    expect(closureMarker(`Ada is right about the budget. ${AGREED_TOKEN}`)).toBe('agreed')
    expect(closureMarker(`We still have not sized it. ${CONTINUE_TOKEN}`)).toBe('continue')
  })

  it('reads it across a line break, which is how models usually write it', () => {
    expect(closureMarker(`Nothing to add.\n\n${AGREED_TOKEN}`)).toBe('agreed')
  })

  it('reads one a model punctuated like prose', () => {
    expect(closureMarker(`Nothing to add. ${AGREED_TOKEN}.`)).toBe('agreed')
  })

  it('reads a marker that is the whole reply', () => {
    expect(closureMarker(AGREED_TOKEN)).toBe('agreed')
    expect(closureMarker(`  ${CONTINUE_TOKEN}  `)).toBe('continue')
  })

  it('answers null when there is no marker at the end', () => {
    expect(closureMarker('Just an answer.')).toBeNull()
    expect(closureMarker('')).toBeNull()
    // Quoting the protocol is not using it.
    expect(closureMarker(`End with ${AGREED_TOKEN} when you are done, or keep talking.`)).toBeNull()
  })

  it('answers null for an abstention, which says nothing about the group', () => {
    expect(closureMarker(PASS_TOKEN)).toBeNull()
    expect(closureMarker(`Sounds fine. ${PASS_TOKEN}`)).toBeNull()
  })

  it('is case-sensitive, like the briefing that teaches it', () => {
    expect(closureMarker('Nothing to add. [agreed]')).toBeNull()
  })
})

describe('stripTrailingMarkers', () => {
  it('removes the abstention marker from the end of a real answer', () => {
    expect(stripTrailingMarkers(`Use exponential backoff. ${PASS_TOKEN}`)).toBe(
      'Use exponential backoff.'
    )
  })

  it('removes either closure marker the same way', () => {
    expect(stripTrailingMarkers(`Use exponential backoff. ${AGREED_TOKEN}`)).toBe(
      'Use exponential backoff.'
    )
    expect(stripTrailingMarkers(`Use exponential backoff. ${CONTINUE_TOKEN}`)).toBe(
      'Use exponential backoff.'
    )
  })

  it('removes one across a line break, which is how models usually write it', () => {
    expect(stripTrailingMarkers(`Use exponential backoff.\n\n${AGREED_TOKEN}`)).toBe(
      'Use exponential backoff.'
    )
  })

  it('removes a marker the model punctuated like prose', () => {
    expect(stripTrailingMarkers(`Nothing further. ${PASS_TOKEN}.`)).toBe('Nothing further.')
  })

  it('removes both when a model wrote two of them', () => {
    expect(stripTrailingMarkers(`Ada is right. ${AGREED_TOKEN} ${PASS_TOKEN}`)).toBe(
      'Ada is right.'
    )
  })

  it('leaves a reply that is nothing but a marker alone', () => {
    expect(stripTrailingMarkers(PASS_TOKEN)).toBe(PASS_TOKEN)
    expect(stripTrailingMarkers(`  ${PASS_TOKEN}  `)).toBe(`  ${PASS_TOKEN}  `)
    expect(stripTrailingMarkers(AGREED_TOKEN)).toBe(AGREED_TOKEN)
    expect(stripTrailingMarkers(CONTINUE_TOKEN)).toBe(CONTINUE_TOKEN)
  })

  it('leaves a marker alone anywhere but the end', () => {
    const text = `The rule is: answer, or reply ${PASS_TOKEN} and say nothing else.`

    expect(stripTrailingMarkers(text)).toBe(text)
  })

  it('leaves text without a marker untouched', () => {
    expect(stripTrailingMarkers('Just an answer.')).toBe('Just an answer.')
    expect(stripTrailingMarkers('')).toBe('')
  })
})
