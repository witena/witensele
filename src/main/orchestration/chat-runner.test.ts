/**
 * The runner, driven the way the renderer drives it: through the handlers, with
 * mock models behind `createModel` and a real temporary database underneath.
 *
 * What is asserted here is the **event sequence**, because that sequence is the
 * contract the renderer's stores are written against — a reordering that still
 * produces the right database rows would still break the UI. The second theme is
 * cancellation: stop mid-run, delete mid-run, and send again mid-run, which are
 * the three things a user does that the happy path never covers.
 *
 * The `multi-agent` block is S2.3's: rounds, both speaking modes, `@mentions`,
 * `[PASS]`, the round cap, and what happens when one speaker fails and the
 * others do not.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  BackendEvent,
  PresenceChangedEvent,
  RunFinishedEvent,
  RunRoundEvent
} from '@shared/events'
import { PASS_TOKEN } from '@shared/pass'
import type { Agent, Chat, HandoffIntent, Message, SystemNoticePart } from '@shared/types'
import { toModelMessages } from '../agents/history'
import type { AppContext } from '../app-context'
import { agentInput, createTestDatabase, providerInput, type TestDatabase } from '../db/testing'
import { DEFAULT_CHAT_TITLE } from '../db/repositories'
import { buildHandlers } from '../handlers'
import { createTestAppContext } from '../testing'
import { WRITE_FILE_TOOL } from '../executor/tools'
import {
  NOTICE_CONTEXT_TRUNCATED,
  NOTICE_HANDOFF,
  NOTICE_HANDOFF_DELIVER,
  NOTICE_MATERIALS_TRUNCATED,
  NOTICE_MAX_ROUNDS,
  type ChatRunnerOptions
} from './chat-runner'

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

/** A model that answers with one whole message, optionally paced. */
function saying(text: string, delayMs: number | null = null): MockLanguageModelV4 {
  return mockModel(textChunks([text]), delayMs)
}

/** A model whose request fails the way a dead provider's does. */
function failing(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doStream: async () => {
      throw new Error('provider exploded')
    }
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
    // `ctx.close()` rather than `database.cleanup()`: it also stops the
    // `AgentSupervisor`'s heartbeat, which would otherwise keep ticking against
    // a closed database for the rest of the suite.
    ctx.close()
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
    // membership up without being recreated.
    await handlers['chats.members.set'](ctx, { chatId: chat.id, agentIds: [second.id, agent.id] })
    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Again' })
    await settle()

    const stored = ctx.repos.messages.listForContext(chat.id, ctx.userId)
    expect(stored.filter((message) => message.senderType === 'agent').map((m) => m.senderId)).toEqual([
      agent.id,
      // Round-robin, in the new `position` order.
      second.id,
      agent.id
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
    const state = ctx.runners.getState(chat.id)

    expect(state).toMatchObject({ chatId: chat.id, round: 1, speakers: [agent.id] })
    expect(state?.startedAt).toBeGreaterThan(0)
    expect(state?.pendingUserMessageIds).toEqual([])
    // The turn is in flight, and names the row it is writing into.
    expect(state?.activeTurns).toHaveLength(1)
    expect(state?.activeTurns[0]).toMatchObject({ agentId: agent.id })

    await settle()
    expect(ctx.runners.getState(chat.id)).toBeNull()
    expect(ctx.runners.state(chat.id)).toBeNull()
  })

  it('marks a reply of exactly [PASS] as passed', async () => {
    model = mockModel(textChunks(['[PASS]']))

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Anything to add?' })
    await settle()

    const stored = ctx.repos.messages.listForContext(chat.id, ctx.userId)
    expect(stored[1]).toMatchObject({ status: 'passed', mentions: [] })
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
    model = failing()

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Hi' })
    await settle()

    expect(finished()[0]).toMatchObject({ reason: 'error' })
    expect(ctx.repos.messages.listForContext(chat.id, ctx.userId)[1]).toMatchObject({
      status: 'error'
    })
  })

  it('answers a message sent during a run in the next round of the same run', async () => {
    model = mockModel(textChunks(['first ', 'answer']), 5)

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'First question' })
    const second = await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Second question' })
    await settle()

    // Stored immediately, before the first round finished: the user sees what
    // they typed, and a crash cannot lose it.
    expect(second).toMatchObject({ senderType: 'user' })

    // One run, two rounds — S1.7's "second run" became a second round, so the
    // composer's Stop button stays up for the whole exchange.
    expect(types().filter((type) => type === 'run.started')).toHaveLength(1)
    expect(rounds(events).map((event) => event.round)).toEqual([1, 2])
    expect(finished().map((event) => event.reason)).toEqual(['completed'])

    // Interleaved, not grouped: the first round's message row is created as soon
    // as the round starts, so the second question lands after it in `seq` order.
    const stored = ctx.repos.messages.listForContext(chat.id, ctx.userId)
    expect(stored.map((message) => message.senderType)).toEqual(['user', 'agent', 'user', 'agent'])
    // The second round sees both questions, because every turn rebuilds its view
    // from the whole transcript.
    const prompt = JSON.stringify(model.doStreamCalls[1]?.prompt)
    expect(prompt).toContain('First question')
    expect(prompt).toContain('Second question')
  })

  it('drops the pending messages when the run is stopped instead of answering them anyway', async () => {
    model = mockModel(textChunks(Array.from({ length: 60 }, () => 'x ')), 5)

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'First' })
    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Second' })
    await new Promise((resolve) => setTimeout(resolve, 25))
    await handlers['chat.stop'](ctx, { chatId: chat.id })
    await settle()

    expect(rounds(events)).toHaveLength(1)
    expect(finished()).toHaveLength(1)
    expect(finished()[0]).toMatchObject({ reason: 'stopped' })
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
 * S2.3: several members, several rounds.
 *
 * Each agent gets its **own** mock model, so `doStreamCalls` can be read per
 * agent — that is how "the second speaker saw the first one's answer" is
 * asserted without inspecting a prompt that belongs to somebody else.
 */
