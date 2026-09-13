/**
 * Renderer bootstrap.
 *
 * The order matters and is the reason this file is async: settings are read
 * *before* the first render so i18next is already initialised with the right
 * language when the tree mounts. Rendering first and switching afterwards would
 * show a frame of raw keys (or of English on a Chinese machine), which is exactly
 * what a bundled-resource setup makes unnecessary — `initI18n` is synchronous.
 *
 * Until the root is created the window shows the dark page background from
 * `index.css`, not an empty white flash.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import App from './App'
import { getNavigatorLanguage, initI18n, resolveLanguage } from './i18n'
import { startEventBridge } from './lib/event-bridge'
import { useSettingsStore } from './stores/settings'
import './index.css'

async function bootstrap(): Promise<void> {
  const container = document.getElementById('root')
  if (!container) throw new Error('root container not found')

  // Before anything else, and deliberately never unsubscribed: the bridge lives
  // as long as the window, so no event can be lost between the first `list` call
  // and the first render (see `lib/event-bridge.ts`).
  startEventBridge()

  // `load` never rejects: a backend failure leaves `settings` null and we fall
  // back to the system language rather than refusing to start.
  await useSettingsStore.getState().load()

  const setting = useSettingsStore.getState().settings?.language ?? 'system'
  const language = resolveLanguage(setting, getNavigatorLanguage())
  const i18n = initI18n(language)

  // Keeps `:lang()` selectors, the spell checker and assistive technology in
  // step with the UI, both now and on every later switch.
  document.documentElement.lang = language
  i18n.on('languageChanged', (next) => {
    document.documentElement.lang = next
  })

  createRoot(container).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>
    </StrictMode>
  )
}

void bootstrap()
