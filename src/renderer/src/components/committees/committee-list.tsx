/**
 * The Committees page's left column: one row per committee.
 *
 * Deliberately the Agents page's `.agent-item` row with a different second line:
 * a committee has no avatar and no model, so the row is the name plus the one
 * fact that distinguishes two groups at a glance — how many agents are in it.
 * Free of i18next for the same reason `AgentList` is: the page above already
 * holds `t`, and a row that subscribed to the translation context would
 * re-render the whole list on a language change for one word.
 */
import clsx from 'clsx'
import type { Committee } from '@shared/types'

export interface CommitteeListProps {
  committees: readonly Committee[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** Already-translated "{{members}} members" for one committee. */
  memberCountLabel: (members: number) => string
}

export function CommitteeList({
  committees,
  selectedId,
  onSelect,
  memberCountLabel
}: CommitteeListProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      {committees.map((committee) => (
        <button
          key={committee.id}
          type="button"
          data-testid="committee-item"
          data-committee-id={committee.id}
          data-selected={committee.id === selectedId}
          onClick={() => onSelect(committee.id)}
          className={clsx(
            'flex flex-col gap-px rounded-lg px-2.5 py-2 text-left transition-colors',
            'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
            committee.id === selectedId ? 'bg-bg-hover' : 'hover:bg-bg-muted'
          )}
        >
          <span data-testid="committee-item-name" className="truncate text-[13px] text-fg">
            {committee.name}
          </span>
          <span
            data-testid="committee-item-members"
            data-members={committee.memberAgentIds.length}
            className="truncate text-[11px] text-fg-faint"
          >
            {memberCountLabel(committee.memberAgentIds.length)}
          </span>
        </button>
      ))}
    </div>
  )
}