describe('ChatRunner (multi-agent)', () => {
  const handlers = buildHandlers()

  let database: TestDatabase
  let ctx: AppContext
  let events: BackendEvent[]
  let ada: Agent
  let bob: Agent
  let chat: Chat
  /** Agent name → the model that answers for it. Swapped per test. */
  let models: Map<string, MockLanguageModelV4>

  beforeEach(async () => {
    database = createTestDatabase()
    models = new Map()
    const created = createTestAppContext(database, {
      runner: {
        createModel: (_ctx, agent) => models.get(agent.name) ?? saying('nothing to add')
      }
    })
    ctx = created.ctx
    events = created.events

    const provider = ctx.repos.providers.create(providerInput(), ctx.userId)
    ada = ctx.repos.agents.create(
      agentInput({ name: 'Ada', providerId: provider.id, modelId: 'deepseek-chat' }),
      ctx.userId
    )
    bob = ctx.repos.agents.create(
      agentInput({ name: 'Bob', providerId: provider.id, modelId: 'deepseek-chat' }),
      ctx.userId
    )
    chat = await handlers['chats.create'](ctx, {
      input: { title: 'Group chat', memberAgentIds: [ada.id, bob.id] }
    })
    events.length = 0
  })

  afterEach(() => {
    // `ctx.close()` rather than `database.cleanup()`: it also stops the
    // `AgentSupervisor`'s heartbeat, which would otherwise keep ticking against
    // a closed database for the rest of the suite.
    ctx.close()
  })

  const settle = () => ctx.runners.for(chat.id).whenIdle()
  const finished = (): RunFinishedEvent[] => finishedIn(events)
  const agentMessages = (): Message[] =>
    ctx.repos.messages
      .listForContext(chat.id, ctx.userId)
      .filter((message) => message.senderType === 'agent')

  /** Replaces the chat's settings through the handler that validates them. */
  const configure = async (settings: Record<string, unknown>): Promise<void> => {
    await handlers['chats.update'](ctx, { id: chat.id, patch: { settings } })
  }

  /** The prompt of one agent's n-th request, as text. */
  const promptOf = (name: string, index = 0): string =>
    JSON.stringify(models.get(name)?.doStreamCalls[index]?.prompt ?? null)

  it('gives every member the floor in round 1 of a roundrobin chat', async () => {
    models.set('Ada', saying('Ada here'))
    models.set('Bob', saying('Bob here'))

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Hello everyone' })
    await settle()

    expect(rounds(events)).toEqual([
      { type: 'run.round', chatId: chat.id, round: 1, speakers: [ada.id, bob.id] }
    ])
    expect(agentMessages().map((message) => message.senderId)).toEqual([ada.id, bob.id])
    expect(finished()[0]).toMatchObject({ reason: 'completed' })
  })

  it('sequential: the second speaker sees the first speaker’s reply', async () => {
    models.set('Ada', saying('the answer is 42'))
    models.set('Bob', saying('agreed'))

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'What is the answer?' })
    await settle()

    expect(promptOf('Bob')).toContain('the answer is 42')
    // …and the first speaker obviously did not see the second one's.
    expect(promptOf('Ada')).not.toContain('agreed')
  })

  it('parallel: both speakers get the same snapshot and cannot see each other', async () => {
    await configure({ speaking: 'parallel' })
    models.set('Ada', saying('the answer is 42', 5))
    models.set('Bob', saying('agreed', 5))

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'What is the answer?' })
    await settle()

    expect(promptOf('Bob')).toContain('What is the answer?')
    expect(promptOf('Bob')).not.toContain('the answer is 42')
    // The barrier still held: both turns finished before the run did.
    expect(agentMessages().map((message) => message.status)).toEqual(['done', 'done'])
    expect(finished()).toHaveLength(1)
  })

  it('a reply that mentions another member schedules round 2 with only that member', async () => {
    models.set('Ada', saying('@Bob what do you think?'))
    models.set('Bob', saying('nothing to add'))

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Start' })
    await settle()

    expect(rounds(events).map((event) => ({ round: event.round, speakers: event.speakers }))).toEqual([
      { round: 1, speakers: [ada.id, bob.id] },
      { round: 2, speakers: [bob.id] }
    ])

    const stored = agentMessages()
    expect(stored[0]).toMatchObject({ senderId: ada.id, round: 1, mentions: [bob.id] })
    // …and the round-2 message records who asked, for the "replying to" label.
    expect(stored[2]).toMatchObject({ senderId: bob.id, round: 2, inReplyTo: [ada.id] })
    expect(finished()[0]).toMatchObject({ reason: 'completed' })
  })

  it('ignores an agent that mentions itself', async () => {
    models.set('Ada', saying('@Ada should keep thinking'))
    models.set('Bob', saying('nothing to add'))

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Start' })
    await settle()

    // The mention is still stored — it is what Ada wrote — but it schedules nobody.
    expect(agentMessages()[0]).toMatchObject({ mentions: [ada.id] })
    expect(rounds(events)).toHaveLength(1)
    expect(finished()[0]).toMatchObject({ reason: 'completed' })
  })

  it('never lets a [PASS] schedule a round', async () => {
    models.set('Ada', saying('[PASS]'))
    models.set('Bob', saying('[PASS]'))

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Anything to add?' })
    await settle()

    expect(agentMessages().map((message) => message.status)).toEqual(['passed', 'passed'])
    expect(rounds(events)).toHaveLength(1)
    expect(finished()[0]).toMatchObject({ reason: 'completed' })
  })

  it('stops the chain at maxAutoRounds and says so', async () => {
    await configure({ maxAutoRounds: 2 })
    // Each agent keeps handing the floor to the other, forever.
    models.set('Ada', saying('@Bob your turn'))
    models.set('Bob', saying('@Ada your turn'))

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Discuss' })
    await settle()

    expect(rounds(events).map((event) => event.round)).toEqual([1, 2])
    expect(finished()[0]).toMatchObject({ reason: 'max-rounds' })
    expect(noticeKeys(ctx, chat)).toEqual(['maxRoundsReached'])
    expect(noticeParams(ctx, chat, 'maxRoundsReached')).toEqual({ max: 2 })
  })

  it('mention-only: only the mentioned member answers', async () => {
    await configure({ mode: 'mention-only' })
    models.set('Bob', saying('on it'))

    await handlers['chat.send'](ctx, { chatId: chat.id, text: '@Bob take this one' })
    await settle()

    expect(rounds(events).map((event) => event.speakers)).toEqual([[bob.id]])
    expect(agentMessages()).toHaveLength(1)
    expect(agentMessages()[0]).toMatchObject({ senderId: bob.id, inReplyTo: ['user'] })
  })

  it('mention-only: a message that mentions nobody finishes at once with a notice', async () => {
    await configure({ mode: 'mention-only' })
    // The settings write emits its own `chat.updated`; the sequence asserted
    // below is the run's.
    events.length = 0

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'thinking out loud' })
    await settle()

    expect(events.map((event) => event.type)).toEqual([
      'message.created', // the user's message
      'run.started',
      'message.created', // the notice
      'run.finished'
    ])
    expect(finished()[0]).toMatchObject({ reason: 'completed' })
    expect(noticeKeys(ctx, chat)).toEqual(['noMentions'])
    expect(agentMessages()).toHaveLength(0)
  })

  it('takes the composer’s explicit mentions into account as well', async () => {
    await configure({ mode: 'mention-only' })
    models.set('Ada', saying('on it'))

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'over to you', mentions: [ada.id] })
    await settle()

    expect(rounds(events).map((event) => event.speakers)).toEqual([[ada.id]])
  })

  it('lets a message sent mid-run join the next round and reset the round counter', async () => {
    // One automatic round only: without the reset the run would stop after it.
    await configure({ maxAutoRounds: 1 })
    models.set('Ada', saying('@Bob your turn', 5))
    models.set('Bob', saying('@Ada your turn', 5))

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'First' })
    const pending = await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Second' })
    // The pending message is visible in the run state before it is scheduled.
    expect(ctx.runners.getState(chat.id)?.pendingUserMessageIds).toEqual([pending.id])

    await settle()

    // Round 2 exists *and* has both members: the union of what the user asked
    // (roundrobin → everyone) and what round 1 mentioned.
    expect(rounds(events).map((event) => ({ round: event.round, speakers: event.speakers }))).toEqual([
      { round: 1, speakers: [ada.id, bob.id] },
      { round: 2, speakers: [ada.id, bob.id] }
    ])
    // …and then the cap applies again, counted from the new user message.
    expect(finished()[0]).toMatchObject({ reason: 'max-rounds' })
  })

  it('stop aborts every active turn of a parallel round', async () => {
    await configure({ speaking: 'parallel' })
    models.set('Ada', mockModel(textChunks(Array.from({ length: 60 }, () => 'a ')), 5))
    models.set('Bob', mockModel(textChunks(Array.from({ length: 60 }, () => 'b ')), 5))

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Count to 200' })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(ctx.runners.getState(chat.id)?.activeTurns).toHaveLength(2)

    await handlers['chat.stop'](ctx, { chatId: chat.id })
    await settle()

    expect(agentMessages().map((message) => message.status)).toEqual(['error', 'error'])
    expect(agentMessages().every((message) => message.error === 'aborted')).toBe(true)
    expect(finished()[0]).toMatchObject({ reason: 'stopped' })
  })

  it('one failing speaker does not stop the round or the run', async () => {
    models.set('Ada', failing())
    models.set('Bob', saying('I can still answer'))

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Hello' })
    await settle()

    expect(agentMessages().map((message) => message.status)).toEqual(['error', 'done'])
    expect(finished()[0]).toMatchObject({ reason: 'completed' })
  })

  it('finishes with error when every speaker of a round failed', async () => {
    models.set('Ada', failing())
    models.set('Bob', failing())

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Hello' })
    await settle()

    expect(agentMessages().map((message) => message.status)).toEqual(['error', 'error'])
    expect(finished()[0]).toMatchObject({ reason: 'error' })
  })

  it('emits run.started once and run.finished once for a multi-round run', async () => {
    models.set('Ada', saying('@Bob your turn'))
    models.set('Bob', saying('done here'))

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Start' })
    await settle()

    const sequence = events.map((event) => event.type)
    expect(sequence.filter((type) => type === 'run.started')).toHaveLength(1)
    expect(sequence.filter((type) => type === 'run.finished')).toHaveLength(1)
    expect(sequence.indexOf('run.started')).toBeLessThan(sequence.indexOf('run.round'))
    expect(sequence.lastIndexOf('run.round')).toBeLessThan(sequence.indexOf('run.finished'))
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
    // `ctx.close()` rather than `database.cleanup()`: it also stops the
    // `AgentSupervisor`'s heartbeat, which would otherwise keep ticking against
    // a closed database for the rest of the suite.
    ctx.close()
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
    expect(ctx.runners.getState(chat.id)).not.toBeNull()

    const runner = ctx.runners.for(chat.id)
    await handlers['chats.delete'](ctx, { id: chat.id })
    await runner.whenIdle()

    // `run.finished` may land after `chat.deleted` — the abort unwinds a
    // microtask later — so what matters is that the delete happened and the run
    // ended as stopped rather than running on into a deleted chat.
    expect(events).toContainEqual({ type: 'chat.deleted', chatId: chat.id })
    expect(finishedIn(events).at(-1)).toMatchObject({ reason: 'stopped' })
    await expect(handlers['chats.list'](ctx)).resolves.toEqual([])
    expect(ctx.runners.getState(chat.id)).toBeNull()
  })
})

