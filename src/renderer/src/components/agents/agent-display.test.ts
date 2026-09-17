/**
 * The derived strings two screens print about an agent.
 *
 * The case that matters is the one nobody writes by hand: a provider that was
 * deleted while agents still point at it. The label has to degrade to the model
 * id rather than to `undefined` or to the word "unknown".
 */
import { describe, expect, it } from 'vitest'
import type { Provider } from '@shared/types'
import { LOCAL_USER_ID } from '@shared/types'
import {
  AGENT_AVATAR_COLORS,
  LEGACY_AVATAR_COLORS,
  NEUTRAL_AVATAR_STYLE,
  agentModelLabel,
  avatarFor,
  avatarInitial,
  avatarPalette,
  avatarPaletteStyle,
  avatarStyle,
  hasExecutor,
  isExecutor,
  nearestAvatarPalette,
  type AvatarPaletteEntry
} from './agent-display'

const ollama: Provider = {
  id: 'p1',
  userId: LOCAL_USER_ID,
  createdAt: 0,
  updatedAt: 0,
  type: 'openai-compatible',
  name: 'Ollama',
  models: ['qwen2.5:1.5b'],
  hasApiKey: false
}

describe('agentModelLabel', () => {
  it('joins the model id and the provider name', () => {
    expect(agentModelLabel({ providerId: 'p1', modelId: 'qwen2.5:1.5b' }, [ollama])).toBe(
      'qwen2.5:1.5b · Ollama'
    )
  })

  it('falls back to the bare model id when the provider is gone', () => {
    expect(agentModelLabel({ providerId: 'deleted', modelId: 'qwen2.5:1.5b' }, [ollama])).toBe(
      'qwen2.5:1.5b'
    )
  })
})

describe('avatarInitial', () => {
  it('uppercases the first character of a Latin name', () => {
    expect(avatarInitial('reviewer')).toBe('R')
    expect(avatarInitial('  architect ')).toBe('A')
  })

  it('is empty for an empty name', () => {
    expect(avatarInitial('   ')).toBe('')
  })

  it('takes one whole character, not half a surrogate pair', () => {
    expect([...avatarInitial('𝒜da')]).toHaveLength(1)
  })
})

describe('avatarFor', () => {
  it('builds an initial avatar on the palette entry it was given', () => {
    const entry = AGENT_AVATAR_COLORS[2] as AvatarPaletteEntry

    expect(avatarFor('Bob', entry)).toEqual({
      kind: 'initial',
      text: 'B',
      palette: 3,
      color: entry.color,
      textColor: entry.textColor
    })
  })

  it('offers eight distinct entries, indexed 1 to 8 in order', () => {
    expect(AGENT_AVATAR_COLORS).toHaveLength(8)
    expect(AGENT_AVATAR_COLORS.map((entry) => entry.palette)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(new Set(AGENT_AVATAR_COLORS.map((entry) => entry.color)).size).toBe(8)
  })
})

/**
 * The migration that is not a migration (S5.17).
 *
 * Nothing rewrites `agents.avatar`; a record keeps whatever hex it was written
 * with and is resolved to a palette slot as it is drawn. The test that matters
 * is therefore the round trip: every one of the eight colours the old build
 * could have stored has to come back as the slot the user actually picked, or
 * an existing agent silently changes colour on upgrade.
 */
describe('nearestAvatarPalette', () => {
  it('maps each of the eight stored hexes back to its own slot', () => {
    LEGACY_AVATAR_COLORS.forEach((legacy, index) => {
      expect(nearestAvatarPalette(legacy.color), legacy.color).toBe(index + 1)
    })
  })

  it('ignores case and accepts the short form', () => {
    expect(nearestAvatarPalette('#2F3D4A')).toBe(2)
    expect(nearestAvatarPalette('#333')).toBe(8)
  })

  it('answers some slot, always the same one, for a hex nobody ever offered', () => {
    // A hand-edited row, an import, or one of the pre-S2.1 fixtures (`#c2653a`
    // is `db/testing.ts`'s). The requirement is only that the renderer never has
    // a tile it has no rule for, and that the answer does not move between runs
    // or between machines — *not* that the match is perceptually the prettiest.
    // The table it measures against is eight dark slabs, so a bright colour's
    // nearest neighbour in RGB is decided mostly by the ratio of its channels;
    // `#c2653a` landing on the olive slot rather than the terracotta one is that
    // effect, and it is fine for data the picker cannot produce.
    for (const orphan of ['#c2653a', '#0000ff', '#ffffff']) {
      const answer = nearestAvatarPalette(orphan)
      expect(AGENT_AVATAR_COLORS.map((entry) => entry.palette), orphan).toContain(answer)
      expect(nearestAvatarPalette(orphan), orphan).toBe(answer)
    }
  })

  it('gives up rather than guessing on something that is not a hex', () => {
    expect(nearestAvatarPalette(undefined)).toBeUndefined()
    expect(nearestAvatarPalette('')).toBeUndefined()
    expect(nearestAvatarPalette('rebeccapurple')).toBeUndefined()
    expect(nearestAvatarPalette('oklch(0.7 0.1 40)')).toBeUndefined()
  })
})

describe('avatarStyle', () => {
  it('paints a stored index from its tokens', () => {
    expect(avatarStyle({ palette: 4, color: '#000000' })).toEqual({
      color: 'var(--color-avatar-4-bg)',
      textColor: 'var(--color-avatar-4-fg)'
    })
  })

  it('prefers the stored index over the legacy colour beside it', () => {
    // Every record the current build writes carries both. If the shadow ever won
    // here, a light-theme tile would go back to being a dark slab.
    expect(avatarPalette({ palette: 7, color: LEGACY_AVATAR_COLORS[1]?.color })).toBe(7)
  })

  it('resolves a record that predates the index', () => {
    expect(avatarStyle({ color: '#2f3d4a' })).toEqual(avatarPaletteStyle(2))
  })

  it('falls back to the neutral tile when there is nothing to resolve', () => {
    expect(avatarStyle({ color: 'transparent' })).toEqual(NEUTRAL_AVATAR_STYLE)
  })

  it('never returns a literal colour', () => {
    for (const entry of AGENT_AVATAR_COLORS) {
      const style = avatarPaletteStyle(entry.palette)
      expect(style.color).toBe(`var(--color-avatar-${entry.palette}-bg)`)
      expect(style.textColor).toBe(`var(--color-avatar-${entry.palette}-fg)`)
    }
  })
})

describe('the executor predicates', () => {
  it('recognises the one role that may change things', () => {
    expect(isExecutor({ role: 'executor' })).toBe(true)
    expect(isExecutor({ role: 'participant' })).toBe(false)
  })

  it('answers whether a member list already holds the one writer', () => {
    expect(hasExecutor([])).toBe(false)
    expect(hasExecutor([{ role: 'participant' }, { role: 'participant' }])).toBe(false)
    expect(hasExecutor([{ role: 'participant' }, { role: 'executor' }])).toBe(true)
  })
})
