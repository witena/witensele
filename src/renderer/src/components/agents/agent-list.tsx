/**
 * The Agents page's left column: the mockup's `.agent-item` rows.
 *
 * Avatar, name and the mono `modelId · provider` line, which is the one thing a
 * user scanning the list actually distinguishes agents by — two "reviewers" on
 * different models are two different agents. The provider's name comes from
 * `agent-display.ts` so this row and the chat's member row always agree.
 */
import clsx from 'clsx'
import type { Agent, Provider } from '@shared/types'
import { Avatar, Badge } from '../ui'
import { agentModelLabel, isExecutor } from './agent-display'

export interface AgentListProps {
  agents: readonly Agent[]
  providers: readonly Provider[]
  selectedId: string | null
  onSelect: (id: string) => void
  /**
   * Already-translated label for the executor tag.
   *
   * Passed in rather than looked up here because this component is otherwise
   * free of i18next — the page above it already holds `t`, and a list row that
   * subscribed to the translation context would re-render every agent on a
   * language change for one word.
   */
  executorLabel: string
}

export function AgentList({
  agents,
  providers,
  selectedId,
  onSelect,
  executorLabel
}: AgentListProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      {agents.map((agent) => (
        <button
          key={agent.id}
          type="button"
          data-testid="agent-item"
          data-agent-id={agent.id}
          data-selected={agent.id === selectedId}
          onClick={() => onSelect(agent.id)}
          className={clsx(
            'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
            'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
            agent.id === selectedId ? 'bg-bg-hover' : 'hover:bg-bg-muted'
          )}
        >
          <Avatar
            text={agent.avatar.text}
            color={agent.avatar.color}
            textColor={agent.avatar.textColor}
            size="lg"
          />
          <span className="flex min-w-0 flex-col gap-px">
            <span className="flex min-w-0 items-center gap-1.5">
              <span data-testid="agent-item-name" className="truncate text-[13px] text-fg">
                {agent.name}
              </span>
              {isExecutor(agent) ? (
                <Badge tone="accent" font="sans" data-testid="agent-item-executor">
                  {executorLabel}
                </Badge>
              ) : null}
            </span>
            <span
              data-testid="agent-item-model"
              className="truncate font-mono text-[11px] text-fg-faint"
            >
              {agentModelLabel(agent, providers)}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}
