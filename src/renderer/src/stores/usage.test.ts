/**
 * The usage store: the client-side half of S4.1.
 *
 * The point of this store is that a run of three agents over three rounds does
 * **not** cost nine IPC calls to keep the header honest — the numbers are
 * recomputed from the transcript the messages store already holds. So the cases
 * here are about exactly that: that a `message.updated` moves the number, that
 * the per-agent split is right, that a local provider costs nothing while a
 * hosted one does, and that the store refuses to recompute from a *page* of a
 * longer transcript and asks the backend instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendClient, BackendMethod } from '@shared/backend'
import type { Agent, Message, Provider, Usage } from '@shared/types'
import { LOCAL_USER_ID } from '@shared/types'
import { emptyUsageSummary } from '@shared/usage'
import { applyBackendEvent } from '../lib/event-bridge'
import { resetBackend, setBackend } from '../lib/backend-provider'
import { useAgentsStore } from './agents'
import { useMessagesStore } from './messages'
import { useProvidersStore } from './providers'
import { pricedModels, useUsageStore } from './usage'

const CHAT = 'chat-1'

/** `exactOptionalPropertyTypes` needs the explicit `| undefined` to *remove* a field. */
type ProviderOverrides = { [K in keyof Provider]?: Provider[K] | undefined }

function provider(overrides: ProviderOverrides = {}): Provider {
  return {
    id: 'provider-hosted',
    userId: LOCAL_USER_ID,
    createdAt: 1,
    updatedAt: 1,
    type: 'openai-compatible',
    name: 'DeepSeek',
    presetId: 'deepseek',
    models: ['deepseek-chat'],
    hasApiKey: true,
    ...overrides
  } as Provider
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-ada',
    userId: LOCAL_USER_ID,
    createdAt: 1,
    updatedAt: 1,
    name: 'Ada',
    avatar: { kind: 'initial', text: 'A', color: '#c2653a' },
    description: '',
    systemPrompt: '',
    providerId: 'provider-hosted',
    modelId: 'deepseek-chat',
    params: {},
    skillNames: [],
    mcpServerIds: [],
    memoryEnabled: false,
    role: 'participant',
    ...overrides
  }
}

const usage = (inputTokens: number, outputTokens: number): Usage => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens
})

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    userId: LOCAL_USER_ID,
    createdAt: 1,
    updatedAt: 1,
    chatId: CHAT,
    senderType: 'agent',
    senderId: 'agent-ada',
    parts: [{ type: 'text', text: 'hi' }],
    status: 'done',
    round: 1,
    mentions: [],
    ...overrides
  }
}

const summary = () => useUsageStore.getState().byChat[CHAT] ?? emptyUsageSummary()

/** Puts a finished message in the store the way the real event path would. */
function land(overrides: Partial<Message>): void {
  applyBackendEvent({ type: 'message.updated', message: message(overrides) })
}

beforeEach(() => {
  useUsageStore.setState({ byChat: {}, error: undefined, errorCode: undefined })
  useMessagesStore.setState({
    byChat: { [CHAT]: [] },
    complete: { [CHAT]: true },
    status: { [CHAT]: 'ready' },
    error: undefined,
    errorCode: undefined
  })
  useAgentsStore.setState({ agents: [agent(), agent({ id: 'agent-bob', name: 'Bob' })] })
  useProvidersStore.setState({ providers: [provider()] })
})

afterEach(() => {
  resetBackend()
  useAgentsStore.setState({ agents: [] })
  useProvidersStore.setState({ providers: [] })
})

describe('pricedModels', () => {
  it('pairs an agent with its provider preset', () => {
    const resolve = pricedModels([agent()], [provider()])

    expect(resolve('agent-ada')).toEqual({ modelId: 'deepseek-chat', presetId: 'deepseek' })
  })

  it('returns undefined for an agent that no longer exists', () => {
    expect(pricedModels([], [provider()])('agent-ghost')).toBeUndefined()
  })

  it('leaves the preset undefined when the provider is gone', () => {
    expect(pricedModels([agent()], [])('agent-ada')).toEqual({
      modelId: 'deepseek-chat',
      presetId: undefined
    })
  })
})

