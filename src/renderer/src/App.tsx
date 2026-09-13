// TODO(S1.4): i18n — this is the S1.3 smoke screen and every string below is a
// plain English literal on purpose. S1.5 replaces the whole file with the real UI
// shell, so nothing here is worth a locale key.
import { useEffect, useState } from 'react'
import { APP_NAME } from '@shared/version'
import { backend } from './lib/backend'

export default function App(): React.JSX.Element {
  const [ping, setPing] = useState('…')
  const [language, setLanguage] = useState('…')
  const [lastEvent, setLastEvent] = useState('—')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Proves the request/response direction: renderer → preload → main → SQLite.
    void (async () => {
      try {
        setPing(await backend.invoke('system.ping'))
        setLanguage((await backend.invoke('settings.get')).language)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
  }, [])

  useEffect(() => {
    // Proves the push direction. Unsubscribing matters under StrictMode, which
    // runs this effect twice in development.
    return backend.subscribeTo('system.test', (event) => {
      setLastEvent(event.payload)
    })
  }, [])

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-bg-base font-sans select-none">
      <h1 className="text-4xl font-medium tracking-[0.3em] text-fg">{APP_NAME}</h1>

      <p className="text-fg-muted" data-testid="ping">
        backend: {ping}
      </p>
      <p className="text-fg-muted" data-testid="language">
        language: {language}
      </p>
      <p className="text-fg-muted" data-testid="last-event">
        last event: {lastEvent}
      </p>

      <button
        type="button"
        data-testid="emit-test-event"
        className="rounded border border-border-strong bg-bg-elevated px-4 py-2 text-fg-secondary hover:bg-bg-hover"
        onClick={() => {
          void backend.invoke('system.emitTestEvent', { payload: `hello-${Date.now()}` })
        }}
      >
        Emit test event
      </button>

      {error ? (
        <p className="text-danger" data-testid="error">
          {error}
        </p>
      ) : null}
    </div>
  )
}
