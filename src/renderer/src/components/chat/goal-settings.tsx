/**
 * The **Goal** block of the group settings, under "Working directory" (S5.10).
 *
 * What the group is working towards: a kind, a description, and — for a
 * `document` — the file it produces plus the materials it starts from. Every
 * member's system prompt is briefed with it, so this is the one control on the
 * screen that changes what the models are told rather than how they are
 * scheduled.
 *
 * ## Why this one has a draft when nothing else in the panel does
 *
 * Every other control in the group settings is one field of one row and persists
 * on change, with no Save button. A goal is a JSON object, and two of its fields
 * are free text: persisting on every keystroke would be a write per character,
 * and persisting only the changed field is not possible when the column holds
 * the whole object. So the block holds a **draft** and writes it on blur —
 * "per field on blur", which is what the rest of the panel does for the fields
 * that are text (the chat title is renamed the same way).
 *
 * ## Why an empty description means no goal
 *
 * `chats.update` refuses a goal with a blank description, because a goal *is*
 * its description — a kind on its own says nothing a model can act on. That
 * gives the block its two edges for free, and they are the only surprising part
 * of it, so they are stated here rather than left to be discovered:
 *
 * - Picking a kind while the description is empty changes the **draft only**.
 *   The goal is created by the first blur that leaves text in the box.
 * - Emptying the description of a chat that has a goal and blurring **removes**
 *   the goal (`goal: null`). It is the way back out, and it is the same gesture
 *   that created it.
 *
 * ## Why Document and Codebase are disabled without a folder
 *
 * Both of them name files, and `chats.update` refuses them on a chat bound to
 * nothing. The segments are disabled with the reason underneath rather than
 * hidden: a control that is not there teaches nobody that the kind exists.
 */
import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatGoal, GoalKind } from '@shared/types'
import { Button, Field, IconButton, Input, SectionTitle, SegmentedControl, TextArea } from '../ui'
import { useChatsStore } from '../../stores/chats'

export interface GoalSettingsProps {
  chatId: string | null
  workdir: string | null
  goal: ChatGoal | null
}

/** Everything the block edits before it is persisted. */
interface GoalDraft {
  kind: GoalKind
  description: string
  /**
   * Kept even while the kind is not `document`, so switching away and back does
   * not lose a path the user typed. It is only ever **sent** for a `document`:
   * the backend refuses a deliverable on the other two kinds, and rightly.
   */
  deliverable: string
  materials: string[]
}

const EMPTY_DRAFT: GoalDraft = { kind: 'discussion', description: '', deliverable: '', materials: [] }

function draftOf(goal: ChatGoal | null): GoalDraft {
  if (!goal) return EMPTY_DRAFT
  return {
    kind: goal.kind,
    description: goal.description,
    deliverable: goal.deliverable ?? '',
    materials: goal.materials
  }
}

/** The draft as the object `chats.update` takes, or `null` to remove the goal. */
export function composeGoal(draft: GoalDraft): ChatGoal | null {
  const description = draft.description.trim()
  if (description.length === 0) return null
  const deliverable = draft.deliverable.trim()
  return {
    kind: draft.kind,
    description,
    materials: draft.materials,
    ...(draft.kind === 'document' && deliverable.length > 0 ? { deliverable } : {})
  }
}

