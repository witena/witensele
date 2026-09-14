/**
 * The draft provider's model list: "Fetch models", one chip per id, and the
 * inline field that adds one by hand.
 *
 * Extracted from `provider-editor.tsx` in S7.5 so the **first-run card drives
 * the same control rather than a copy of it** — see `provider-credential.tsx`
 * for the general argument. This half matters for one extra reason: the two
 * ways of filling the list have a documented interaction (a fetch *replaces*
 * what the form held, including a preset's guesses), and a second
 * implementation would eventually disagree about it.
 *
 * What is local here is only what dies with the panel: the half-typed model id
 * and whether the inline field is open.
 *
 * `ProviderRef` is always `{ draft }`: both call sites are editing the draft,
 * and probing the draft rather than the record is the whole point of the union
 * — a key the user just typed is testable before Save, and so is an endpoint
 * that has no row yet.
 */
import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProviderRef } from '@shared/backend'
import { Chip, Input, Spinner } from '../ui'
import { useProvidersStore } from '../../stores/providers'

export function ProviderModels(): React.JSX.Element | null {
  const { t } = useTranslation()

  const draft = useProvidersStore((state) => state.draft)
  const fetchingModels = useProvidersStore((state) => state.fetchingModels)

  const [newModel, setNewModel] = useState('')
  const [addingModel, setAddingModel] = useState(false)
  const modelInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (addingModel) modelInput.current?.focus()
  }, [addingModel])

  if (!draft) return null

  const store = useProvidersStore.getState
  const ref: ProviderRef = { draft }
  // An `openai-compatible` endpoint with no URL has nothing to ask.
  const canProbe = draft.type !== 'openai-compatible' || Boolean(draft.baseUrl?.trim())

  function commitModel(): void {
    store().addModel(newModel)
    setNewModel('')
    setAddingModel(false)
  }

  return (
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
  )
}
