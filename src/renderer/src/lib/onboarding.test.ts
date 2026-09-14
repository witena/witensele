/**
 * The first-run card's state machine (S7.5).
 *
 * Every case here is a screen someone will actually see: an empty install, a
 * half-filled provider form, a machine where the Anthropic CLI is not signed in,
 * a user who added a provider in Settings and never saw step one, and a user who
 * pressed Skip.
 */
import { describe, expect, it } from 'vitest'
import type { ProviderInput } from '@shared/types'
import {
  ONBOARDING_STEPS,
  credentialReady,
  onboardingState,
  type OnboardingInput
} from './onboarding'

/** An empty installation: settings loaded, nothing else. */
const FRESH: OnboardingInput = {
  dismissed: false,
  providerCount: 0,
  draft: null,
  authStatus: null,
  agentCount: 0,
  hasChatWithMembers: false
}

const draft = (patch: Partial<ProviderInput> = {}): ProviderInput => ({
  type: 'openai-compatible',
  name: '',
  models: [],
  ...patch
})

describe('onboardingState', () => {
  it('opens on the first step of an empty installation', () => {
    const state = onboardingState(FRESH)
    expect(state.visible).toBe(true)
    expect(state.current).toBe('preset')
    expect(Object.values(state.done)).toEqual([false, false, false, false, false])
  })

  it('stays hidden until the settings row has been read', () => {
    // `null` is "not loaded yet". Showing the card and then hiding it because
    // the row says it was skipped is worse than one frame of nothing.
    expect(onboardingState({ ...FRESH, dismissed: null }).visible).toBe(false)
  })

  it('is hidden once the installation has skipped it', () => {
    expect(onboardingState({ ...FRESH, dismissed: true }).visible).toBe(false)
  })

  it('is hidden once a chat has at least one member', () => {
    // The end of the journey: a member implies an agent, which implies a
    // provider, so every step is done and there is no current one left.
    const state = onboardingState({
      ...FRESH,
      providerCount: 1,
      agentCount: 1,
      hasChatWithMembers: true
    })
    expect(state.visible).toBe(false)
    expect(state.current).toBe(null)
  })

  it('stays visible while the user works through the middle steps', () => {
    // The acceptance sentence's journey: a saved provider is *not* the end.
    const state = onboardingState({ ...FRESH, providerCount: 1 })
    expect(state.visible).toBe(true)
    expect(state.current).toBe('agent')
  })

  it('counts a picked preset as the first step being done', () => {
    const state = onboardingState({ ...FRESH, draft: draft({ presetId: 'anthropic' }) })
    expect(state.done.preset).toBe(true)
    expect(state.current).toBe('credential')
  })

  it('waits on the key of a preset that needs one', () => {
    const anthropic = draft({ type: 'anthropic', presetId: 'anthropic' })
    expect(onboardingState({ ...FRESH, draft: anthropic }).current).toBe('credential')
    expect(
      onboardingState({ ...FRESH, draft: { ...anthropic, apiKey: 'sk-ant-x' } }).current
    ).toBe('models')
  })

  it('lets a local preset past the credential step with an empty field', () => {
    const ollama = draft({ type: 'openai-compatible', presetId: 'ollama' })
    expect(onboardingState({ ...FRESH, draft: ollama }).current).toBe('models')
  })

  it('treats the models step as done only once the provider is stored', () => {
    // A draft carrying three chips is not yet something an agent can speak
    // through, so the step whose action is Save stays current.
    const withModels = draft({ presetId: 'ollama', models: ['qwen2.5:1.5b'] })
    expect(onboardingState({ ...FRESH, draft: withModels }).current).toBe('models')
    expect(onboardingState({ ...FRESH, draft: withModels, providerCount: 1 }).current).toBe('agent')
  })

  it('marks the provider steps done for a user who added one in Settings', () => {
    const state = onboardingState({ ...FRESH, providerCount: 2, draft: null })
    expect(state.done.preset).toBe(true)
    expect(state.done.credential).toBe(true)
    expect(state.done.models).toBe(true)
  })

  it('asks for the chat once an agent exists', () => {
    const state = onboardingState({ ...FRESH, providerCount: 1, agentCount: 1 })
    expect(state.current).toBe('chat')
    expect(state.visible).toBe(true)
  })

  it('reports the steps in the order the card lists them', () => {
    expect(ONBOARDING_STEPS).toEqual(['preset', 'credential', 'models', 'agent', 'chat'])
  })
})

describe('credentialReady', () => {
  it('requires a signed-in CLI in sign-in mode, whatever the key field holds', () => {
    const oauth = draft({ type: 'anthropic', presetId: 'anthropic', auth: 'oauth' })
    expect(credentialReady(oauth, null)).toBe(false)
    expect(credentialReady(oauth, { state: 'not-installed' })).toBe(false)
    expect(credentialReady(oauth, { state: 'signed-out' })).toBe(false)
    expect(credentialReady(oauth, { state: 'signed-in' })).toBe(true)
  })

  it('ignores whitespace typed into the key field', () => {
    const anthropic = draft({ type: 'anthropic', presetId: 'anthropic', apiKey: '   ' })
    expect(credentialReady(anthropic, null)).toBe(false)
  })
})
