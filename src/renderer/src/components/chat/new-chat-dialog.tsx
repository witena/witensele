/**
 * How a topic is convened (S9.3): a committee, individual agents, or both.
 *
 * Until this step the chat list's "+" created a chat and that was the whole
 * interaction — the members were chosen afterwards, one popover click at a
 * time, in the panel on the far side of the window. That was fine while a chat
 * was only ever a handful of agents picked by hand. It stops being fine the
 * moment a committee exists, because "convene the architecture review on this
 * question" is one decision and it would have taken five clicks in three places.
 *
 * ## The rules the form draws
 *
 * - **At most one committee.** A single-select list that can be left empty —
 *   clicking the selected row again clears it. The column is single-valued on
 *   purpose (`docs/features/committees/context.md`); several committees per
 *   chat is a Phase 6 entry, not a thing this list is hiding.
 * - **The committee's members are checked and locked.** They are going to be in
 *   the chat whatever the agent list says, so showing them unticked would be a
 *   lie and showing them tickable would be a control that does nothing.
 * - **One executor.** PLAN.md allows one writer per group, so once the merged
 *   list has one, every other executor is disabled with the same
 *   `chat.executorTaken` sentence the member panel and the committee editor
 *   use. Picking a committee that brings an executor drops an executor the user
 *   had ticked, rather than leaving the form in a state the backend would
 *   refuse.
 * - **Create with nothing chosen is the old "+".** No title, no committee, no
 *   agents sends an empty input, and the backend does exactly what it did
 *   before: an empty chat, or the bootstrap agent on a library that has never
 *   been used.
 *
 * The count under the lists is `mergeMembers` — the renderer's copy of the
 * backend's own merge rule (`lib/committee-members.ts`) — so the number the user
 * reads is the number of rows the member panel will show a moment later.
 *
 * A refusal keeps the dialog **open** and prints the reason inside it. The
 * chat list's error line is behind the scrim, and a dialog that vanished
 * leaving a red line on a column nobody was looking at would be the worst of
 * both.
 */
import clsx from 'clsx'
import { Check } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent, BackendErrorCode } from '@shared/types'
import { agentModelLabel, avatarStyle, hasExecutor, isExecutor } from '../agents/agent-display'
import { Avatar, Badge, Button, Dialog, Field, Input, SectionTitle } from '../ui'
import { translateFailure } from '../../i18n/errors'
import { mergeMembers } from '../../lib/committee-members'
import { useAgentsStore } from '../../stores/agents'
import { useChatsStore } from '../../stores/chats'
import { useCommitteesStore } from '../../stores/committees'
import { useProvidersStore } from '../../stores/providers'
import { useUiStore } from '../../stores/ui'

/** What the store left behind when `create` returned `null`. */
interface Refusal {
  code: BackendErrorCode | undefined
  details: unknown
}