describe('usage store', () => {
  it('starts empty, and reports an empty summary for an unknown chat', () => {
    expect(summary()).toEqual(emptyUsageSummary())
    expect(summary().cost).toBeNull()
  })

  it('recomputes the total from the transcript when a message finishes', () => {
    land({ id: 'm1', usage: usage(1_000, 200) })

    expect(summary().total).toEqual(usage(1_000, 200))
    expect(summary().perAgent['agent-ada']?.turns).toBe(1)
  })

  it('sums several turns and splits them per agent', () => {
    land({ id: 'm1', senderId: 'agent-ada', usage: usage(1_000, 200) })
    land({ id: 'm2', senderId: 'agent-bob', usage: usage(500, 100) })
    land({ id: 'm3', senderId: 'agent-ada', usage: usage(300, 50) })

    expect(summary().total.totalTokens).toBe(1_200 + 600 + 350)
    expect(summary().perAgent['agent-ada']?.usage).toEqual(usage(1_300, 250))
    expect(summary().perAgent['agent-ada']?.turns).toBe(2)
    expect(summary().perAgent['agent-bob']?.usage).toEqual(usage(500, 100))
    expect(summary().perAgent['agent-bob']?.turns).toBe(1)
  })

  it('ignores a message that carries no usage yet', () => {
    land({ id: 'm1', status: 'streaming' })

    expect(summary().total.totalTokens).toBe(0)
    expect(summary().perAgent).toEqual({})
  })

  it('ignores the user and the system, who have no model behind them', () => {
    land({ id: 'm1', senderType: 'user', senderId: LOCAL_USER_ID, usage: usage(10, 10) })
    land({ id: 'm2', senderType: 'system', senderId: 'system', usage: usage(10, 10) })

    expect(summary().total.totalTokens).toBe(0)
  })

  it('prices a hosted provider and reports the cost', () => {
    land({ id: 'm1', usage: usage(1_000_000, 0) })

    expect(summary().cost).toBeGreaterThan(0)
  })

  it('reports no cost at all for a local provider', () => {
    useProvidersStore.setState({
      providers: [provider({ id: 'provider-hosted', presetId: 'ollama', name: 'Ollama' })]
    })
    useAgentsStore.setState({ agents: [agent({ modelId: 'qwen2.5:1.5b' })] })

    land({ id: 'm1', usage: usage(1_000_000, 1_000_000) })

    // Counted in the tokens, free in the money — the header prints the tokens
    // alone rather than `$0.00`.
    expect(summary().total.totalTokens).toBe(2_000_000)
    expect(summary().cost).toBe(0)
  })

  it('leaves the cost unknown for a model the price table has never heard of', () => {
    useAgentsStore.setState({ agents: [agent({ modelId: 'some-private-model' })] })
    useProvidersStore.setState({ providers: [provider({ presetId: undefined })] })

    land({ id: 'm1', usage: usage(1_000, 1_000) })

    expect(summary().total.totalTokens).toBe(2_000)
    expect(summary().cost).toBeNull()
  })

  it('asks the backend instead of recomputing when the store holds only a page', async () => {
    const invoke = vi.fn(async (method: BackendMethod) => {
      if (method === 'messages.usageSummary') {
        return { total: usage(9_000, 1_000), cost: 1.5, perAgent: {} }
      }
      throw new Error(`unexpected method ${method}`)
    })
    setBackend({ invoke: invoke as unknown as BackendClient['invoke'], subscribe: () => () => {} })
    useMessagesStore.setState({ complete: { [CHAT]: false } })

    land({ id: 'm1', usage: usage(1_000, 200) })
    // `recompute` delegates to `load`, which is async; let it settle.
    await Promise.resolve()
    await Promise.resolve()

    expect(invoke).toHaveBeenCalledWith('messages.usageSummary', { chatId: CHAT })
    expect(summary().total).toEqual(usage(9_000, 1_000))
  })

  it('seeds a chat from the backend on open', async () => {
    setBackend({
      invoke: (async (method: BackendMethod) => {
        if (method === 'messages.usageSummary') {
          return { total: usage(4_000, 400), cost: null, perAgent: {} }
        }
        throw new Error(`unexpected method ${method}`)
      }) as BackendClient['invoke'],
      subscribe: () => () => {}
    })

    await useUsageStore.getState().load(CHAT)

    expect(summary().total).toEqual(usage(4_000, 400))
  })

  it('records a failed read as state rather than throwing', async () => {
    setBackend({
      invoke: (async () => {
        throw new Error('transport is down')
      }) as BackendClient['invoke'],
      subscribe: () => () => {}
    })

    await expect(useUsageStore.getState().load(CHAT)).resolves.toBeUndefined()

    expect(useUsageStore.getState().error).toContain('transport is down')
  })

  it('forgets a chat summary when the chat is deleted', () => {
    land({ id: 'm1', usage: usage(1_000, 200) })
    applyBackendEvent({ type: 'chat.deleted', chatId: CHAT })

    expect(useUsageStore.getState().byChat[CHAT]).toBeUndefined()
  })
})
