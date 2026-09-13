/**
 * The context budget: the estimator's rough accuracy, and every rule `fitHistory`
 * promises.
 *
 * The estimator is checked **with a tolerance**, on purpose. It is an
 * approximation by construction (see `context-budget.ts`), so asserting an exact
 * number would pin the implementation rather than the behaviour and would break
 * on a one-character change to the bucketing. What matters is that English costs
 * roughly a quarter of a token per character, that Chinese costs roughly one, and
 * that neither is out by a factor.
 */
import type { ModelMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OUTPUT_RESERVE,
  estimateTokens,
  fitHistory,
  TRUNCATION_NOTE
} from './context-budget'

const user = (content: string): ModelMessage => ({ role: 'user', content })
const assistant = (content: string): ModelMessage => ({ role: 'assistant', content })

/** A message whose text is `length` ASCII characters, i.e. about `length / 4` tokens. */
const filler = (length: number, mark = 'x'): string => mark.repeat(length)

describe('estimateTokens', () => {
  it('is zero for an empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('counts ASCII at roughly a quarter of a token per character', () => {
    const text = filler(400)

    // 100 tokens, give or take the rounding.
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(90)
    expect(estimateTokens(text)).toBeLessThanOrEqual(110)
  })

  it('counts CJK at roughly one token per character', () => {
    // A two-character Chinese greeting repeated: 100 characters, so about 100
    // tokens — four times what the same number of ASCII characters would cost.
    const text = '\u4f60\u597d'.repeat(50)

    expect(estimateTokens(text)).toBeGreaterThanOrEqual(90)
    expect(estimateTokens(text)).toBeLessThanOrEqual(110)
  })

  it('is within tolerance on a realistic English sentence', () => {
    // 57 characters; every vendor's rule of thumb puts this near 14 tokens.
    const text = 'The quick brown fox jumps over the lazy dog, twice over.'

    expect(estimateTokens(text)).toBeGreaterThanOrEqual(10)
    expect(estimateTokens(text)).toBeLessThanOrEqual(20)
  })

  it('never reports zero for a non-empty string', () => {
    expect(estimateTokens('a')).toBe(1)
  })
})

describe('fitHistory', () => {
  it('returns the history untouched when it already fits', () => {
    const messages = [user('Hello'), assistant('Hi'), user('How are you?')]

    const result = fitHistory({ system: 'You are Ada.', messages, contextWindow: 32_768 })

    expect(result.droppedCount).toBe(0)
    expect(result.messages).toBe(messages)
    expect(result.messages[0]?.content).toBe('Hello')
    expect(result.estimatedTokens).toBeGreaterThan(0)
  })

  it('drops the oldest messages first', () => {
    const messages = [
      user(filler(4_000, 'a')),
      assistant(filler(4_000, 'b')),
      user(filler(4_000, 'c')),
      assistant(filler(4_000, 'd')),
      user('The actual question.')
    ]

    // Room for roughly 1_200 tokens of history: two of the 1_000-token fillers
    // will not fit.
    const result = fitHistory({
      system: '',
      messages,
      contextWindow: 1_200 + 200,
      reserveForOutput: 200
    })

    expect(result.droppedCount).toBeGreaterThan(0)
    const kept = result.messages.map((message) => String(message.content))
    // Whatever survived, it is a suffix of the input: the first one to go is the
    // first one that was said.
    expect(kept.some((text) => text.includes('aaaa'))).toBe(false)
    expect(kept[kept.length - 1]).toContain('The actual question.')
  })

  it('never drops the last user message, even when it alone exceeds the budget', () => {
    const question = 'What should we do about the retry budget?'
    const messages = [user(filler(40_000, 'a')), assistant(filler(40_000, 'b')), user(question)]

    const result = fitHistory({
      system: 'You are Ada.',
      messages,
      contextWindow: 1_000,
      reserveForOutput: 500
    })

    expect(result.droppedCount).toBe(2)
    expect(result.messages).toHaveLength(1)
    expect(String(result.messages[0]?.content)).toContain(question)
  })

  it('prepends the note to the first surviving message when anything was dropped', () => {
    const messages = [user(filler(8_000, 'a')), assistant('A short reply.'), user('And now?')]

    const result = fitHistory({
      system: '',
      messages,
      contextWindow: 400,
      reserveForOutput: 100
    })

    expect(result.droppedCount).toBeGreaterThan(0)
    expect(String(result.messages[0]?.content)).toContain(TRUNCATION_NOTE)
    // Once only: the note replaces nothing, it is added in front of what was kept.
    expect(String(result.messages[0]?.content).split(TRUNCATION_NOTE)).toHaveLength(2)
  })

  it('adds no note when nothing was dropped', () => {
    const result = fitHistory({ system: '', messages: [user('Hi')], contextWindow: 32_768 })

    expect(String(result.messages[0]?.content)).not.toContain(TRUNCATION_NOTE)
  })

  it('respects the output reserve: a bigger reserve drops more', () => {
    const messages = Array.from({ length: 20 }, (_unused, index) =>
      index % 2 === 0 ? user(filler(400, 'a')) : assistant(filler(400, 'b'))
    )
    const base = { system: '', messages, contextWindow: 2_000 }

    const small = fitHistory({ ...base, reserveForOutput: 100 })
    const large = fitHistory({ ...base, reserveForOutput: 1_500 })

    expect(large.droppedCount).toBeGreaterThan(small.droppedCount)
  })

  it('counts the system prompt against the same budget', () => {
    const messages = Array.from({ length: 20 }, () => user(filler(400, 'a')))
    const base = { messages, contextWindow: 2_000, reserveForOutput: 100 }

    const bare = fitHistory({ ...base, system: '' })
    const heavy = fitHistory({ ...base, system: filler(4_000, 's') })

    expect(heavy.droppedCount).toBeGreaterThan(bare.droppedCount)
  })

  it('defaults the reserve to DEFAULT_OUTPUT_RESERVE', () => {
    const messages = Array.from({ length: 40 }, () => user(filler(400, 'a')))
    const explicit = fitHistory({
      system: '',
      messages,
      contextWindow: 8_000,
      reserveForOutput: DEFAULT_OUTPUT_RESERVE
    })
    const implicit = fitHistory({ system: '', messages, contextWindow: 8_000 })

    expect(implicit.droppedCount).toBe(explicit.droppedCount)
  })

  it('survives a window smaller than the system prompt without looping', () => {
    const result = fitHistory({
      system: filler(40_000, 's'),
      messages: [user('a'), assistant('b'), user('c')],
      contextWindow: 100,
      reserveForOutput: 50
    })

    // Everything but the protected last user message goes, and the call returns.
    expect(result.messages).toHaveLength(1)
    expect(String(result.messages[0]?.content)).toContain('c')
  })
})
