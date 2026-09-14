/**
 * The add / edit panel from the settings artboard: preset grid, name, base URL,
 * API key, the model chips with their two ways of filling them, and the
 * Test / Save (/ Delete) row.
 *
 * Everything it edits lives in `stores/providers.ts` as a `ProviderInput` draft —
 * see that file for why the editor works on a copy rather than on the record.
 * What is local here is only what dies with the panel: the half-typed model id
 * and the "click again to confirm" delete latch.
 *
 * Since S7.5 three of its blocks are components of their own — `PresetGrid`,
 * `ProviderCredential` (the Authentication control plus the key field or the
 * sign-in panel) and `ProviderModels` — because the first-run card on the chat
 * page drives **the same controls**, not copies of them. They all read and
 * write the one draft in `stores/providers.ts`, so this file is now the form's
 * layout and its Test / Save / Delete row.
 *
 * Behaviours worth knowing before changing this file:
 *
 * - **Both probes run against the draft, not the record.** That is the whole
 *   point of `ProviderRef`: a key the user just typed is testable before Save,
 *   and so is an endpoint that has no row yet.
 * - **Delete confirms with a second click**, not a modal. A modal needs focus
 *   management and an escape route the shell does not have yet (S4.x); a latch
 *   that resets after a few seconds is honest and costs nothing.
 */
import clsx from 'clsx'
import { Check, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProviderRef } from '@shared/backend'
import { Button, Field, Input, Select, Spinner } from '../ui'
import { translateError, translateFailure } from '../../i18n/errors'
import { useProvidersStore } from '../../stores/providers'
import { PresetGrid } from './preset-grid'
import { ProviderCredential } from './provider-credential'
import { ProviderModels } from './provider-models'

/** How long the delete latch stays armed before it forgets it was clicked. */
const CONFIRM_DELETE_MS = 4_000

export function ProviderEditor(): React.JSX.Element | null {
  const { t } = useTranslation()

  const draft = useProvidersStore((state) => state.draft)
  const mode = useProvidersStore((state) => state.mode)
  const selectedId = useProvidersStore((state) => state.selectedId)
  const testResults = useProvidersStore((state) => state.testResults)
  const testing = useProvidersStore((state) => state.testing)
  const saving = useProvidersStore((state) => state.saving)
  const error = useProvidersStore((state) => state.error)
  const errorCode = useProvidersStore((state) => state.errorCode)
  const errorDetails = useProvidersStore((state) => state.errorDetails)

  const [confirmingDelete, setConfirmingDelete] = useState(false)
  /**
   * Which model the probe goes to. Empty means "the first one", which is what the
   * backend does by default. The choice matters more than it looks: an Ollama
   * install can easily hold both a 1B and a 70B model, and probing whichever
   * happens to sort first turns "Test connection" into a several-minute wait.
   */
  const [probeModel, setProbeModel] = useState('')

  // The latch must not stay armed while the user is off doing something else.
  useEffect(() => {
    if (!confirmingDelete) return
    const timer = setTimeout(() => setConfirmingDelete(false), CONFIRM_DELETE_MS)
    return () => clearTimeout(timer)
  }, [confirmingDelete])

  // Switching records must not carry the previous one's half-finished state.
  useEffect(() => {
    setConfirmingDelete(false)
    setProbeModel('')
  }, [selectedId, mode])

  if (!draft) return null

  const store = useProvidersStore.getState
  const result = testResults[selectedId ?? 'draft']
  const ref: ProviderRef = { draft }

  const needsBaseUrl = draft.type === 'openai-compatible'
  const hasBaseUrl = Boolean(draft.baseUrl?.trim())
  const canProbe = !needsBaseUrl || hasBaseUrl

  return (
    <div data-testid="provider-editor" className="flex max-w-2xl flex-col gap-4.5">
      <Field label={t('settings.providers.preset')} layout="column">
        <PresetGrid
          selectedId={draft.presetId}
          customLabel={t('settings.providers.presetCustom')}
          onSelect={(presetId) => store().applyPreset(presetId)}
        />
      </Field>

      <Field label={t('settings.providers.name')} htmlFor="provider-name" layout="column">
        <Input
          id="provider-name"
          data-testid="provider-name-input"
          value={draft.name}
          placeholder={t('settings.providers.namePlaceholder')}
          onChange={(event) => store().patchDraft({ name: event.target.value })}
        />
      </Field>

      <Field
        label={t('settings.providers.baseUrl')}
        hint={needsBaseUrl ? undefined : t('settings.providers.baseUrlOptional')}
        htmlFor="provider-base-url"
        layout="column"
      >
        <Input
          id="provider-base-url"
          data-testid="provider-base-url-input"
          className="font-mono text-[12px]"
          value={draft.baseUrl ?? ''}
          placeholder={t('settings.providers.baseUrlPlaceholder')}
          onChange={(event) => store().patchDraft({ baseUrl: event.target.value })}
        />
      </Field>

      <ProviderCredential />

      <ProviderModels />

      {result ? (
        <p
          data-testid="provider-test-result"
          data-ok={result.ok ? 'true' : 'false'}
          className={clsx('text-xs', result.ok ? 'text-status-ok' : 'text-status-warn')}
        >
          {result.ok ? (
            <span className="inline-flex items-center gap-1.5">
              <Check aria-hidden="true" className="h-3 w-3" />
              {t('settings.providers.testOk', {
                latency: result.latencyMs,
                model: result.model ?? ''
              })}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <X aria-hidden="true" className="h-3 w-3" />
              {translateError(t, result.error)}
              <span className="font-mono text-[11px] text-fg-faint">{result.error.message}</span>
            </span>
          )}
        </p>
      ) : null}

      {error ? (
        <p
          data-testid="provider-error"
          data-error-code={errorCode ?? 'internal'}
          className="text-xs text-danger"
        >
          <span>{translateFailure(t, errorCode, errorDetails)}</span>{' '}
          <span className="font-mono text-[11px] text-fg-faint">{error}</span>
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-1">
        {mode === 'edit' && selectedId ? (
          <Button
            variant="danger"
            data-testid="provider-delete"
            className="mr-auto"
            onClick={() => {
              if (!confirmingDelete) {
                setConfirmingDelete(true)
                return
              }
              void store().remove(selectedId)
            }}
          >
            {confirmingDelete ? t('settings.providers.deleteConfirm') : t('common.delete')}
          </Button>
        ) : null}

        {draft.models.length > 1 ? (
          <Select
            data-testid="provider-probe-model"
            aria-label={t('settings.providers.probeModel')}
            className="max-w-56 font-mono text-[11px]"
            value={probeModel || (draft.models[0] as string)}
            onChange={(event) => setProbeModel(event.target.value)}
            options={draft.models.map((model) => ({ value: model, label: model }))}
          />
        ) : null}

        <Button
          data-testid="provider-test"
          disabled={testing || draft.models.length === 0 || !canProbe}
          onClick={() => {
            void store().testConnection(ref, probeModel || draft.models[0])
          }}
        >
          {testing ? <Spinner /> : null}
          {testing ? t('settings.providers.testing') : t('settings.providers.test')}
        </Button>

        <Button
          variant="primary"
          data-testid="provider-save"
          disabled={saving || draft.name.trim().length === 0}
          onClick={() => {
            void store().saveDraft()
          }}
        >
          {saving ? <Spinner /> : null}
          {t('common.save')}
        </Button>
      </div>
    </div>
  )
}
