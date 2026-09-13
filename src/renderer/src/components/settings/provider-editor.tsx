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
 * Three behaviours worth knowing before changing this file:
 *
 * - **The key field is write-only.** A stored key never comes back from the
 *   backend, so the input is empty even when one exists and a hint says so.
 *   Typing replaces the key; emptying a field that was typed into clears it.
 * - **Both probes run against the draft, not the record.** That is the whole
 *   point of `ProviderRef`: a key the user just typed is testable before Save,
 *   and so is an endpoint that has no row yet.
 * - **Delete confirms with a second click**, not a modal. A modal needs focus
 *   management and an escape route the shell does not have yet (S4.x); a latch
 *   that resets after a few seconds is honest and costs nothing.
 */
import clsx from 'clsx'
import { Check, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProviderRef } from '@shared/backend'
import { getPreset } from '@shared/presets'
import { Button, Chip, Field, Input, Select, Spinner } from '../ui'
import { translateError } from '../../i18n/errors'
import { useProvidersStore } from '../../stores/providers'
import { PresetGrid } from './preset-grid'

/** How long the delete latch stays armed before it forgets it was clicked. */
const CONFIRM_DELETE_MS = 4_000

export function ProviderEditor(): React.JSX.Element | null {
  const { t } = useTranslation()

  const draft = useProvidersStore((state) => state.draft)
  const mode = useProvidersStore((state) => state.mode)
  const selectedId = useProvidersStore((state) => state.selectedId)
  const providers = useProvidersStore((state) => state.providers)
  const testResults = useProvidersStore((state) => state.testResults)
  const testing = useProvidersStore((state) => state.testing)
  const fetchingModels = useProvidersStore((state) => state.fetchingModels)
  const saving = useProvidersStore((state) => state.saving)
  const error = useProvidersStore((state) => state.error)
  const errorCode = useProvidersStore((state) => state.errorCode)

  const [newModel, setNewModel] = useState('')
  const [addingModel, setAddingModel] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  /**
   * Which model the probe goes to. Empty means "the first one", which is what the
   * backend does by default. The choice matters more than it looks: an Ollama
   * install can easily hold both a 1B and a 70B model, and probing whichever
   * happens to sort first turns "Test connection" into a several-minute wait.
   */
  const [probeModel, setProbeModel] = useState('')
  const modelInput = useRef<HTMLInputElement>(null)

  // The latch must not stay armed while the user is off doing something else.
  useEffect(() => {
    if (!confirmingDelete) return
    const timer = setTimeout(() => setConfirmingDelete(false), CONFIRM_DELETE_MS)
    return () => clearTimeout(timer)
  }, [confirmingDelete])

  // Switching records must not carry the previous one's half-finished state.
  useEffect(() => {
    setNewModel('')
    setAddingModel(false)
    setConfirmingDelete(false)
    setProbeModel('')
  }, [selectedId, mode])

  useEffect(() => {
    if (addingModel) modelInput.current?.focus()
  }, [addingModel])

  if (!draft) return null

  const store = useProvidersStore.getState
  const record = providers.find((provider) => provider.id === selectedId)
  const preset = getPreset(draft.presetId)
  const result = testResults[selectedId ?? 'draft']
  const ref: ProviderRef = { draft }

  const needsBaseUrl = draft.type === 'openai-compatible'
  const hasBaseUrl = Boolean(draft.baseUrl?.trim())
  const canProbe = !needsBaseUrl || hasBaseUrl
  // A key typed into the field is `''` once emptied, which *clears* the stored
  // key; the hint only applies while the field has never been touched.
  const showStoredKeyHint = Boolean(record?.hasApiKey) && draft.apiKey === undefined

  function commitModel(): void {
    store().addModel(newModel)
    setNewModel('')
    setAddingModel(false)
  }

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
            // Only a *local* preset can honestly say a key is pointless. `custom`
            // also declares `requiresApiKey: false`, but that means "we cannot
            // know", and a key is usually exactly what such an endpoint wants.
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

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-fg-muted">{t('settings.providers.models')}</span>
          <button
            type="button"
            data-testid="provider-fetch-models"
            disabled={fetchingModels || !canProbe}
            onClick={() => {
              void store()
                .fetchModels(ref)
                // The store already recorded it; this only stops the unhandled
                // rejection warning the browser would otherwise print.
                .catch(() => undefined)
            }}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded text-xs text-accent transition-colors',
              'hover:text-accent-hover focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
              'disabled:cursor-not-allowed disabled:text-fg-faint'
            )}
          >
            {fetchingModels ? <Spinner /> : null}
            {t('settings.providers.fetchModels')}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {draft.models.map((model) => (
            <Chip
              key={model}
              data-testid="provider-model-chip"
              removeLabel={t('settings.providers.removeModel')}
              onRemove={() => store().removeModel(model)}
            >
              {model}
            </Chip>
          ))}

          {addingModel ? (
            <Input
              ref={modelInput}
              data-testid="provider-add-model-input"
              wrapperClassName="w-52 py-0.5"
              className="font-mono text-[11px]"
              value={newModel}
              placeholder={t('settings.providers.addModelPlaceholder')}
              onChange={(event) => setNewModel(event.target.value)}
              onBlur={commitModel}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitModel()
                if (event.key === 'Escape') {
                  setNewModel('')
                  setAddingModel(false)
                }
              }}
            />
          ) : (
            <Chip
              tone="accent"
              font="sans"
              data-testid="provider-add-model"
              onClick={() => setAddingModel(true)}
            >
              {/*
                The leading "+" is part of the copy rather than a lucide icon:
                Tailwind's preflight gives every `svg` `display: block`, which
                inside the chip's truncating text span forces the label onto a
                second line. The artboard draws it as text anyway.
              */}
              {t('settings.providers.addModel')}
            </Chip>
          )}
        </div>

        {draft.models.length === 0 && !addingModel ? (
          <p className="text-[11px] text-fg-faint">{t('settings.providers.noModels')}</p>
        ) : null}
      </div>

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
        <p data-testid="provider-error" className="text-xs text-danger">
          <span>{translateError(t, { code: errorCode ?? 'internal', message: error })}</span>{' '}
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
