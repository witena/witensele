/**
 * The runner, driven the way the renderer drives it: through the handlers, with a
 * mock model behind `createModel` and a real temporary database underneath.
 *
 * What is asserted here is the **event sequence**, because that sequence is the
 * contract the renderer's stores are written against — a reordering that still
 * produces the right database rows would still break the UI. The second theme is
 * cancellation: stop mid-run, delete mid-run, and send again mid-run, which are
 * the three things a user does that the happy path never covers.
 */
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendEvent, RunFinishedEvent } from '@shared/events'
import type { Agent, Chat, Message } from '@shared/types'
import type { AppContext } from '../app-context'
import { agentInput, createTestDatabase, providerInput, type TestDatabase } from '../db/testing'
import { buildHandlers } from '../handlers'
import { createTestAppContext } from '../testing'

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = StreamResult extends { stream: ReadableStream<infer Part> } ? Part : never

const USAGE = {
  inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
} as const

function textChunks(deltas: string[]): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '0' },
    ...deltas.map((delta): StreamPart => ({ type: 'text-delta', id: '0', delta })),
    { type: 'text-end', id: '0' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE }
  ]
}

function mockModel(chunks: StreamPart[], delayMs: number | null = null): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doStream: async () => ({
      stream: simulateReadableStream({ chunks, initialDelayInMs: delayMs, chunkDelayInMs: delayMs })
    })
  })
}

