/**
 * The committee form: the right-hand two thirds of the Committees page.
 *
 * Header (name, Delete, Save) plus a two-column body — name, description and
 * the ordered member list on the left; the topics this committee has been
 * convened on on the right. Everything writes into the store's `draft`; nothing
 * reaches the backend until Save, which is disabled until the draft is both
 * `dirty` and valid. That is the Agents editor's shape, its components and its
 * spacing, because a committee is edited the same way an agent is.
 *
 * ## The member list is the whole feature
 *
 * A committee *is* an ordered list of agents, and the order is the speaking
 * order a chat inherits at creation — so the list carries three ways to change
 * it, and two of them work without a pointer:
 *
 * - **Add** opens `AgentPicker`, the member panel's popover, with the executor
 *   rule and its `chat.executorTaken` explanation already in it.
 * - **Drag** a row onto another, through `ReorderableList` — the member panel's
 *   own drag interaction, extracted in S9.2 so both lists behave identically.
 * - **Move up / move down**, two buttons per row, because dragging is
 *   pointer-only and this list decides who speaks first.
 *
 * All three end in a `patchDraft`, never a backend call: membership rides on the
 * entity (there is no `committees.members.*`), so the list is written with the
 * rest of the record when Save is pressed.
 */
import { ChevronDown, ChevronUp, Plus, UserPlus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { Agent, Provider } from '@shared/types'
import { MAX_COMMITTEE_NAME_CHARS } from '@shared/types'
import { agentModelLabel, avatarStyle, isExecutor } from '../agents/agent-display'
import { AgentPicker } from '../agents/agent-picker'
import { CommitteeTopics } from './committee-topics'
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
  Input,
  ReorderableList,
  SectionTitle
} from '../ui'
import type { CommitteeDraftErrors } from '../../stores/committees'
import { useCommitteesStore } from '../../stores/committees'

/** Literal `t()` calls, so `used-keys.test.ts` can verify every message. */
function nameError(t: TFunction, code: CommitteeDraftErrors['name']): string | undefined {
  switch (code) {
    case 'required':
      return t('committees.validation.nameRequired')
    case 'tooLong':
      return t('committees.validation.nameTooLong', { max: MAX_COMMITTEE_NAME_CHARS })
    default:
      return undefined
  }
}

export interface CommitteeEditorProps {
  /** Every agent in the library, for the picker and for the member rows. */
  agents: readonly Agent[]
  providers: readonly Provider[]
  /** True once Delete has been armed; a second click confirms. */
  deleteArmed: boolean
  onDelete: () => void
}

