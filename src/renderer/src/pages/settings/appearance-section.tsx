/**
 * Settings → Appearance & language.
 *
 * The only settings section with real behaviour in S1.5, because the language
 * setting is the only one the backend already stores (S1.4). Theme is not offered:
 * `AppSettings.theme` exists but has exactly one value, and a control with one
 * option is worse than no control.
 *
 * The `<select>` and the quick toggle in the settings nav are two views of the
 * same stored setting, not two settings: both read `settings.language` and both
 * write through `applyLanguageSetting`.
 */
import { useTranslation } from 'react-i18next'
import { useSettingsStore, type LanguageSetting } from '../../stores/settings'
import { Field, Select } from '../../components/ui'
import { applyLanguageSetting } from './language'

export function AppearanceSection(): React.JSX.Element {
  const { t } = useTranslation()
  const language = useSettingsStore((state) => state.settings?.language ?? 'system')

  return (
    <div className="flex max-w-lg flex-col gap-4">
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