describe('ChatRunner', () => {
  const handlers = buildHandlers()

  let database: TestDatabase
  let ctx: AppContext
  let events: BackendEvent[]
  let agent: Agent
  let chat: Chat
  /** Swapped per test; the injected `createModel` always hands back this one. */
  let model: MockLanguageModelV4

  beforeEach(async () => {
    database = createTestDatabase()
    model = mockModel(textChunks(['Hello ', 'there.']))
    const created = createTestAppContext(database, { runner: { createModel: () => model } })
    ctx = created.ctx
    events = created.events

    const provider = ctx.repos.providers.create(providerInput(), ctx.userId)
    agent = ctx.repos.agents.create(
      agentInput({ name: 'Ada', providerId: provider.id, modelId: 'deepseek-chat' }),
      ctx.userId
    )
    // Explicit members: since S2.2 `chats.create` only falls back to the
    // bootstrap agent when the agent library is empty, and this suite creates one.
    chat = await handlers['chats.create'](ctx, {
      input: { title: 'First chat', memberAgentIds: [agent.id] }
    })
    events.length = 0
  })

  afterEach(() => {
    database.cleanup()
  })

  const types = (): string[] => events.map((event) => event.type)
  const finished = (): RunFinishedEvent[] => finishedIn(events)
  const settle = () => ctx.runners.for(chat.id).whenIdle()

  it('stores the member list a chat was created with', async () => {
    const members = ctx.repos.chats.listMembers(chat.id, ctx.userId)

    expect(members).toEqual([{ chatId: chat.id, agentId: agent.id, position: 0 }])
  })

  it('reads the member list again on the next run rather than caching it', async () => {
    const second = ctx.repos.agents.create(
      agentInput({ name: 'Bob', providerId: agent.providerId, modelId: 'deepseek-chat' }),
      ctx.userId
    )

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Hi' })
    await settle()

    // The member list changes between the two runs; the runner must pick the new
    // first speaker up without being recreated.
    await handlers['chats.members.set'](ctx, { chatId: chat.id, agentIds: [second.id, agent.id] })
    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Again' })
    await settle()

    const stored = ctx.repos.messages.listForContext(chat.id, ctx.userId)
    expect(stored.filter((message) => message.senderType === 'agent').map((m) => m.senderId)).toEqual([
      agent.id,
      second.id
    ])
  })

  it('rejects chat.send on a chat with no members and stores nothing', async () => {
    const empty = await handlers['chats.create'](ctx, { input: { title: 'Nobody here' } })
    expect(ctx.repos.chats.listMembers(empty.id, ctx.userId)).toEqual([])

    await expect(handlers['chat.send'](ctx, { chatId: empty.id, text: 'Hi' })).rejects.toMatchObject(
      { code: 'validation', message: 'chat has no members' }
    )
    expect(ctx.repos.messages.listForContext(empty.id, ctx.userId)).toEqual([])
  })

  it('runs one full send → stream → persist cycle and emits it in order', async () => {
    const sent = await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Hi there' })
    await settle()

    expect(types()).toEqual([
      'message.created', // the user's message, before anything else
      'run.started',
      'run.round',
      'message.created', // the agent's empty, streaming message
      'presence.changed',
      'message.delta',
      'message.delta',
      'message.updated',
      'presence.changed',
      'run.finished'
    ])

    expect(sent).toMatchObject({ senderType: 'user', senderId: ctx.userId, round: 0, status: 'done' })
    expect(finished()[0]).toMatchObject({ chatId: chat.id, reason: 'completed' })

    const stored = ctx.repos.messages.listForContext(chat.id, ctx.userId)
    expect(stored).toHaveLength(2)
    expect(stored[1]).toMatchObject({
      senderType: 'agent',
      senderId: agent.id,
      status: 'done',
      round: 1,
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 }
    })
    expect(stored[1]?.parts).toEqual([{ type: 'text', text: 'Hello there.' }])
  })

  it('names the single member as the speaker of round 1', async () => {
    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Hi' })
    await settle()

    expect(events.find((event) => event.type === 'run.round')).toEqual({
      type: 'run.round',
      chatId: chat.id,
      round: 1,
      speakers: [agent.id]
    })
  })

  it('exposes the live run state while it is running and clears it afterwards', async () => {
    model = mockModel(textChunks(['slow ', 'answer']), 10)

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Hi' })
    const state = ctx.runners.state(chat.id)

    expect(state).toMatchObject({ chatId: chat.id, round: 1, speakers: [agent.id] })
    expect(state?.startedAt).toBeGreaterThan(0)

    await settle()
    expect(ctx.runners.state(chat.id)).toBeNull()
  })

  it('marks a reply of exactly [PASS] as passed', async () => {
    model = mockModel(textChunks(['[PASS]']))

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Anything to add?' })
    await settle()

    const stored = ctx.repos.messages.listForContext(chat.id, ctx.userId)
    expect(stored[1]).toMatchObject({ status: 'passed' })
    expect(finished()[0]).toMatchObject({ reason: 'completed' })
  })

  it('stops the run, finishes with reason stopped and leaves the message in error', async () => {
    model = mockModel(textChunks(Array.from({ length: 60 }, (_, index) => `${index} `)), 5)

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Count to 200' })
    await new Promise((resolve) => setTimeout(resolve, 25))
    await handlers['chat.stop'](ctx, { chatId: chat.id })
    await settle()

    expect(finished()[0]).toMatchObject({ reason: 'stopped' })
    const stored = ctx.repos.messages.listForContext(chat.id, ctx.userId)
    expect(stored[1]).toMatchObject({ status: 'error', error: 'aborted' })
  })

  it('is a no-op to stop a chat that is not running', async () => {
    await expect(handlers['chat.stop'](ctx, { chatId: chat.id })).resolves.toBeUndefined()
    expect(events).toEqual([])
  })

  it('ends the run with reason error when the provider fails', async () => {
    model = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'mock-model',
      doStream: async () => {
        throw new Error('provider exploded')
      }
    })

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Hi' })
    await settle()

    expect(finished()[0]).toMatchObject({ reason: 'error' })
    expect(ctx.repos.messages.listForContext(chat.id, ctx.userId)[1]).toMatchObject({
      status: 'error'
    })
  })

  it('queues a message sent during a run and answers it in a second run', async () => {
    model = mockModel(textChunks(['first ', 'answer']), 5)

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'First question' })
    const second = await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Second question' })
    await settle()

    // Stored immediately, before the first run finished: the user sees what they
    // typed, and a crash cannot lose it.
    expect(second).toMatchObject({ senderType: 'user' })

    // Two runs, not one, and not two at the same time.
    expect(types().filter((type) => type === 'run.started')).toHaveLength(2)
    expect(finished().map((event) => event.reason)).toEqual(['completed', 'completed'])

    // Interleaved, not grouped: the first run's message row is created as soon
    // as the run starts, so the second question lands after it in `seq` order.
    const stored = ctx.repos.messages.listForContext(chat.id, ctx.userId)
    expect(stored.map((message) => message.senderType)).toEqual(['user', 'agent', 'user', 'agent'])
    // The second run sees both questions, because every turn rebuilds its view
    // from the whole transcript.
    const prompt = JSON.stringify(model.doStreamCalls[1]?.prompt)
    expect(prompt).toContain('First question')
    expect(prompt).toContain('Second question')
  })

  it('drops the queue when the run is stopped instead of answering it anyway', async () => {
    model = mockModel(textChunks(Array.from({ length: 60 }, () => 'x ')), 5)

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'First' })
    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Second' })
    await new Promise((resolve) => setTimeout(resolve, 25))
    await handlers['chat.stop'](ctx, { chatId: chat.id })
    await settle()

    expect(types().filter((type) => type === 'run.started')).toHaveLength(1)
    expect(finished()).toHaveLength(1)
  })

  it('rejects an empty message before anything is stored', async () => {
    await expect(
      handlers['chat.send'](ctx, { chatId: chat.id, text: '   ' })
    ).rejects.toMatchObject({ code: 'validation' })
    expect(ctx.repos.messages.listForContext(chat.id, ctx.userId)).toEqual([])
  })

  it('rejects a send into a chat that does not exist', async () => {
    await expect(handlers['chat.send'](ctx, { chatId: 'nope', text: 'Hi' })).rejects.toMatchObject({
      code: 'not_found'
    })
  })
})

