/**
 * The `agents.*` handlers, driven exactly as the renderer drives them: through
 * `buildHandlers()` against a real temporary database.
 *
 * Two themes. The first is **validation**, because every rule here exists to stop
 * a record that would only fail later — at the first turn, or when S2.3 tries to
 * resolve an `@mention`. The second is **deletion**, which is the only agent
 * operation with consequences outside its own row: the membership cascade, the
 * `chat.updated` events that follow it, and the run that has to be stopped first.
 */
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendEvent, ChatUpdatedEvent } from '@shared/events'
import type { Agent, AgentInput, Provider } from '@shared/types'
import type { AppContext } from '../app-context'
import { agentInput, createTestDatabase, providerInput, type TestDatabase } from '../db/testing'
import { createTestAppContext } from '../testing'
import { buildHandlers } from './index'

/** A model that starts streaming and never finishes, so a run stays running. */
function neverFinishingModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '0' },
          // Long enough that the run is still going when the assertion runs, and
          // slow enough that the abort lands in the middle of it.
          ...Array.from({ length: 500 }, () => ({ type: 'text-delta', id: '0', delta: 'x ' }))
        ] as never,
        initialDelayInMs: 5,
        chunkDelayInMs: 5
      })
    })
  })
}

describe('handlers/agents', () => {
  const handlers = buildHandlers()

  let database: TestDatabase
  let ctx: AppContext
  let events: BackendEvent[]
  let provider: Provider

  /** A valid input, so each test only states the field it is about. */
  const input = (overrides: Partial<AgentInput> = {}): AgentInput =>
    agentInput({ providerId: provider.id, modelId: 'deepseek-chat', ...overrides })

  beforeEach(() => {
    database = createTestDatabase()
    const created = createTestAppContext(database, { runner: { createModel: neverFinishingModel } })
    ctx = created.ctx
    events = created.events
    provider = ctx.repos.providers.create(providerInput(), ctx.userId)
    events.length = 0
  })

  afterEach(() => {
    // `ctx.close()` rather than `database.cleanup()`: it also stops the
    // `AgentSupervisor`'s heartbeat, which would otherwise keep ticking against
    // a closed database for the rest of the suite.
    ctx.close()
  })

  const chatUpdates = (): ChatUpdatedEvent[] =>
    events.filter((event): event is ChatUpdatedEvent => event.type === 'chat.updated')

  describe('agents.create', () => {
    it('stores a valid agent and lists it', async () => {
      const created = await handlers['agents.create'](ctx, { input: input({ name: 'Ada' }) })

      expect(created).toMatchObject({ name: 'Ada', providerId: provider.id, role: 'participant' })
      await expect(handlers['agents.list'](ctx)).resolves.toHaveLength(1)
      await expect(handlers['agents.get'](ctx, { id: created.id })).resolves.toEqual(created)
    })

    it('trims the stored name so " Ada " and "Ada" are the same agent', async () => {
      const created = await handlers['agents.create'](ctx, { input: input({ name: '  Ada  ' }) })

      expect(created.name).toBe('Ada')
      await expect(
        handlers['agents.create'](ctx, { input: input({ name: 'Ada' }) })
      ).rejects.toMatchObject({ code: 'validation' })
    })

    it.each([
      ['an empty name', { name: '' }],
      ['a whitespace-only name', { name: '   ' }],
      ['a name containing @', { name: 'Ada@work' }],
      ['an empty model id', { modelId: '  ' }],
      ['a missing provider', { providerId: '' }],
      ['a temperature above 2', { params: { temperature: 2.5 } }],
      ['a negative temperature', { params: { temperature: -0.1 } }],
      ['a fractional maxTokens', { params: { maxTokens: 12.5 } }],
      ['a zero maxTokens', { params: { maxTokens: 0 } }],
      ['a non-boolean reasoning flag', { params: { reasoning: 'yes' as never } }],
      ['an unknown role', { role: 'overlord' as never }]
    ])('rejects %s with validation', async (_label, overrides) => {
      await expect(
        handlers['agents.create'](ctx, { input: input(overrides) })
      ).rejects.toMatchObject({ code: 'validation' })

      expect(ctx.repos.agents.list(ctx.userId)).toEqual([])
    })

    it('rejects a provider that does not exist with not_found', async () => {
      await expect(
        handlers['agents.create'](ctx, { input: input({ providerId: 'nope' }) })
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it('rejects a name another agent already holds, ignoring case', async () => {
      await handlers['agents.create'](ctx, { input: input({ name: 'Reviewer' }) })

      await expect(
        handlers['agents.create'](ctx, { input: input({ name: 'reviewer' }) })
      ).rejects.toMatchObject({ code: 'validation' })
    })

    it('accepts the reserved executor role, which the UI does not offer', async () => {
      const created = await handlers['agents.create'](ctx, {
        input: input({ name: 'Hands', role: 'executor' })
      })

      expect(created.role).toBe('executor')
    })

    // S5.14: "show thinking" gets its answer here, from the provider, so a
    // stored agent always carries a choice of its own.
    describe('the show-thinking default', () => {
      /** Creates an agent on a provider of this shape and reports the flag. */
      const reasoningOn = async (
        overrides: Parameters<typeof providerInput>[0],
        params: AgentInput['params'] = {}
      ): Promise<boolean | undefined> => {
        const on = ctx.repos.providers.create(providerInput(overrides), ctx.userId)
        const created = await handlers['agents.create'](ctx, {
          input: input({ name: `Agent ${on.id}`, providerId: on.id, params })
        })
        return created.params.reasoning
      }

      it('hides thinking on an openai-compatible provider', async () => {
        await expect(reasoningOn({ type: 'openai-compatible', presetId: 'deepseek' })).resolves.toBe(
          false
        )
      })

      it('hides thinking on a local provider', async () => {
        await expect(
          reasoningOn({ type: 'openai-compatible', presetId: 'ollama', name: 'Ollama' })
        ).resolves.toBe(false)
      })

      it.each(['anthropic', 'openai', 'google'] as const)(
        'shows thinking on a %s provider',
        async (type) => {
          await expect(reasoningOn({ type, presetId: type, name: type })).resolves.toBe(true)
        }
      )

      it('leaves an explicit choice alone', async () => {
        await expect(
          reasoningOn({ type: 'anthropic', presetId: 'anthropic' }, { reasoning: false })
        ).resolves.toBe(false)
        await expect(
          reasoningOn({ type: 'openai-compatible', presetId: 'deepseek' }, { reasoning: true })
        ).resolves.toBe(true)
      })
    })
  })

  describe('agents.update', () => {
    let agent: Agent

    beforeEach(async () => {
      agent = await handlers['agents.create'](ctx, { input: input({ name: 'Ada' }) })
      events.length = 0
    })

    it('lets an agent keep its own name', async () => {
      const updated = await handlers['agents.update'](ctx, {
        id: agent.id,
        patch: { name: 'Ada', description: 'Now with a description' }
      })

      expect(updated).toMatchObject({ name: 'Ada', description: 'Now with a description' })
    })

    it('rejects a name another agent holds', async () => {
      await handlers['agents.create'](ctx, { input: input({ name: 'Bob' }) })

      await expect(
        handlers['agents.update'](ctx, { id: agent.id, patch: { name: 'Bob' } })
      ).rejects.toMatchObject({ code: 'validation' })
    })

    it('rejects an unknown id with not_found before it measures the patch', async () => {
      await expect(
        handlers['agents.update'](ctx, { id: 'missing', patch: { name: 'Ada' } })
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it('emits chat.updated for every chat the agent is in', async () => {
      const chat = await handlers['chats.create'](ctx, {
        input: { title: 'One', memberAgentIds: [agent.id] }
      })
      await handlers['chats.create'](ctx, { input: { title: 'Without it' } })
      events.length = 0

      await handlers['agents.update'](ctx, { id: agent.id, patch: { modelId: 'deepseek-chat' } })

      expect(chatUpdates().map((event) => event.chat.id)).toEqual([chat.id])
    })
  })

  describe('agents.delete', () => {
    it('removes the agent from every chat and announces each of them', async () => {
      const agent = await handlers['agents.create'](ctx, { input: input({ name: 'Ada' }) })
      const other = await handlers['agents.create'](ctx, { input: input({ name: 'Bob' }) })
      const both = await handlers['chats.create'](ctx, {
        input: { title: 'Both', memberAgentIds: [agent.id, other.id] }
      })
      const onlyOther = await handlers['chats.create'](ctx, {
        input: { title: 'Only Bob', memberAgentIds: [other.id] }
      })
      events.length = 0

      await handlers['agents.delete'](ctx, { id: agent.id })

      // The cascading foreign key did its job, and the remaining member kept its
      // place rather than being renumbered away.
      expect(ctx.repos.chats.listMembers(both.id, ctx.userId).map((m) => m.agentId)).toEqual([
        other.id
      ])
      expect(chatUpdates().map((event) => event.chat.id)).toEqual([both.id])
      expect(chatUpdates().map((event) => event.chat.id)).not.toContain(onlyOther.id)
      await expect(handlers['agents.get'](ctx, { id: agent.id })).rejects.toMatchObject({
        code: 'not_found'
      })
    })

    it('stops a run the agent is speaking in before deleting it', async () => {
      const agent = await handlers['agents.create'](ctx, { input: input({ name: 'Ada' }) })
      const chat = await handlers['chats.create'](ctx, {
        input: { title: 'Busy', memberAgentIds: [agent.id] }
      })

      await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Say something long' })
      // The mock never finishes on its own, so the run is still going here.
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(ctx.runners.state(chat.id)).not.toBeNull()

      await handlers['agents.delete'](ctx, { id: agent.id })
      await ctx.runners.for(chat.id).whenIdle()

      expect(
        events.filter((event) => event.type === 'run.finished').map((event) => event.reason)
      ).toEqual(['stopped'])
      expect(ctx.runners.state(chat.id)).toBeNull()
    })

    it('rejects an unknown id with not_found', async () => {
      await expect(handlers['agents.delete'](ctx, { id: 'missing' })).rejects.toMatchObject({
        code: 'not_found'
      })
    })
  })
})
