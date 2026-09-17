/**
 * The arithmetic the palette is judged by.
 *
 * Small, but it is the *measuring instrument*: `theme.test.ts` decides whether
 * the app's colours are readable entirely on its answers, and the docs table in
 * `docs/features/ui-shell/frontend.md` is printed from them. A quietly wrong
 * luminance would make every one of those assertions pass for the wrong reason,
 * which is the worst failure mode a test helper has — so this file pins it to
 * the values WCAG itself states rather than to values it produced.
 */
import { describe, expect, it } from 'vitest'
import {
  AA_LARGE,
  AA_NORMAL,
  contrastRatio,
  formatRatio,
  parseHex,
  relativeLuminance,
  rgbDistanceSquared
} from './contrast'

describe('parseHex', () => {
  it('reads both lengths, either case, with or without the hash', () => {
    expect(parseHex('#ffffff')).toEqual({ r: 255, g: 255, b: 255 })
    expect(parseHex('#FFF')).toEqual({ r: 255, g: 255, b: 255 })
    expect(parseHex('4a2f22')).toEqual({ r: 74, g: 47, b: 34 })
    expect(parseHex('  #21384D  ')).toEqual({ r: 33, g: 56, b: 77 })
  })

  it('throws rather than returning NaN for anything else', () => {
    // A silent NaN propagates into a ratio of NaN, and `NaN < 4.5` is false — so
    // every contrast assertion in the suite would pass on an unparseable colour.
    for (const bad of ['', '#', '#12', '#12345', 'rebeccapurple', 'var(--color-fg)']) {
      expect(() => parseHex(bad), bad).toThrow()
    }
  })
})

describe('relativeLuminance', () => {
  it('anchors at the two ends WCAG defines', () => {
    expect(relativeLuminance('#000000')).toBe(0)
    expect(relativeLuminance('#ffffff')).toBe(1)
  })

  it('weights green far above blue, as the formula does', () => {
    expect(relativeLuminance('#00ff00')).toBeGreaterThan(relativeLuminance('#ff0000'))
    expect(relativeLuminance('#ff0000')).toBeGreaterThan(relativeLuminance('#0000ff'))
  })
})

describe('contrastRatio', () => {
  it('spans 1 to 21', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#3a3a3a', '#3a3a3a')).toBeCloseTo(1, 5)
  })

  it('does not care which argument is the foreground', () => {
    expect(contrastRatio('#1f1d1a', '#f7f4ef')).toBeCloseTo(contrastRatio('#f7f4ef', '#1f1d1a'), 10)
  })

  it('agrees with a published value', () => {
    // WCAG's own worked example: #777 on white is 4.48:1 — just under AA, which
    // is what makes it the useful one to pin.
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2)
  })

  it('names the two AA thresholds', () => {
    expect(AA_NORMAL).toBe(4.5)
    expect(AA_LARGE).toBe(3)
  })
})

describe('formatRatio', () => {
  it('is two decimals, the form the docs table prints', () => {
    expect(formatRatio(4.7123)).toBe('4.71')
    expect(formatRatio(21)).toBe('21.00')
  })
})

describe('rgbDistanceSquared', () => {
  it('is zero for a colour against itself, whatever the spelling', () => {
    expect(rgbDistanceSquared('#4a2f22', '4A2F22')).toBe(0)
    expect(rgbDistanceSquared('#fff', '#ffffff')).toBe(0)
  })

  it('orders by how far apart the channels are', () => {
    expect(rgbDistanceSquared('#000000', '#010101')).toBeLessThan(
      rgbDistanceSquared('#000000', '#0a0a0a')
    )
    expect(rgbDistanceSquared('#000000', '#ffffff')).toBe(3 * 255 * 255)
  })
})
