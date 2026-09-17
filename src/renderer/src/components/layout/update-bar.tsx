/**
 * "Version 0.2.0 is ready. Restart to update." (S7.4)
 *
 * A strip across the bottom of the window rather than the top, for one concrete
 * reason: `titleBarStyle: 'hiddenInset'` leaves the traffic lights floating over
 * the top-left of the content, and a full-width bar there would either sit under
 * them or need the same inset every draggable header already carries. The bottom
 * edge belongs to nobody.
 *
 * It appears only in the `downloaded` state — when there is something the user
 * can actually do — and it is dismissable, per version rather than for ever
 * (`stores/updates.ts`). Dismissing hides it for this window; the update is still
 * installed on the next quit (`autoInstallOnAppQuit`), and Settings → About still
 * offers the same button.
 */
import { RefreshCw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, IconButton } from '../ui'
import { useUpdatesStore, useUpdateReady } from '../../stores/updates'

export function UpdateBar(): React.JSX.Element | null {
  const { t } = useTranslation()
  const version = useUpdateReady()
  const install = useUpdatesStore((state) => state.install)
  const dismiss = useUpdatesStore((state) => state.dismiss)

  if (!version) return null

  return (
    <div
      data-testid="update-bar"
      data-version={version}
      className="flex shrink-0 items-center gap-3 border-t border-border-strong bg-bg-elevated px-4 py-2"
    >
      <RefreshCw className="size-3.5 shrink-0 text-accent" aria-hidden />
      <p className="min-w-0 flex-1 truncate text-xs text-fg-muted">
        {t('settings.about.updates.barTitle', { version })}
      </p>
      <Button
        data-testid="update-bar-restart"
        size="sm"
        variant="primary"
        onClick={() => {
          void install()
        }}
      >
        {t('settings.about.updates.restart')}
      </Button>
      <IconButton
        data-testid="update-bar-dismiss"
        size="sm"
        label={t('settings.about.updates.barDismiss')}
        onClick={dismiss}
      >
        <X className="size-3.5" aria-hidden />
      </IconButton>
    </div>
  )
}