/**
 * The handlers around the runner. They live here rather than in
 * `handlers.test.ts` because what makes them interesting is the run they start
 * and stop, not their validation.
 */
describe('chats handlers', () => {
  const handlers = buildHandlers()

  let database: TestDatabase
  let ctx: AppContext
  let events: BackendEvent[]
  let model: MockLanguageModelV4

  beforeEach(() => {
    database = createTestDatabase()
    model = mockModel(textChunks(['ok']))
    const created = createTestAppContext(database, { runner: { createModel: () => model } })
    ctx = created.ctx
    events = created.events
    ctx.repos.providers.create(providerInput(), ctx.userId)
  })

  afterEach(() => {
    database.cleanup()
  })

  it('creates a chat with the default title and emits chat.updated', async () => {
    const chat = await handlers['chats.create'](ctx, { input: {} })

    expect(chat.title).toBe('New chat')
    expect(chat.settings).toMatchObject({ mode: 'roundrobin', speaking: 'sequential' })
    expect(events.at(-1)).toEqual({ type: 'chat.updated', chat })
    await expect(handlers['chats.list'](ctx)).resolves.toEqual([chat])
  })

  it('refuses to create a chat when no provider has a model', async () => {
    const empty = createTestAppContext(createTestDatabase())
    try {
      await expect(handlers['chats.create'](empty.ctx, { input: {} })).rejects.toMatchObject({
        code: 'validation'
      })
    } finally {
      empty.ctx.close()
    }
  })

  it('renames a chat, bumps updatedAt and emits chat.updated', async () => {
    const chat = await handlers['chats.create'](ctx, { input: {} })
    events.length = 0

    const renamed = await handlers['chats.update'](ctx, {
      id: chat.id,
      patch: { title: 'Orchestration' }
    })

    expect(renamed.title).toBe('Orchestration')
    expect(renamed.updatedAt).toBeGreaterThanOrEqual(chat.updatedAt)
    expect(events).toEqual([{ type: 'chat.updated', chat: renamed }])
  })

  it('rejects an empty title rather than storing it', async () => {
    const chat = await handlers['chats.create'](ctx, { input: {} })

    await expect(
      handlers['chats.update'](ctx, { id: chat.id, patch: { title: '  ' } })
    ).rejects.toMatchObject({ code: 'validation' })
  })

  it('lists messages newest first and pages with the before cursor', async () => {
    const chat = await handlers['chats.create'](ctx, { input: {} })
    for (const text of ['one', 'two', 'three']) {
      ctx.repos.messages.create(
        {
          chatId: chat.id,
          senderType: 'user',
          senderId: ctx.userId,
          parts: [{ type: 'text', text }],
          status: 'done',
          round: 0,
          mentions: []
        },
        ctx.userId
      )
    }

    const page = await handlers['messages.list'](ctx, { chatId: chat.id, limit: 2 })
    expect(page.map(firstText)).toEqual(['three', 'two'])

    const older = await handlers['messages.list'](ctx, {
      chatId: chat.id,
      before: page[1]?.id as string
    })
    expect(older.map(firstText)).toEqual(['one'])
  })

  it('deletes a chat, stops its run first and emits chat.deleted', async () => {
    model = mockModel(textChunks(Array.from({ length: 60 }, () => 'x ')), 5)
    const chat = await handlers['chats.create'](ctx, { input: {} })
    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Count to 200' })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(ctx.runners.state(chat.id)).not.toBeNull()

    const runner = ctx.runners.for(chat.id)
    await handlers['chats.delete'](ctx, { id: chat.id })
    await runner.whenIdle()

    // `run.finished` may land after `chat.deleted` — the abort unwinds a
    // microtask later — so what matters is that the delete happened and the run
    // ended as stopped rather than running on into a deleted chat.
    expect(events).toContainEqual({ type: 'chat.deleted', chatId: chat.id })
    expect(finishedIn(events).at(-1)).toMatchObject({ reason: 'stopped' })
    await expect(handlers['chats.list'](ctx)).resolves.toEqual([])
    expect(ctx.runners.state(chat.id)).toBeNull()
  })
})

/** Every `run.finished` in an event log, narrowed. */
function finishedIn(events: BackendEvent[]): RunFinishedEvent[] {
  return events.filter((event): event is RunFinishedEvent => event.type === 'run.finished')
}

/** The text of a message's first part, for the paging assertions. */
function firstText(message: Message): string {
  const part = message.parts[0]
  return part && part.type === 'text' ? part.text : ''
}
