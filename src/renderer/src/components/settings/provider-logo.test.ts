/**
 * The monogram derivation. Pure functions, so this needs no DOM.
 *
 * What matters is that the colour is *stable* — a provider that changes swatch
 * between renders would be worse than no colour at all — and that the initials
 * rule never produces an empty mark, whatever the user types into the name field.
 */
import { describe, expect, it } from 'vitest'
import { PROVIDER_PRESETS } from '@shared/presets'
import { NEUTRAL_AVATAR_STYLE } from '../agents/agent-display'
import { providerInitials, providerLogo } from './provider-logo'

describe('providerInitials', () => {
  it('takes the initial of each of the first two words', () => {
    expect(providerInitials('LM Studio')).toBe('LM')
    expect(providerInitials('Volcengine Ark')).toBe('VA')
  })

  it('uses both capitals of a camel-cased single word', () => {
    expect(providerInitials('DeepSeek')).toBe('DS')
    expect(providerInitials('OpenRouter')).toBe('OR')
    expect(providerInitials('SiliconFlow')).toBe('SF')
  })

  it('title-cases the first two letters otherwise', () => {
    expect(providerInitials('Anthropic')).toBe('An')
    expect(providerInitials('google')).toBe('Go')
    expect(providerInitials('ollama')).toBe('Ol')
  })

  it('never returns an empty mark', () => {
    expect(providerInitials('')).toBe('?')
    expect(providerInitials('   ')).toBe('?')
    expect(providerInitials('X')).toBe('X')
  })

  it('gives every shipped preset a mark of one or two characters', () => {
    for (const preset of PROVIDER_PRESETS) {
      const text = providerInitials(preset.name)
      expect(text.length, preset.id).toBeGreaterThanOrEqual(1)
      expect(text.length, preset.id).toBeLessThanOrEqual(2)
    }
  })
})

describe('providerLogo', () => {
  it('gives the same preset the same colour every time', () => {
    expect(providerLogo('DeepSeek', 'deepseek')).toEqual(providerLogo('DeepSeek', 'deepseek'))
    // The colour follows the preset, not the name, so renaming keeps the swatch.
    expect(providerLogo('Work account', 'deepseek').color).toBe(
      providerLogo('DeepSeek', 'deepseek').color
    )
  })

  it('falls back to the neutral pair with no preset', () => {
    const logo = providerLogo('My Lab Box')

    expect(logo.text).toBe('ML')
    expect(logo.palette).toBeUndefined()
    expect(logo).toMatchObject(NEUTRAL_AVATAR_STYLE)
  })

  /**
   * The S5.17 rule: a tile is a *slot*, never a colour.
   *
   * Before it, this test asserted the opposite — that every logo was a literal
   * `#rrggbb` — which is exactly how eight dark chips ended up surviving onto
   * the light theme's near-white settings page. The assertion is inverted on
   * purpose, so a future change back to literals fails here rather than being
   * discovered by someone in light mode.
   */
  it('always produces a palette slot, named as tokens', () => {
    for (const preset of PROVIDER_PRESETS) {
      const logo = providerLogo(preset.name, preset.id)
      expect(logo.palette, preset.id).toBeGreaterThanOrEqual(1)
      expect(logo.palette, preset.id).toBeLessThanOrEqual(8)
      expect(logo.color, preset.id).toBe(`var(--color-avatar-${logo.palette}-bg)`)
      expect(logo.textColor, preset.id).toBe(`var(--color-avatar-${logo.palette}-fg)`)
    }
  })

  it('spreads its presets across the palette rather than crowding one slot', () => {
    const slots = new Set(PROVIDER_PRESETS.map((preset) => providerLogo(preset.name, preset.id).palette))
    expect(slots.size).toBeGreaterThan(3)
  })
})
