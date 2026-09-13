/**
 * The appearance rule, shared by the two processes that have to paint.
 *
 * `AppSettings.theme` is a *setting* (`system` / `light` / `dark`); everything
 * that draws needs a *theme* (`light` / `dark`). Turning one into the other is
 * one line, and it lives here rather than in either process because both make
 * the same decision from different inputs:
 *
 * - the renderer resolves `'system'` against `matchMedia('(prefers-color-scheme: dark)')`
 *   (`src/renderer/src/lib/theme.ts`, which re-exports `resolveTheme`),
 * - the main process resolves it against `nativeTheme.shouldUseDarkColors` when
 *   it picks the window's `backgroundColor` (`src/main/index.ts`).
 *
 * Two copies of a boolean would be two chances to disagree about the first frame,
 * which is the one frame the user cannot miss. Pure data and pure functions only:
 * no electron, no DOM, no node (CLAUDE.md rule #5).
 */
import type { ThemeSetting } from './types'

/** What a theme resolves to: the two palettes `index.css` actually defines. */
export type ResolvedTheme = 'light' | 'dark'

/**
 * The setting plus what the machine prefers, as the theme to paint.
 *
 * `prefersDark` is only consulted for `'system'`; an explicit choice wins over
 * the operating system, which is the whole point of offering the choice.
 */
export function resolveTheme(setting: ThemeSetting, prefersDark: boolean): ResolvedTheme {
  if (setting === 'light') return 'light'
  if (setting === 'dark') return 'dark'
  return prefersDark ? 'dark' : 'light'
}

/**
 * `--color-bg-base` of each theme, duplicated here for one reason: the Electron
 * window is painted **before** any stylesheet exists, so `createWindow` needs the
 * colour as a string. `src/renderer/src/lib/theme.test.ts` reads `index.css` and
 * asserts the two agree, so the copy cannot drift into a flash of the wrong
 * colour.
 */
export const WINDOW_BACKGROUND: Record<ResolvedTheme, string> = {
  dark: '#171614',
  light: '#f7f4ef'
}
