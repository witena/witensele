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
import { AGENT_AVATAR_COLORS, agentModelLabel, avatarFor, avatarInitial } from './agent-display'

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
    const palette = AGENT_AVATAR_COLORS[2] as { color: string; textColor: string }

    expect(avatarFor('Bob', palette)).toEqual({
      kind: 'initial',
      text: 'B',
      color: palette.color,
      textColor: palette.textColor
    })
  })

  it('offers eight distinct colours', () => {
    expect(AGENT_AVATAR_COLORS).toHaveLength(8)
    expect(new Set(AGENT_AVATAR_COLORS.map((entry) => entry.color)).size).toBe(8)
  })
})