/**
 * S2.4: one member that never emits anything, one that answers normally, and the
 * supervisor between them.
 *
 * The timeouts are cut from 30 s / 120 s to 50 ms / 120 ms **on the chat**, and
 * the heartbeat from 1 s to 10 ms on the supervisor, so the whole away → offline
 * → skipped path plays out in a fraction of a second against the real clock.
 * That is deliberate: a fake clock here would also have to fake the AI SDK's own
 * stream scheduling, and the thing under test is precisely that an abort reaches
 * a hung provider and releases the round barrier.
 *
 * The stalled model is a stream that enqueues its start part and then **never
 * produces anything else** until the signal it was handed is aborted — the exact
 * shape of a provider that accepted the request and then stopped talking.
 */
describe('ChatRunner + AgentSupervisor', () => {
  const handlers = buildHandlers()

  /** Per-chat overrides; the global settings are left at their defaults. */
  const STALL_MS = 50
  const HARD_MS = 120

  let database: TestDatabase
  let ctx: AppContext
  let events: BackendEvent[]
  let ghost: Agent
  let reviewer: Agent
  let chat: Chat
  /** Swapped per test, so one member can be made to answer after a retry. */
  let models: Record<string, MockLanguageModelV4>
  /** What the injected provider probe answers; the retry test flips it. */
  let probeOk: boolean

  /** A model that accepts the request and then goes silent until it is aborted. */
  function stalling(): MockLanguageModelV4 {
    return new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'mock-model',
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] } as StreamPart)
            const fail = (): void => {
              controller.error(abortSignal?.reason ?? new Error('aborted'))
            }
            if (abortSignal?.aborted) fail()
            else abortSignal?.addEventListener('abort', fail, { once: true })
          }
        })
      })
    })
  }

  beforeEach(async () => {
    database = createTestDatabase()
    probeOk = false
    const created = createTestAppContext(database, {
      runner: { createModel: (_context, agent) => models[agent.id] as MockLanguageModelV4 },
      supervisor: {
        // Ten ticks inside the stall budget: the transitions are observed, not raced.
        heartbeatIntervalMs: 10,
        // Long enough never to fire on its own inside a test; `probe` is called directly.
        probeIntervalMs: 60_000,
        probeProvider: () => Promise.resolve(probeOk)
      }
    })
    ctx = created.ctx
    events = created.events

    const provider = ctx.repos.providers.create(providerInput(), ctx.userId)
    ghost = ctx.repos.agents.create(
      agentInput({ name: 'Ghost', providerId: provider.id, modelId: 'deepseek-chat' }),
      ctx.userId
    )
    reviewer = ctx.repos.agents.create(
      agentInput({ name: 'Reviewer', providerId: provider.id, modelId: 'deepseek-chat' }),
      ctx.userId
    )
    models = { [ghost.id]: stalling(), [reviewer.id]: saying('Mutual exclusion.') }

    chat = await handlers['chats.create'](ctx, {
      input: {
        title: 'Stuck member',
        memberAgentIds: [ghost.id, reviewer.id],
        // Parallel, so the barrier is a real one: the stalled member must not
        // delay the member that answered.
        settings: { speaking: 'parallel', stallTimeoutMs: STALL_MS, hardTimeoutMs: HARD_MS }
      }
    })
    events.length = 0
  })

  afterEach(() => {
    ctx.close()
  })

  const settle = () => ctx.runners.for(chat.id).whenIdle()

  /** Presence states emitted for one agent, in order. */
  const presenceOf = (agentId: string): string[] =>
    events
      .filter(
        (event): event is PresenceChangedEvent =>
          event.type === 'presence.changed' && event.presence.agentId === agentId
      )
      .map((event) => event.presence.state)

  /** The stored messages of one sender. */
  const messagesOf = (senderId: string): Message[] =>
    ctx.repos.messages
      .listForContext(chat.id, ctx.userId)
      .filter((message) => message.senderId === senderId)

  it('turns a silent member orange, then grey, and skips its message', async () => {
    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'What is a mutex?' })
    await settle()

    expect(presenceOf(ghost.id)).toEqual(['working', 'away', 'offline'])

    const skipped = messagesOf(ghost.id).at(-1) as Message
    expect(skipped.status).toBe('skipped')
    expect(skipped.error).toBe('timeout')
  })

  it('inserts the agentSkipped notice naming the member', async () => {
    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'What is a mutex?' })
    await settle()

    expect(noticeKeys(ctx, chat)).toContain('agentSkipped')
    expect(noticeParams(ctx, chat, 'agentSkipped')).toEqual({ agent: 'Ghost' })
  })

  it('lets the other member finish and ends the run as completed', async () => {
    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'What is a mutex?' })
    await settle()

    const answer = messagesOf(reviewer.id).at(-1) as Message
    expect(answer.status).toBe('done')
    expect(firstText(answer)).toBe('Mutual exclusion.')
    // The barrier released on the skip rather than on a stopped run.
    expect(finishedIn(events).at(-1)).toMatchObject({ reason: 'completed' })
    expect(ctx.runners.getState(chat.id)).toBeNull()
  })

  it('does not schedule the offline member in the next round', async () => {
    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'What is a mutex?' })
    await settle()
    expect(ctx.supervisor.isOffline(ghost.id)).toBe(true)

    events.length = 0
    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'And a semaphore?' })
    await settle()

    expect(rounds(events).map((event) => event.speakers)).toEqual([[reviewer.id]])
    // One more message from the member that works, none from the one that does not.
    expect(messagesOf(ghost.id)).toHaveLength(1)
    expect(messagesOf(reviewer.id)).toHaveLength(2)
  })

  it('finishes with the allOffline notice when nobody is left to ask', async () => {
    await handlers['chats.members.set'](ctx, { chatId: chat.id, agentIds: [ghost.id] })
    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'What is a mutex?' })
    await settle()

    events.length = 0
    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Anyone?' })
    await settle()

    expect(rounds(events)).toEqual([])
    expect(noticeKeys(ctx, chat)).toContain('allOffline')
    expect(finishedIn(events).at(-1)).toMatchObject({ reason: 'completed' })
  })

  it('puts the member back after a retry whose probe succeeds', async () => {
    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'What is a mutex?' })
    await settle()

    probeOk = true
    await expect(
      handlers['presence.retry'](ctx, { chatId: chat.id, agentId: ghost.id })
    ).resolves.toMatchObject({ chatId: chat.id, agentId: ghost.id, state: 'available' })
    expect(ctx.supervisor.isOffline(ghost.id)).toBe(false)

    // …and it speaks again. Its model is swapped for one that answers, because
    // the point being proven is the scheduling, not a second timeout.
    models[ghost.id] = saying('Back.')
    events.length = 0
    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Still there?' })
    await settle()

    expect(rounds(events).map((event) => event.speakers)).toEqual([[ghost.id, reviewer.id]])
    expect((messagesOf(ghost.id).at(-1) as Message).status).toBe('done')
  })

  it('reports every member of the chat through presence.list', async () => {
    await expect(handlers['presence.list'](ctx, { chatId: chat.id })).resolves.toEqual([
      expect.objectContaining({ agentId: ghost.id, state: 'available' }),
      expect.objectContaining({ agentId: reviewer.id, state: 'available' })
    ])

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'What is a mutex?' })
    await settle()

    await expect(handlers['presence.list'](ctx, { chatId: chat.id })).resolves.toEqual([
      expect.objectContaining({ agentId: ghost.id, state: 'offline' }),
      expect.objectContaining({ agentId: reviewer.id, state: 'available' })
    ])
  })
})

