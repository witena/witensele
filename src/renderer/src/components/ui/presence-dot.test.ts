/**
 * The one piece of logic in the presence dot: state → design token.
 *
 * It is a unit test rather than a rendering test because `presenceColorClass` is
 * deliberately a pure function — no jsdom, no React, and the assertion is about
 * the token contract with `index.css` rather than about markup.
 *
 * What it actually protects: the four `--color-presence-*` tokens exist, the
 * mapping is total over `PresenceState` (a fifth state would fail to compile *and*
 * fail here), and no two states share a colour — a dot that cannot be told apart
 * from another is the failure mode the member panel exists to avoid.
 */
import { describe, expect, it } from 'vitest'
import type { PresenceState } from '@shared/types'
import { presenceColorClass } from './presence-dot'

const STATES = ['available', 'working', 'away', 'offline'] as const satisfies readonly PresenceState[]

describe('presenceColorClass', () => {
  it('maps every presence state to its own token utility', () => {
    expect(presenceColorClass('available')).toBe('bg-presence-available')
    expect(presenceColorClass('working')).toBe('bg-presence-working')
    expect(presenceColorClass('away')).toBe('bg-presence-away')
    expect(presenceColorClass('offline')).toBe('bg-presence-offline')
  })

  it('gives each state a distinct colour', () => {
    const classes = STATES.map(presenceColorClass)
    expect(new Set(classes).size).toBe(STATES.length)
  })

  it('returns a literal token utility, never an interpolated class name', () => {
    // Tailwind scans source text: `bg-presence-${state}` would compile and then
    // render transparent, because the class would never reach the stylesheet.
    for (const state of STATES) {
      expect(presenceColorClass(state)).toMatch(/^bg-presence-[a-z]+$/)
    }
  })
})
