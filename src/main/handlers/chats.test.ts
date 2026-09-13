/**
 * The parts of `chats.*` that S2.2 made real: who a new chat is created with, the
 * member list, and the orchestration settings.
 *
 * The S1.7 behaviour (create, rename, delete, the run methods) is covered by
 * `handlers.test.ts` and `../orchestration/chat-runner.test.ts`; this file is
 * about the three rules that changed, and about the events the member panel
 * depends on. Nothing here talks to a model, so no runner options are injected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendEvent, ChatUpdatedEvent } from '@shared/events'
import { DEFAULT_CHAT_SETTINGS, type Agent, type Provider } from '@shared/types'
import type { AppContext } from '../app-context'
import { DEFAULT_AGENT_NAME } from '../agents/default-agent'
import { agentInput, createTestDatabase, providerInput, type TestDatabase } from '../db/testing'
import { createTestAppContext } from '../testing'
import { buildHandlers } from './index'

describe('handlers/chats members and settings', () => {
  const handlers = buildHandlers()

  let database: TestDatabase
  let ctx: AppContext
  let events: BackendEvent[]
  let provider: Provider

  const createAgent = (name: string): Promise<Agent> =>
    handlers['agents.create'](ctx, {
      input: agentInput({ name, providerId: provider.id, modelId: 'deepseek-chat' })
    })

  beforeEach(() => {
    database = createTestDatabase()
    const created = createTestAppContext(database)
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

  describe('chats.create', () => {
    it('writes the bootstrap agent only while the agent library is empty', async () => {
      const first = await handlers['chats.create'](ctx, { input: {} })

      const agents = ctx.repos.agents.list(ctx.userId)
      expect(agents.map((agent) => agent.name)).toEqual([DEFAULT_AGENT_NAME])
      expect(ctx.repos.chats.listMembers(first.id, ctx.userId).map((m) => m.agentId)).toEqual([
        agents[0]?.id
      ])
    })

    it('creates an empty chat once the user owns agents', async () => {
      await createAgent('Ada')

      const chat = await handlers['chats.create'](ctx, { input: {} })

      expect(ctx.repos.chats.listMembers(chat.id, ctx.userId)).toEqual([])
      // No second agent was invented behind the user's back.
      expect(ctx.repos.agents.list(ctx.userId)).toHaveLength(1)
    })

    it('uses memberAgentIds in the order they were given', async () => {
      const ada = await createAgent('Ada')
      const bob = await createAgent('Bob')

      const chat = await handlers['chats.create'](ctx, {
        input: { title: 'Pair', memberAgentIds: [bob.id, ada.id] }
      })

      expect(ctx.repos.chats.listMembers(chat.id, ctx.userId)).toEqual([
        { chatId: chat.id, agentId: bob.id, position: 0 },
        { chatId: chat.id, agentId: ada.id, position: 1 }
      ])
    })

    it('rejects a member id that names no agent', async () => {
      await createAgent('Ada')

      await expect(
        handlers['chats.create'](ctx, { input: { memberAgentIds: ['ghost'] } })
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it('rejects when no provider has a model and there is nothing to fall back on', async () => {
      ctx.repos.providers.delete(provider.id, ctx.userId)

      await expect(handlers['chats.create'](ctx, { input: {} })).rejects.toMatchObject({
        code: 'validation'
      })
    })
  })

  describe('chats.members.set', () => {
    it('replaces the list, derives position from the order and emits chat.updated', async () => {
      const ada = await createAgent('Ada')
      const bob = await createAgent('Bob')
      const chat = await handlers['chats.create'](ctx, { input: { memberAgentIds: [ada.id] } })
      events.length = 0

      const members = await handlers['chats.members.set'](ctx, {
        chatId: chat.id,
        agentIds: [bob.id, ada.id]
      })

      expect(members.map((member) => member.agentId)).toEqual([bob.id, ada.id])
      expect(members.map((member) => member.position)).toEqual([0, 1])
      expect(chatUpdates().map((event) => event.chat.id)).toEqual([chat.id])
    })

    it('accepts an empty list, which is how the last member is removed', async () => {
      const ada = await createAgent('Ada')
      const chat = await handlers['chats.create'](ctx, { input: { memberAgentIds: [ada.id] } })

      await expect(
        handlers['chats.members.set'](ctx, { chatId: chat.id, agentIds: [] })
      ).resolves.toEqual([])
    })

    it('rejects an unknown agent id before writing anything', async () => {
      const ada = await createAgent('Ada')
      const chat = await handlers['chats.create'](ctx, { input: { memberAgentIds: [ada.id] } })
      events.length = 0

      await expect(
        handlers['chats.members.set'](ctx, { chatId: chat.id, agentIds: [ada.id, 'ghost'] })
      ).rejects.toMatchObject({ code: 'not_found' })

      expect(ctx.repos.chats.listMembers(chat.id, ctx.userId).map((m) => m.agentId)).toEqual([
        ada.id
      ])
      expect(chatUpdates()).toEqual([])
    })

    it('rejects the same agent listed twice', async () => {
      const ada = await createAgent('Ada')
      const chat = await handlers['chats.create'](ctx, { input: {} })

      await expect(
        handlers['chats.members.set'](ctx, { chatId: chat.id, agentIds: [ada.id, ada.id] })
      ).rejects.toMatchObject({ code: 'validation' })
    })
  })

  describe('chats.update settings', () => {
    it('merges one field at a time and leaves the rest alone', async () => {
      const chat = await handlers['chats.create'](ctx, { input: {} })

      const updated = await handlers['chats.update'](ctx, {
        id: chat.id,
        patch: { settings: { speaking: 'parallel' } }
      })

      expect(updated.settings).toEqual({ ...DEFAULT_CHAT_SETTINGS, speaking: 'parallel' })

      const again = await handlers['chats.update'](ctx, {
        id: chat.id,
        patch: { settings: { maxAutoRounds: 5 } }
      })
      expect(again.settings).toEqual({
        ...DEFAULT_CHAT_SETTINGS,
        speaking: 'parallel',
        maxAutoRounds: 5
      })
    })

    it('stores the per-chat timeouts', async () => {
      const chat = await handlers['chats.create'](ctx, { input: {} })

      const updated = await handlers['chats.update'](ctx, {
        id: chat.id,
        patch: { settings: { hardTimeoutMs: 300_000, stallTimeoutMs: 30_000 } }
      })

      expect(updated.settings).toMatchObject({ hardTimeoutMs: 300_000, stallTimeoutMs: 30_000 })
    })

    it.each([
      ['an unknown mode', { mode: 'freeforall' as never }],
      ['an unknown speaking mode', { speaking: 'shouting' as never }],
      ['zero rounds', { maxAutoRounds: 0 }],
      ['more rounds than the cap', { maxAutoRounds: 11 }],
      ['a fractional round count', { maxAutoRounds: 2.5 }],
      ['a negative hard timeout', { hardTimeoutMs: -1 }],
      ['a zero stall timeout', { stallTimeoutMs: 0 }]
    ])('rejects %s with validation', async (_label, settings) => {
      const chat = await handlers['chats.create'](ctx, { input: {} })
      events.length = 0

      await expect(
        handlers['chats.update'](ctx, { id: chat.id, patch: { settings } })
      ).rejects.toMatchObject({ code: 'validation' })

      expect(ctx.repos.chats.get(chat.id, ctx.userId).settings).toEqual(DEFAULT_CHAT_SETTINGS)
      expect(chatUpdates()).toEqual([])
    })
  })
})