/** Every `run.finished` in an event log, narrowed. */
function finishedIn(events: BackendEvent[]): RunFinishedEvent[] {
  return events.filter((event): event is RunFinishedEvent => event.type === 'run.finished')
}

/** Every `run.round` in an event log, narrowed. */
function rounds(events: BackendEvent[]): RunRoundEvent[] {
  return events.filter((event): event is RunRoundEvent => event.type === 'run.round')
}

/** The `system-notice` parts stored in a chat, in order. */
function notices(ctx: AppContext, chat: Chat): SystemNoticePart[] {
  return ctx.repos.messages
    .listForContext(chat.id, ctx.userId)
    .flatMap((message) => message.parts)
    .filter((part): part is SystemNoticePart => part.type === 'system-notice')
}

function noticeKeys(ctx: AppContext, chat: Chat): string[] {
  return notices(ctx, chat).map((part) => part.key)
}

function noticeParams(
  ctx: AppContext,
  chat: Chat,
  key: string
): Record<string, string | number> | undefined {
  return notices(ctx, chat).find((part) => part.key === key)?.params
}

/** The text of a message's first part, for the paging assertions. */
function firstText(message: Message): string {
  const part = message.parts[0]
  return part && part.type === 'text' ? part.text : ''
}

/* -------------------------------------------------------------------------- */
/* S4.1 / S4.2 / S4.3                                                          */
/* -------------------------------------------------------------------------- */

