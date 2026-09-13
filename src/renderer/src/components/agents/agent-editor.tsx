/**
 * The agent configuration form: the right-hand two thirds of the Agents artboard.
 *
 * Header (avatar, name, "in N chats", Duplicate / Delete / Save) plus a two-column
 * body — basic info, model and system prompt on the left; skills, MCP servers and
 * memory on the right. Everything writes into the store's `draft`; nothing
 * reaches the backend until Save, which is disabled until the draft is both
 * `dirty` and valid.
 *
 * ## Why three of the blocks are empty states
 *
 * Skills (S3.2), MCP servers (S3.1) and the memory viewer (S3.3) are later steps.
 * They are drawn as `EmptyState`s that *name the step* rather than being left out,
 * because the artboard's proportions depend on them: dropping them would make the
 * right column collapse and the form stop looking like the design. The memory
 * **toggle** is real — `memoryEnabled` is a stored field the agent turn will read
 * — only its contents are pending.
 *
 * ## Why the model control is a select *and* a text field
 *
 * A provider's `models` list can legitimately be empty (a custom endpoint nobody
 * fetched, an Ollama that was offline when the provider was added). Offering only
 * a dropdown would make such a provider unusable; offering only free text would
 * throw away the list the user already fetched. So the select appears when there
 * is a list and the text field when there is not — the same shape the provider
 * editor uses for its own model list.
 */
import type { TFunction } from 'i18next'
import { Puzzle, Server } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent, Provider } from '@shared/types'
import {
  Avatar,
  Button,
  EmptyState,
  Field,
  Input,
  SectionTitle,
  Select,
  TextArea,
  Toggle
} from '../ui'
import { AGENT_AVATAR_COLORS, avatarInitial } from './agent-display'
import type { AgentDraftErrors } from '../../stores/agents'
import { useAgentsStore, validateDraft } from '../../stores/agents'

/** Literal `t()` calls so `used-keys.test.ts` can verify every message. */
function nameError(t: TFunction, code: AgentDraftErrors['name']): string | undefined {
  switch (code) {
    case 'required':
      return t('agents.validation.nameRequired')
    case 'at':
      return t('agents.validation.nameAt')
    case 'taken':
      return t('agents.validation.nameTaken')
    default:
      return undefined
  }
}

export interface AgentEditorProps {
  providers: readonly Provider[]
  /** The stored record, when editing one; absent while creating. */
  agent: Agent | undefined
  /** How many chats the edited agent is a member of. */
  chatCount: number
  /** True once Delete has been armed; a second click confirms. */
  deleteArmed: boolean
  onDelete: () => void
  onDuplicate: () => void
}

