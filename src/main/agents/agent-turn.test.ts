/**
 * One turn, end to end, against the temporary database and the **real**
 * `streamText`.
 *
 * The model is a `MockLanguageModelV4` (`ai/test`) whose `doStream` yields a
 * canned `LanguageModelV4` stream, so no socket is opened and yet every AI SDK
 * name `agent-turn.ts` depends on — the option names, `fullStream`, the
 * `text-delta` / `reasoning-delta` / `finish` part shapes, the structured V4
 * usage — is exercised for real. A stub around `streamText` would prove none of
 * that, which is the whole reason this is an integration test.
 */
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendEvent, MessageDeltaEvent } from '@shared/events'
import type { Agent, Chat, Message } from '@shared/types'
import type { AppContext } from '../app-context'
import { agentInput, createTestDatabase, providerInput, type TestDatabase } from '../db/testing'
import { createTestAppContext } from '../testing'
import { FLUSH_EVERY_DELTAS, runAgentTurn, toUsage } from './agent-turn'

/* -------------------------------------------------------------------------- */
/* Mock model                                                                  */
/* -------------------------------------------------------------------------- */

/** The V4 stream shapes, derived from the mock so no provider package is imported. */
type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = StreamResult extends { stream: ReadableStream<infer Part> } ? Part : never

/** The structured V4 usage: nested objects, not three bare numbers. */
const USAGE = {
  inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 4, text: 4, reasoning: 0 }
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

/** A model that streams `chunks`, optionally pacing them so an abort can land. */
function mockModel(chunks: StreamPart[], delayMs: number | null = null): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks,
        initialDelayInMs: delayMs,
        chunkDelayInMs: delayMs
      })
    })
  })
}

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

