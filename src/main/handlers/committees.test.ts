/**
 * `committees.*` (S9.1): the validation the Committees page runs into, and the
 * one event the rest of the app depends on.
 *
 * The storage contract underneath — ordering, the cascades, the transaction
 * that keeps a committee and its members in step — is
 * `../db/committees.test.ts`. What is here is the handler layer: what a bad
 * request is refused with, and what the renderer hears when a committee that
 * had topics is deleted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendEvent, ChatUpdatedEvent } from '@shared/events'
import { MAX_COMMITTEE_NAME_CHARS, type Agent, type Provider } from '@shared/types'
import type { AppContext } from '../app-context'
import { agentInput, createTestDatabase, providerInput, type TestDatabase } from '../db/testing'
import { createTestAppContext } from '../testing'
import { buildHandlers } from './index'

describe('handlers/committees', () => {
  const handlers = buildHandlers()

  let database: TestDatabase
  let ctx: AppContext
  let events: BackendEvent[]
  let provider: Provider

  const createAgent = (name: string, role: 'participant' | 'executor' = 'participant'): Promise<Agent> =>
    handlers['agents.create'](ctx, {
      input: agentInput({ name, providerId: provider.id, modelId: 'deepseek-chat', role })
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
    ctx.close()
  })

  const chatUpdates = (): ChatUpdatedEvent[] =>
    events.filter((event): event is ChatUpdatedEvent => event.type === 'chat.updated')

  it('creates, reads, updates and deletes a committee', async () => {
    const ada = await createAgent('Ada')
    const bob = await createAgent('Bob')

    const created = await handlers['committees.create'](ctx, {
      input: { name: '  Architecture  ', description: 'Reads designs twice', memberAgentIds: [ada.id] }
    })
    expect(created.name).toBe('Architecture')
    expect(created.memberAgentIds).toEqual([ada.id])

    expect(await handlers['committees.get'](ctx, { id: created.id })).toEqual(created)
    expect(await handlers['committees.list'](ctx)).toEqual([created])

    const updated = await handlers['committees.update'](ctx, {
      id: created.id,
      patch: { name: 'Architecture review', memberAgentIds: [bob.id, ada.id] }
    })
    expect(updated.name).toBe('Architecture review')
    expect(updated.memberAgentIds).toEqual([bob.id, ada.id])

    await handlers['committees.delete'](ctx, { id: created.id })
    expect(await handlers['committees.list'](ctx)).toEqual([])
  })

  it('refuses a blank name and one past the cap', async () => {
    for (const name of ['', '   ']) {
      await expect(
        handlers['committees.create'](ctx, { input: { name, description: '', memberAgentIds: [] } })
      ).rejects.toMatchObject({ code: 'validation' })
    }

    await expect(
      handlers['committees.create'](ctx, {
        input: {
          name: 'x'.repeat(MAX_COMMITTEE_NAME_CHARS + 1),
          description: '',
          memberAgentIds: []
        }
      })
    ).rejects.toMatchObject({ code: 'validation' })

    // Exactly at the cap is fine.
    const atCap = await handlers['committees.create'](ctx, {
      input: { name: 'x'.repeat(MAX_COMMITTEE_NAME_CHARS), description: '', memberAgentIds: [] }
    })
    expect(atCap.name).toHaveLength(MAX_COMMITTEE_NAME_CHARS)
  })

  it('refuses a member that names no agent, and a duplicate', async () => {
    const ada = await createAgent('Ada')

    await expect(
      handlers['committees.create'](ctx, {
        input: { name: 'Ghost', description: '', memberAgentIds: ['ghost'] }
      })
    ).rejects.toMatchObject({ code: 'not_found' })

    await expect(
      handlers['committees.create'](ctx, {
        input: { name: 'Twice', description: '', memberAgentIds: [ada.id, ada.id] }
      })
    ).rejects.toMatchObject({ code: 'validation' })

    expect(await handlers['committees.list'](ctx)).toEqual([])
  })

  it('refuses a second executor with the chat rule’s own reason', async () => {
    const first = await createAgent('Hands', 'executor')
    const second = await createAgent('Also hands', 'executor')

    await expect(
      handlers['committees.create'](ctx, {
        input: { name: 'Two writers', description: '', memberAgentIds: [first.id, second.id] }
      })
    ).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'second_executor' }
    })

    const ok = await handlers['committees.create'](ctx, {
      input: { name: 'One writer', description: '', memberAgentIds: [first.id] }
    })
    await expect(
      handlers['committees.update'](ctx, {
        id: ok.id,
        patch: { memberAgentIds: [first.id, second.id] }
      })
    ).rejects.toMatchObject({ details: { reason: 'second_executor' } })
    // The refused patch changed nothing.
    expect((await handlers['committees.get'](ctx, { id: ok.id })).memberAgentIds).toEqual([first.id])
  })

  it('rejects an unknown id on get, update and delete', async () => {
    for (const call of [
      handlers['committees.get'](ctx, { id: 'ghost' }),
      handlers['committees.update'](ctx, { id: 'ghost', patch: { name: 'x' } }),
      handlers['committees.delete'](ctx, { id: 'ghost' })
    ]) {
      await expect(call).rejects.toMatchObject({ code: 'not_found' })
    }
  })

  it('tells the renderer about every topic that lost its committee', async () => {
    const ada = await createAgent('Ada')
    const committee = await handlers['committees.create'](ctx, {
      input: { name: 'Review', description: '', memberAgentIds: [ada.id] }
    })
    const topic = await handlers['chats.create'](ctx, {
      input: { title: 'Topic', committeeId: committee.id }
    })
    const other = await handlers['chats.create'](ctx, { input: { title: 'Unrelated' } })
    events.length = 0

    await handlers['committees.delete'](ctx, { id: committee.id })

    expect(chatUpdates().map((event) => event.chat.id)).toEqual([topic.id])
    expect(chatUpdates()[0]?.chat.committeeId).toBeNull()
    // The topic keeps everybody the committee put in it.
    expect(ctx.repos.chats.listMembers(topic.id, ctx.userId).map((m) => m.agentId)).toEqual([ada.id])
    expect(ctx.repos.chats.get(other.id, ctx.userId).committeeId).toBeNull()
  })
})
