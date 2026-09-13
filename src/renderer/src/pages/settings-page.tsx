/**
 * Settings: a 220px section nav on the left, the selected section on the right.
 *
 * Sections are filled in by the step that owns them: Appearance & language and
 * Developer landed with S1.5, Providers with S1.6 and Timeouts & heartbeat with
 * S2.4. The rest are empty states that name the step which fills them in, so the
 * nav is complete and navigable now rather than growing item by item.
 *
 * The language quick toggle sits at the bottom of the nav, which is where
 * `PLAN.md` puts it: a user who cannot read the current UI language has to be
 * able to reach the switch without reading anything except the endonyms in it,
 * so it is visible from every section rather than hidden inside one of them.
 */
import clsx from 'clsx'
import type { TFunction } from 'i18next'
import {
  Database,
  Globe,
  KeyRound,
  Palette,
  Server,
  Sparkles,
  Terminal,
  Timer,
  type LucideIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Column } from '../components/layout/column'
import { PageHeader } from '../components/layout/page-header'
import { DRAG_REGION, NO_DRAG, TRAFFIC_LIGHT_INSET } from '../components/layout/window-chrome'
import { EmptyState, SectionTitle, SegmentedControl } from '../components/ui'
import { useSettingsStore, type LanguageSetting } from '../stores/settings'
import { SETTINGS_SECTIONS, useUiStore, type SettingsSection } from '../stores/ui'
import { AppearanceSection } from './settings/appearance-section'
import { DeveloperSection } from './settings/developer-section'
import { McpSection } from './settings/mcp-section'
import { ProvidersSection } from './settings/providers-section'
import { TimeoutsSection } from './settings/timeouts-section'
import { applyLanguageSetting } from './settings/language'

const SECTION_ICONS: Record<SettingsSection, LucideIcon> = {
  providers: KeyRound,
  mcp: Server,
  skills: Sparkles,
  timeouts: Timer,
  appearance: Palette,
  data: Database,
  developer: Terminal
}

/** Literal `t()` calls, so `used-keys.test.ts` can verify every section label. */
function sectionLabel(t: TFunction, section: SettingsSection): string {
  switch (section) {
    case 'providers':
      return t('settings.sections.providers')
    case 'mcp':
      return t('settings.sections.mcp')
    case 'skills':
      return t('settings.sections.skills')
    case 'timeouts':
      return t('settings.sections.timeouts')
    case 'appearance':
      return t('settings.sections.appearanceLanguage')
    case 'data':
      return t('settings.sections.dataBackup')
    case 'developer':
      return t('settings.sections.developer')
  }
}

function SectionBody({ section }: { section: SettingsSection }): React.JSX.Element {
  const { t } = useTranslation()

  if (section === 'appearance') return <AppearanceSection />
  if (section === 'developer') return <DeveloperSection />
  if (section === 'timeouts') return <TimeoutsSection />

  return (
    <EmptyState
      icon={SECTION_ICONS[section]}
      title={t('settings.comingSoonTitle')}
      description={t('settings.comingSoonDescription')}
    />
  )
}

function LanguageQuickToggle(): React.JSX.Element {
  const { t } = useTranslation()
  const language = useSettingsStore((state) => state.settings?.language ?? 'system')

  return (
    <div className="flex shrink-0 flex-col gap-1.5 px-1 pb-1">
      <p className="flex items-center gap-1.5 text-[11px] text-fg-faint">
        <Globe aria-hidden="true" className="h-3 w-3" />
        {t('settings.interfaceLanguage')}
      </p>
      <SegmentedControl<LanguageSetting>
        value={language}
        onChange={applyLanguageSetting}
        options={[
          { value: 'system', label: t('settings.languageSystemShort'), testId: 'lang-system' },
          { value: 'zh-CN', label: t('settings.languageZhShort'), testId: 'lang-zh-CN' },
          { value: 'en', label: t('settings.languageEnShort'), testId: 'lang-en' }
        ]}
      />
    </div>
  )
}

export function SettingsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const section = useUiStore((state) => state.settingsSection)
  const setSection = useUiStore((state) => state.setSettingsSection)

  return (
    <>
      <Column width={220} className="bg-bg-base">
        <div
          className={clsx(
            'flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3.5',
            TRAFFIC_LIGHT_INSET,
            DRAG_REGION
          )}
        >
          <SectionTitle data-testid="page-settings" className="px-2.5 pb-2.5">
            {t('settings.title')}
          </SectionTitle>

          {SETTINGS_SECTIONS.map((item) => (
            <button
              key={item}
              type="button"
              data-testid={`settings-section-${item}`}
              aria-current={item === section ? 'page' : undefined}
              onClick={() => setSection(item)}
              className={clsx(
                NO_DRAG,
                'w-full rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors',
                'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
                item === section
                  ? 'bg-bg-hover text-fg'
                  : 'text-fg-muted hover:bg-bg-hover/60 hover:text-fg-secondary'
              )}
            >
              {sectionLabel(t, item)}
            </button>
          ))}

          <div className="flex-1" />
          <div className={NO_DRAG}>
            <LanguageQuickToggle />
          </div>
        </div>
      </Column>

      {/*
        Providers and MCP servers are the sections with a layout of their own — a
        520px card list plus an editor, straight from the artboard — so each
        supplies both of its columns, including the header that carries
        `settings-section-title`. Every other section is a single pane under a
        shared header.
      */}
      {section === 'providers' ? (
        <ProvidersSection />
      ) : section === 'mcp' ? (
        <McpSection />
      ) : (
        <Column border="none" className="bg-bg-panel">
          <PageHeader testId="settings-section-title" title={sectionLabel(t, section)} />
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <SectionBody section={section} />
          </div>
        </Column>
      )}
    </>
  )
}
