/**
 * The right column's member list: the mockup's `.member` rows, plus the three
 * things S2.2 makes real — add, remove and reorder.
 *
 * ## Where the picker and the drag-to-reorder live now (S9.2)
 *
 * Both were written here and both are now shared: the popover is
 * `components/agents/agent-picker.tsx` and the draggable rows are
 * `components/ui/reorderable-list.tsx`, because the committee editor needs the
 * same two interactions on the same kind of list. Nothing about this panel
 * changed in the move — the same DOM, the same classes, the same test ids — and
 * the two pieces it kept are the ones that are its own: the picker's **open
 * state**, closed by a `mousedown` anywhere outside the panel, and the whole
 * `chats.members.set` write below.
 *
 * The reasoning that produced the drag interaction is in `ReorderableList`'s own
 * header; the short of it is that a handful of rows in a window that is always
 * Chromium needs `draggable` and three events, not a library, and that the index
 * arithmetic — the only part that can silently be wrong — lives in
 * `lib/reorder.ts` where a unit test covers it.
 *
 * ## Why the panel writes the whole list
 *
 * Every action (add, remove, reorder) ends in one `chats.members.set` with the
 * complete array, because that is the backend's contract: the array index *is*
 * `position`. Three narrower calls would each have to read the current order
 * first and would race with the `chat.updated` event that follows.
 *
 * The per-member column carries that agent's tokens **in this chat** (S4.1), read
 * from `stores/usage` and recomputed on every `message.updated`. A member that has
 * not spoken yet prints an em dash rather than a zero, because a zero would be a
 * claim about a turn that never happened — and an **offline** member gives the
 * column up entirely to the "Retry" button, which is the manual half of S2.4's
 * recovery loop.
 *
 * ## Presence
 *
 * The dot and the label under the name come from `stores/presence`, seeded by
 * `presence.list` when the chat is opened and kept current by `presence.changed`.
 * `away` additionally prints how long the agent has been silent; that number is
 * computed here from `lastActivityAt` and ticked by a one-second timer that only
 * exists while some member is actually `away`.
 */
import type { TFunction } from 'i18next'
import { Plus, UserPlus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatTokens } from '@shared/pricing'
import type { Agent, AgentPresence, PresenceState, Provider } from '@shared/types'
import { agentModelLabel, avatarStyle, isExecutor } from '../agents/agent-display'
import { AgentPicker } from '../agents/agent-picker'
import { useIsRetrying, usePresence, usePresenceStore } from '../../stores/presence'
import { useChatUsage } from '../../stores/usage'
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  IconButton,
  ReorderableList,
  SectionTitle
} from '../ui'

/** Literal `t()` calls, so `used-keys.test.ts` can verify all four labels. */
function presenceLabel(t: TFunction, state: PresenceState): string {
  switch (state) {
    case 'available':
      return t('presence.available')
    case 'working':
      return t('presence.working')
    case 'away':
      return t('presence.away')
    case 'offline':
      return t('presence.offline')
  }
}

/**
 * The label under a member's name: the state, plus how long an `away` agent has
 * been silent.
 *
 * The seconds are computed in the renderer from `lastActivityAt` rather than sent
 * with the event, because the number changes every second and the backend emits
 * only on a *state change* — one event per transition instead of one per second
 * per agent, which is the whole point of `PresenceDot` reading a store.
 */
function presenceText(t: TFunction, presence: AgentPresence | undefined, now: number): string {
  if (presence?.state === 'away') {
    return t('presence.awayFor', { seconds: Math.max(0, Math.round((now - presence.lastActivityAt) / 1000)) })
  }
  return presenceLabel(t, presence?.state ?? 'available')
}

/**
 * A clock that ticks once a second, and only while it is needed.
 *
 * `active` is false for every member that is not `away`, so an idle chat runs no
 * timers at all — a member panel that re-rendered every second forever would be
 * the most expensive thing on an otherwise static screen.
 */
function useTickingNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [active])

  return now
}

export interface MemberPanelProps {
  chatId: string | null
  /** The chat's members, in speaking order. */
  members: Agent[]
  /** Every agent in the library, for the picker. */
  agents: readonly Agent[]
  providers: readonly Provider[]
  onAdd: (agentId: string) => void
  onRemove: (agentId: string) => void
  /** Called with the dragged row's index and the index it was dropped on. */
  onReorder: (from: number, to: number) => void
}

