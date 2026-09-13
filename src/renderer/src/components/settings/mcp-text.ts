/**
 * The one rule behind the editor's line-list boxes (arguments, environment,
 * headers): **the text the user is typing is not the value the draft stores.**
 *
 * The draft keeps `args` as `string[]` and `env` as a map, because that is what
 * the backend validates and what every other reader of the store wants. The box
 * keeps the raw text, because a normaliser is lossy in exactly the places a
 * half-typed line lives in: `textToArgs` drops empty lines, so the Enter that
 * starts a second argument is an empty line until the first character of that
 * argument is typed; `textToEnv` drops a line with no `=`, so a variable name is
 * nothing until its `=` arrives. A box that rendered the draft back on every
 * keystroke would erase the newline (or the name) the user just typed and put
 * the caret back at the end of the previous line — which is what it did until
 * this module existed.
 *
 * So the box shows its own text and pushes the normalised value into the draft
 * on every change. The only question left is when the draft must win over the
 * text, and `visibleText` answers it without an effect or a reset key: the text
 * is shown for as long as it still normalises to what the draft holds. The
 * moment the draft says something the text cannot account for — another server
 * was opened, "Add" started a fresh draft — the draft is rendered instead, and
 * the next keystroke replaces the stale local text.
 */
import { argsToText, envToText, textToArgs, textToEnv } from '../../stores/mcp'

/** The text a line-list box shows: what was typed, unless the draft moved on. */
export function visibleText(
  typed: string,
  stored: string,
  normalise: (text: string) => string
): string {
  return normalise(typed) === stored ? typed : stored
}

/** `argsToText ∘ textToArgs`: the text form the draft would render for this text. */
export function canonicalArgs(text: string): string {
  return argsToText(textToArgs(text))
}

/** `envToText ∘ textToEnv`, likewise. */
export function canonicalEnv(text: string): string {
  return envToText(textToEnv(text))
}
