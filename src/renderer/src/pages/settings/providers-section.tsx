/**
 * Settings → Providers: the 520px card list and the editor beside it.
 *
 * This is the one settings section that is **not** a single content pane. The
 * artboard gives it two columns of its own, so it returns them itself and
 * `SettingsPage` renders it in place of the generic pane — which is also why the
 * list header carries `data-testid="settings-section-title"`: it *is* the section
 * title, and the end-to-end specs read it like any other section's.
 *
 * The list is loaded on mount rather than by the shell's bootstrap: providers are
 * only needed once the user opens this section (and, from S2.1, the agent form),
 * so paying for the query at startup would buy nothing.
 */
import { KeyRound, Plus } from 'lucide-react'
import type { TFunction } from 'i18next'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Column } from '../../components/layout/column'
import { PageHeader } from '../../components/layout/page-header'
import { ProviderCard } from '../../components/settings/provider-card'
import { providerStatus, type ProviderStatus } from '../../components/settings/provider-display'
import { ProviderEditor } from '../../components/settings/provider-editor'
import { Button, EmptyState } from '../../components/ui'
import { translateError } from '../../i18n/errors'
import { useProvidersStore } from '../../stores/providers'

/** Literal `t()` calls, so `used-keys.test.ts` can verify every status label. */
function statusLabel(t: TFunction, status: ProviderStatus): string {
  switch (status) {
    case 'connected':
      return t('settings.providers.statusConnected')
    case 'failed':
      return t('settings.providers.statusFailed')
    case 'no-key':
      return t('settings.providers.statusNoKey')
    case 'untested':
      return t('settings.providers.statusUntested')
  }
}

/** The editor column's own header, which names what the panel is doing. */
function editorTitle(t: TFunction, mode: 'idle' | 'create' | 'edit'): string {
  switch (mode) {
    case 'create':
      return t('settings.providers.addTitle')
    case 'edit':
      return t('settings.providers.editTitle')
    case 'idle':
      return t('settings.providers.editorIdleTitle')
  }
}

export function ProvidersSection(): React.JSX.Element {
  const { t } = useTranslation()

  const providers = useProvidersStore((state) => state.providers)
  const status = useProvidersStore((state) => state.status)
  const error = useProvidersStore((state) => state.error)
  const errorCode = useProvidersStore((state) => state.errorCode)
  const selectedId = useProvidersStore((state) => state.selectedId)
  const mode = useProvidersStore((state) => state.mode)
  const testResults = useProvidersStore((state) => state.testResults)

  useEffect(() => {
    void useProvidersStore.getState().load()
  }, [])

  /**
   * The same action in two places — the header and the empty state — so the
   * `data-testid` is given only to the header's copy. Two elements answering to
   * one test id is a locator that fails as soon as the list is empty.
   */
  const addButton = (testId?: string): React.JSX.Element => (
    <Button
      variant="primary"
      data-testid={testId}
      onClick={() => useProvidersStore.getState().startCreate()}
    >
      <Plus aria-hidden="true" strokeWidth={2.2} className="h-3.5 w-3.5" />
      {t('settings.providers.add')}
    </Button>
  )

  return (
    <>
      <Column width={520} className="bg-bg-panel">
        <PageHeader
          testId="settings-section-title"
          title={t('settings.sections.providers')}
          badge={<span className="text-sm font-normal text-fg-faint">{providers.length}</span>}
          actions={addButton('providers-add')}
        />

        <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-5 py-4">
          {providers.map((provider) => {
            const cardStatus = providerStatus(provider, testResults[provider.id])
            const hidden = provider.models.length - 4
            return (
              <ProviderCard
                key={provider.id}
                provider={provider}
                selected={provider.id === selectedId}
                status={cardStatus}
                statusLabel={statusLabel(t, cardStatus)}
                overflowLabel={
                  hidden > 0 ? t('settings.providers.moreModels', { extra: hidden }) : undefined
                }
                onSelect={() => useProvidersStore.getState().startEdit(provider.id)}
              />
            )
          })}

          {providers.length === 0 && status !== 'loading' ? (
            <EmptyState
              icon={KeyRound}
              title={t('settings.providers.emptyTitle')}
              description={t('settings.providers.emptyDescription')}
              action={addButton()}
            />
          ) : null}

          {status === 'error' && error ? (
            <p data-testid="providers-list-error" className="px-1 text-xs text-danger">
              {translateError(t, { code: errorCode ?? 'internal', message: error })}
            </p>
          ) : null}
        </div>
      </Column>

      <Column border="none" className="bg-bg-panel">
        <PageHeader title={editorTitle(t, mode)} />
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {mode === 'idle' ? (
            <EmptyState
              icon={KeyRound}
              title={t('settings.providers.selectOrCreateTitle')}
              description={t('settings.providers.selectOrCreateDescription')}
            />
          ) : (
            <ProviderEditor />
          )}
        </div>
      </Column>
    </>
  )
}