/** A model that answers one whole message when `generateText` asks it to. */
function titling(title: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doStream: async () => ({ stream: simulateReadableStream({ chunks: textChunks(['An answer.']) }) }),
    doGenerate: async () => ({
      content: [{ type: 'text', text: title }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: USAGE,
      warnings: []
    })
  })
}

describe('ChatRunner (usage, truncation and titles)', () => {
  const handlers = buildHandlers()

  let database: TestDatabase
  let ctx: AppContext
  let events: BackendEvent[]
  let ada: Agent
  let bob: Agent
  let chat: Chat
  let model: MockLanguageModelV4

  /** Builds a context whose runner uses `model` and the given title generator. */
  async function start(options: {
    generateTitle?: ChatRunnerOptions['generateTitle']
    title?: string
  } = {}): Promise<void> {
    database = createTestDatabase()
    model = mockModel(textChunks(['An answer.']))
    const created = createTestAppContext(database, {
      runner: {
        createModel: () => model,
        ...(options.generateTitle ? { generateTitle: options.generateTitle } : {})
      }
    })
    ctx = created.ctx
    events = created.events

    const provider = ctx.repos.providers.create(providerInput(), ctx.userId)
    ada = ctx.repos.agents.create(
      agentInput({ name: 'Ada', providerId: provider.id, modelId: 'deepseek-chat' }),
      ctx.userId
    )
    bob = ctx.repos.agents.create(
      agentInput({ name: 'Bob', providerId: provider.id, modelId: 'deepseek-chat' }),
      ctx.userId
    )
    chat = await handlers['chats.create'](ctx, {
      input: {
        ...(options.title ? { title: options.title } : {}),
        memberAgentIds: [ada.id]
      }
    })
    events.length = 0
  }

  afterEach(() => {
    ctx.close()
  })

  const settle = () => ctx.runners.for(chat.id).whenIdle()

  /* -- S4.1 --------------------------------------------------------------- */

  it('sums usage over the whole chat and splits it per agent', async () => {
    await start({ generateTitle: async () => null })
    await handlers['chats.members.set'](ctx, { chatId: chat.id, agentIds: [ada.id, bob.id] })

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Hi' })
    await settle()

    const summary = await handlers['messages.usageSummary'](ctx, { chatId: chat.id })

    // Two agents, one turn each, both reporting the same mock usage.
    expect(summary.perAgent[ada.id]).toMatchObject({ turns: 1 })
    expect(summary.perAgent[bob.id]).toMatchObject({ turns: 1 })
    expect(summary.total.inputTokens).toBe(
      (summary.perAgent[ada.id]?.usage.inputTokens ?? 0) +
        (summary.perAgent[bob.id]?.usage.inputTokens ?? 0)
    )
    expect(summary.total.totalTokens).toBeGreaterThan(0)
    // `deepseek-chat` is in the price table, so there is a number rather than null.
    expect(summary.cost).toBeGreaterThan(0)
  })

  it('reports an empty summary for a chat that has not spoken', async () => {
    await start({ generateTitle: async () => null })

    await expect(handlers['messages.usageSummary'](ctx, { chatId: chat.id })).resolves.toEqual({
      total: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      cost: null,
      perAgent: {}
    })
  })

  it('rejects a usage summary for a chat that does not exist', async () => {
    await start({ generateTitle: async () => null })

    await expect(
      handlers['messages.usageSummary'](ctx, { chatId: 'nope' })
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  /* -- S4.2 --------------------------------------------------------------- */

  it('stores a contextTruncated notice once per run when history had to be dropped', async () => {
    await start({ generateTitle: async () => null })
    // The agent's own `maxTokens` is what `fitHistory` reserves, so an output
    // reserve just under `deepseek-chat`'s 65_536 window leaves no room for any
    // history at all — which is the overflow case without a megabyte of fixture.
    ctx.repos.agents.update(ada.id, { params: { maxTokens: 65_500 } }, ctx.userId)

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'First question' })
    await settle()
    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Second question' })
    await settle()

    const truncated = noticeKeys(ctx, chat).filter((key) => key === NOTICE_CONTEXT_TRUNCATED)
    expect(truncated.length).toBeGreaterThan(0)
    const params = noticeParams(ctx, chat, NOTICE_CONTEXT_TRUNCATED)
    expect(params?.['agent']).toBe('Ada')
    expect(Number(params?.['dropped'])).toBeGreaterThan(0)
    // One per run, not one per round: two runs, at most two notices.
    expect(truncated.length).toBeLessThanOrEqual(2)
  })

  it('stores no truncation notice for a conversation that fits', async () => {
    await start({ generateTitle: async () => null })

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Hi' })
    await settle()

    expect(noticeKeys(ctx, chat)).not.toContain(NOTICE_CONTEXT_TRUNCATED)
  })

  /* -- S5.11 -------------------------------------------------------------- */

  /**
   * The materials notice, which is the one notice in the product stored **once
   * per chat** rather than once per run: the goal's materials are the same in
   * every round of every run until the user edits them, so a second sentence
   * would say exactly what the first one said.
   */
  it('says once per chat that the materials did not all fit', async () => {
    await start({ generateTitle: async () => null })
    const workdir = mkdtempSync(join(tmpdir(), 'witena-runner-materials-'))
    try {
      writeFileSync(join(workdir, 'HUGE.md'), 'w'.repeat(400_000), 'utf8')
      writeFileSync(join(workdir, 'SMALL.md'), 'a line\n', 'utf8')
      await handlers['chats.update'](ctx, {
        id: chat.id,
        patch: {
          workdir,
          goal: {
            kind: 'discussion',
            description: 'Decide what to do about the brief',
            materials: ['HUGE.md', 'SMALL.md']
          }
        }
      })

      await handlers['chat.send'](ctx, { chatId: chat.id, text: 'What does it say?' })
      await settle()

      const params = noticeParams(ctx, chat, NOTICE_MATERIALS_TRUNCATED)
      expect(params?.['agent']).toBe('Ada')
      expect(Number(params?.['omitted'])).toBeGreaterThan(0)

      // A second run adds no second sentence.
      await handlers['chat.send'](ctx, { chatId: chat.id, text: 'And now?' })
      await settle()
      expect(
        noticeKeys(ctx, chat).filter((key) => key === NOTICE_MATERIALS_TRUNCATED)
      ).toHaveLength(1)
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  it('stores no materials notice when they all fit', async () => {
    await start({ generateTitle: async () => null })
    const workdir = mkdtempSync(join(tmpdir(), 'witena-runner-materials-'))
    try {
      writeFileSync(join(workdir, 'SMALL.md'), 'a line\n', 'utf8')
      await handlers['chats.update'](ctx, {
        id: chat.id,
        patch: {
          workdir,
          goal: { kind: 'discussion', description: 'Read the line', materials: ['SMALL.md'] }
        }
      })

      await handlers['chat.send'](ctx, { chatId: chat.id, text: 'What does it say?' })
      await settle()

      expect(noticeKeys(ctx, chat)).not.toContain(NOTICE_MATERIALS_TRUNCATED)
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  /* -- S4.3 --------------------------------------------------------------- */

  it('names a chat after the first exchange, using the model', async () => {
    await start()
    model = titling('Retry budget tradeoffs')

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'What retry budget should we use?' })
    await settle()

    expect(ctx.repos.chats.get(chat.id, ctx.userId).title).toBe('Retry budget tradeoffs')
    // The renderer learns about it the same way it learns about a rename.
    const updated = events.filter((event) => event.type === 'chat.updated')
    expect(updated.at(-1)).toMatchObject({ chat: { title: 'Retry budget tradeoffs' } })
  })

  it('sanitises whatever the model answered', async () => {
    await start({ generateTitle: async () => '  "Retry budget tradeoffs."  ' })

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'What retry budget?' })
    await settle()

    expect(ctx.repos.chats.get(chat.id, ctx.userId).title).toBe('Retry budget tradeoffs')
  })

  it('falls back to the first words of the question when the model gives nothing', async () => {
    await start({ generateTitle: async () => null })

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'What retry budget should we use?' })
    await settle()

    expect(ctx.repos.chats.get(chat.id, ctx.userId).title).toBe('What retry budget should we use?')
  })

  it('falls back rather than failing when the title request throws', async () => {
    await start({
      generateTitle: async () => {
        throw new Error('provider exploded')
      }
    })

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'What retry budget?' })
    await settle()

    expect(ctx.repos.chats.get(chat.id, ctx.userId).title).toBe('What retry budget?')
  })

  it('never retitles a chat the user named', async () => {
    await start({ title: 'My own title', generateTitle: async () => 'Something generated' })

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Hi' })
    await settle()

    expect(ctx.repos.chats.get(chat.id, ctx.userId).title).toBe('My own title')
  })

  it('never retitles a chat the user renamed after the first run', async () => {
    await start({ generateTitle: async () => 'Generated once' })

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Hi' })
    await settle()
    expect(ctx.repos.chats.get(chat.id, ctx.userId).title).toBe('Generated once')

    await handlers['chats.update'](ctx, { id: chat.id, patch: { title: 'Renamed by hand' } })
    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Again' })
    await settle()

    expect(ctx.repos.chats.get(chat.id, ctx.userId).title).toBe('Renamed by hand')
  })

  it('leaves the default title alone when every turn failed', async () => {
    await start({ generateTitle: async () => 'Should not be used' })
    model = failing()

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Hi' })
    await settle()

    expect(ctx.repos.chats.get(chat.id, ctx.userId).title).toBe(DEFAULT_CHAT_TITLE)
  })

  it('keeps status done and strips the marker from history when a reply ends with [PASS]', async () => {
    await start({ generateTitle: async () => null })
    model = mockModel(textChunks([`Use exponential backoff. ${PASS_TOKEN}`]))

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'What should we do?' })
    await settle()

    const reply = ctx.repos.messages
      .listForContext(chat.id, ctx.userId)
      .find((message) => message.senderType === 'agent') as Message
    expect(reply.status).toBe('done')
    // The stored parts keep exactly what the model wrote…
    expect(firstText(reply)).toContain(PASS_TOKEN)
    // …and the prompt the next speaker sees does not.
    const view = toModelMessages({
      self: bob,
      agentsById: { [ada.id]: ada, [bob.id]: bob },
      messages: ctx.repos.messages.listForContext(chat.id, ctx.userId)
    })
    expect(JSON.stringify(view)).not.toContain(PASS_TOKEN)
    expect(JSON.stringify(view)).toContain('Use exponential backoff.')
  })

  /* -- chats.search ------------------------------------------------------- */

  it('finds a chat by a word in one of its messages', async () => {
    await start({ generateTitle: async () => null })
    const other = await handlers['chats.create'](ctx, {
      input: { title: 'Other', memberAgentIds: [ada.id] }
    })

    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Tell me about a zebra' })
    await settle()

    await expect(handlers['chats.search'](ctx, { query: 'zebra' })).resolves.toEqual([chat.id])
    await expect(handlers['chats.search'](ctx, { query: '' })).resolves.toEqual(
      expect.arrayContaining([chat.id, other.id])
    )
  })

  it('rejects a search with no query string', async () => {
    await start({ generateTitle: async () => null })

    // Cast: the contract requires a string, and the point of the case is what
    // happens when a caller that is not the typed client sends something else.
    await expect(
      handlers['chats.search'](ctx, {} as { query: string })
    ).rejects.toMatchObject({ code: 'validation' })
  })
})

