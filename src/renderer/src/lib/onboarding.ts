/**
 * The first-run card's state machine (S7.5).
 *
 * A pure function over what the stores already hold, for the reason
 * `presenceColorClass` and `groupChats` are pure: the interesting part of the
 * card is *which step is current*, and that decision is worth a unit test with
 * no React, no jsdom and no backend.
 *
 * ## The five steps, and why completion is defined this way
 *
 * The first three all edit the **provider draft**, so while the user is on them
 * nothing is stored yet and the only evidence is the draft itself. As soon as
 * the provider is saved, all three are complete for good — which is what makes
 * the card correct for a user who added a provider in Settings and never saw
 * step one.
 *
 * | Step | Complete when |
 * |---|---|
 * | `preset` | a provider exists, or the draft has a preset |
 * | `credential` | a provider exists, or the draft needs no key (a local preset), carries one, or signs in with a CLI that is signed in |
 * | `models` | a provider exists (i.e. the draft was saved with its models) |
 * | `agent` | an agent exists |
 * | `chat` | a chat has at least one member |
 *
 * The **current** step is the first incomplete one, which is also why a user who
 * skips ahead by doing something in Settings never sees the card ask for it
 * again.
 *
 * ## When the card is shown at all
 *
 * `visible` is "not dismissed, and no chat has a member yet". S7.5 puts it two
 * ways — *shown when no provider exists*, *gone once a chat with at least one
 * member exists* — and those are the start and the end of the same journey: the
 * card has to survive the four steps in between, or it would vanish the moment
 * the first provider was saved and leave the user on an empty screen again.
 *
 * `settings` is `null` while the bootstrap is still reading the row. The card
 * stays hidden until then rather than flashing onto a screen that is about to
 * say it was skipped.
 */
import type { AnthropicAuthStatus, ProviderInput } from '@shared/types'
import { providerAuth, providerRequiresApiKey } from '@shared/presets'

/** The five steps, in the order the card lists them. */
export const ONBOARDING_STEPS = ['preset', 'credential', 'models', 'agent', 'chat'] as const

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

export interface OnboardingInput {
  /** `AppSettings.onboardingDismissed`, or `null` while settings are loading. */
  dismissed: boolean | null
  /** How many providers are stored. */
  providerCount: number
  /** The providers store's editor draft, which the first three steps write to. */
  draft: ProviderInput | null
  /** What the Anthropic CLI last reported, for a draft in sign-in mode. */
  authStatus: AnthropicAuthStatus | null
  /** How many agents are stored. */
  agentCount: number
  /** True once any chat has at least one member. */
  hasChatWithMembers: boolean
}

export interface OnboardingState {
  visible: boolean
  /** The first incomplete step; `null` once every step is done. */
  current: OnboardingStep | null
  done: Record<OnboardingStep, boolean>
}

/**
 * Whether the draft can authenticate, which is what step `credential` asks.
 *
 * Three shapes, and the local one is the reason this is not simply "is the key
 * field non-empty": Ollama and LM Studio need no key at all, and a step the
 * user cannot complete is a wall rather than a guide.
 */
export function credentialReady(
  draft: ProviderInput,
  authStatus: AnthropicAuthStatus | null
): boolean {
  if (providerAuth(draft) === 'oauth') return authStatus?.state === 'signed-in'
  // Covers both "Ollama needs none" and "a bare endpoint might not": the rule
  // lives in `@shared/presets` so the card, the card's Save and the handler's
  // refusal cannot disagree about what a provider needs.
  if (!providerRequiresApiKey(draft)) return true
  return (draft.apiKey ?? '').trim().length > 0
}

/** Which step the card is on, and whether it should be on screen at all. */
export function onboardingState(input: OnboardingInput): OnboardingState {
  const saved = input.providerCount > 0

  const done: Record<OnboardingStep, boolean> = {
    preset: saved || Boolean(input.draft?.presetId),
    credential: saved || (input.draft ? credentialReady(input.draft, input.authStatus) : false),
    // Deliberately not "the draft has models": the step's action is Save, and a
    // draft with three chips and no record is not a provider an agent can use.
    models: saved,
    agent: input.agentCount > 0,
    chat: input.hasChatWithMembers
  }

  const current = ONBOARDING_STEPS.find((step) => !done[step]) ?? null

  return {
    visible: input.dismissed === false && !input.hasChatWithMembers,
    current,
    done
  }
}