export function MemberPanel({
  chatId,
  members,
  agents,
  providers,
  onAdd,
  onRemove,
  onReorder
}: MemberPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const [picking, setPicking] = useState(false)
  const panel = useRef<HTMLElement>(null)
  // Read once for the whole panel rather than once per row: it is one object in
  // the store and a selector per row would resubscribe every member to it.
  const usage = useChatUsage(chatId)

  // The picker closes when the chat changes: its candidate list belongs to the
  // chat that was open, not to the one that just became selected.
  useEffect(() => setPicking(false), [chatId])

  // …and when the user clicks anywhere else, which is what a popover is expected
  // to do and what keeps it from covering the settings block below.
  useEffect(() => {
    if (!picking) return undefined
    const close = (event: MouseEvent): void => {
      if (!panel.current?.contains(event.target as Node)) setPicking(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [picking])

  return (
    <section ref={panel} className="relative flex flex-col gap-1.5">
      <div className="flex items-center justify-between px-1">
        <SectionTitle count={members.length}>{t('chat.members')}</SectionTitle>
        <Button
          variant="ghost"
          size="sm"
          data-testid="member-add"
          disabled={chatId === null}
          className="text-accent hover:text-accent"
          onClick={() => setPicking((open) => !open)}
        >
          <Plus aria-hidden="true" strokeWidth={2.2} className="h-3 w-3" />
          {t('common.add')}
        </Button>
      </div>

      {picking ? (
        <AgentPicker
          agents={agents}
          selected={members}
          providers={providers}
          testIdPrefix="member"
          emptyLabel={t('chat.addMemberEmpty')}
          allAddedLabel={t('chat.addMemberAll')}
          className="absolute top-7 right-0 z-10 w-[264px]"
          onPick={(agentId) => {
            setPicking(false)
            onAdd(agentId)
          }}
        />
      ) : null}

      {members.length === 0 ? (
        <>
          <EmptyState
            size="sm"
            icon={UserPlus}
            title={t('chat.emptyMembersTitle')}
            description={t('chat.emptyMembersDescription')}
          />
          {chatId ? (
            <p data-testid="member-empty-hint" className="px-1 pb-1 text-center text-[11px] text-accent">
              {t('chat.noMembersHint')}
            </p>
          ) : null}
        </>
      ) : (
        <ReorderableList
          items={members}
          itemId={(agent) => agent.id}
          onReorder={onReorder}
          rowTestId="member-row"
          rowTitle={t('chat.reorderMember')}
          rowClassName="group flex items-center gap-2.5 rounded-lg p-2 transition-colors hover:bg-bg-muted"
        >
          {(agent) => (
            <MemberRow
              chatId={chatId}
              agent={agent}
              tokens={usage.perAgent[agent.id]?.usage.totalTokens ?? 0}
              providers={providers}
              onRemove={() => onRemove(agent.id)}
            />
          )}
        </ReorderableList>
      )}
    </section>
  )
}

interface MemberRowProps {
  chatId: string | null
  agent: Agent
  /** This agent's total tokens in this chat; `0` means it has not spoken yet. */
  tokens: number
  providers: readonly Provider[]
  onRemove: () => void
}

/**
 * The **contents** of one member row: `ReorderableList` owns the wrapper that
 * carries `data-testid="member-row"`, the drag handlers and the classes.
 */
function MemberRow({
  chatId,
  agent,
  tokens,
  providers,
  onRemove
}: MemberRowProps): React.JSX.Element {
  const { t } = useTranslation()
  const record = usePresence(chatId, agent.id)
  const presence: PresenceState = record?.state ?? 'available'
  const retrying = useIsRetrying(chatId, agent.id)
  const now = useTickingNow(presence === 'away')
  const label = presenceText(t, record, now)

  return (
    <>
      <Avatar
        text={agent.avatar.text}
        {...avatarStyle(agent.avatar)}
        size="md"
        presence={presence}
        presenceLabel={presenceLabel(t, presence)}
        presenceTestId="member-presence"
      />
      <div className="flex min-w-0 grow flex-col gap-px">
        <span className="flex min-w-0 items-center gap-1.5">
          <span data-testid="member-name" className="truncate text-[13px] text-fg">
            {agent.name}
          </span>
          {isExecutor(agent) ? (
            <Badge
              tone="accent"
              font="sans"
              data-testid="member-executor"
              title={t('agents.executorBadgeTitle')}
            >
              {t('agents.executorBadge')}
            </Badge>
          ) : null}
        </span>
        {/* `model · presence`, as the artboard has it. The provider's name would
            not fit in 288px next to both, so it lives in the tooltip and in the
            picker rows, where there is room for it. */}
        <span
          data-testid="member-model"
          data-presence={presence}
          title={agentModelLabel(agent, providers)}
          className="truncate text-[11px] text-fg-faint"
        >
          {`${agent.modelId} · ${label}`}
        </span>
      </div>
      {/*
        The manual half of the recovery loop. It replaces the usage column
        instead of joining it, because a 288px row cannot carry both and an
        offline member has no usage worth reading anyway.
      */}
      {presence === 'offline' && chatId ? (
        <button
          type="button"
          data-testid="member-retry"
          disabled={retrying}
          onClick={() => void usePresenceStore.getState().retry(chatId, agent.id)}
          className="shrink-0 rounded px-1 text-[11px] text-accent transition-colors hover:text-fg disabled:cursor-not-allowed disabled:text-fg-faint focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
        >
          {retrying ? t('presence.retrying') : t('presence.retry')}
        </button>
      ) : (
        <span
          data-testid="member-usage"
          data-tokens={tokens}
          title={t('chat.memberUsageTitle')}
          className="shrink-0 font-mono text-[11px] text-fg-faint"
        >
          {tokens > 0 ? formatTokens(tokens) : t('chat.memberUsage')}
        </span>
      )}
      <IconButton
        size="sm"
        label={t('chat.removeMember')}
        data-testid="member-remove"
        className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        onClick={onRemove}
      >
        <X aria-hidden="true" className="h-3.5 w-3.5" />
      </IconButton>
    </>
  )
}
