/**
 * The right column's member list: the mockup's `.member` rows, plus the three
 * things S2.2 makes real — add, remove and reorder.
 *
 * ## Why drag-and-drop uses the native HTML5 events
 *
 * A list of at most a handful of rows, reordered by dragging, inside an Electron
 * window that is always Chromium: `draggable` plus `dragstart` / `dragover` /
 * `drop` is about twenty lines and no dependency. A drag-and-drop library would
 * add a package, a provider component and its own keyboard model to a control
 * that already has a keyboard-accessible alternative in the works (the speaking
 * order is also the member order, which S2.3 will let the user set from the
 * agent list). The index arithmetic — the only part that can silently be wrong —
 * lives in `lib/reorder.ts` and is unit-tested there.
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
import clsx from 'clsx'
import type { TFunction } from 'i18next'
import { Plus, UserPlus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatTokens } from '@shared/pricing'
import type { Agent, AgentPresence, PresenceState, Provider } from '@shared/types'
import { agentModelLabel, hasExecutor, isExecutor } from '../agents/agent-display'
import { useIsRetrying, usePresence, usePresenceStore } from '../../stores/presence'
import { useChatUsage } from '../../stores/usage'
import { Avatar, Badge, Button, EmptyState, IconButton, SectionTitle } from '../ui'

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
  const [dragIndex, setDragIndex] = useState<number | null>(null)
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

  const candidates = agents.filter((agent) => !members.some((member) => member.id === agent.id))
  // PLAN.md: one writer per chat. The picker says so before the click rather
  // than letting the backend refuse it — the refusal is still the authority
  // (see `assertOneExecutor` in `src/main/handlers/chats.ts`), this is the
  // explanation.
  const executorTaken = hasExecutor(members)

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
        <div
          data-testid="member-picker"
          className="absolute top-7 right-0 z-10 flex w-[264px] flex-col gap-0.5 rounded-lg border border-border-strong bg-bg-elevated p-1.5 shadow-lg"
        >
          {candidates.length === 0 ? (
            <p className="px-2 py-2 text-[11px] text-fg-faint">
              {agents.length === 0 ? t('chat.addMemberEmpty') : t('chat.addMemberAll')}
            </p>
          ) : (
            candidates.map((agent) => {
              const blocked = executorTaken && isExecutor(agent)
              return (
                <button
                  key={agent.id}
                  type="button"
                  data-testid="member-candidate"
                  data-agent-id={agent.id}
                  data-blocked={blocked ? 'true' : 'false'}
                  disabled={blocked}
                  onClick={() => {
                    setPicking(false)
                    onAdd(agent.id)
                  }}
                  className={clsx(
                    'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
                    blocked ? 'cursor-not-allowed opacity-55' : 'hover:bg-bg-hover'
                  )}
                >
                  <Avatar
                    text={agent.avatar.text}
                    color={agent.avatar.color}
                    textColor={agent.avatar.textColor}
                    size="md"
                  />
                  <span className="flex min-w-0 flex-col gap-px">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[13px] text-fg">{agent.name}</span>
                      {isExecutor(agent) ? (
                        <Badge tone="accent" font="sans" data-testid="member-candidate-executor">
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
        members.map((agent, index) => (
          <MemberRow
            key={agent.id}
            chatId={chatId}
            agent={agent}
            tokens={usage.perAgent[agent.id]?.usage.totalTokens ?? 0}
            providers={providers}
            dragging={dragIndex === index}
            onDragStart={() => setDragIndex(index)}
            onDragEnd={() => setDragIndex(null)}
            onDrop={() => {
              if (dragIndex !== null) onReorder(dragIndex, index)
              setDragIndex(null)
            }}
            onRemove={() => onRemove(agent.id)}
          />
        ))
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
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onDrop: () => void
  onRemove: () => void
}

function MemberRow({
  chatId,
  agent,
  tokens,
  providers,
  dragging,
  onDragStart,
  onDragEnd,
  onDrop,
  onRemove
}: MemberRowProps): React.JSX.Element {
  const { t } = useTranslation()
  const record = usePresence(chatId, agent.id)
  const presence: PresenceState = record?.state ?? 'available'
  const retrying = useIsRetrying(chatId, agent.id)
  const now = useTickingNow(presence === 'away')
  const label = presenceText(t, record, now)

  return (
    <div
      data-testid="member-row"
      data-agent-id={agent.id}
      draggable
      title={t('chat.reorderMember')}
      onDragStart={(event) => {
        // Chromium refuses to start a drag without payload; the index itself is
        // kept in React state because the drop target needs it synchronously.
        event.dataTransfer.setData('text/plain', agent.id)
        event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        // Without this the drop event never fires: the default is "not a target".
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(event) => {
        event.preventDefault()
        onDrop()
      }}
      className={clsx(
        'group flex items-center gap-2.5 rounded-lg p-2 transition-colors hover:bg-bg-muted',
        dragging && 'opacity-50'
      )}
    >
      <Avatar
        text={agent.avatar.text}
        color={agent.avatar.color}
        textColor={agent.avatar.textColor}
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
    </div>
  )
}
