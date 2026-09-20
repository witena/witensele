/**
 * The popover that adds one agent to a list of agents.
 *
 * Extracted from `components/chat/member-panel.tsx` in S9.2, when the committee
 * editor needed the same list of candidates with the same executor rule. It is
 * the rows and their copy only: **the open state, the outside-click that closes
 * it and the positioning stay with the caller**, because the member panel closes
 * its picker from a `mousedown` listener anchored on the whole panel — a
 * listener moved in here would fire before the Add button's own click and make
 * the toggle reopen what it just closed.
 *
 * One rule travels with the rows: PLAN.md allows one writer per group, so a
 * second executor is shown disabled rather than refused after the click. The
 * refusal is still the authority (`assertOneExecutor` in
 * `src/main/handlers/chats.ts`, reused by `handlers/committees.ts`); this is the
 * explanation, and it is deliberately the same `chat.executorTaken` sentence in
 * both places — it is the same rule about the same kind of group.
 */
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import type { Agent, Provider } from '@shared/types'
import { agentModelLabel, avatarStyle, hasExecutor, isExecutor } from './agent-display'
import { Avatar, Badge } from '../ui'

export interface AgentPickerProps {
  /** Every agent in the library. */
  agents: readonly Agent[]
  /** The agents already in the list; they are the ones filtered out. */
  selected: readonly Agent[]
  providers: readonly Provider[]
  /**
   * Test-id prefix: the popover is `<prefix>-picker`, a row `<prefix>-candidate`
   * and its executor tag `<prefix>-candidate-executor`. The member panel passes
   * `member`, which is exactly the three ids it had before the extraction.
   */
  testIdPrefix: string
  /** Shown when the whole library is empty. Already translated. */
  emptyLabel: string
  /** Shown when every agent is already in the list. Already translated. */
  allAddedLabel: string
  /** Positioning and width; the popover's own surface classes are ours. */
  className?: string | undefined
  onPick: (agentId: string) => void
}

export function AgentPicker({
  agents,
  selected,
  providers,
  testIdPrefix,
  emptyLabel,
  allAddedLabel,
  className,
  onPick
}: AgentPickerProps): React.JSX.Element {
  const { t } = useTranslation()

  const candidates = agents.filter((agent) => !selected.some((member) => member.id === agent.id))
  const executorTaken = hasExecutor(selected)

  return (
    <div
      data-testid={`${testIdPrefix}-picker`}
      className={clsx(
        'flex flex-col gap-0.5 rounded-lg border border-border-strong bg-bg-elevated p-1.5 shadow-lg',
        className
      )}
    >
      {candidates.length === 0 ? (
        <p className="px-2 py-2 text-[11px] text-fg-faint">
          {agents.length === 0 ? emptyLabel : allAddedLabel}
        </p>
      ) : (
        candidates.map((agent) => {
          const blocked = executorTaken && isExecutor(agent)
          return (
            <button
              key={agent.id}
              type="button"
              data-testid={`${testIdPrefix}-candidate`}
              data-agent-id={agent.id}
              data-blocked={blocked ? 'true' : 'false'}
              disabled={blocked}
              onClick={() => onPick(agent.id)}
              className={clsx(
                'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
                blocked ? 'cursor-not-allowed opacity-55' : 'hover:bg-bg-hover'
              )}
            >
              <Avatar text={agent.avatar.text} {...avatarStyle(agent.avatar)} size="md" />
              <span className="flex min-w-0 flex-col gap-px">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[13px] text-fg">{agent.name}</span>
                  {isExecutor(agent) ? (
                    <Badge
                      tone="accent"
                      font="sans"
                      data-testid={`${testIdPrefix}-candidate-executor`}
                    >
                      {t('agents.executorBadge')}
                    </Badge>
                  ) : null}
                </span>
                <span className="truncate font-mono text-[11px] text-fg-faint">
                  {blocked ? t('chat.executorTaken') : agentModelLabel(agent, providers)}
                </span>
              </span>
            </button>
          )
        })
      )}
    </div>
  )
}
