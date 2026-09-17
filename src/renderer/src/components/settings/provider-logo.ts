/**
 * The monogram a provider is recognised by: two letters on a tinted square,
 * exactly as in the settings artboard.
 *
 * Both halves are **derived, never stored**. A colour picked from the preset id
 * means a provider looks the same in the list, in the preset grid and (later) in
 * an agent's model dropdown without a `logoColor` column that could drift; and
 * initials taken from the name mean a custom endpoint gets a sensible mark
 * without asking the user to choose one.
 *
 * Until S5.17 the palette was eight literal hexes of its own — the same
 * amber-era family the agent avatars used — so a provider tile was a dark chip
 * on a near-white page in the light theme. It is the **same eight tokens as the
 * agent palette** now (`avatarPaletteStyle`), for the same reason and with the
 * one extra benefit that the app has one set of monogram colours instead of two
 * lists that drifted. The assignment rule is unchanged — a preset still lands on
 * the slot its id hashes to — but slots 5 and 6 held a red and a green in the
 * provider list and a green and a rose in the agent one, so a preset that hashes
 * to either of those two changes hue once, at this step. That is the price of
 * having one list; every other preset keeps the colour it had.
 *
 * Witena's own mark is not one of these; `--color-brand-point` is an identity
 * and keeps its colour in both appearances (S7.1).
 */
import type { AvatarPaletteIndex } from '@shared/types'
import {
  AGENT_AVATAR_COLORS,
  NEUTRAL_AVATAR_STYLE,
  avatarPaletteStyle,
  type AvatarStyle
} from '../agents/agent-display'

/**
 * One monogram: the two CSS values the tile is painted with, plus the slot they
 * came from so a test (and a reader) can say *which* swatch was picked without
 * matching on a colour. `palette` is absent for the neutral, presetless tile.
 */
export interface ProviderLogo extends AvatarStyle {
  text: string
  palette?: AvatarPaletteIndex
}

/**
 * A small, stable string hash.
 *
 * Deterministic across runs and machines is the whole requirement: the same
 * preset must always land on the same swatch, so a user who learns "DeepSeek is
 * the blue one" is never surprised. FNV-1a is two lines and does that.
 */
function hash(value: string): number {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return result >>> 0
}

/**
 * One or two characters for a name.
 *
 * - A first word that is already an acronym: its first two letters
 *   (`LM Studio` → `LM`), because that is the part people actually say.
 * - Two or more words otherwise: the initial of each of the first two
 *   (`Volcengine Ark` → `VA`).
 * - One word with an inner capital: both capitals (`DeepSeek` → `DS`).
 * - Otherwise: the first two letters, title-cased (`Anthropic` → `An`).
 *
 * Non-Latin names fall back to their first character, which is what a Chinese
 * provider name in the user's own wording would produce and is fine as a mark.
 */
export function providerInitials(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) return '?'

  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length > 1) {
    const first = words[0] as string
    if (/^[A-Z]{2,}$/.test(first)) return first.slice(0, 2)
    return (first[0] ?? '').toUpperCase() + (words[1]?.[0] ?? '').toUpperCase()
  }

  const word = words[0] as string
  const innerCapital = word.slice(1).match(/[A-Z]/)
  if (innerCapital) return (word[0] as string).toUpperCase() + innerCapital[0]

  if (!/^[A-Za-z]/.test(word)) return word.slice(0, 1)
  return (word[0] as string).toUpperCase() + (word[1] ?? '').toLowerCase()
}

/**
 * The monogram for a provider or a preset.
 *
 * `presetId` drives the colour so that a renamed provider keeps its swatch; a
 * provider with no preset gets the neutral pair, which reads as "you configured
 * this one yourself".
 */
export function providerLogo(name: string, presetId?: string | undefined): ProviderLogo {
  const text = providerInitials(name)
  if (!presetId) return { text, ...NEUTRAL_AVATAR_STYLE }
  const entry = AGENT_AVATAR_COLORS[hash(presetId) % AGENT_AVATAR_COLORS.length]
  if (!entry) return { text, ...NEUTRAL_AVATAR_STYLE }
  return { text, palette: entry.palette, ...avatarPaletteStyle(entry.palette) }
}
