/**
 * The one place the appearance control goes through, mirroring `./language.ts`.
 *
 * `setTheme` rejects when the write fails, and the failure has to land somewhere
 * the user can be told about: the store's `error` field, which Settings →
 * Developer renders. The window itself has already repainted optimistically by
 * then — that is deliberate. A theme that did not persist is a small, visible,
 * self-correcting problem (the next launch is the old theme); a click that does
 * nothing while a round trip completes is a control that feels broken.
 */
import { useSettingsStore } from '../../stores/settings'
import type { ThemeSetting } from '@shared/types'

export function applyThemeSetting(setting: ThemeSetting): void {
  void useSettingsStore
    .getState()
    .setTheme(setting)
    .catch((cause: unknown) => {
      useSettingsStore.setState({
        error: cause instanceof Error ? cause.message : String(cause)
      })
    })
}
