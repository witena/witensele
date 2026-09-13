/**
 * Settings → MCP servers: the 520px card list and the editor beside it.
 *
 * The same two-column shape as `ProvidersSection`, and for the same reason — the
 * artboard gives this section its own columns, so it supplies both and
 * `SettingsPage` renders it in place of the generic pane. The list header
 * therefore carries `data-testid="settings-section-title"`: it *is* the section
 * title, and the end-to-end specs read it like any other section's.
 *
 * Tool counts are **not** loaded on mount. `mcp.tools` connects, which for a
 * stdio server means spawning a child process; doing that for every registered
 * server the moment the page opens would run half a dozen `npx` processes the
 * user never asked for. A count appears after a probe instead, which is the
 * moment the user has said they want that server contacted.
 */
import { Plus, Server } from 'lucide-react'
import type { TFunction } from 'i18next'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Column } from '../../components/layout/column'
import { PageHeader } from '../../components/layout/page-header'
import { McpCard } from '../../components/settings/mcp-card'
import { mcpStatus, type McpStatus } from '../../components/settings/mcp-display'
import { McpEditor } from '../../components/settings/mcp-editor'
import { Button, EmptyState } from '../../components/ui'
import { translateError } from '../../i18n/errors'
import { useMcpStore } from '../../stores/mcp'

/** Literal `t()` calls, so `used-keys.test.ts` can verify every status label. */
function statusLabel(t: TFunction, status: McpStatus): string {
  switch (status) {
    case 'connected':
      return t('settings.mcp.statusConnected')
    case 'failed':
      return t('settings.mcp.statusFailed')
    case 'disabled':
      return t('settings.mcp.statusDisabled')
    case 'untested':
      return t('settings.mcp.statusUntested')
  }
}

/** The editor column's own header, which names what the panel is doing. */
function editorTitle(t: TFunction, mode: 'idle' | 'create' | 'edit'): string {
  switch (mode) {
    case 'create':
      return t('settings.mcp.addTitle')
    case 'edit':
      return t('settings.mcp.editTitle')
    case 'idle':
      return t('settings.mcp.editorIdleTitle')
  }
}

export function McpSection(): React.JSX.Element {
  const { t } = useTranslation()

  const servers = useMcpStore((state) => state.servers)
  const status = useMcpStore((state) => state.status)
  const error = useMcpStore((state) => state.error)
  const errorCode = useMcpStore((state) => state.errorCode)
  const selectedId = useMcpStore((state) => state.selectedId)
  const mode = useMcpStore((state) => state.mode)
  const testResults = useMcpStore((state) => state.testResults)
  const tools = useMcpStore((state) => state.tools)

  useEffect(() => {
    void useMcpStore.getState().load()
  }, [])

  /**
   * The same action in two places — the header and the empty state — so the
   * `data-testid` is given only to the header's copy.
   */
  const addButton = (testId?: string): React.JSX.Element => (
    <Button variant="primary" data-testid={testId} onClick={() => useMcpStore.getState().startCreate()}>
      <Plus aria-hidden="true" strokeWidth={2.2} className="h-3.5 w-3.5" />
      {t('settings.mcp.add')}
    </Button>
  )

  return (
    <>
      <Column width={520} className="bg-bg-panel">
        <PageHeader
          testId="settings-section-title"
          title={t('settings.sections.mcp')}
          badge={<span className="text-sm font-normal text-fg-faint">{servers.length}</span>}
          actions={addButton('mcp-add')}
        />

        <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-5 py-4">
          {servers.map((server) => {
            const cardStatus = mcpStatus(server, testResults[server.id])
            const discovered = tools[server.id]
            return (
              <McpCard
                key={server.id}
                server={server}
                selected={server.id === selectedId}
                status={cardStatus}
                statusLabel={statusLabel(t, cardStatus)}
                toolsLabel={
                  discovered ? t('settings.mcp.toolCount', { tools: discovered.length }) : undefined
                }
                sideEffectsLabel={server.sideEffects ? t('settings.mcp.sideEffectsTag') : undefined}
                enabledLabel={t('settings.mcp.enabled')}
                onSelect={() => useMcpStore.getState().startEdit(server.id)}
                onToggleEnabled={(enabled) => {
                  void useMcpStore
                    .getState()
                    .update(server.id, { enabled })
                    // The store already recorded it; this only stops the
                    // unhandled rejection warning the browser would print.
                    .catch(() => undefined)
                }}
              />
            )
          })}

          {servers.length === 0 && status !== 'loading' ? (
            <EmptyState
              icon={Server}
              title={t('settings.mcp.emptyTitle')}
              description={t('settings.mcp.emptyDescription')}
              action={addButton()}
            />
          ) : null}

          {status === 'error' && error ? (
            <p data-testid="mcp-list-error" className="px-1 text-xs text-danger">
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
              icon={Server}
              title={t('settings.mcp.selectOrCreateTitle')}
              description={t('settings.mcp.selectOrCreateDescription')}
            />
          ) : (
            <McpEditor />
          )}
        </div>
      </Column>
    </>
  )
}