describe('runAgentTurn', () => {
  let database: TestDatabase
  let ctx: AppContext
  let events: BackendEvent[]
  let agent: Agent
  let chat: Chat

  beforeEach(() => {
    database = createTestDatabase()
    const created = createTestAppContext(database)
    ctx = created.ctx
    events = created.events

    const provider = ctx.repos.providers.create(providerInput(), ctx.userId)
    agent = ctx.repos.agents.create(
      agentInput({ name: 'Ada', providerId: provider.id, modelId: 'deepseek-chat' }),
      ctx.userId
    )
    chat = ctx.repos.chats.create({ title: 'Design review' }, ctx.userId)
    ctx.repos.chats.setMembers(ctx.userId, chat.id, [agent.id])
    ctx.repos.messages.create(
      {
        chatId: chat.id,
        senderType: 'user',
        senderId: ctx.userId,
        parts: [{ type: 'text', text: 'What should we build first?' }],
        status: 'done',
        round: 0,
        mentions: []
      },
      ctx.userId
    )
    // Only the agent's own events matter below.
    events.length = 0
  })

  afterEach(() => {
    database.cleanup()
  })

  const turn = (model: MockLanguageModelV4, signal = new AbortController().signal) =>
    runAgentTurn({ ctx, chat, agent, members: [agent], round: 1, signal, model })

  const types = (): string[] => events.map((event) => event.type)
  const deltas = (): MessageDeltaEvent[] =>
    events.filter((event): event is MessageDeltaEvent => event.type === 'message.delta')

  it('streams the answer token by token and persists it', async () => {
    const result = await turn(mockModel(textChunks(['Start ', 'with ', 'the ', 'data model.'])))

    expect(result.status).toBe('done')
    expect(result.message.parts).toEqual([{ type: 'text', text: 'Start with the data model.' }])
    expect(result.message.status).toBe('done')
    expect(result.message.round).toBe(1)
    expect(result.message.senderId).toBe(agent.id)

    const stored = ctx.repos.messages.get(result.message.id, ctx.userId)
    expect(stored.parts).toEqual([{ type: 'text', text: 'Start with the data model.' }])
  })

  it('emits created, one delta per token, then updated', async () => {
    await turn(mockModel(textChunks(['a', 'b', 'c'])))

    expect(types()).toEqual([
      'message.created',
      'presence.changed',
      'message.delta',
      'message.delta',
      'message.delta',
      'message.updated',
      'presence.changed'
    ])
    expect(deltas().map((event) => event.delta)).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'b' },
      { kind: 'text', text: 'c' }
    ])
  })

  it('creates the message empty and streaming before the first token', async () => {
    await turn(mockModel(textChunks(['hi'])))

    const created = events[0]
    expect(created).toMatchObject({ type: 'message.created' })
    const message = (created as { message: Message }).message
    expect(message).toMatchObject({ status: 'streaming', parts: [], senderType: 'agent' })
  })

  it('reports working around the turn and available afterwards', async () => {
    await turn(mockModel(textChunks(['x'])))

    const presence = events
      .filter((event) => event.type === 'presence.changed')
      .map((event) => (event as { presence: { state: string } }).presence.state)
    expect(presence).toEqual(['working', 'available'])
  })

  it('maps the structured V4 usage onto the stored Usage', async () => {
    const result = await turn(mockModel(textChunks(['x'])))

    expect(result.message.usage).toEqual({ inputTokens: 11, outputTokens: 4, totalTokens: 15 })
  })

  it('records reasoning as its own part and its own delta kind', async () => {
    const chunks: StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'reasoning-start', id: 'r' },
      { type: 'reasoning-delta', id: 'r', delta: 'Let me think.' },
      { type: 'reasoning-end', id: 'r' },
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', delta: 'Answer.' },
      { type: 'text-end', id: '0' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE }
    ]

    const result = await turn(mockModel(chunks))

    expect(result.message.parts).toEqual([
      { type: 'reasoning', text: 'Let me think.' },
      { type: 'text', text: 'Answer.' }
    ])
    expect(deltas().map((event) => event.delta.kind)).toEqual(['reasoning', 'text'])
  })

  it('marks a reply of exactly [PASS] as passed', async () => {
    const result = await turn(mockModel(textChunks(['[PASS]'])))

    expect(result.status).toBe('passed')
    expect(ctx.repos.messages.get(result.message.id, ctx.userId).status).toBe('passed')
  })

  it('does not treat [PASS] inside a longer answer as an abstention', async () => {
    const result = await turn(mockModel(textChunks(['Reply with [PASS] when you have nothing.'])))

    expect(result.status).toBe('done')
  })

  it('ends as error with the provider detail when the model fails', async () => {
    const model = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'mock-model',
      doStream: async () => {
        throw new Error('provider exploded')
      }
    })

    const result = await turn(model)

    expect(result.status).toBe('error')
    expect(result.message.error).toContain('provider exploded')
    expect(types()).toContain('message.updated')
  })

  it('ends as error with the detail "aborted" when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await turn(mockModel(textChunks(['never'])), controller.signal)

    expect(result.aborted).toBe(true)
    expect(result.status).toBe('error')
    expect(result.message.error).toBe('aborted')
    expect(result.message.parts).toEqual([])
  })

  it('stops mid-stream when the signal is aborted and keeps what it had', async () => {
    const controller = new AbortController()
    const chunks = textChunks(Array.from({ length: 40 }, (_, index) => `${index} `))

    const running = turn(mockModel(chunks, 5), controller.signal)
    setTimeout(() => controller.abort(), 30)
    const result = await running

    expect(result.aborted).toBe(true)
    expect(result.message.status).toBe('error')
    expect(result.message.error).toBe('aborted')
    // Whatever arrived before the abort is kept rather than thrown away.
    const stored = ctx.repos.messages.get(result.message.id, ctx.userId)
    expect(stored.parts.length).toBeLessThanOrEqual(1)
  })

  it('flushes partial text to the database rather than only writing at the end', async () => {
    const update = vi.spyOn(ctx.repos.messages, 'update')
    const many = Array.from({ length: FLUSH_EVERY_DELTAS * 2 + 5 }, () => 'x ')

    await turn(mockModel(textChunks(many)))

    // Two interim flushes plus the final write; the exact number depends on the
    // 500 ms timer, so only "more than the final write" is asserted.
    expect(update.mock.calls.length).toBeGreaterThanOrEqual(3)
    update.mockRestore()
  })

  it('sends the agent prompt, the briefing and the prefixed history to the model', async () => {
    const model = mockModel(textChunks(['ok']))

    await turn(model)

    const call = model.doStreamCalls[0]
    expect(call).toBeDefined()
    const prompt = JSON.stringify(call?.prompt)
    // The agent's own system prompt and the briefing's PASS rule are both there.
    expect(prompt).toContain(agentInput().systemPrompt)
    expect(prompt).toContain('[PASS]')
    // The user's message arrives prefixed, as `history.ts` promises.
    expect(prompt).toContain('[User]: What should we build first?')
  })

  it('passes the agent parameters through as AI SDK call options', async () => {
    const tuned = ctx.repos.agents.update(
      agent.id,
      { params: { temperature: 0.2, maxTokens: 64 } },
      ctx.userId
    )
    const model = mockModel(textChunks(['ok']))

    await runAgentTurn({
      ctx,
      chat,
      agent: tuned,
      members: [tuned],
      round: 1,
      signal: new AbortController().signal,
      model
    })

    expect(model.doStreamCalls[0]).toMatchObject({ temperature: 0.2, maxOutputTokens: 64 })
  })

  it('stores the mentions parsed out of the finished reply', async () => {
    const bob = ctx.repos.agents.create(
      agentInput({ name: 'Bob', providerId: agent.providerId, modelId: 'deepseek-chat' }),
      ctx.userId
    )

    const result = await runAgentTurn({
      ctx,
      chat,
      agent,
      members: [agent, bob],
      round: 1,
      signal: new AbortController().signal,
      model: mockModel(textChunks(['I agree with ', '@Bob on this.']))
    })

    // Parsed here, scheduled by `orchestration/scheduling.ts`: the stored set is
    // what the agent wrote, self-mentions included.
    expect(result.message.mentions).toEqual([bob.id])
    expect(ctx.repos.messages.get(result.message.id, ctx.userId).mentions).toEqual([bob.id])
  })

  it('stores no mentions for a [PASS]', async () => {
    const bob = ctx.repos.agents.create(
      agentInput({ name: 'Bob', providerId: agent.providerId, modelId: 'deepseek-chat' }),
      ctx.userId
    )

    const result = await runAgentTurn({
      ctx,
      chat,
      agent,
      members: [agent, bob],
      round: 1,
      signal: new AbortController().signal,
      model: mockModel(textChunks(['[PASS]']))
    })

    expect(result.status).toBe('passed')
    expect(result.message.mentions).toEqual([])
  })

  it('records inReplyTo on the message when the caller supplies it', async () => {
    const result = await runAgentTurn({
      ctx,
      chat,
      agent,
      members: [agent],
      round: 2,
      inReplyTo: ['user', 'agent-42'],
      signal: new AbortController().signal,
      model: mockModel(textChunks(['ok']))
    })

    expect(ctx.repos.messages.get(result.message.id, ctx.userId).inReplyTo).toEqual([
      'user',
      'agent-42'
    ])
  })

  it('leaves inReplyTo absent when nobody asked for the reply', async () => {
    const result = await turn(mockModel(textChunks(['ok'])))

    expect(result.message.inReplyTo).toBeUndefined()
  })

  it('uses the prebuilt history snapshot instead of re-reading the transcript', async () => {
    // What parallel speaking hands every speaker: the transcript as it was at the
    // start of the round. A message stored after the snapshot must not appear.
    const snapshot = ctx.repos.messages.listForContext(chat.id, ctx.userId)
    ctx.repos.messages.create(
      {
        chatId: chat.id,
        senderType: 'user',
        senderId: ctx.userId,
        parts: [{ type: 'text', text: 'A later thought nobody has seen' }],
        status: 'done',
        round: 0,
        mentions: []
      },
      ctx.userId
    )
    const model = mockModel(textChunks(['ok']))

    await runAgentTurn({
      ctx,
      chat,
      agent,
      members: [agent],
      round: 1,
      history: snapshot,
      signal: new AbortController().signal,
      model
    })

    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt)
    expect(prompt).toContain('What should we build first?')
    expect(prompt).not.toContain('A later thought nobody has seen')
  })

  it('builds the model through createModel when none is supplied', async () => {
    const model = mockModel(textChunks(['ok']))
    const createModel = vi.fn(() => model)

    const result = await runAgentTurn({
      ctx,
      chat,
      agent,
      members: [agent],
      round: 1,
      signal: new AbortController().signal,
      createModel
    })

    expect(createModel).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('done')
  })
})

describe('toUsage', () => {
  it('fills in a missing total from the two halves', () => {
    expect(
      toUsage({
        inputTokens: 3,
        outputTokens: 5,
        totalTokens: undefined,
        inputTokenDetails: { noCacheTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 5, reasoningTokens: 0 }
      })
    ).toEqual({ inputTokens: 3, outputTokens: 5, totalTokens: 8 })
  })

  it('treats an entirely unreported usage as zeroes rather than NaN', () => {
    expect(
      toUsage({
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined
        },
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined }
      })
    ).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  })
})
