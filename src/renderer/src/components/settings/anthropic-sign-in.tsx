/**
 * The panel that replaces the API key field when a provider signs in (S5.3).
 *
 * It shows one of three states, and the state is a **value** rather than an
 * error path: `signed-in` (who, where, until when, and a way out), `signed-out`
 * (what this mode is and a way in), and `not-installed` (the install command,
 * printed as data because a shell command is the same in every language).
 *
 * Two things worth knowing before changing it:
 *
 * - **The status is about the machine, not the provider.** `ant` is one login
 *   shared by every Anthropic provider, so the panel reads `authStatus` from the
 *   store and never takes a provider as a prop.
 * - **"Sign in" stays clickable while `ant` is missing.** It is also the
 *   re-check: a user who installs the CLI in another window needs a way to say
 *   "look again", and a second button for that would be one more thing to
 *   explain. The click fails with `ant_missing`, the status is re-read, and the
 *   panel updates itself.
 */
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ANT_INSTALL_COMMAND } from '@shared/presets'
import type { AnthropicAuthStatus } from '@shared/types'
import { Button, Spinner } from '../ui'
import { errorMessage } from '../../i18n/errors'
import { useProvidersStore } from '../../stores/providers'
import { formatExpiry, signedInName } from './provider-display'

export function AnthropicSignIn(): React.JSX.Element {
  const { t, i18n } = useTranslation()

  const status = useProvidersStore((state) => state.authStatus)
  const busy = useProvidersStore((state) => state.authBusy)
  const errorCode = useProvidersStore((state) => state.authErrorCode)

  // Asked once when the panel appears rather than at startup: a user who never
  // opens this mode never spawns a process.
  useEffect(() => {
    if (useProvidersStore.getState().authStatus === null) {
      void useProvidersStore.getState().loadAuthStatus()
    }
  }, [])

  // `null` is "not asked yet", which the panel draws as the signed-out shape:
  // it is the state one `loadAuthStatus()` away and never flashes an error.
  const current: AnthropicAuthStatus = status ?? { state: 'signed-out' }
  const state = current.state
  const signedIn = state === 'signed-in'
  const expiry = signedIn ? formatExpiry(current.expiresAt, i18n.language) : ''
  const organization = current.organizationName ?? ''
  const workspace = current.workspaceName ?? ''

  return (
    <div
      data-testid="provider-sign-in"
      data-auth-state={state}
      className="flex flex-col gap-2 rounded-[10px] border border-border-strong bg-bg-elevated px-3.5 py-3"
    >
      {signedIn ? (
        <>
          <p data-testid="provider-signed-in" className="text-xs text-fg">
            {t('settings.providers.signedIn', { account: signedInName(current) })}
          </p>
          {organization || workspace ? (
            <p className="font-mono text-[11px] text-fg-faint">
              {t('settings.providers.signedInDetail', { organization, workspace })}
            </p>
          ) : null}
          {expiry ? (
            <p className="text-[11px] text-fg-faint">
              {t('settings.providers.authExpires', { expires: expiry })}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-fg-muted">
          {state === 'not-installed'
            ? t('settings.providers.antMissing')
            : t('settings.providers.signedOut')}
        </p>
      )}

      {state === 'not-installed' ? (
        <code
          data-testid="provider-ant-install"
          className="rounded bg-bg-hover px-2 py-1 font-mono text-[11px] text-fg-secondary select-all"
        >
          {ANT_INSTALL_COMMAND}
        </code>
      ) : null}

      {errorCode ? (
        <p
          data-testid="provider-auth-error"
          data-error-code={errorCode}
          className="text-xs text-danger"
        >
          {errorMessage(t, errorCode)}
        </p>
      ) : null}

      <div className="flex items-center gap-2 pt-0.5">
        {signedIn ? (
          <Button
            data-testid="provider-sign-out"
            disabled={busy}
            onClick={() => {
              void useProvidersStore.getState().signOut()
            }}
          >
            {busy ? <Spinner /> : null}
            {t('settings.providers.signOut')}
          </Button>
        ) : (
          <Button
            variant="primary"
            data-testid="provider-sign-in-button"
            disabled={busy}
            onClick={() => {
              void useProvidersStore.getState().signIn()
            }}
          >
            {busy ? <Spinner /> : null}
            {busy ? t('settings.providers.signingIn') : t('settings.providers.signIn')}
          </Button>
        )}
      </div>
    </div>
  )
}
