/**
 * The price list, the two formatters, and the one rule that is easy to get
 * silently wrong: **matching order**.
 *
 * `MODEL_PRICING` is matched first-hit-wins, so `gpt-4o-mini` has to be listed
 * before `gpt-4o` and `glm-4.5-air` before `glm-4.5`. A reordering that broke
 * that would not throw — it would quietly bill a mini model at the full model's
 * price — which is exactly the kind of thing a test has to hold down.
 *
 * The actual figures are deliberately **not** asserted one by one: they are
 * estimates that are meant to be edited when a vendor reprices (see the header of
 * `pricing.ts`), and a test that pinned them would turn a one-line maintenance
 * edit into a two-line one for no benefit. What is asserted is that the table is
 * well formed, that lookups land on the right row, and that the arithmetic and
 * the formatting are right.
 */
import { describe, expect, it } from 'vitest'
import {
  contextWindowFor,
  DEFAULT_CONTEXT_WINDOW,
  estimateCost,
  findPricing,
  formatCost,
  formatTokens,
  MODEL_PRICING
} from './pricing'
import type { Usage } from './types'

const usage = (inputTokens: number, outputTokens: number): Usage => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens
})

describe('MODEL_PRICING', () => {
  it('is well formed: positive prices and a positive context window', () => {
    expect(MODEL_PRICING.length).toBeGreaterThan(0)
    for (const entry of MODEL_PRICING) {
      const label = String(entry.match)
      expect(entry.inputPerMTok, label).toBeGreaterThan(0)
      expect(entry.outputPerMTok, label).toBeGreaterThan(0)
      expect(entry.contextWindow, label).toBeGreaterThan(0)
    }
  })

  it('lists the specific rows before the general ones they share a prefix with', () => {
    const index = (id: string): number => MODEL_PRICING.indexOf(findPricing(id)!)

    expect(index('gpt-4o-mini')).toBeLessThan(index('gpt-4o'))
    expect(index('glm-4.5-air')).toBeLessThan(index('glm-4.5'))
    expect(index('deepseek-reasoner')).toBeLessThan(index('deepseek-chat'))
    expect(index('o3-mini')).toBeLessThan(index('o3'))
  })

  it('covers every family the provider presets ship with', () => {
    for (const id of [
      'claude-opus-4-1',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'gpt-5',
      'gpt-4.1',
      'gpt-4o',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'deepseek-chat',
      'deepseek-reasoner',
      'qwen-max',
      'qwen-plus',
      'qwen-turbo',
      'glm-4.5',
      'kimi-k2-0711-preview',
      'MiniMax-M1',
      'doubao-seed-1-6-250615'
    ]) {
      expect(findPricing(id), id).toBeDefined()
    }
  })
})

describe('findPricing', () => {
  it('matches a model id carrying a vendor prefix, as OpenRouter sends it', () => {
    expect(findPricing('anthropic/claude-sonnet-4')).toBe(findPricing('claude-sonnet-4-5'))
  })

  it('is case insensitive', () => {
    expect(findPricing('GPT-4O')).toBe(findPricing('gpt-4o'))
  })

  it('returns undefined for an unknown or empty id', () => {
    expect(findPricing('qwen2.5:1.5b')).toBeUndefined()
    expect(findPricing('')).toBeUndefined()
  })
})

describe('estimateCost', () => {
  it('prices input and output separately, per million tokens', () => {
    const pricing = findPricing('claude-sonnet-4-5')!
    const cost = estimateCost({ modelId: 'claude-sonnet-4-5' }, usage(1_000_000, 1_000_000))

    expect(cost).toBeCloseTo(pricing.inputPerMTok + pricing.outputPerMTok, 6)
  })

  it('scales linearly with the token count', () => {
    const one = estimateCost({ modelId: 'gpt-4o' }, usage(1_000, 500))!
    const ten = estimateCost({ modelId: 'gpt-4o' }, usage(10_000, 5_000))!

    expect(ten).toBeCloseTo(one * 10, 9)
  })

  it('returns null for a model the table does not know', () => {
    expect(estimateCost({ modelId: 'some-private-model' }, usage(100, 100))).toBeNull()
  })

  it('costs nothing on a local preset, whatever the model is called', () => {
    // The weights may well be a model the table prices; running them on the
    // user's own machine is still free.
    expect(estimateCost({ modelId: 'qwen2.5:1.5b', presetId: 'ollama' }, usage(9e6, 9e6))).toBe(0)
    expect(estimateCost({ modelId: 'gpt-4o', presetId: 'lmstudio' }, usage(9e6, 9e6))).toBe(0)
  })

  it('still prices a hosted preset', () => {
    expect(estimateCost({ modelId: 'deepseek-chat', presetId: 'deepseek' }, usage(1e6, 0))).toBeGreaterThan(0)
  })
})

describe('contextWindowFor', () => {
  it("reports the table's window for a known model", () => {
    expect(contextWindowFor('claude-sonnet-4-5')).toBe(200_000)
  })

  it('falls back to the conservative default for an unknown one', () => {
    expect(contextWindowFor('qwen2.5:1.5b')).toBe(DEFAULT_CONTEXT_WINDOW)
  })
})

describe('formatTokens', () => {
  it('prints a small count in full', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(842)).toBe('842')
  })

  it('prints thousands with one decimal, and drops a trailing zero', () => {
    expect(formatTokens(12_400)).toBe('12.4k')
    expect(formatTokens(1_000)).toBe('1k')
    expect(formatTokens(999_499)).toBe('999.5k')
  })

  it('switches to millions past a million', () => {
    expect(formatTokens(1_200_000)).toBe('1.2M')
  })

  it('never prints a negative or a non-finite count', () => {
    expect(formatTokens(-5)).toBe('0')
    expect(formatTokens(Number.NaN)).toBe('0')
  })
})

describe('formatCost', () => {
  it('prints cents with two decimals', () => {
    expect(formatCost(0.04)).toBe('$0.04')
    expect(formatCost(12.5)).toBe('$12.50')
  })

  it('says "less than a cent" rather than $0.00 for a tiny amount', () => {
    expect(formatCost(0.004)).toBe('<$0.01')
  })

  it('drops the decimals once the number is big enough not to need them', () => {
    expect(formatCost(1234.56)).toBe('$1235')
  })

  it('prints an exact zero as a zero', () => {
    expect(formatCost(0)).toBe('$0.00')
  })
})
