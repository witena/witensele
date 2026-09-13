/**
 * The one place the two language controls (the quick toggle at the bottom of the
 * settings nav and the select in Appearance & language) go through.
 *
 * `setLanguage` rejects when the write fails — that is its documented contract,
 * so the caller can surface the failure instead of the store swallowing it. Both
 * callers want the same treatment, so the handling lives here: the message goes
 * into the store's `error` field, which is the single surface the Developer
 * section renders under `data-testid="error"`. Without this the optimistic
 * highlight would simply snap back on the next load with no explanation.
 */
import { useSettingsStore, type LanguageSetting } from '../../stores/settings'

export function applyLanguageSetting(setting: LanguageSetting): void {
  void useSettingsStore
    .getState()
    .setLanguage(setting)
    .catch((cause: unknown) => {
      useSettingsStore.setState({
        error: cause instanceof Error ? cause.message : String(cause)
      })
    })
}
