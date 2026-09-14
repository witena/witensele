/**
 * How the draft provider authenticates: the Authentication control, and under
 * it either the write-only API key field or S5.3's sign-in panel.
 *
 * Extracted from `provider-editor.tsx` in S7.5 so the **first-run card can use
 * the same control rather than a copy of it**. Two key fields with two ideas
 * about what an empty string means would be the kind of bug nobody finds until
 * a user loses a stored key, and `AnthropicSignIn` is not something to have
 * twice at all — it drives a CLI.
 *
 * It reads the draft from `stores/providers.ts` and writes back through
 * `patchDraft`, exactly as the editor did inline, so it takes no props and both
 * call sites are editing one object. Only one of them is ever mounted: the
 * shell renders a single page at a time, so the `data-testid`s below are unique
 * on screen whichever screen it is.
 *
 * The three behaviours that were documented in the editor and still hold:
 *
 * - **The key field is write-only.** A stored key never comes back, so the
 *   input is empty even when one exists and a hint says so. Typing replaces the
 *   key; emptying a field that was typed into clears it.
 * - **The Authentication control is rendered for the three first-party types
 *   only**, disabled with a hint for the two that have no flow yet. An
 *   `openai-compatible` endpoint has no account to sign in to, so it gets no
 *   control rather than a dead one.
 * - **In sign-in mode the panel replaces the key field**, never sits beside it.
 */
import { useTranslation } from 'react-i18next'
import { getPreset, providerAuth } from '@shared/presets'
import type { ProviderAuth } from '@shared/types'
import { Field, Input, SegmentedControl } from '../ui'
import { useProvidersStore } from '../../stores/providers'
import { AnthropicSignIn } from './anthropic-sign-in'
import { authControl } from './provider-display'

export function ProviderCredential(): React.JSX.Element | null {
  const { t } = useTranslation()

  const draft = useProvidersStore((state) => state.draft)
  const selectedId = useProvidersStore((state) => state.selectedId)
  const providers = useProvidersStore((state) => state.providers)

  if (!draft) return null

  const store = useProvidersStore.getState
  const record = providers.find((provider) => provider.id === selectedId)
  const preset = getPreset(draft.presetId)
  const auth = providerAuth(draft)
  const { shown: showsAuthControl, available: authAvailable } = authControl(draft.type)
  // A key typed into the field is `''` once emptied, which *clears* the stored
  // key; the hint only applies while the field has never been touched.
  const showStoredKeyHint = Boolean(record?.hasApiKey) && draft.apiKey === undefined

  return (
    <>
      {showsAuthControl ? (
        <Field
          label={t('settings.providers.auth')}
          hint={authAvailable ? undefined : t('settings.providers.authUnavailable')}
          layout="column"
        >
          <SegmentedControl<ProviderAuth>
            className="max-w-md"
            value={auth}
            disabled={!authAvailable}
            onChange={(next) => store().patchDraft({ auth: next })}
            options={[
              {
                value: 'apiKey',
                label: t('settings.providers.authApiKey'),
                testId: 'provider-auth-apiKey'
              },
              {
                value: 'oauth',
                label: t('settings.providers.authSignIn'),
                testId: 'provider-auth-oauth'
              }
            ]}
          />
        </Field>
      ) : null}

      {auth === 'oauth' ? (
        <AnthropicSignIn />
      ) : (
        <Field
          label={t('settings.providers.apiKey')}
          hint={t('settings.providers.apiKeyHint')}
          htmlFor="provider-api-key"
          layout="column"
        >
          <Input
            id="provider-api-key"
            data-testid="provider-api-key-input"
            type="password"
            autoComplete="off"
            className="font-mono text-[12px]"
            value={draft.apiKey ?? ''}
            placeholder={
              // Only a *local* preset can honestly say a key is pointless.
              // `custom` also declares `requiresApiKey: false`, but that means
              // "we cannot know", and a key is usually exactly what such an
              // endpoint wants.
              preset?.local
                ? t('settings.providers.apiKeyNotNeeded')
                : t('settings.providers.apiKeyPlaceholder')
            }
            onChange={(event) => store().patchDraft({ apiKey: event.target.value })}
          />
          {showStoredKeyHint ? (
            <p data-testid="provider-api-key-stored" className="text-[11px] text-fg-faint">
              {t('settings.providers.apiKeyStored')}
            </p>
          ) : null}
        </Field>
      )}
    </>
  )
}
