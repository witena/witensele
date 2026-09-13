/**
 * The derived values an agent is *shown* with, and the avatar palette the editor
 * offers.
 *
 * Two screens print the same three things about an agent — the list row on the
 * Agents page, the member row in the chat's right column — and both need the
 * provider's **name**, which lives on another record. Deriving it in one pure
 * module rather than in each component means the two never drift, and means the
 * rule "a provider that no longer exists still prints something useful" is
 * written once.
 *
 * Nothing here renders; it is plain TypeScript so it can be unit-tested in Node.
 */
import type { Agent, InitialAvatar, Provider } from '@shared/types'

/**
 * The eight monogram colours the avatar picker offers, background paired with
 * foreground.
 *
 * They are **literal colours rather than CSS variables** because an avatar is
 * *data*: the pair is copied into `agents.avatar` and stored in SQLite, where a
 * `var(--color-…)` reference would resolve to nothing. The values are the ones
 * the mockup's artboards use for their five agents plus three in the same family,
 * so a new agent looks like the design from the first render.
 */
export const AGENT_AVATAR_COLORS: readonly { color: string; textColor: string }[] = [
  { color: '#4a3a2f', textColor: '#e8b98a' },
  { color: '#2f3d4a', textColor: '#8ac0e8' },
  { color: '#3a2f4a', textColor: '#c0a0e8' },
  { color: '#2f4a47', textColor: '#8ae0d8' },
  { color: '#2f4a3e', textColor: '#9fd8b8' },
  { color: '#4a2f33', textColor: '#e8a0a8' },
  { color: '#4a452f', textColor: '#e0d88a' },
  { color: '#3a3a3a', textColor: '#b0aca4' }
]

/** The pair a brand-new agent starts on: the mockup's warm brown. */
export const DEFAULT_AGENT_AVATAR = AGENT_AVATAR_COLORS[0] as {
  color: string
  textColor: string
}

/**
 * The monogram derived from a name.
 *
 * One character, because the mockup's tiles hold one: the first Han character of
 * a Chinese name, the first letter of a Latin one. Uppercased so `reviewer` and
 * `Reviewer` look alike, and empty for an empty name so the tile renders blank
 * rather than showing punctuation the user did not choose.
 */
export function avatarInitial(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) return ''
  // `[...]` rather than `charAt`: an emoji or an astral-plane character is one
  // grapheme the user typed, not two halves of a surrogate pair.
  return ([...trimmed][0] as string).toUpperCase()
}

/** The avatar a name implies, keeping whatever colour pair is already chosen. */
export function avatarFor(name: string, palette = DEFAULT_AGENT_AVATAR): InitialAvatar {
  return { kind: 'initial', text: avatarInitial(name), ...palette }
}

/**
 * The provider's display name for an agent, or `undefined` when the provider is
 * gone.
 *
 * Deleting a provider does not delete the agents pointing at it — an agent is
 * worth keeping while its key is being replaced — so this genuinely returns
 * nothing sometimes, and the callers below print the model alone rather than the
 * word "unknown".
 */
export function providerNameFor(
  agent: Pick<Agent, 'providerId'>,
  providers: readonly Provider[]
): string | undefined {
  return providers.find((provider) => provider.id === agent.providerId)?.name
}

/**
 * The mono sub-line under an agent's name: `modelId · provider name`.
 *
 * The separator matches the mockup's `qwen2.5:14b · ollama`. With no provider it
 * degrades to the bare model id, which is still the more useful half.
 */
export function agentModelLabel(
  agent: Pick<Agent, 'providerId' | 'modelId'>,
  providers: readonly Provider[]
): string {
  const providerName = providerNameFor(agent, providers)
  return providerName ? `${agent.modelId} · ${providerName}` : agent.modelId
}
