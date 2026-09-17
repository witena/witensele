/**
 * The first-run card (S7.5): an empty installation reaches a streamed reply
 * without leaving the chat page and without reading the README.
 *
 * It replaces the conversation column's "no chat selected" empty state while
 * `onboardingState` says it is visible — see `lib/onboarding.ts` for when that
 * is and why a saved provider is not the end of it.
 *
 * ## Everything is done in place, with the real controls
 *
 * The three provider steps render `PresetGrid`, `ProviderCredential` and
 * `ProviderModels` — the settings editor's own components, extracted in this
 * step rather than copied — all writing the one draft in
 * `stores/providers.ts`. So the card is not a second provider form: a user who
 * starts here and finishes in Settings → Providers finds the same half-filled
 * draft, and there is exactly one place where "an empty key field clears the
 * stored key" is decided.
 *
 * The last two steps are the only new controls: three agent templates
 * (`@shared/agent-templates`) and one button that creates a chat with the agent
 * that was just made. That last part is why `chats.create` grew a member list —
 * once the agent library is non-empty the backend creates chats **empty**, so
 * the card has to name its agent or it would produce a chat nobody can speak in.
 *
 * ## Dismissable at every step
 *
 * Skip sits in the footer and is rendered on every step, not only the first: a
 * user who wants to set things up their own way must not have to complete one
 * more thing first. It writes `AppSettings.onboardingDismissed`, a setting
 * rather than browser storage, so the choice belongs to the installation.
 */
import clsx from 'clsx'
import { Check, Rocket } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { AGENT_TEMPLATES, suggestedModel, type AgentTemplate } from '@shared/agent-templates'
import { supportsOAuth } from '@shared/presets'
import {
  AGENT_AVATAR_COLORS,
  DEFAULT_AGENT_AVATAR,
  avatarInitial,
  avatarPaletteStyle
} from '../agents/agent-display'
import { Avatar, Button, SectionTitle, Spinner } from '../ui'
import { translateFailure } from '../../i18n/errors'
import {
  ONBOARDING_STEPS,
  onboardingState,
  type OnboardingState,
  type OnboardingStep
} from '../../lib/onboarding'
import { useAgentsStore } from '../../stores/agents'
import { useChatsStore, useHasChatWithMembers } from '../../stores/chats'
import { useProvidersStore } from '../../stores/providers'
import { useSettingsStore } from '../../stores/settings'
import { PresetGrid } from '../settings/preset-grid'
import { ProviderCredential } from '../settings/provider-credential'
import { ProviderModels } from '../settings/provider-models'

/** Literal `t()` calls, so `i18n/used-keys.test.ts` can verify every label. */
function stepTitle(t: TFunction, step: OnboardingStep): string {
  switch (step) {
    case 'preset':
      return t('chat.onboarding.stepPreset')
    case 'credential':
      return t('chat.onboarding.stepCredential')
    case 'models':
      return t('chat.onboarding.stepModels')
    case 'agent':
      return t('chat.onboarding.stepAgent')
    case 'chat':
      return t('chat.onboarding.stepChat')
  }
}

/**
 * Each template's one-line description.
 *
 * A runtime key (`agents.templates.<id>`) is invisible to the usage guard, so
 * `i18n/locales.test.ts` checks the subtree against the table in both
 * directions instead — the rule the MCP gallery established in S5.1.
 */
function templateDescription(t: TFunction, template: AgentTemplate): string {
  return t(`agents.templates.${template.id}`)
}

