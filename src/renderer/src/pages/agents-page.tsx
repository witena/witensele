/**
 * The agent library: a 264px list on the left, the configuration editor on the
 * right.
 *
 * S1.5 builds only the frame. The editor form — basic info, provider and model
 * dropdowns, parameters, system prompt, skills, MCP servers, memory — is S2.1,
 * and the list needs `agents.list` from the same step, so both halves are empty
 * states for now. The editor's empty state is the one that tells the user what to
 * do next ("select or create an agent"), which is why it, not the list, carries
 * the fuller copy.
 */
import { Bot, Plus, UserPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Column } from '../components/layout/column'
import { DRAG_REGION, NO_DRAG, TRAFFIC_LIGHT_INSET } from '../components/layout/window-chrome'
import { EmptyState, IconButton, SectionTitle } from '../components/ui'

export function AgentsPage(): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <>
      <Column width={264} className="bg-bg-base">
        <div
          className={`flex shrink-0 items-center justify-between px-3 pb-2.5 ${TRAFFIC_LIGHT_INSET} ${DRAG_REGION}`}
        >
          <SectionTitle data-testid="page-agents" count={0}>
            {t('agents.title')}
          </SectionTitle>
          <IconButton
            variant="primary"
            label={t('agents.newAgent')}
            className={NO_DRAG}
            disabled
            onClick={() => undefined}
          >
            <Plus aria-hidden="true" strokeWidth={2.2} className="h-4 w-4" />
          </IconButton>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          <EmptyState
            size="sm"
            icon={Bot}
            title={t('agents.emptyTitle')}
            description={t('agents.empty')}
          />
        </div>
      </Column>

      <Column border="none" className="bg-bg-panel">
        <div className={`h-[52px] shrink-0 border-b border-border ${DRAG_REGION}`} />
        <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-5">
          <EmptyState
            icon={UserPlus}
            title={t('agents.selectOrCreateTitle')}
            description={t('agents.selectOrCreateDescription')}
          />
        </div>
      </Column>
    </>
  )
}