export function GoalSettings({ chatId, workdir, goal }: GoalSettingsProps): React.JSX.Element {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<GoalDraft>(() => draftOf(goal))

  // Re-seed from the stored goal whenever the chat changes or the stored goal
  // does. Keyed on the **value** rather than the object identity: every save
  // returns a fresh `Chat`, and resetting the box on each of those would fight
  // with the cursor of anyone still typing in it.
  const stored = JSON.stringify(goal)
  useEffect(() => {
    setDraft(draftOf(goal))
    // `goal` itself is deliberately not a dependency: `stored` is its *value*,
    // which is the thing that must re-seed the draft, and `chatId` covers
    // switching to a chat whose goal happens to be identical.
  }, [chatId, stored]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = (next: GoalDraft): void => {
    if (!chatId) return
    // `composeGoal` returns null for a blank description, which is how a goal is
    // removed; a chat that never had one then writes `null` over `null`, which
    // the backend accepts and nothing notices.
    void useChatsStore.getState().setGoal(chatId, composeGoal(next))
  }

  const update = (patch: Partial<GoalDraft>, persist: boolean): void => {
    const next = { ...draft, ...patch }
    setDraft(next)
    if (persist) save(next)
  }

  const bound = Boolean(workdir)
  const disabled = !chatId

  const chooseDeliverable = (): void => {
    if (!workdir) return
    void useChatsStore
      .getState()
      .pickDeliverable(workdir)
      .then((relative) => {
        // A cancelled dialog and a pick outside the folder both answer `null`;
        // the second left its own reason in the chats error line.
        if (relative !== null) update({ deliverable: relative }, true)
      })
  }

  const addMaterials = (): void => {
    if (!workdir) return
    void useChatsStore
      .getState()
      .pickMaterials(workdir)
      .then((picked) => {
        // De-duplicated against what is already listed: the dialog does not know
        // what the goal holds, and the same file twice is the same material.
        const added = picked.filter((path) => !draft.materials.includes(path))
        if (added.length > 0) update({ materials: [...draft.materials, ...added] }, true)
      })
  }

  return (
    <div className="flex flex-col gap-2.5" data-testid="chat-goal">
      <SectionTitle level={3}>{t('chat.goal')}</SectionTitle>

      <SegmentedControl<GoalKind>
        value={draft.kind}
        disabled={disabled}
        onChange={(kind) => update({ kind }, draft.description.trim().length > 0)}
        options={[
          {
            value: 'discussion',
            label: t('chat.goalKindDiscussion'),
            testId: 'goal-discussion'
          },
          {
            value: 'document',
            label: t('chat.goalKindDocument'),
            testId: 'goal-document',
            disabled: !bound
          },
          {
            value: 'codebase',
            label: t('chat.goalKindCodebase'),
            testId: 'goal-codebase',
            disabled: !bound
          }
        ]}
      />

      {bound ? null : (
        <p data-testid="goal-needs-workdir" className="text-[11px] text-fg-faint">
          {t('chat.goalNeedsWorkdirHint')}
        </p>
      )}

      <Field label={t('chat.goalDescription')} layout="column">
        <TextArea
          rows={3}
          data-testid="goal-description"
          disabled={disabled}
          value={draft.description}
          placeholder={t('chat.goalDescriptionPlaceholder')}
          onChange={(event) => update({ description: event.target.value }, false)}
          onBlur={() => save(draft)}
          className="rounded-md border border-border-strong bg-bg-elevated px-2 py-1.5 text-xs"
        />
      </Field>

      {draft.kind === 'document' ? (
        <Field label={t('chat.goalDeliverable')} layout="column">
          <div className="flex items-center gap-1.5">
            <Input
              data-testid="goal-deliverable"
              disabled={disabled}
              value={draft.deliverable}
              placeholder={t('chat.goalDeliverablePlaceholder')}
              wrapperClassName="min-w-0 grow"
              className="font-mono text-[11px]"
              onChange={(event) => update({ deliverable: event.target.value }, false)}
              onBlur={() => save(draft)}
            />
            <Button
              size="sm"
              data-testid="goal-deliverable-pick"
              disabled={disabled || !bound}
              onClick={chooseDeliverable}
            >
              {t('chat.goalDeliverableChoose')}
            </Button>
          </div>
        </Field>
      ) : null}

      <Field label={t('chat.goalMaterials')} layout="column">
        <div data-testid="goal-materials" className="flex flex-col gap-1">
          {draft.materials.length === 0 ? (
            <span className="text-[11px] text-fg-faint">{t('chat.goalMaterialsNone')}</span>
          ) : (
            draft.materials.map((path) => (
              <div
                key={path}
                data-testid="goal-material"
                data-path={path}
                className="flex items-center gap-1"
              >
                {/* The path is data and is printed, never translated. */}
                <span title={path} className="min-w-0 grow truncate font-mono text-[11px] text-fg-dim">
                  {path}
                </span>
                <IconButton
                  label={t('chat.goalMaterialRemove')}
                  data-testid="goal-material-remove"
                  onClick={() =>
                    update({ materials: draft.materials.filter((entry) => entry !== path) }, true)
                  }
                >
                  <X aria-hidden="true" className="h-3 w-3" />
                </IconButton>
              </div>
            ))
          )}
          <div>
            <Button
              size="sm"
              data-testid="goal-materials-add"
              disabled={disabled || !bound}
              onClick={addMaterials}
            >
              {t('chat.goalMaterialsAdd')}
            </Button>
          </div>
        </div>
      </Field>
    </div>
  )
}