export function CommitteeEditor({
  agents,
  providers,
  deleteArmed,
  onDelete
}: CommitteeEditorProps): React.JSX.Element | null {
  const { t } = useTranslation()

  const draft = useCommitteesStore((state) => state.draft)
  const dirty = useCommitteesStore((state) => state.dirty)
  const saving = useCommitteesStore((state) => state.saving)
  const selectedId = useCommitteesStore((state) => state.selectedId)

  const [picking, setPicking] = useState(false)
  const members = useRef<HTMLElement>(null)

  // The picker belongs to the committee that was open, not to the one that has
  // just been selected — and it closes on a click anywhere else, exactly as the
  // member panel's does (the open state is the caller's; see `AgentPicker`).
  useEffect(() => setPicking(false), [selectedId])

  useEffect(() => {
    if (!picking) return undefined
    const close = (event: MouseEvent): void => {
      if (!members.current?.contains(event.target as Node)) setPicking(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [picking])

  if (!draft) return null

  const store = (): ReturnType<typeof useCommitteesStore.getState> =>
    useCommitteesStore.getState()
  const errors = store().draftErrors()
  const saveDisabled = saving || !dirty || Object.keys(errors).length > 0

  // Ids the library can no longer resolve are simply not drawn: `agents.delete`
  // cascades the join row away, so a missing agent means the list is a render
  // behind the deletion rather than that the committee holds a ghost.
  const memberAgents = draft.memberAgentIds
    .map((id) => agents.find((agent) => agent.id === id))
    .filter((agent): agent is Agent => agent !== undefined)

  return (
    <>
      <header className="flex h-[52px] shrink-0 items-center justify-between gap-3 border-b border-border px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <h1 data-testid="committee-editor-name" className="truncate text-sm font-semibold text-fg">
            {draft.name}
          </h1>
          <span className="shrink-0 text-[11px] text-fg-faint">
            {t('committees.memberCount', { members: draft.memberAgentIds.length })}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="danger"
            data-testid="committee-delete"
            disabled={selectedId === null}
            onClick={onDelete}
            title={deleteArmed ? t('committees.deleteConfirm') : t('common.delete')}
          >
            {deleteArmed ? t('committees.deleteConfirm') : t('common.delete')}
          </Button>
          <Button
            variant="primary"
            data-testid="committee-save"
            disabled={saveDisabled}
            onClick={() => void store().save()}
          >
            {t('common.save')}
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-7 overflow-y-auto px-6 py-5">
        {/* Left column: what the committee is, and who is in it. */}
        <div className="flex min-w-0 flex-col gap-5">
          <section className="flex flex-col gap-2.5">
            <SectionTitle level={3}>{t('committees.basicInfo')}</SectionTitle>

            <Field label={t('committees.name')} layout="column" htmlFor="committee-name">
              <Input
                id="committee-name"
                data-testid="committee-name"
                value={draft.name}
                placeholder={t('committees.namePlaceholder')}
                onChange={(event) => store().patchDraft({ name: event.target.value })}
              />
              {nameError(t, errors.name) ? (
                <p data-testid="committee-name-error" className="text-[11px] text-danger">
                  {nameError(t, errors.name)}
                </p>
              ) : null}
            </Field>

            <Field
              label={t('committees.description')}
              hint={t('committees.descriptionHint')}
              layout="column"
              htmlFor="committee-description"
            >
              <Input
                id="committee-description"
                data-testid="committee-description"
                value={draft.description}
                placeholder={t('committees.descriptionPlaceholder')}
                onChange={(event) => store().patchDraft({ description: event.target.value })}
              />
            </Field>
          </section>

          <section ref={members} className="relative flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <SectionTitle level={3} count={memberAgents.length}>
                {t('committees.members')}
              </SectionTitle>
              <Button
                variant="ghost"
                size="sm"
                data-testid="committee-member-add"
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
                selected={memberAgents}
                providers={providers}
                testIdPrefix="committee-member"
                emptyLabel={t('committees.addMemberEmpty')}
                allAddedLabel={t('committees.addMemberAll')}
                className="absolute top-7 right-0 z-10 w-[264px]"
                onPick={(agentId) => {
                  setPicking(false)
                  store().addMember(agentId)
                }}
              />
            ) : null}

            {memberAgents.length === 0 ? (
              <EmptyState
                size="sm"
                icon={UserPlus}
                title={t('committees.emptyMembersTitle')}
                description={t('committees.emptyMembersDescription')}
              />
            ) : (
              <ReorderableList
                items={memberAgents}
                itemId={(agent) => agent.id}
                onReorder={(from, to) => store().moveMember(from, to)}
                rowTestId="committee-member-row"
                rowTitle={t('committees.reorderMember')}
                rowClassName="group flex items-center gap-2.5 rounded-lg p-2 transition-colors hover:bg-bg-muted"
              >
                {(agent, index) => (
                  <>
                    <Avatar text={agent.avatar.text} {...avatarStyle(agent.avatar)} size="md" />
                    <div className="flex min-w-0 grow flex-col gap-px">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span
                          data-testid="committee-member-name"
                          className="truncate text-[13px] text-fg"
                        >
                          {agent.name}
                        </span>
                        {isExecutor(agent) ? (
                          <Badge
                            tone="accent"
                            font="sans"
                            data-testid="committee-member-executor"
                            title={t('agents.executorBadgeTitle')}
                          >
                            {t('agents.executorBadge')}
                          </Badge>
                        ) : null}
                      </span>
                      <span className="truncate font-mono text-[11px] text-fg-faint">
                        {agentModelLabel(agent, providers)}
                      </span>
                    </div>
                    {/*
                      The keyboard half of the reorder. Two buttons rather than a
                      key handler on the row, because the row is a `div` nobody
                      can focus and making it focusable would put every member
                      into the tab order twice.
                    */}
                    <IconButton
                      size="sm"
                      label={t('committees.moveUp')}
                      data-testid="committee-member-up"
                      disabled={index === 0}
                      className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => store().moveMember(index, index - 1)}
                    >
                      <ChevronUp aria-hidden="true" className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton
                      size="sm"
                      label={t('committees.moveDown')}
                      data-testid="committee-member-down"
                      disabled={index === memberAgents.length - 1}
                      className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => store().moveMember(index, index + 1)}
                    >
                      <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton
                      size="sm"
                      label={t('committees.removeMember')}
                      data-testid="committee-member-remove"
                      className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => store().removeMember(agent.id)}
                    >
                      <X aria-hidden="true" className="h-3.5 w-3.5" />
                    </IconButton>
                  </>
                )}
              </ReorderableList>
            )}
          </section>
        </div>

        {/* Right column: where this committee has been convened. */}
        <div className="flex min-w-0 flex-col gap-5">
          <CommitteeTopics committeeId={selectedId} />
        </div>
      </div>
    </>
  )
}
