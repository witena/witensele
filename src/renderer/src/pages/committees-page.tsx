/**
 * The committee library: a 264px list on the left, the editor on the right.
 *
 * Deliberately the Agents page, down to the column width, the header, the "+"
 * and the two-step delete — a committee is a saved record edited on one screen,
 * which is what that page is for, and a second layout for the same job would be
 * a second thing to keep in step.
 *
 * The page owns the loads (committees, agents and the providers the member rows
 * print a model from, plus the chats the topics list is filtered out of) and the
 * "click Delete again to confirm" arming, which is view state and has to reset
 * whenever the selection moves. Everything else is the store's.
 */
import { Plus, Users, UsersRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CommitteeEditor } from '../components/committees/committee-editor'
import { CommitteeList } from '../components/committees/committee-list'
import { Column } from '../components/layout/column'
import { DRAG_REGION, NO_DRAG, TRAFFIC_LIGHT_INSET } from '../components/layout/window-chrome'
import { EmptyState, IconButton, SectionTitle } from '../components/ui'
import { translateFailure } from '../i18n/errors'
import { useAgentsStore } from '../stores/agents'
import { useChatsStore } from '../stores/chats'
import { useCommitteesStore } from '../stores/committees'
import { useProvidersStore } from '../stores/providers'

export function CommitteesPage(): React.JSX.Element {
  const { t } = useTranslation()

  const committees = useCommitteesStore((state) => state.committees)
  const selectedId = useCommitteesStore((state) => state.selectedId)
  const mode = useCommitteesStore((state) => state.mode)
  const error = useCommitteesStore((state) => state.error)
  const errorCode = useCommitteesStore((state) => state.errorCode)
  const errorDetails = useCommitteesStore((state) => state.errorDetails)
  const agents = useAgentsStore((state) => state.agents)
  const providers = useProvidersStore((state) => state.providers)

  /** The committee whose Delete button has been armed. `null` while nothing is. */
  const [deleteArmedId, setDeleteArmedId] = useState<string | null>(null)

  // Paid for when the page opens rather than at startup: the committees this
  // page edits, the agents its member list is built from, the providers those
  // rows print a model from, and the chats the topics block filters.
  useEffect(() => {
    void useCommitteesStore.getState().load()
    void useAgentsStore.getState().load()
    void useProvidersStore.getState().load()
    void useChatsStore.getState().load()
  }, [])

  const select = (id: string): void => {
    setDeleteArmedId(null)
    useCommitteesStore.getState().startEdit(id)
  }

  const onDelete = (): void => {
    if (!selectedId) return
    // Two clicks, like the Agents page's delete: the first arms, the second acts.
    if (deleteArmedId !== selectedId) {
      setDeleteArmedId(selectedId)
      return
    }
    setDeleteArmedId(null)
    void useCommitteesStore.getState().remove(selectedId)
  }

  return (
    <>
      <Column width={264} className="bg-bg-base">
        <div
          className={`flex shrink-0 items-center justify-between px-3 pb-2.5 ${TRAFFIC_LIGHT_INSET} ${DRAG_REGION}`}
        >
          <SectionTitle data-testid="page-committees" count={committees.length}>
            {t('committees.title')}
          </SectionTitle>
          <IconButton
            variant="primary"
            label={t('committees.newCommittee')}
            data-testid="committees-new"
            className={NO_DRAG}
            onClick={() => {
              setDeleteArmedId(null)
              useCommitteesStore.getState().startCreate()
            }}
          >
            <Plus aria-hidden="true" strokeWidth={2.2} className="h-4 w-4" />
          </IconButton>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {committees.length === 0 ? (
            <EmptyState
              size="sm"
              icon={UsersRound}
              title={t('committees.emptyTitle')}
              description={t('committees.empty')}
            />
          ) : (
            <CommitteeList
              committees={committees}
              selectedId={selectedId}
              onSelect={select}
              memberCountLabel={(members) => t('committees.memberCount', { members })}
            />
          )}

          {error ? (
            <p data-testid="committees-error" className="px-2 pt-2 text-xs text-danger">
              {translateFailure(t, errorCode, errorDetails)}
            </p>
          ) : null}
        </div>
      </Column>

      <Column border="none" className="bg-bg-panel">
        {mode === 'idle' ? (
          <>
            <div className={`h-[52px] shrink-0 border-b border-border ${DRAG_REGION}`} />
            <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-5">
              <EmptyState
                icon={Users}
                title={t('committees.selectOrCreateTitle')}
                description={t('committees.selectOrCreateDescription')}
              />
            </div>
          </>
        ) : (
          <CommitteeEditor
            agents={agents}
            providers={providers}
            deleteArmed={deleteArmedId !== null && deleteArmedId === selectedId}
            onDelete={onDelete}
          />
        )}
      </Column>
    </>
  )
}
