/**
 * The agent library: a 264px list on the left, the configuration editor on the
 * right.
 *
 * S1.5 built the frame and S2.1 fills it in. The page owns three things and
 * delegates the rest: the two loads it needs (agents, and the providers the model
 * dropdown is fed from), the "click Delete again to confirm" arming — which is
 * view state, not store state, and has to reset whenever the selection moves —
 * and the count of chats the edited agent belongs to, which it reads from the
 * chats store rather than from a derived field on `Agent`.
 */
import { Bot, Plus, UserPlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AgentEditor } from '../components/agents/agent-editor'
import { AgentList } from '../components/agents/agent-list'
import { Column } from '../components/layout/column'
import { DRAG_REGION, NO_DRAG, TRAFFIC_LIGHT_INSET } from '../components/layout/window-chrome'
import { EmptyState, IconButton, SectionTitle } from '../components/ui'
import { translateFailure } from '../i18n/errors'
import { useAgentsStore } from '../stores/agents'
import { useChatsStore } from '../stores/chats'
import { useProvidersStore } from '../stores/providers'

export function AgentsPage(): React.JSX.Element {
  const { t } = useTranslation()

  const agents = useAgentsStore((state) => state.agents)
  const selectedId = useAgentsStore((state) => state.selectedId)
  const mode = useAgentsStore((state) => state.mode)
  const error = useAgentsStore((state) => state.error)
  const errorCode = useAgentsStore((state) => state.errorCode)
  const providers = useProvidersStore((state) => state.providers)
  const membersByChat = useChatsStore((state) => state.membersByChat)

  /** The agent whose Delete button has been armed. `null` while nothing is armed. */
  const [deleteArmedId, setDeleteArmedId] = useState<string | null>(null)

  // Both lists: the agents this page edits, and the providers its model dropdown
  // is fed from. Paid for when the page opens rather than at startup.
  useEffect(() => {
    void useAgentsStore.getState().load()
    void useProvidersStore.getState().load()
    void useChatsStore.getState().load()
  }, [])

  const selected = agents.find((agent) => agent.id === selectedId)
  const chatCount = Object.values(membersByChat).filter((ids) =>
    selectedId ? ids.includes(selectedId) : false
  ).length

  const select = (id: string): void => {
    setDeleteArmedId(null)
    useAgentsStore.getState().startEdit(id)
  }

  const onDelete = (): void => {
    if (!selectedId) return
    // Two clicks, like the chat list's delete: the first arms, the second acts.
    if (deleteArmedId !== selectedId) {
      setDeleteArmedId(selectedId)
      return
    }
    setDeleteArmedId(null)
    void useAgentsStore.getState().remove(selectedId)
  }

  return (
    <>
      <Column width={264} className="bg-bg-base">
        <div
          className={`flex shrink-0 items-center justify-between px-3 pb-2.5 ${TRAFFIC_LIGHT_INSET} ${DRAG_REGION}`}
        >
          <SectionTitle data-testid="page-agents" count={agents.length}>
            {t('agents.title')}
          </SectionTitle>
          <IconButton
            variant="primary"
            label={t('agents.newAgent')}
            data-testid="agents-new"
            className={NO_DRAG}
            onClick={() => {
              setDeleteArmedId(null)
              useAgentsStore.getState().startCreate()
            }}
          >
            <Plus aria-hidden="true" strokeWidth={2.2} className="h-4 w-4" />
          </IconButton>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {agents.length === 0 ? (
            <EmptyState
              size="sm"
              icon={Bot}
              title={t('agents.emptyTitle')}
              description={t('agents.empty')}
            />
          ) : (
            <AgentList
              agents={agents}
              providers={providers}
              selectedId={selectedId}
              onSelect={select}
              executorLabel={t('agents.executorBadge')}
            />
          )}

          {error ? (
            <p data-testid="agents-error" className="px-2 pt-2 text-xs text-danger">
              {translateFailure(t, errorCode)}
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
                icon={UserPlus}
                title={t('agents.selectOrCreateTitle')}
                description={t('agents.selectOrCreateDescription')}
              />
            </div>
          </>
        ) : (
          <AgentEditor
            providers={providers}
            agent={selected}
            chatCount={chatCount}
            deleteArmed={deleteArmedId !== null && deleteArmedId === selectedId}
            onDelete={onDelete}
            onDuplicate={() => {
              setDeleteArmedId(null)
              if (selectedId) void useAgentsStore.getState().duplicate(selectedId)
            }}
          />
        )}
      </Column>
    </>
  )
}