function TemplateTile({
  template,
  models,
  busy,
  onPick
}: {
  template: AgentTemplate
  models: readonly string[]
  busy: boolean
  onPick: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const palette = AGENT_AVATAR_COLORS[template.paletteIndex] ?? DEFAULT_AGENT_AVATAR
  const model = suggestedModel(template, models)

  return (
    <button
      type="button"
      data-testid={`onboarding-template-${template.id}`}
      data-model={model ?? ''}
      disabled={busy || !model}
      onClick={onPick}
      className={clsx(
        'flex flex-col gap-1.5 rounded-lg border border-border-strong bg-bg-base px-3 py-2.5 text-left',
        'transition-colors hover:border-fg-faint',
        'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-45'
      )}
    >
      <span className="flex items-center gap-2">
        <Avatar
          size="sm"
          text={avatarInitial(template.name)}
          {...avatarPaletteStyle(palette.palette)}
        />
        {/* The name is stored data, not copy: it is what `@mentions` resolve
            against, so it is printed rather than translated. */}
        <span className="truncate text-xs text-fg">{template.name}</span>
      </span>
      <span className="text-[11px] leading-relaxed text-fg-faint">
        {templateDescription(t, template)}
      </span>
      {model ? (
        <span className="truncate font-mono text-[10px] text-fg-faint">{model}</span>
      ) : null}
    </button>
  )
}

/**
 * Which step the card is on, from the five stores that know.
 *
 * Exported because `ChatsPage` has to ask the same question *before* rendering:
 * it draws either this card or the bare empty state, and a component that
 * returns `null` is still a truthy element, so the decision cannot be made from
 * the element itself.
 */
export function useOnboarding(): OnboardingState {
  const dismissed = useSettingsStore((state) =>
    state.settings ? state.settings.onboardingDismissed : null
  )
  const providerCount = useProvidersStore((state) => state.providers.length)
  const draft = useProvidersStore((state) => state.draft)
  // The draft's *own* vendor login (S5.13): a Google draft is not made ready by
  // being signed in to Anthropic. A draft whose type has no sign-in flow has no
  // status to read, and `credentialReady` then falls through to the key rule.
  const authStatus = useProvidersStore((state) =>
    draft && supportsOAuth(draft.type) ? state.authStatus[draft.type] : null
  )
  const agentCount = useAgentsStore((state) => state.agents.length)
  const hasChatWithMembers = useHasChatWithMembers()

  return onboardingState({
    dismissed,
    providerCount,
    draft,
    authStatus,
    agentCount,
    hasChatWithMembers
  })
}

export function OnboardingCard(): React.JSX.Element | null {
  const { t } = useTranslation()

  const state = useOnboarding()
  const providers = useProvidersStore((state) => state.providers)
  const draft = useProvidersStore((state) => state.draft)
  const saving = useProvidersStore((state) => state.saving)
  const providerError = useProvidersStore((state) => state.error)
  const providerErrorCode = useProvidersStore((state) => state.errorCode)
  const providerErrorDetails = useProvidersStore((state) => state.errorDetails)
  const agentsSaving = useAgentsStore((state) => state.saving)
  const agentsError = useAgentsStore((state) => state.error)
  const agentsErrorCode = useAgentsStore((state) => state.errorCode)

  const step = state.current
  const needsDraft = step === 'preset' || step === 'credential' || step === 'models'

  // The first three steps edit a draft, so one has to exist before the preset
  // grid can write to it. `ensureDraft` rather than `startCreate`: `mode` is the
  // settings editor's own state, and a card on the chat page must not leave the
  // Add form open on a screen the user has never visited.
  useEffect(() => {
    if (!state.visible || !needsDraft) return
    useProvidersStore.getState().ensureDraft()
  }, [state.visible, needsDraft])

  if (!state.visible) return null

  const provider = providers.find((candidate) => candidate.models.length > 0) ?? providers[0]

  const pickTemplate = (template: AgentTemplate): void => {
    if (!provider) return
    void useAgentsStore.getState().createFromTemplate(template, provider.id, provider.models)
  }

  const startChat = (): void => {
    const first = useAgentsStore.getState().agents[0]
    if (!first) return
    void useChatsStore.getState().create([first.id])
  }

  return (
    <div
      data-testid="onboarding"
      data-step={step ?? 'done'}
      className="flex w-full max-w-xl flex-col gap-3.5 rounded-xl border border-border-strong bg-bg-elevated px-5 py-4"
    >
      <div className="flex items-start gap-2.5">
        <Rocket aria-hidden="true" strokeWidth={1.6} className="mt-0.5 h-5 w-5 text-accent" />
        <div className="flex flex-col gap-1">
          <SectionTitle level={2}>{t('chat.onboarding.title')}</SectionTitle>
          <p className="text-xs leading-relaxed text-fg-faint">
            {t('chat.onboarding.description')}
          </p>
        </div>
      </div>

      <ol className="flex flex-col gap-2.5">
        {ONBOARDING_STEPS.map((item, index) => {
          const done = state.done[item]
          const current = item === step
          return (
            <li
              key={item}
              data-testid="onboarding-step"
              data-step={item}
              data-state={done ? 'done' : current ? 'current' : 'todo'}
              className={clsx(
                'flex flex-col gap-2 rounded-lg px-2.5 py-2',
                current ? 'bg-bg-base' : 'opacity-70'
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={clsx(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px]',
                    done
                      ? 'bg-accent text-bg-base'
                      : current
                        ? 'bg-bg-hover text-fg'
                        : 'bg-bg-hover text-fg-faint'
                  )}
                >
                  {done ? (
                    <Check aria-hidden="true" strokeWidth={3} className="h-2.5 w-2.5" />
                  ) : (
                    // A step number, not copy: it is the same glyph in every
                    // language and the guard's three-letter rule ignores it.
                    index + 1
                  )}
                </span>
                <span className={clsx('text-xs', current ? 'text-fg' : 'text-fg-muted')}>
                  {stepTitle(t, item)}
                </span>
              </div>

              {current ? <div className="pl-6">{renderStep(item)}</div> : null}
            </li>
          )
        })}
      </ol>

      <div className="flex items-center justify-between gap-3 border-t border-border pt-2.5">
        <p className="text-[11px] text-fg-faint">{t('chat.onboarding.skipHint')}</p>
        <button
          type="button"
          data-testid="onboarding-skip"
          onClick={() => void useSettingsStore.getState().dismissOnboarding()}
          className={clsx(
            'rounded text-[11px] text-fg-muted transition-colors hover:text-fg',
            'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none'
          )}
        >
          {t('chat.onboarding.skip')}
        </button>
      </div>
    </div>
  )

  /**
   * The body of the step the card is on.
   *
   * A function rather than five components because each body is two or three
   * elements over state this component already holds, and because
   * `used-keys.test.ts` reads adjacent JSX in a `switch` as a hard-coded text
   * node — the trap `AppShell` documents.
   */
  function renderStep(item: OnboardingStep): React.JSX.Element | null {
    if (item === 'preset') {
      return (
        <PresetGrid
          selectedId={draft?.presetId}
          customLabel={t('settings.providers.presetCustom')}
          onSelect={(presetId) => useProvidersStore.getState().applyPreset(presetId)}
        />
      )
    }

    if (item === 'credential') return <ProviderCredential />

    if (item === 'models') {
      return (
        <div className="flex flex-col gap-2.5">
          <ProviderModels />
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              data-testid="onboarding-save-provider"
              disabled={saving || (draft?.models.length ?? 0) === 0}
              onClick={() => void useProvidersStore.getState().saveDraft()}
            >
              {saving ? <Spinner /> : null}
              {t('chat.onboarding.saveProvider')}
            </Button>
          </div>
          {providerError ? (
            <p
              data-testid="onboarding-error"
              data-error-code={providerErrorCode ?? 'internal'}
              className="text-[11px] text-danger"
            >
              {translateFailure(t, providerErrorCode, providerErrorDetails)}
            </p>
          ) : null}
        </div>
      )
    }

    if (item === 'agent') {
      return (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-3 gap-2">
            {AGENT_TEMPLATES.map((template) => (
              <TemplateTile
                key={template.id}
                template={template}
                models={provider?.models ?? []}
                busy={agentsSaving}
                onPick={() => pickTemplate(template)}
              />
            ))}
          </div>
          {agentsError ? (
            <p
              data-testid="onboarding-error"
              data-error-code={agentsErrorCode ?? 'internal'}
              className="text-[11px] text-danger"
            >
              {translateFailure(t, agentsErrorCode, undefined)}
            </p>
          ) : null}
        </div>
      )
    }

    return (
      <Button variant="primary" data-testid="onboarding-start-chat" onClick={startChat}>
        {t('chat.onboarding.startChat')}
      </Button>
    )
  }
}