/* -------------------------------------------------------------------------- */
/* S5.6: hand to executor, and the review round                                */
/* -------------------------------------------------------------------------- */

/**
 * PLAN.md's workflow, driven through the handler the button calls: discuss →
 * hand to executor → it implements → the others review → iterate.
 *
 * The chat is deliberately `roundrobin` (the default) with the executor **in the
 * middle** of the member list: the two facts these cases exist to pin down are
 * that the executor speaks alone in a mode where everybody normally speaks, and
 * that the review round is everybody else in `position` order rather than
 * "whoever is not last".
 */
describe('ChatRunner (hand to executor)', () => {
  const handlers = buildHandlers()

  let database: TestDatabase
  let ctx: AppContext
  let events: BackendEvent[]
  let ada: Agent
  let hands: Agent
  let bob: Agent
  let chat: Chat
  let workdir: string
  let models: Map<string, MockLanguageModelV4>

  beforeEach(async () => {
    database = createTestDatabase()
    models = new Map()
    const created = createTestAppContext(database, {
      runner: {
        createModel: (_ctx, agent) => models.get(agent.name) ?? saying('nothing to add')
      }
    })
    ctx = created.ctx
    events = created.events
    workdir = mkdtempSync(join(tmpdir(), 'witena-handoff-'))

    const provider = ctx.repos.providers.create(providerInput(), ctx.userId)
    ada = ctx.repos.agents.create(
      agentInput({ name: 'Ada', providerId: provider.id, modelId: 'deepseek-chat' }),
      ctx.userId
    )
    hands = ctx.repos.agents.create(
      agentInput({
        name: 'Hands',
        providerId: provider.id,
        modelId: 'deepseek-chat',
        role: 'executor'
      }),
      ctx.userId
    )
    bob = ctx.repos.agents.create(
      agentInput({ name: 'Bob', providerId: provider.id, modelId: 'deepseek-chat' }),
      ctx.userId
    )
    chat = await handlers['chats.create'](ctx, {
      input: { title: 'Implementation', workdir, memberAgentIds: [ada.id, hands.id, bob.id] }
    })
    events.length = 0
  })

  afterEach(() => {
    ctx.close()
    rmSync(workdir, { recursive: true, force: true })
  })

  const settle = () => ctx.runners.for(chat.id).whenIdle()
  const finished = (): RunFinishedEvent[] => finishedIn(events)
  const agentMessages = (): Message[] =>
    ctx.repos.messages
      .listForContext(chat.id, ctx.userId)
      .filter((message) => message.senderType === 'agent')
  const promptOf = (name: string, index = 0): string =>
    JSON.stringify(models.get(name)?.doStreamCalls[index]?.prompt ?? null)

  /** A model that answers a different sentence per turn, then repeats the last. */
  const answering = (texts: string[]): MockLanguageModelV4 => {
    let turn = 0
    return new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'mock-model',
      doStream: async () => {
        const text = texts[turn] ?? texts[texts.length - 1] ?? ''
        turn += 1
        return { stream: simulateReadableStream({ chunks: textChunks([text]) }) }
      }
    })
  }

  it('stores a hand-off message that mentions the executor and nobody else', async () => {
    const message = await handlers['chat.handoff'](ctx, { chatId: chat.id })
    await settle()

    expect(message).toMatchObject({
      senderType: 'user',
      status: 'done',
      round: 0,
      mentions: [hands.id],
      // A key plus the executor's name, never a sentence: the row outlives any
      // language choice (CLAUDE.md rule #4).
      parts: [{ type: 'system-notice', key: NOTICE_HANDOFF, params: { agent: 'Hands' } }]
    })
    expect(events[0]).toMatchObject({ type: 'message.created', message: { id: message.id } })
  })

  it('gives the executor the floor alone, then everybody else one review round', async () => {
    models.set('Hands', saying('I added NOTES.md and wired it into the index.'))
    models.set('Ada', saying('Reads fine.'))
    models.set('Bob', saying('Same here.'))

    await handlers['chat.handoff'](ctx, { chatId: chat.id })
    await settle()

    // Round 1 is the executor on its own, in a `roundrobin` chat where a typed
    // message would have given all three the floor; round 2 is the other two, in
    // member order, and there is no round 3.
    expect(rounds(events)).toEqual([
      { type: 'run.round', chatId: chat.id, round: 1, speakers: [hands.id] },
      { type: 'run.round', chatId: chat.id, round: 2, speakers: [ada.id, bob.id] }
    ])
    expect(agentMessages().map((message) => message.senderId)).toEqual([hands.id, ada.id, bob.id])
    // The reviewers were pulled in by the executor, which is what the UI prints.
    expect(agentMessages()[1]?.inReplyTo).toEqual([hands.id])
    expect(finished()[0]).toMatchObject({ reason: 'completed' })
  })

  it('briefs the executor to implement the conclusion, and feeds the reviewers its answer', async () => {
    models.set('Hands', saying('I added NOTES.md and wired it into the index.'))
    models.set('Ada', saying('Reads fine.'))

    await handlers['chat.handoff'](ctx, { chatId: chat.id })
    await settle()

    // The extra briefing (S5.6) on top of the standing executor section (S5.4).
    expect(promptOf('Hands')).toContain('Implement the conclusion the group reached')
    expect(promptOf('Hands')).toContain(workdir)
    // The request itself reached the prompt as prose rather than as a bare key.
    expect(promptOf('Hands')).toContain('handed the discussion to Hands')
    // And the review round is reading what the executor actually said.
    expect(promptOf('Ada')).toContain('I added NOTES.md')
  })

  it('schedules no review round when the executor is the only member', async () => {
    await handlers['chats.members.set'](ctx, { chatId: chat.id, agentIds: [hands.id] })
    models.set('Hands', saying('Done; nothing to review against.'))
    events.length = 0

    await handlers['chat.handoff'](ctx, { chatId: chat.id })
    await settle()

    expect(rounds(events)).toEqual([
      { type: 'run.round', chatId: chat.id, round: 1, speakers: [hands.id] }
    ])
    // `completed`, and silent: nobody was mentioned and nothing failed, so there
    // is nothing for a notice to explain.
    expect(finished()[0]).toMatchObject({ reason: 'completed' })
    expect(noticeKeys(ctx, chat)).toEqual([NOTICE_HANDOFF])
  })

  it('hands the floor back to the executor when a reviewer @s it, under the round cap', async () => {
    // The executor answers twice: the hand-off, then the reviewer's complaint,
    // which it closes by asking Ada to look again — a fourth round the cap
    // refuses, because `maxAutoRounds` counts every round since the hand-off.
    models.set('Hands', answering(['Added NOTES.md.', '@Ada fixed, look again.']))
    models.set('Ada', saying('@Hands the title is wrong.'))
    models.set('Bob', saying('Nothing from me.'))

    await handlers['chat.handoff'](ctx, { chatId: chat.id })
    await settle()

    expect(rounds(events).map((event) => event.speakers)).toEqual([
      [hands.id],
      [ada.id, bob.id],
      [hands.id]
    ])
    // The second executor turn is an ordinary reply to a mention: it keeps the
    // folder and the tools, and loses the "the discussion is over" briefing.
    expect(promptOf('Hands', 1)).toContain(workdir)
    expect(promptOf('Hands', 1)).not.toContain('Implement the conclusion the group reached')
    // The fourth round is refused: three is `maxAutoRounds`, and a hand-off's
    // own two rounds count towards it like any other.
    expect(finished()[0]).toMatchObject({ reason: 'max-rounds' })
    expect(noticeKeys(ctx, chat)).toEqual([NOTICE_HANDOFF, NOTICE_MAX_ROUNDS])
  })

  it('stops inside the executor’s turn, leaving no pending permission and no review', async () => {
    // A model that reaches for a gated tool and never gets an answer: the turn
    // is suspended inside `streamText`'s tool loop when Stop arrives.
    models.set(
      'Hands',
      new MockLanguageModelV4({
        provider: 'mock',
        modelId: 'mock-model',
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: WRITE_FILE_TOOL,
                input: JSON.stringify({ path: 'NOTES.md', content: '# Notes\n' })
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: USAGE
              }
            ]
          })
        })
      })
    )
    const stopOnPrompt = ctx.events.subscribe((event) => {
      if (event.type === 'permission.requested') ctx.runners.stop(chat.id)
    })

    await handlers['chat.handoff'](ctx, { chatId: chat.id })
    await settle()
    stopOnPrompt()

    expect(finished()[0]).toMatchObject({ reason: 'stopped' })
    // Exactly one `permission.resolved` per `permission.requested`, on every
    // path: a stop must not leave a card on screen with nothing behind it.
    expect(events.filter((event) => event.type === 'permission.resolved')).toMatchObject([
      { decision: 'aborted' }
    ])
    expect(ctx.permissions.pending()).toEqual([])
    // Neither the write nor the review round happened.
    expect(existsSync(join(workdir, 'NOTES.md'))).toBe(false)
    expect(rounds(events)).toHaveLength(1)
  })

  /* ------------------------------------------------------------------------ */
  /* S5.12: the second intent, and the review round that knows it is one       */
  /* ------------------------------------------------------------------------ */

  /** Puts a `document` goal on the chat and returns the deliverable's path. */
  const setDocumentGoal = async (deliverable = 'docs/REPORT.md'): Promise<string> => {
    await handlers['chats.update'](ctx, {
      id: chat.id,
      patch: {
        goal: {
          kind: 'document',
          description: 'Write the quarterly report',
          deliverable,
          materials: []
        }
      }
    })
    return deliverable
  }

  it('stores its own notice for a deliver hand-off, naming the file', async () => {
    const deliverable = await setDocumentGoal()

    const message = await handlers['chat.handoff'](ctx, { chatId: chat.id, intent: 'deliver' })
    await settle()

    expect(message).toMatchObject({
      senderType: 'user',
      mentions: [hands.id],
      // A different key rather than the same one with a parameter: the sentence
      // the user reads is a different sentence. The path is the **relative** one
      // the goal stores, which is what the header chip shows too.
      parts: [
        {
          type: 'system-notice',
          key: NOTICE_HANDOFF_DELIVER,
          params: { agent: 'Hands', path: deliverable }
        }
      ]
    })
    // …and the same two staged rounds as an ordinary hand-off: the intent
    // changes the briefing, not the scheduling.
    expect(rounds(events).map((event) => event.speakers)).toEqual([
      [hands.id],
      [ada.id, bob.id]
    ])
  })

  it('briefs the executor to write the file, and reaches the reviewers as prose', async () => {
    await setDocumentGoal()
    models.set('Hands', saying('Written.'))
    models.set('Ada', saying('Reads fine.'))

    await handlers['chat.handoff'](ctx, { chatId: chat.id, intent: 'deliver' })
    await settle()

    expect(promptOf('Hands')).toContain('write the deliverable of this chat now')
    expect(promptOf('Hands')).toContain('docs/REPORT.md')
    expect(promptOf('Hands')).not.toContain('Implement the conclusion the group reached')
    // The notice is rendered into the transcript the reviewers read, like the
    // other one: a key with no rendering would be an empty request.
    expect(promptOf('Ada')).toContain('write the deliverable of this chat')
  })

  it('tells the review round it is reviewing, and the executor round nothing of the kind', async () => {
    await setDocumentGoal()
    models.set('Hands', saying('Written.'))
    models.set('Ada', saying('Reads fine.'))
    models.set('Bob', saying('Same here.'))

    await handlers['chat.handoff'](ctx, { chatId: chat.id })
    await settle()

    expect(promptOf('Ada')).toContain('This round is a review')
    expect(promptOf('Bob')).toContain('This round is a review')
    // The executor wrote the thing; it is not reviewing it.
    expect(promptOf('Hands')).not.toContain('This round is a review')
  })

  it('does not carry the review briefing into the rounds after it', async () => {
    await setDocumentGoal()
    models.set('Hands', answering(['Written.', 'Fixed.']))
    models.set('Ada', saying('@Hands the title is wrong.'))
    models.set('Bob', saying('Nothing from me.'))

    await handlers['chat.handoff'](ctx, { chatId: chat.id })
    await settle()

    // Round 3 is ordinary `@` scheduling; nothing in it is a review round, so
    // the executor's second prompt carries neither block.
    expect(promptOf('Hands', 1)).not.toContain('This round is a review')
  })

  it('refuses a deliver hand-off on a chat whose goal names no file', async () => {
    // No goal at all…
    await expect(
      handlers['chat.handoff'](ctx, { chatId: chat.id, intent: 'deliver' })
    ).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'handoff_no_deliverable' }
    })

    // …and a goal of the wrong kind. Both are the same mistake to the user: this
    // chat has nothing to deliver.
    await handlers['chats.update'](ctx, {
      id: chat.id,
      patch: { goal: { kind: 'codebase', description: 'Split the runner', materials: [] } }
    })
    await expect(
      handlers['chat.handoff'](ctx, { chatId: chat.id, intent: 'deliver' })
    ).rejects.toMatchObject({ details: { reason: 'handoff_no_deliverable' } })

    // Nothing was stored on either path, and the ordinary hand-off still works.
    expect(ctx.repos.messages.listForContext(chat.id, ctx.userId)).toEqual([])
  })

  it('checks the folder and the executor before the deliverable', async () => {
    await handlers['chats.update'](ctx, { id: chat.id, patch: { workdir: null } })

    await expect(
      handlers['chat.handoff'](ctx, { chatId: chat.id, intent: 'deliver' })
    ).rejects.toMatchObject({ details: { reason: 'handoff_no_workdir' } })
  })

  it('refuses an intent it does not know', async () => {
    // Cast because the *type* already forbids it: the check exists for a caller
    // the compiler never saw — a stale renderer, or a future HTTP client.
    await expect(
      handlers['chat.handoff'](ctx, { chatId: chat.id, intent: 'ship-it' as HandoffIntent })
    ).rejects.toMatchObject({ code: 'validation' })
    expect(ctx.repos.messages.listForContext(chat.id, ctx.userId)).toEqual([])
  })

  it('refuses a chat with no working directory', async () => {
    await handlers['chats.update'](ctx, { id: chat.id, patch: { workdir: null } })

    await expect(handlers['chat.handoff'](ctx, { chatId: chat.id })).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'handoff_no_workdir' }
    })
    expect(ctx.repos.messages.listForContext(chat.id, ctx.userId)).toEqual([])
  })

  it('refuses a chat with no executor member', async () => {
    await handlers['chats.members.set'](ctx, { chatId: chat.id, agentIds: [ada.id, bob.id] })

    await expect(handlers['chat.handoff'](ctx, { chatId: chat.id })).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'handoff_no_executor' }
    })
  })

  it('refuses to join a run that is already going', async () => {
    models.set('Ada', saying('thinking', 20))
    models.set('Hands', saying('thinking', 20))
    models.set('Bob', saying('thinking', 20))
    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'What should we do?' })

    await expect(handlers['chat.handoff'](ctx, { chatId: chat.id })).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'handoff_run_active' }
    })

    ctx.runners.stop(chat.id)
    await settle()
  })
})
