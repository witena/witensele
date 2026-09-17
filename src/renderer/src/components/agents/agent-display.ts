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
import {
  AVATAR_PALETTE_INDEXES,
  type Agent,
  type AvatarPaletteIndex,
  type InitialAvatar,
  type Provider
} from '@shared/types'
import { rgbDistanceSquared } from '../../lib/contrast'

/**
 * The colour pair a tile is painted with: two CSS values, ready for an inline
 * style.
 *
 * Both are `var(--color-…)` references since S5.17, which is the whole point —
 * an avatar used to be painted from the hex in its own record, so it stayed a
 * dark slab on the light theme's near-white panels. The tile now names a slot
 * and the stylesheet decides what that slot looks like in the appearance that is
 * actually painted.
 */
export interface AvatarStyle {
  color: string
  textColor: string
}

/**
 * The eight amber-era pairs, exactly as S5.8 shipped them.
 *
 * **This is the stored-data table, not the palette.** Every agent created before
 * S5.17 has one of these hexes in `agents.avatar.color`, and every agent created
 * *after* it still carries one as a compatibility shadow (see
 * `InitialAvatar.color`). Two jobs, both of them about records rather than about
 * appearance:
 *
 * 1. `nearestAvatarPalette` maps a stored hex back to the index it means, so a
 *    record written in 2026 renders on the new tokens with no migration, no
 *    write on read, and no half-converted database if the app is killed.
 * 2. `avatarFor` / the picker copy the pair into new records, so a build that
 *    does not understand `palette` — an older one, an export, the future server
 *    — still has a colour.
 *
 * It is therefore the one module outside `index.css` and the brand mark where a
 * hex literal is allowed, and `hex-literals.test.ts` names it explicitly.
 * **Do not add a ninth entry**: the list is the history of what was stored, not
 * a place to design.
 */
export const LEGACY_AVATAR_COLORS: readonly AvatarStyle[] = [
  { color: '#4a3a2f', textColor: '#e8b98a' },
  { color: '#2f3d4a', textColor: '#8ac0e8' },
  { color: '#3a2f4a', textColor: '#c0a0e8' },
  { color: '#2f4a47', textColor: '#8ae0d8' },
  { color: '#2f4a3e', textColor: '#9fd8b8' },
  { color: '#4a2f33', textColor: '#e8a0a8' },
  { color: '#4a452f', textColor: '#e0d88a' },
  { color: '#3a3a3a', textColor: '#b0aca4' }
]

/** One entry of what the avatar picker offers: an index plus its stored shadow. */
export interface AvatarPaletteEntry extends AvatarStyle {
  palette: AvatarPaletteIndex
}

/**
 * The eight entries the avatar picker offers, in order.
 *
 * Spreading one of these into an `InitialAvatar` writes all three fields at
 * once, which is why every call site that used to do `{ ...palette }` still
 * does — it now also carries the index that actually gets painted.
 */
export const AGENT_AVATAR_COLORS: readonly AvatarPaletteEntry[] = AVATAR_PALETTE_INDEXES.map(
  (palette) => ({
    palette,
    ...(LEGACY_AVATAR_COLORS[palette - 1] as AvatarStyle)
  })
)

/** The entry a brand-new agent starts on. */
export const DEFAULT_AGENT_AVATAR = AGENT_AVATAR_COLORS[0] as AvatarPaletteEntry

/** The tile an avatar with no usable index or colour is drawn on. */
export const NEUTRAL_AVATAR_STYLE: AvatarStyle = {
  color: 'var(--color-avatar-neutral-bg)',
  textColor: 'var(--color-avatar-neutral-fg)'
}

/** The two token references for one palette index. */
export function avatarPaletteStyle(palette: AvatarPaletteIndex): AvatarStyle {
  return {
    color: `var(--color-avatar-${palette}-bg)`,
    textColor: `var(--color-avatar-${palette}-fg)`
  }
}

/**
 * The palette entry a stored hex means, by plain RGB distance.
 *
 * "Nearest" rather than "equal" on purpose. The eight legacy values map back to
 * themselves exactly, which is the case that matters; but `agents.avatar` is a
 * JSON blob with no constraint on it, and S1.x fixtures, a hand-edited row and a
 * future import can all put something else there. Answering *some* index for any
 * parseable colour means the renderer never has to draw a tile it has no rule
 * for, and the answer is stable — the same hex always lands on the same tile.
 *
 * An unparseable or missing colour is `undefined`, and the caller falls back to
 * the neutral tile rather than to a colour the user never picked.
 */
export function nearestAvatarPalette(color: string | undefined): AvatarPaletteIndex | undefined {
  if (!color) return undefined
  let best: AvatarPaletteIndex | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const entry of AGENT_AVATAR_COLORS) {
    let distance: number
    try {
      distance = rgbDistanceSquared(color, entry.color)
    } catch {
      // Not a hex at all — `oklch(…)`, a named colour, a truncated string. There
      // is nothing to be near, so the whole lookup gives up rather than guessing
      // from whichever entry happened to parse.
      return undefined
    }
    if (distance < bestDistance) {
      bestDistance = distance
      best = entry.palette
    }
  }
  return best
}

/**
 * The palette entry an avatar is *effectively* on.
 *
 * The stored index wins; a record that predates it is resolved through the table
 * above; anything else is `undefined`. One rule, so the tile the message list
 * draws and the swatch the editor marks as pressed can never disagree.
 */
export function avatarPalette(
  avatar: Pick<InitialAvatar, 'palette' | 'color'>
): AvatarPaletteIndex | undefined {
  return avatar.palette ?? nearestAvatarPalette(avatar.color)
}

/**
 * What to paint one agent's tile with: the entry above, or the neutral slot.
 *
 * Pure, so the two dozen call sites that draw an avatar all agree without any of
 * them knowing the rule.
 */
export function avatarStyle(avatar: Pick<InitialAvatar, 'palette' | 'color'>): AvatarStyle {
  const palette = avatarPalette(avatar)
  return palette ? avatarPaletteStyle(palette) : NEUTRAL_AVATAR_STYLE
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

/** The avatar a name implies, keeping whatever palette entry is already chosen. */
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

/**
 * Whether this agent is the one allowed to change things (S5.2).
 *
 * A one-line predicate, but it is the rule four surfaces draw a badge from — the
 * agent list, the member row, the message header and the member picker — and a
 * literal `=== 'executor'` repeated in four components is four places to miss
 * when the role set grows.
 */
export function isExecutor(agent: Pick<Agent, 'role'>): boolean {
  return agent.role === 'executor'
}

/**
 * Whether a member list already holds the chat's one executor.
 *
 * The member picker greys an executor candidate out with this rather than
 * letting the click be refused by the backend: a disabled row with a reason is a
 * better answer than an error line in another column. The backend refusal stays
 * the authority — a second window, or a future HTTP client, is not this picker.
 */
export function hasExecutor(agents: readonly Pick<Agent, 'role'>[]): boolean {
  return agents.some(isExecutor)
}
