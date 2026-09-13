/**
 * The two pure halves of automatic titling: what a model's answer is turned into,
 * and what is used when the model gives nothing usable.
 *
 * `generateChatTitle` itself is exercised end to end in `chat-runner.test.ts`,
 * against a mock model — the interesting part of it is *when* the runner calls it,
 * not the `generateText` call.
 *
 * CJK in the expectations is written as `\u` escapes (CLAUDE.md rule #1); the
 * cases exist because a Chinese-first model wraps a title in corner brackets and
 * ends it with an ideographic full stop exactly as readily as an English one uses
 * quotes and a period.
 */
import { describe, expect, it } from 'vitest'
import { fallbackTitle, FALLBACK_TITLE_CHARS, MAX_TITLE_CHARS, sanitizeTitle } from './title'

describe('sanitizeTitle', () => {
  it('keeps a title that is already clean', () => {
    expect(sanitizeTitle('Retry budget tradeoffs')).toBe('Retry budget tradeoffs')
  })

  it('collapses whitespace, including the newline a model answers on', () => {
    expect(sanitizeTitle('\n  Retry   budget \n tradeoffs \n')).toBe('Retry budget tradeoffs')
  })

  it('strips wrapping quotes, straight and typographic', () => {
    expect(sanitizeTitle('"Retry budget tradeoffs"')).toBe('Retry budget tradeoffs')
    expect(sanitizeTitle('“Retry budget tradeoffs”')).toBe('Retry budget tradeoffs')
    expect(sanitizeTitle('\u300c\u91cd\u8bd5\u9884\u7b97\u300d')).toBe('\u91cd\u8bd5\u9884\u7b97')
  })

  it('strips trailing punctuation in both scripts', () => {
    expect(sanitizeTitle('Retry budget tradeoffs.')).toBe('Retry budget tradeoffs')
    expect(sanitizeTitle('\u91cd\u8bd5\u9884\u7b97\u3002')).toBe('\u91cd\u8bd5\u9884\u7b97')
  })

  it('drops a "Title:" preamble the model added', () => {
    expect(sanitizeTitle('Title: Retry budget tradeoffs')).toBe('Retry budget tradeoffs')
    expect(sanitizeTitle('\u6807\u9898\uff1a\u91cd\u8bd5\u9884\u7b97')).toBe('\u91cd\u8bd5\u9884\u7b97')
  })

  it('caps a model that ignored the instruction', () => {
    const long = 'word '.repeat(40)

    expect(sanitizeTitle(long).length).toBeLessThanOrEqual(MAX_TITLE_CHARS)
  })

  it('returns an empty string when nothing usable is left', () => {
    expect(sanitizeTitle('')).toBe('')
    expect(sanitizeTitle('   ')).toBe('')
    expect(sanitizeTitle('"..."')).toBe('')
    // Not a string at all: the model layer is typed, a JSON payload is not.
    expect(sanitizeTitle(undefined as unknown as string)).toBe('')
  })
})

describe('fallbackTitle', () => {
  it('uses a short question as it stands', () => {
    expect(fallbackTitle('What is our retry budget?')).toBe('What is our retry budget?')
  })

  it('cuts a long one and marks the cut', () => {
    const question =
      'What should our retry budget be for the checkout service, and who owns that decision?'
    const title = fallbackTitle(question)

    expect(title.length).toBeLessThanOrEqual(FALLBACK_TITLE_CHARS + 1)
    expect(title.endsWith('\u2026')).toBe(true)
    expect(question.startsWith(title.slice(0, -1).trimEnd())).toBe(true)
  })

  it('collapses whitespace so a multi-line question still reads as one label', () => {
    expect(fallbackTitle('What now?\n\nPlease be brief.')).toBe('What now? Please be brief.')
  })

  it("is empty for an empty question, which is the caller's signal to do nothing", () => {
    expect(fallbackTitle('')).toBe('')
    expect(fallbackTitle('   \n ')).toBe('')
  })
})