export function NewChatDialog(): React.JSX.Element {
  const { t } = useTranslation()

  // A seed, not the selection: the store hands the dialog the committee "New
  // topic" was pressed on and stops caring (see `stores/ui.ts`).
  const seed = useUiStore((state) => state.newChatDialog.committeeId)
  const committees = useCommitteesStore((state) => state.committees)
  const agents = useAgentsStore((state) => state.agents)
  const providers = useProvidersStore((state) => state.providers)

  const [title, setTitle] = useState('')
  const [committeeId, setCommitteeId] = useState<string | null>(seed ?? null)
  const [extraIds, setExtraIds] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)

  const close = (): void => useUiStore.getState().closeNewChatDialog()

  const agentById = (agentId: string): Agent | undefined =>
    agents.find((agent) => agent.id === agentId)

  const resolve = (agentIds: readonly string[]): Agent[] =>
    agentIds.map(agentById).filter((agent): agent is Agent => agent !== undefined)

  const committee = committees.find((candidate) => candidate.id === committeeId) ?? null
  const committeeMemberIds = committee?.memberAgentIds ?? []
  // The exact list the backend will build, so the count is not an estimate.
  const merged = mergeMembers(committeeMemberIds, extraIds)
  const executorTaken = hasExecutor(resolve(merged))

  const pickCommittee = (id: string): void => {
    const next = committeeId === id ? null : id
    setCommitteeId(next)
    setRefusal(null)
    if (next === null) return

    const picked = committees.find((candidate) => candidate.id === next)
    if (!picked) return
    const brings = picked.memberAgentIds
    const bringsExecutor = hasExecutor(resolve(brings))
    // Two kinds of now-impossible tick: one the committee already contributes,
    // and an executor the committee's own executor would collide with.
    setExtraIds((ids) =>
      ids.filter((extra) => {
        if (brings.includes(extra)) return false
        const agent = agentById(extra)
        return !(bringsExecutor && agent !== undefined && isExecutor(agent))
      })
    )
  }

  const toggleAgent = (agentId: string): void => {
    // A committee member is locked: the row is a read-out, not a control.
    if (committeeMemberIds.includes(agentId)) return
    setRefusal(null)
    setExtraIds((ids) =>
      ids.includes(agentId) ? ids.filter((id) => id !== agentId) : [...ids, agentId]
    )
  }

  const submit = async (): Promise<void> => {
    setCreating(true)
    setRefusal(null)
    const chat = await useChatsStore.getState().create({
      title,
      ...(committeeId ? { committeeId } : {}),
      memberAgentIds: extraIds
    })
    setCreating(false)
    if (chat) {
      close()
      return
    }
    const { errorCode, errorDetails } = useChatsStore.getState()
    setRefusal({ code: errorCode, details: errorDetails })
  }

  return (
    <Dialog
      title={t('chat.newChat')}
      closeLabel={t('common.close')}
      testId="new-chat-dialog"
      onClose={close}
      footer={
        <>
          <Button data-testid="new-chat-cancel" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            data-testid="new-chat-create"
            disabled={creating}
            onClick={() => void submit()}
          >
            {t('chat.newChatCreate')}
          </Button>
        </>
      }
    >
      <Field label={t('chat.newChatTitleLabel')} layout="column" htmlFor="new-chat-title">
        <Input
          id="new-chat-title"
          data-testid="new-chat-title"
          value={title}
          placeholder={t('chat.newChatTitlePlaceholder')}
          onChange={(event) => setTitle(event.target.value)}
        />
      </Field>

      <section className="flex flex-col gap-1.5">
        <SectionTitle level={3}>{t('nav.committees')}</SectionTitle>
        <p className="text-[11px] text-fg-faint">{t('chat.newChatCommitteesHint')}</p>

        {committees.length === 0 ? (
          <p className="px-1 py-1.5 text-[11px] text-fg-faint">
            {t('chat.newChatCommitteesEmpty')}
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {committees.map((candidate) => {
              const selected = candidate.id === committeeId
              return (
                <button
                  key={candidate.id}
                  type="button"
                  data-testid="new-chat-committee"
                  data-committee-id={candidate.id}
                  data-selected={selected}
                  onClick={() => pickCommittee(candidate.id)}
                  className={clsx(
                    'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
                    'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
                    selected ? 'bg-bg-hover text-fg' : 'text-fg-muted hover:bg-bg-subtle'
                  )}
                >
                  <Tick on={selected} />
                  <span className="flex min-w-0 grow flex-col gap-px">
                    {/* The name is stored data, not copy. */}
                    <span className="truncate text-[13px] text-fg">{candidate.name}</span>
                    <span className="truncate text-[11px] text-fg-faint">
                      {t('committees.memberCount', {
                        members: candidate.memberAgentIds.length
                      })}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-1.5">
        <SectionTitle level={3}>{t('chat.newChatAgents')}</SectionTitle>

        {agents.length === 0 ? (
          <p className="px-1 py-1.5 text-[11px] text-fg-faint">{t('chat.addMemberEmpty')}</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {agents.map((agent) => {
              const locked = committeeMemberIds.includes(agent.id)
              const checked = locked || extraIds.includes(agent.id)
              const blocked = !checked && executorTaken && isExecutor(agent)
              return (
                <button
                  key={agent.id}
                  type="button"
                  data-testid="new-chat-agent"
                  data-agent-id={agent.id}
                  data-selected={checked}
                  data-locked={locked}
                  data-blocked={blocked}
                  disabled={blocked || locked}
                  onClick={() => toggleAgent(agent.id)}
                  className={clsx(
                    'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
                    'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
                    blocked && 'cursor-not-allowed opacity-55',
                    // Locked is not disabled-looking: the row is *on*, it simply
                    // cannot be turned off, so it keeps the selected surface.
                    locked && 'cursor-default',
                    checked ? 'bg-bg-hover text-fg' : !blocked && 'text-fg-muted hover:bg-bg-subtle'
                  )}
                >
                  <Tick on={checked} />
                  <Avatar text={agent.avatar.text} {...avatarStyle(agent.avatar)} size="md" />
                  <span className="flex min-w-0 grow flex-col gap-px">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[13px] text-fg">{agent.name}</span>
                      {isExecutor(agent) ? (
                        <Badge tone="accent" font="sans" data-testid="new-chat-agent-executor">
                          {t('agents.executorBadge')}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="truncate font-mono text-[11px] text-fg-faint">
                      {blocked
                        ? t('chat.executorTaken')
                        : locked
                          ? t('chat.newChatFromCommittee')
                          : agentModelLabel(agent, providers)}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </section>

      <p data-testid="new-chat-summary" data-members={merged.length} className="text-xs text-fg-muted">
        {t('chat.newChatSummary', { members: merged.length })}
      </p>

      {refusal ? (
        <p
          data-testid="new-chat-error"
          data-error-code={refusal.code ?? 'internal'}
          className="text-[11px] text-danger"
        >
          {translateFailure(t, refusal.code, refusal.details)}
        </p>
      ) : null}
    </Dialog>
  )
}

/**
 * The checkbox, drawn rather than used.
 *
 * A real `<input type="checkbox">` inside a `<button>` is invalid HTML and
 * inside a clickable row is two focus stops for one decision; the row is the
 * control, and this is what it looks like when it is on.
 */
function Tick({ on }: { on: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
        on ? 'border-accent bg-accent text-bg-base' : 'border-border-strong'
      )}
    >
      {on ? <Check strokeWidth={3} className="h-2.5 w-2.5" /> : null}
    </span>
  )
}
