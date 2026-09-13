/**
 * The renderer half of the appearance setting: one attribute on `<html>`.
 *
 * `applyTheme` stamps `data-theme="light"` or `data-theme="dark"` on the document
 * element and nothing else. Every colour in the app is a `--color-*` token and
 * the light palette in `index.css` is an override on `:root[data-theme='light']`,
 * so that single attribute repaints the whole tree — no context, no provider, no
 * component re-render, and no risk of one screen keeping the other palette
 * because it did not subscribe to anything.
 *
 * `'system'` is the interesting case: it is a standing rule rather than a value,
 * so the function also subscribes to `matchMedia('(prefers-color-scheme: dark)')`
 * and re-stamps when the machine flips (macOS does that on a schedule). It
 * returns the unsubscribe, and the caller is expected to call it before applying
 * a new setting — the bootstrap and `stores/settings.ts` both keep exactly one
 * subscription alive, which is what `applyThemeSetting` in
 * `pages/settings/theme.ts` exists to guarantee.
 *
 * `resolveTheme` itself lives in `@shared/theme`: the main process makes the same
 * decision when it picks the window's `backgroundColor`, and one copy of that
 * rule is one chance to disagree about the first frame. It is re-exported here so
 * renderer code has a single import for the theme.
 */
import { resolveTheme, type ResolvedTheme } from '@shared/theme'
import type { ThemeSetting } from '@shared/types'

export { resolveTheme }
export type { ResolvedTheme }

/** The media query `'system'` follows. */
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)'

/** The attribute the light palette in `index.css` keys off. */
export const THEME_ATTRIBUTE = 'data-theme'

/**
 * What the machine currently prefers.
 *
 * Defensive about `matchMedia` being absent: the unit tests run in Node, where
 * jsdom may not provide it, and a missing media query is "not dark" rather than
 * an exception that would take the bootstrap down with it.
 */
export function prefersDarkScheme(): boolean {
  return globalThis.matchMedia?.(DARK_SCHEME_QUERY).matches ?? false
}

/** Writes the resolved theme onto `<html>`. Exported for the tests. */
export function stampTheme(theme: ResolvedTheme): void {
  document.documentElement.setAttribute(THEME_ATTRIBUTE, theme)
}

/**
 * Applies the setting and, for `'system'`, keeps following the machine.
 *
 * Returns the unsubscribe function; it is a no-op for an explicit `'light'` or
 * `'dark'`, so the caller never has to branch on the setting it just passed in.
 */
export function applyTheme(setting: ThemeSetting): () => void {
  stampTheme(resolveTheme(setting, prefersDarkScheme()))
  if (setting !== 'system') return () => {}

  const query = globalThis.matchMedia?.(DARK_SCHEME_QUERY)
  if (!query) return () => {}

  const listener = (event: MediaQueryListEvent): void => {
    stampTheme(resolveTheme('system', event.matches))
  }
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

/**
 * The window's current subscription, so that switching away from `'system'`
 * really stops following the machine.
 *
 * A leaked listener would be invisible until the OS flipped at sunset and
 * repainted an app the user had explicitly set to light, which is exactly the
 * kind of bug nobody reproduces on purpose. One module-level slot is enough:
 * there is one document.
 */
let stopFollowing: (() => void) | null = null

/** Applies a setting as *the* current one, replacing whatever was active. */
export function activateTheme(setting: ThemeSetting): void {
  stopFollowing?.()
  stopFollowing = applyTheme(setting)
}