export function AgentEditor({
  providers,
  agent,
  chatCount,
  deleteArmed,
  onDelete,
  onDuplicate
}: AgentEditorProps): React.JSX.Element | null {
  const { t } = useTranslation()

  const draft = useAgentsStore((state) => state.draft)
  const dirty = useAgentsStore((state) => state.dirty)
  const saving = useAgentsStore((state) => state.saving)
  const agents = useAgentsStore((state) => state.agents)
  const selectedId = useAgentsStore((state) => state.selectedId)

  // Computed rather than selected: `validateDraft` returns a fresh object every
  // call, and zustand compares snapshots by identity — selecting it would make
  // the subscription report a change on every render.
  const errors: AgentDraftErrors = useMemo(
    () => (draft ? validateDraft(draft, agents, selectedId) : {}),
    [draft, agents, selectedId]
  )

  if (!draft) return null

  const store = (): ReturnType<typeof useAgentsStore.getState> => useAgentsStore.getState()
  const provider = providers.find((candidate) => candidate.id === draft.providerId)
  const models = provider?.models ?? []
  const saveDisabled = saving || !dirty || Object.keys(errors).length > 0
  // The monogram follows the name until the record is saved, exactly as
  // `saveDraft` will store it, so the header tile is never a step behind.
  const initial = draft.avatar.text || avatarInitial(draft.name)

  return (
    <>
      <header className="flex h-[52px] shrink-0 items-center justify-between gap-3 border-b border-border px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar
            text={initial}
            color={draft.avatar.color}
            textColor={draft.avatar.textColor}
            size="lg"
          />
          <h1 data-testid="agent-editor-name" className="truncate text-sm font-semibold text-fg">
            {draft.name}
          </h1>
          {agent ? (
            <span className="shrink-0 text-[11px] text-fg-faint">
              {t('agents.inChats', { chats: chatCount })}
            </span>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button data-testid="agent-duplicate" disabled={!agent} onClick={onDuplicate}>
            {t('agents.duplicate')}
          </Button>
          <Button
            variant="danger"
            data-testid="agent-delete"
            disabled={!agent}
            onClick={onDelete}
            title={deleteArmed ? t('agents.deleteConfirm') : t('common.delete')}
          >
            {deleteArmed ? t('agents.deleteConfirm') : t('common.delete')}
          </Button>
          <Button
            variant="primary"
            data-testid="agent-save"
            disabled={saveDisabled}
            onClick={() => void store().saveDraft()}
          >
            {t('common.save')}
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-7 overflow-y-auto px-6 py-5">
        {/* Left column: identity, model, prompt. */}
        <div className="flex min-w-0 flex-col gap-5">
          <section className="flex flex-col gap-2.5">
            <SectionTitle level={3}>{t('agents.basicInfo')}</SectionTitle>

            <div className="grid grid-cols-2 gap-2.5">
              <Field label={t('agents.name')} layout="column" htmlFor="agent-name">
                <Input
                  id="agent-name"
                  data-testid="agent-name"
                  value={draft.name}
                  placeholder={t('agents.namePlaceholder')}
                  onChange={(event) => store().patchDraft({ name: event.target.value })}
                />
                {nameError(t, errors.name) ? (
                  <p data-testid="agent-name-error" className="text-[11px] text-danger">
                    {nameError(t, errors.name)}
                  </p>
                ) : null}
              </Field>

              <Field label={t('agents.avatar')} layout="column">
                <div className="flex items-center gap-1.5">
                  <Avatar
                    text={initial}
                    color={draft.avatar.color}
                    textColor={draft.avatar.textColor}
                    size="sm"
                  />
                  {AGENT_AVATAR_COLORS.map((palette, index) => (
                    <button
                      key={palette.color}
                      type="button"
                      data-testid="agent-avatar-swatch"
                      aria-label={t('agents.avatarColor', { index: index + 1 })}
                      title={t('agents.avatarColor', { index: index + 1 })}
                      aria-pressed={palette.color === draft.avatar.color}
                      style={{ backgroundColor: palette.color }}
                      onClick={() => store().pickAvatarColor(index)}
                      className={
                        palette.color === draft.avatar.color
                          ? 'h-4 w-4 rounded-full ring-1 ring-accent'
                          : 'h-4 w-4 rounded-full ring-1 ring-border-strong'
                      }
                    />
                  ))}
                </div>
              </Field>
            </div>

            <Field
              label={t('agents.description')}
              hint={t('agents.descriptionHint')}
              layout="column"
              htmlFor="agent-description"
            >
              <Input
                id="agent-description"
                data-testid="agent-description"
                value={draft.description}
                placeholder={t('agents.descriptionPlaceholder')}
                onChange={(event) => store().patchDraft({ description: event.target.value })}
              />
            </Field>
          </section>

          <section className="flex flex-col gap-2.5">
            <SectionTitle level={3}>{t('agents.model')}</SectionTitle>

            <div className="grid grid-cols-2 gap-2.5">
              <Field label={t('agents.provider')} layout="column" htmlFor="agent-provider">
                <Select
                  id="agent-provider"
                  data-testid="agent-provider"
                  wrapperClassName="w-full"
                  className="w-full"
                  value={draft.providerId}
                  onChange={(event) =>
                    // Changing provider invalidates the model: a model id from one
                    // endpoint almost never exists on another.
                    store().patchDraft({ providerId: event.target.value, modelId: '' })
                  }
                  options={[
                    { value: '', label: t('agents.providerPlaceholder') },
                    ...providers.map((candidate) => ({
                      value: candidate.id,
                      label: candidate.name
                    }))
                  ]}
                />
                {providers.length === 0 ? (
                  <p className="text-[11px] text-fg-faint">{t('agents.noProviders')}</p>
                ) : null}
                {errors.providerId ? (
                  <p className="text-[11px] text-danger">
                    {t('agents.validation.providerRequired')}
                  </p>
                ) : null}
              </Field>

              <Field label={t('agents.model')} layout="column" htmlFor="agent-model">
                {models.length > 0 ? (
                  <Select
                    id="agent-model"
                    data-testid="agent-model"
                    wrapperClassName="w-full"
                    className="w-full font-mono"
                    value={draft.modelId}
                    onChange={(event) => store().patchDraft({ modelId: event.target.value })}
                    options={[
                      { value: '', label: t('agents.modelPlaceholder') },
                      ...models.map((model) => ({ value: model, label: model }))
                    ]}
                  />
                ) : (
                  <>
                    <Input
                      id="agent-model"
                      data-testid="agent-model-input"
                      className="font-mono"
                      value={draft.modelId}
                      placeholder={t('agents.modelPlaceholder')}
                      onChange={(event) => store().patchDraft({ modelId: event.target.value })}
                    />
                    <p className="text-[11px] text-fg-faint">{t('agents.modelManualHint')}</p>
                  </>
                )}
                {errors.modelId ? (
                  <p className="text-[11px] text-danger">{t('agents.validation.modelRequired')}</p>
                ) : null}
              </Field>
            </div>

            <div className="grid grid-cols-3 items-start gap-2.5">
              <Field label={t('agents.temperature')} layout="column" htmlFor="agent-temperature">
                <Input
                  id="agent-temperature"
                  data-testid="agent-temperature"
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  className="font-mono"
                  value={draft.params.temperature ?? ''}
                  onChange={(event) =>
                    store().patchParams({
                      temperature:
                        event.target.value === '' ? undefined : Number(event.target.value)
                    })
                  }
                />
                {errors.temperature ? (
                  <p className="text-[11px] text-danger">
                    {t('agents.validation.temperatureRange')}
                  </p>
                ) : null}
              </Field>

              <Field label={t('agents.maxTokens')} layout="column" htmlFor="agent-max-tokens">
                <Input
                  id="agent-max-tokens"
                  data-testid="agent-max-tokens"
                  type="number"
                  step="1"
                  min="1"
                  className="font-mono"
                  value={draft.params.maxTokens ?? ''}
                  onChange={(event) =>
                    store().patchParams({
                      maxTokens: event.target.value === '' ? undefined : Number(event.target.value)
                    })
                  }
                />
                {errors.maxTokens ? (
                  <p className="text-[11px] text-danger">{t('agents.validation.maxTokensRange')}</p>
                ) : null}
              </Field>

              <Field label={t('agents.reasoning')} hint={t('agents.reasoningHint')} layout="column">
                <Toggle
                  label={t('agents.reasoning')}
                  checked={draft.params.reasoning === true}
                  onChange={(checked) =>
                    store().patchParams({ reasoning: checked ? true : undefined })
                  }
                />
              </Field>
            </div>
          </section>

          <section className="flex min-h-0 flex-1 flex-col gap-2.5">
            <SectionTitle level={3}>{t('agents.systemPrompt')}</SectionTitle>
            <div className="flex min-h-[180px] flex-1 rounded-md border border-border-strong bg-bg-elevated px-2.5 py-2">
              <TextArea
                data-testid="agent-system-prompt"
                aria-label={t('agents.systemPrompt')}
                value={draft.systemPrompt}
                placeholder={t('agents.systemPromptPlaceholder')}
                onChange={(event) => store().patchDraft({ systemPrompt: event.target.value })}
                className="h-full"
              />
            </div>
          </section>
        </div>

        {/* Right column: capabilities, all of them later steps except the toggle. */}
        <div className="flex min-w-0 flex-col gap-5">
          <section className="flex flex-col gap-2.5">
            <SectionTitle level={3}>{t('agents.skills')}</SectionTitle>
            <div className="rounded-lg border border-border-strong bg-bg-elevated">
              <EmptyState
                size="sm"
                icon={Puzzle}
                title={t('agents.skillsEmptyTitle')}
                description={t('agents.skillsEmptyDescription')}
              />
            </div>
          </section>

          <section className="flex flex-col gap-2.5">
            <SectionTitle level={3}>{t('agents.mcpServers')}</SectionTitle>
            <div className="rounded-lg border border-border-strong bg-bg-elevated">
              <EmptyState
                size="sm"
                icon={Server}
                title={t('agents.mcpEmptyTitle')}
                description={t('agents.mcpEmptyDescription')}
              />
            </div>
          </section>

          <section className="flex min-h-0 flex-1 flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <SectionTitle level={3}>{t('agents.memoryAcrossChats')}</SectionTitle>
              <Toggle
                label={t('agents.memoryToggle')}
                checked={draft.memoryEnabled}
                onChange={(memoryEnabled) => store().patchDraft({ memoryEnabled })}
              />
            </div>
            <div className="flex flex-1 items-center justify-center rounded-lg border border-border-strong bg-bg-elevated p-3">
              <p className="text-center text-[11px] leading-relaxed text-fg-faint">
                {t('agents.memoryComingSoon')}
              </p>
            </div>
          </section>
        </div>
      </div>
    </>
  )
}
