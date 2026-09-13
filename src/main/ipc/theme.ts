/**
 * The second handler that must import electron (S5.8).
 *
 * Same shape as `./dialogs.ts` and the same justification: the renderer paints
 * the page, but `titleBarStyle: 'hiddenInset'` leaves the traffic lights to the
 * platform, and the platform decides whether to draw them light or dark from
 * `nativeTheme.themeSource`. There is no injectable stand-in for it — it is the
 * window system — so the exception is made in the layer that is already allowed
 * to import electron and nowhere else:
 *
 * - `handlers/system.ts` declares the method and rejects with
 *   `APPLY_THEME_UNAVAILABLE`, keeping the Electron-free map total;
 * - `registerIpc` layers this module over it;
 * - a server build layers nothing, and the rejection is the truth.
 *
 * `themeSource` maps one-to-one onto the stored setting, `'system'` included —
 * electron's own word for it is `'system'` too — so nothing is resolved here.
 * Resolution happens where something is actually painted: `resolveTheme` in the
 * renderer, and `nativeTheme.shouldUseDarkColors` in `src/main/index.ts` when it
 * picks the new window's `backgroundColor`.
 *
 * Setting `themeSource` is also what makes the value stick for windows opened
 * later (macOS `activate`), so the main process does not have to remember it.
 */
import { nativeTheme } from 'electron'
import { THEME_SETTINGS, type ThemeSetting } from '@shared/types'
import { validation } from '../errors'
import type { HandlerModule } from '../handlers/types'

function assertTheme(theme: unknown): asserts theme is ThemeSetting {
  if (!THEME_SETTINGS.includes(theme as ThemeSetting)) {
    throw validation(`system.applyTheme received an unknown theme: ${String(theme)}`)
  }
}

export const themeHandlers: HandlerModule = {
  'system.applyTheme': async (_ctx, input) => {
    assertTheme(input?.theme)
    nativeTheme.themeSource = input.theme
  }
}
