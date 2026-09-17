/**
 * WCAG relative luminance and contrast, in about twenty lines.
 *
 * The palette in `index.css` makes a promise — "each foreground keeps at least
 * its dark counterpart's contrast on its own surface" (S5.8) — that was checked
 * by pasting hexes into a web tool. S5.17 turns it into arithmetic the suite
 * runs: `theme.test.ts` reads the two palette blocks as text and asserts the
 * body-copy steps are AA on every surface token, and `docs/features/ui-shell/
 * frontend.md` prints the whole matrix from the same function.
 *
 * It lives under `lib/` rather than beside the test because two callers want it
 * and because it is ordinary pure code: no DOM, no colour library, nothing to
 * mock. It is not imported by any component, so it never reaches the bundle.
 *
 * Only `#rgb` and `#rrggbb` are understood. That is deliberately narrow: the
 * only colours it is ever handed come out of `index.css`, and a silent `NaN`
 * from a format nobody uses would make the assertions pass for the wrong reason
 * — so an unparseable string throws instead.
 */

/** One colour as 0–255 channels. */
export interface Rgb {
  r: number
  g: number
  b: number
}

/** `#abc` or `#aabbcc` → channels. Throws on anything else. */
export function parseHex(color: string): Rgb {
  const value = color.trim().replace(/^#/, '')
  const full =
    value.length === 3
      ? [...value].map((digit) => `${digit}${digit}`).join('')
      : value.length === 6
        ? value
        : ''
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Not a hex colour: ${color}`)
  }
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16)
  }
}

/** The sRGB → linear transfer function WCAG 2.x specifies. */
function linear(channel: number): number {
  const value = channel / 255
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(color: string): number {
  const { r, g, b } = parseHex(color)
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/**
 * The contrast ratio between two colours, 1 to 21.
 *
 * Order does not matter: the brighter of the two is always the numerator, which
 * is what lets a caller pass "foreground, background" without thinking about
 * which one is which.
 */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a)
  const second = relativeLuminance(b)
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}

/** The two WCAG AA thresholds: normal text, and text at 18.66px+ or bold 14px+. */
export const AA_NORMAL = 4.5
export const AA_LARGE = 3

/** `4.71` — the form the docs table and the failure messages both print. */
export function formatRatio(ratio: number): string {
  return ratio.toFixed(2)
}

/**
 * Squared distance in RGB between two colours.
 *
 * Used by the legacy-avatar mapping in `components/agents/agent-display.ts`,
 * which only has to answer "which of these eight is this one", not "how
 * different do these look" — so plain Euclidean RGB is the right amount of
 * colour science. Squared, because nothing compares the value to anything but
 * another distance.
 */
export function rgbDistanceSquared(a: string, b: string): number {
  const first = parseHex(a)
  const second = parseHex(b)
  return (
    (first.r - second.r) ** 2 + (first.g - second.g) ** 2 + (first.b - second.b) ** 2
  )
}
