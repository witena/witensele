/**
 * The one place the Editor controls go through, mirroring `./theme.ts` and
 * `./language.ts` (S5.7).
 *
 * `setEditor` rejects when the write fails — the backend refuses an unknown kind
 * and a blank command — and the failure has to land somewhere the user can be
 * told about, which is the store's `error` field that Settings → Developer
 * already renders a few lines above these controls.
 *
 * Unlike the theme there is nothing optimistic to undo: no pixel depends on this
 * value until the next click on a file reference, so the control simply shows the
 * stored setting and the store is the only writer.
 */
import type { EditorSettings } from '@shared/types'
import { useSettingsStore } from '../../stores/settings'

export function applyEditorSetting(patch: Partial<EditorSettings>): void {
  void useSettingsStore
    .getState()
    .setEditor(patch)
    .catch((cause: unknown) => {
      useSettingsStore.setState({
        error: cause instanceof Error ? cause.message : String(cause)
      })
    })
}
