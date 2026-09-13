/**
 * Settings → Appearance & language.
 *
 * Two settings, one section, and they work the same way: the control writes the
 * stored setting through a handler module (`./theme.ts`, `./language.ts`) and
 * everything else — the palette, the active i18next language — follows from the
 * value that comes back. Neither control holds state of its own.
 *
 * The theme is a `SegmentedControl` and the language a `<select>` on purpose:
 * three options that the eye should compare at a glance (and that the user flips
 * between while looking at the result) versus a list that will grow with every
 * locale added. The language `<select>` and the quick toggle in the settings nav
 * are still two views of the same stored setting, not two settings.
 */
import { useTranslation } from 'react-i18next'
import type { ThemeSetting } from '@shared/types'
import { useSettingsStore, type LanguageSetting } from '../../stores/settings'
import { Field, SegmentedControl, Select } from '../../components/ui'
import { applyLanguageSetting } from './language'
import { applyThemeSetting } from './theme'

export function AppearanceSection(): React.JSX.Element {
  const { t } = useTranslation()
  const language = useSettingsStore((state) => state.settings?.language ?? 'system')
  const theme = useSettingsStore((state) => state.settings?.theme ?? 'system')

  // Literal `t()` calls rather than a key table: `i18n/used-keys.test.ts` cannot
  // see a key that is assembled at runtime (see `docs/features/ui-shell/`).
  const themeOptions: { value: ThemeSetting; label: string; testId: string }[] = [
    { value: 'system', label: t('settings.themeSystem'), testId: 'theme-system' },
    { value: 'light', label: t('settings.themeLight'), testId: 'theme-light' },
    { value: 'dark', label: t('settings.themeDark'), testId: 'theme-dark' }
  ]

  return (
    <div className="flex max-w-lg flex-col gap-4">
      <Field label={t('settings.theme')} layout="column">
        <SegmentedControl
          value={theme}
          onChange={applyThemeSetting}
          options={themeOptions}
          className="w-full"
        />
      </Field>
      <p className="text-xs leading-relaxed text-fg-faint">{t('settings.themeHint')}</p>

      <Field label={t('settings.language')} htmlFor="settings-language" layout="column">
        <Select
          id="settings-language"
          data-testid="settings-language-select"
          wrapperClassName="w-full"
          className="w-full py-1.5"
          value={language}
          onChange={(event) => applyLanguageSetting(event.target.value as LanguageSetting)}
          options={[
            { value: 'system', label: t('settings.languageSystem') },
            { value: 'zh-CN', label: t('settings.languageZh') },
            { value: 'en', label: t('settings.languageEn') }
          ]}
        />
      </Field>
      <p className="text-xs leading-relaxed text-fg-faint">{t('settings.languageHint')}</p>
    </div>
  )
}
