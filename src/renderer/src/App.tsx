/**
 * The S1.3 transport smoke screen, now fully translated (S1.4).
 *
 * It is still a test surface rather than a design — S1.5 replaces this file with
 * the real three-column shell — but every string goes through `t()` under the
 * `smoke.*` namespace, so the "no hard-coded UI strings" guard in
 * `i18n/used-keys.test.ts` covers it like any other component.
 *
 * Each `data-testid` wraps the *value* only, never its label: the label is
 * translated and would otherwise make the Playwright assertions depend on the
 * active language.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LanguageSetting } from './stores/settings'
import { getBackend } from './lib/backend-provider'
import { useSettingsStore } from './stores/settings'

/** The three choices of the language switcher, in display order. */
const LANGUAGE_OPTIONS: { setting: LanguageSetting; labelKey: string }[] = [
  { setting: 'system', labelKey: 'settings.languageSystem' },
  { setting: 'zh-CN', labelKey: 'settings.languageZh' },
  { setting: 'en', labelKey: 'settings.languageEn' }
]

export default function App(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [ping, setPing] = useState<string | null>(null)
  const [lastEvent, setLastEvent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const languageSetting = useSettingsStore((state) => state.settings?.language ?? null)
  const setLanguage = useSettingsStore((state) => state.setLanguage)
  const settingsError = useSettingsStore((state) => state.error)

  useEffect(() => {
    // Proves the request/response direction: renderer → preload → main → SQLite.
    // Settings are not fetched here any more; the bootstrap loaded them into the
    // store before this component ever mounted.
    void (async () => {
      try {
        setPing(await getBackend().invoke('system.ping'))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
  }, [])

  useEffect(() => {
    // Proves the push direction. Unsubscribing matters under StrictMode, which
    // runs this effect twice in development.
    return getBackend().subscribe((event) => {
      if (event.type === 'system.test') setLastEvent(event.payload)
    })
  }, [])

  const pending = t('smoke.pending')
  const failure = error ?? settingsError ?? null

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-bg-base font-sans select-none">
      <h1 className="text-2xl font-medium tracking-[0.2em] text-fg" data-testid="smoke-title">
        {t('smoke.title')}
      </h1>

      <p className="text-fg-muted">
        <span>{t('smoke.backend')}</span> <span data-testid="ping">{ping ?? pending}</span>
      </p>
      <p className="text-fg-muted">
        <span>{t('smoke.language')}</span>{' '}
        <span data-testid="language">{languageSetting ?? pending}</span>
      </p>
      <p className="text-fg-muted">
        <span>{t('smoke.resolvedLanguage')}</span>{' '}
        <span data-testid="resolved-language">{i18n.language}</span>
      </p>
      <p className="text-fg-muted">
        <span>{t('smoke.lastEvent')}</span>{' '}
        <span data-testid="last-event">{lastEvent ?? t('smoke.noEvent')}</span>
      </p>

      <div className="flex gap-2">
        {LANGUAGE_OPTIONS.map((option) => (
          <button
            key={option.setting}
            type="button"
            data-testid={`lang-${option.setting}`}
            aria-pressed={languageSetting === option.setting}
            className={
              languageSetting === option.setting
                ? 'rounded border border-accent bg-bg-elevated px-3 py-1.5 text-accent'
                : 'rounded border border-border-strong bg-bg-elevated px-3 py-1.5 text-fg-secondary hover:bg-bg-hover'
            }
            onClick={() => {
              void setLanguage(option.setting).catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : String(cause))
              })
            }}
          >
            {t(option.labelKey)}
          </button>
        ))}
      </div>

      <button
        type="button"
        data-testid="emit-test-event"
        className="rounded border border-border-strong bg-bg-elevated px-4 py-2 text-fg-secondary hover:bg-bg-hover"
        onClick={() => {
          void getBackend().invoke('system.emitTestEvent', { payload: `hello-${Date.now()}` })
        }}
      >
        {t('smoke.emitTestEvent')}
      </button>

      {failure ? (
        <p className="text-danger" data-testid="error">
          {failure}
        </p>
      ) : null}
    </div>
  )
}
