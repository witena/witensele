/**
 * Settings → Developer: the transport and i18n smoke surface.
 *
 * This is the S1.3/S1.4 smoke screen, moved out of `App.tsx` (which S1.5 turns
 * into the real shell) and given a home instead of being deleted. It still earns
 * its place: `smoke.spec.ts` and `i18n.spec.ts` drive the whole stack through it —
 * renderer → preload → main → SQLite for `ping` and the language setting, and
 * main → renderer for the test event — and none of that is observable anywhere
 * else until S1.7 puts a real message on screen.
 *
 * Each `data-testid` wraps a **value**, never its translated label, so the
 * Playwright assertions do not depend on the active UI language.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getBackend } from '../../lib/backend-provider'
import { useSettingsStore } from '../../stores/settings'
import { Button } from '../../components/ui'

export function DeveloperSection(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [ping, setPing] = useState<string | null>(null)
  const [lastEvent, setLastEvent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const languageSetting = useSettingsStore((state) => state.settings?.language ?? null)
  const settingsError = useSettingsStore((state) => state.error)

  useEffect(() => {
    // Request/response: renderer -> preload -> main -> handler.
    void (async () => {
      try {
        setPing(await getBackend().invoke('system.ping'))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
  }, [])

  useEffect(() => {
    // Push. Unsubscribing matters under StrictMode, which runs this twice in dev.
    return getBackend().subscribe((event) => {
      if (event.type === 'system.test') setLastEvent(event.payload)
    })
  }, [])

  const pending = t('settings.developer.pending')
  const failure = error ?? settingsError ?? null

  return (
    <div className="flex max-w-lg flex-col items-start gap-3 text-sm">
      <p className="text-fg-muted">
        <span>{t('settings.developer.backend')}</span>{' '}
        <span className="font-mono text-fg" data-testid="ping">
          {ping ?? pending}
        </span>
      </p>
      <p className="text-fg-muted">
        <span>{t('settings.developer.languageSetting')}</span>{' '}
        <span className="font-mono text-fg" data-testid="language">
          {languageSetting ?? pending}
        </span>
      </p>
      <p className="text-fg-muted">
        <span>{t('settings.developer.resolvedLanguage')}</span>{' '}
        <span className="font-mono text-fg" data-testid="resolved-language">
          {i18n.language}
        </span>
      </p>
      <p className="text-fg-muted">
        <span>{t('settings.developer.lastEvent')}</span>{' '}
        <span className="font-mono text-fg" data-testid="last-event">
          {lastEvent ?? t('settings.developer.noEvent')}
        </span>
      </p>

      <Button
        data-testid="emit-test-event"
        onClick={() => {
          void getBackend().invoke('system.emitTestEvent', { payload: `hello-${Date.now()}` })
        }}
      >
        {t('settings.developer.emitTestEvent')}
      </Button>

      {failure ? (
        <p className="text-danger" data-testid="error">
          {failure}
        </p>
      ) : null}
    </div>
  )
}
