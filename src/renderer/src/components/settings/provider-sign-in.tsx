/**
 * The panel that replaces the API key field when a provider signs in.
 *
 * S5.3 wrote it for Anthropic as `anthropic-sign-in.tsx`; S5.13 **generalised
 * this one component** rather than adding a Google sibling beside it. The two
 * vendors share the whole of it: the same three states, the same "the status is
 * about the machine, not the row" rule, the same busy flag, the same error line,
 * the same pair of buttons and the same doubling of Sign in as "look again". A
 * second file would have been a second copy of that state machine, and the parts
 * that genuinely differ are three strings, an install command and — for Google —
 * one extra control. Those are a prop and two branches, not a component.
 *
 * It shows one of three states, and the state is a **value** rather than an
 * error path: `signed-in` (who, where, until when, and a way out), `signed-out`
 * (what this mode is and a way in), and `not-installed` (the install command,
 * printed as data because a shell command is the same in every language).
 *
 * Three things worth knowing before changing it:
 *
 * - **The status is about the machine, not the provider.** Each vendor's CLI has
 *   one active login shared by every provider of that type, so the panel reads
 *   `authStatus[type]` from the store and never takes a provider as a prop.
 * - **"Sign in" stays clickable while the CLI is missing.** It is also the
 *   re-check: a user who installs the SDK in another window needs a way to say
 *   "look again", and a second button for that would be one more thing to
 *   explain. The click fails with `ant_missing` / `gcloud_missing`, the status is
 *   re-read, and the panel updates itself.
 * - **The Google project field appears only when there is no project.** It is not
 *   an error — the user is signed in — but the Gemini API refuses an end-user
 *   credential that names no project, so the panel offers the one thing that
 *   fixes it rather than letting the failure surface during a chat.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cliInstallCommand, type OAuthProviderType } from '@shared/presets'
import type { ProviderAuthStatus } from '@shared/types'
import { Button, Input, Spinner } from '../ui'
import { errorMessage } from '../../i18n/errors'
import { useProvidersStore } from '../../stores/providers'
import { formatExpiry, signedInName } from './provider-display'

export interface ProviderSignInProps {
  /** Which vendor's login this panel is about. */
  type: OAuthProviderType
}

export function ProviderSignIn({ type }: ProviderSignInProps): React.JSX.Element {
  const { t, i18n } = useTranslation()

  const status = useProvidersStore((state) => state.authStatus[type])
  const busy = useProvidersStore((state) => state.authBusy)
  const errorCode = useProvidersStore((state) => state.authErrorCode)

  /** The project id being typed; only ever mounted for Google with none set. */
  const [project, setProject] = useState('')

  // Asked once per vendor when the panel appears rather than at startup: a user
  // who never opens this mode never spawns a process.
  useEffect(() => {
    if (useProvidersStore.getState().authStatus[type] === null) {
      void useProvidersStore.getState().loadAuthStatus(type)
    }
  }, [type])

  // Switching the draft's type must not carry the previous vendor's half-typed id.
  useEffect(() => setProject(''), [type])

  // `null` is "not asked yet", which the panel draws as the signed-out shape:
  // it is the state one `loadAuthStatus()` away and never flashes an error.
  const current: ProviderAuthStatus = status ?? { state: 'signed-out' }
  const state = current.state
  const signedIn = state === 'signed-in'
  const expiry = signedIn ? formatExpiry(current.expiresAt, i18n.language) : ''
  const organization = current.organizationName ?? ''
  const workspace = current.workspaceName ?? ''
  const isGoogle = type === 'google'
  const needsProject = isGoogle && signedIn && !current.project

  return (
    <div
      data-testid="provider-sign-in"
      data-auth-type={type}
      data-auth-state={state}
      className="flex flex-col gap-2 rounded-[10px] border border-border-strong bg-bg-elevated px-3.5 py-3"
    >
      {signedIn ? (
        <>
          <p data-testid="provider-signed-in" className="text-xs text-fg">
            {t('settings.providers.signedIn', { account: signedInName(current) })}
          </p>
          {isGoogle ? (
            current.project ? (
              <p data-testid="provider-project" className="font-mono text-[11px] text-fg-faint">
                {t('settings.providers.quotaProject', { project: current.project })}
              </p>
            ) : (
              <p data-testid="provider-no-project" className="text-[11px] text-status-warn">
                {t('settings.providers.quotaProjectMissing')}
              </p>
            )
          ) : organization || workspace ? (
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
            ? isGoogle
              ? t('settings.providers.gcloudMissing')
              : t('settings.providers.antMissing')
            : isGoogle
              ? t('settings.providers.signedOutGoogle')
              : t('settings.providers.signedOut')}
        </p>
      )}

      {state === 'not-installed' ? (
        <code
          data-testid="provider-cli-install"
          className="rounded bg-bg-hover px-2 py-1 font-mono text-[11px] text-fg-secondary select-all"
        >
          {cliInstallCommand(type)}
        </code>
      ) : null}

      {needsProject ? (
        <div className="flex items-center gap-2 pt-0.5">
          <Input
            data-testid="provider-project-input"
            aria-label={t('settings.providers.quotaProjectLabel')}
            className="max-w-64 font-mono text-[12px]"
            value={project}
            placeholder={t('settings.providers.quotaProjectPlaceholder')}
            onChange={(event) => setProject(event.target.value)}
          />
          <Button
            data-testid="provider-project-save"
            disabled={busy || project.trim().length === 0}
            onClick={() => {
              void useProvidersStore.getState().setQuotaProject(project)
            }}
          >
            {t('settings.providers.quotaProjectSave')}
          </Button>
        </div>
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
              void useProvidersStore.getState().signOut(type)
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
              void useProvidersStore.getState().signIn(type)
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
