/**
 * The watcher, driven through a real run.
 *
 * Nothing is stubbed except the model: a real `AppContext` over a temporary
 * database, the real `buildHandlers()`, the real `ChatRunner` and the real
 * `AgentTurn` against a `MockLanguageModelV4` — the injection
 * `chat-runner.test.ts` and `src/server/http.test.ts` both use. That is the only
 * way the status table means anything, because every row of it is a statement
 * about what the orchestration does, not about what this module computes from a
 * hand-written event.
 *
 * Two invariants are asserted in every case rather than in one test of their
 * own: the bus has as many listeners at the end as it had at the start (a
 * watcher that leaked one would keep the whole `AppContext` alive for the rest
 * of the process), and the result promise never rejects.
 */
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGREED_TOKEN } from '@shared/markers'
import { MAX_POSITION_CHARS } from '@shared/mcp-tools'
import type { Agent, Chat } from '@shared/types'
import type { AppContext } from '../app-context'
import { agentInput, createTestDatabase, providerInput, type TestDatabase } from '../db/testing'
import type { EventBus } from '../events/bus'
import { buildHandlers } from '../handlers'
import { createTestAppContext } from '../testing'
import { loadTranscript, readDiscussion, watchDiscussion } from './discussion'

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = StreamResult extends { stream: ReadableStream<infer Part> } ? Part : never

const USAGE = {
  inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
} as const

/** A model that answers with one whole message, optionally paced. */
function saying(text: string, delayMs: number | null = null): MockLanguageModelV4 {
  const chunks: StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: text },
    { type: 'text-end', id: '0' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE }
  ]
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doStream: async () => ({
      stream: simulateReadableStream({ chunks, initialDelayInMs: delayMs, chunkDelayInMs: delayMs })
    })
  })
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

/** A bus that counts its listeners, so a leaked subscription is a failed test. */
function counting(bus: EventBus): { bus: EventBus; listeners: () => number } {
  let listeners = 0
  return {
    bus: {
      emit: (event) => bus.emit(event),
      subscribe: (listener) => {
        listeners += 1
        const remove = bus.subscribe(listener)
        let removed = false
        return () => {
          if (removed) return
          removed = true
          listeners -= 1
          remove()
        }
      }
    },
    listeners: () => listeners
  }
}

describe('the discussion watcher', () => {
  const handlers = buildHandlers()

  let database: TestDatabase
  let ctx: AppContext
  let listeners: () => number
  let ada: Agent
  let lin: Agent
  let chat: Chat
  /** Swapped per test; the injected `createModel` always hands back this one. */
  let model: MockLanguageModelV4

  beforeEach(async () => {
    database = createTestDatabase()
    model = saying('Ship it.')
    const created = createTestAppContext(database, { runner: { createModel: () => model } })
    ctx = created.ctx

    // The bus the context was built with keeps recording; the counting wrapper
    // goes on top, so the starting count is 0 and every service reads
    // `ctx.events` at call time and therefore goes through it.
    const wrapped = counting(ctx.events)
    ctx.events = wrapped.bus
    listeners = wrapped.listeners

    const provider = ctx.repos.providers.create(providerInput(), ctx.userId)
    ada = ctx.repos.agents.create(
      agentInput({ name: 'Ada', providerId: provider.id, modelId: 'deepseek-chat' }),
      ctx.userId
    )
    lin = ctx.repos.agents.create(
      agentInput({ name: 'Lin', providerId: provider.id, modelId: 'deepseek-chat' }),
      ctx.userId
    )
    chat = await handlers['chats.create'](ctx, {
      input: { title: 'Migration', memberAgentIds: [ada.id, lin.id] }
    })
  })

  afterEach(() => {
    // Every path releases its subscription; this is the assertion that says so.
    expect(listeners()).toBe(0)
    ctx.close()
  })

  /** The `afterSeq` of a message about to be sent: everything said so far. */
  async function afterSeq(): Promise<number> {
    return (await loadTranscript(ctx, handlers, chat.id)).length
  }

  /** Watches, sends, and hands back what the watcher settled on. */
  async function ask(
    text: string,
    options: {
      waitMs?: number
      rounds?: number
      signal?: AbortSignal
      progress?: (update: { message: string; round?: number }) => void
    } = {}
  ): ReturnType<typeof watchDiscussion>['result'] {
    const seq = await afterSeq()
    const controller = new AbortController()
    const watch = watchDiscussion(ctx, handlers, {
      chatId: chat.id,
      afterSeq: seq,
      deadlineMs: Date.now() + (options.waitMs ?? 5_000),
      signal: options.signal ?? controller.signal,
      ...(options.progress ? { progress: options.progress } : {})
    })
    await handlers['chat.send'](ctx, {
      chatId: chat.id,
      text,
      ...(options.rounds === undefined ? {} : { rounds: options.rounds })
    })
    return watch.result
  }

  it('reports a chat position as the repository’s own seq', async () => {
    // The whole module indexes the transcript by position and calls it `seq`;
    // this is the assumption that makes the two the same number.
    await ask('Anything.', { rounds: 1 })
    await ctx.runners.for(chat.id).whenIdle()
    const transcript = await loadTranscript(ctx, handlers, chat.id)
    expect(transcript.length + 1).toBe(ctx.repos.messages.nextSeq(chat.id))
  })

  it('concludes when the group agrees, and names who wrote it', async () => {
    model = saying(`Ship it, the migration is safe. ${AGREED_TOKEN}`)
    const updates: { message: string; round?: number }[] = []

    const result = await ask('Is this migration safe?', { progress: (u) => updates.push(u) })

    expect(result.status).toBe('concluded')
    expect(result.chatId).toBe(chat.id)
    expect(result.url).toBe(`witena://chat/${chat.id}`)
    expect(result.round).toBeGreaterThanOrEqual(1)
    expect(result.conclusion?.agentName).toBe('Ada')
    // The closure marker is protocol, not prose: the caller never sees it.
    expect(result.conclusion?.markdown).toContain('Ship it, the migration is safe.')
    expect(result.conclusion?.markdown).not.toContain(AGREED_TOKEN)
    expect(result.usage?.totalTokens).toBeGreaterThan(0)
    expect(result.hint).toMatch(/apply the conclusion/i)
    // It is also the assertion that the conclusion row is committed *before*
    // `run.finished`: a result built from an unwritten message would be `ended`.
    expect(result.positions).toBeUndefined()

    expect(updates.some((update) => update.message === 'Round 1 — Ada, Lin')).toBe(true)
    expect(updates.some((update) => update.message === 'Ada has spoken')).toBe(true)
    expect(updates.some((update) => update.message === 'Lin has spoken')).toBe(true)
    expect(updates.find((update) => update.message.startsWith('Round 1'))?.round).toBe(1)
  })

  it('ends with one position per member when the rounds run out', async () => {
    const long = `${'a'.repeat(MAX_POSITION_CHARS + 50)} tail`
    model = saying(long)

    const result = await ask('What do you think?', { rounds: 1 })

    expect(result.status).toBe('ended')
    expect(result.conclusion).toBeUndefined()
    expect(result.positions?.map((position) => position.agentName)).toEqual(['Ada', 'Lin'])
    for (const position of result.positions ?? []) {
      expect(position.truncated).toBe(true)
      expect(position.markdown).toHaveLength(MAX_POSITION_CHARS)
    }
    expect(result.hint).toMatch(/positions/i)
  })

  it('answers running at the deadline, and the final result on a second watch', async () => {
    model = saying('Thinking about it.', 40)
    const seq = await afterSeq()
    const controller = new AbortController()

    const first = watchDiscussion(ctx, handlers, {
      chatId: chat.id,
      afterSeq: seq,
      // Short enough that the first round cannot have finished.
      deadlineMs: Date.now() + 20,
      signal: controller.signal
    })
    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Take your time.', rounds: 1 })
    const running = await first.result
    expect(running.status).toBe('running')
    expect(running.hint).toMatch(/wait_for_discussion/)

    const second = watchDiscussion(ctx, handlers, {
      chatId: chat.id,
      afterSeq: seq,
      deadlineMs: Date.now() + 5_000,
      signal: controller.signal
    })
    const final = await second.result
    expect(final.status).toBe('ended')
    expect(final.positions).toHaveLength(2)
  })

  it('reports a stopped run as stopped', async () => {
    model = saying('Still typing.', 40)
    const seq = await afterSeq()
    const watch = watchDiscussion(ctx, handlers, {
      chatId: chat.id,
      afterSeq: seq,
      deadlineMs: Date.now() + 5_000,
      signal: new AbortController().signal
    })
    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Go.' })
    await handlers['chat.stop'](ctx, { chatId: chat.id })

    const result = await watch.result
    expect(result.status).toBe('stopped')
    expect(result.hint).toMatch(/stopped/i)
  })

  it('reports a failing provider as error, with what the transcript recorded', async () => {
    model = failing()

    const result = await ask('Will this work?')

    expect(result.status).toBe('error')
    expect(result.error).toBeTruthy()
    expect(result.hint).toMatch(/failed/i)
  })

  it('returns needs-attention while the user is being asked something', async () => {
    const watch = watchDiscussion(ctx, handlers, {
      chatId: chat.id,
      afterSeq: 0,
      deadlineMs: Date.now() + 5_000,
      signal: new AbortController().signal
    })
    ctx.events.emit({
      type: 'permission.requested',
      requestId: 'request-1',
      chatId: chat.id,
      agentId: ada.id,
      toolName: 'write_file',
      input: { path: 'README.md' }
    })

    const result = await watch.result
    expect(result.status).toBe('needs-attention')
    expect(result.hint).toContain(`witena://chat/${chat.id}`)
  })

  it('ignores events belonging to another chat', async () => {
    const other = await handlers['chats.create'](ctx, {
      input: { title: 'Elsewhere', memberAgentIds: [ada.id] }
    })
    const watch = watchDiscussion(ctx, handlers, {
      chatId: chat.id,
      afterSeq: 0,
      deadlineMs: Date.now() + 60,
      signal: new AbortController().signal
    })
    ctx.events.emit({ type: 'run.finished', chatId: other.id, reason: 'completed' })

    // Still waiting, so the deadline is what settles it.
    const result = await watch.result
    expect(result.status).toBe('running')
  })

  it('gives up on abort without stopping the run', async () => {
    model = saying('Working on it.', 30)
    const controller = new AbortController()
    const seq = await afterSeq()
    const watch = watchDiscussion(ctx, handlers, {
      chatId: chat.id,
      afterSeq: seq,
      deadlineMs: Date.now() + 5_000,
      signal: controller.signal
    })
    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Go.', rounds: 1 })
    controller.abort()

    const result = await watch.result
    expect(result.status).toBe('running')
    // The run is the chat's, not the caller's: it keeps going and finishes.
    await ctx.runners.for(chat.id).whenIdle()
    const after = await readDiscussion(ctx, handlers, { chatId: chat.id, afterSeq: seq })
    expect(after.status).toBe('ended')
  })

  it('settles on a signal that was already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const watch = watchDiscussion(ctx, handlers, {
      chatId: chat.id,
      afterSeq: 0,
      deadlineMs: Date.now() + 5_000,
      signal: controller.signal
    })
    await expect(watch.result).resolves.toMatchObject({ status: 'running' })
  })

  it('cancels without rejecting, even for a chat that does not exist', async () => {
    // What WP-3 does when `chat.send` throws: the watcher was attached in front
    // of a send that never happened, and nothing awaits its result.
    const watch = watchDiscussion(ctx, handlers, {
      chatId: 'missing-chat',
      afterSeq: 0,
      deadlineMs: Date.now() + 5_000,
      signal: new AbortController().signal
    })
    watch.cancel()
    watch.cancel()
    await expect(watch.result).resolves.toMatchObject({ status: 'running' })
  })

  describe('readDiscussion', () => {
    it('reads a finished discussion without waiting', async () => {
      model = saying(`Agreed. ${AGREED_TOKEN}`)
      const seq = await afterSeq()
      await ask('Should we ship?')
      await ctx.runners.for(chat.id).whenIdle()

      const result = await readDiscussion(ctx, handlers, { chatId: chat.id, afterSeq: seq })
      expect(result.status).toBe('concluded')
      expect(result.conclusion?.markdown).toBe('Agreed.')
    })

    it('reads an idle chat that never concluded as ended', async () => {
      const result = await readDiscussion(ctx, handlers, { chatId: chat.id, afterSeq: 0 })
      expect(result.status).toBe('ended')
      expect(result.round).toBe(0)
      expect(result.positions).toEqual([])
      expect(result.usage).toBeUndefined()
    })

    it('refuses a chat that does not exist', async () => {
      await expect(
        readDiscussion(ctx, handlers, { chatId: 'missing-chat', afterSeq: 0 })
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it('sees only what was said after afterSeq', async () => {
      model = saying(`First. ${AGREED_TOKEN}`)
      await ask('Round one?')
      await ctx.runners.for(chat.id).whenIdle()
      const between = await afterSeq()

      model = saying('Second, and no agreement.')
      await ask('Round two?', { rounds: 1 })
      await ctx.runners.for(chat.id).whenIdle()

      const scoped = await readDiscussion(ctx, handlers, { chatId: chat.id, afterSeq: between })
      expect(scoped.status).toBe('ended')
      expect(scoped.conclusion).toBeUndefined()
      expect(scoped.positions?.every((position) => position.markdown === 'Second, and no agreement.')).toBe(true)

      const whole = await readDiscussion(ctx, handlers, { chatId: chat.id, afterSeq: 0 })
      expect(whole.conclusion?.markdown).toBe('First.')
    })
  })

  it('pages a transcript longer than one page', async () => {
    for (let index = 0; index < 205; index += 1) {
      ctx.repos.messages.create(
        {
          chatId: chat.id,
          senderType: 'user',
          senderId: ctx.userId,
          parts: [{ type: 'text', text: `message ${index}` }],
          status: 'done',
          round: 0,
          mentions: []
        },
        ctx.userId
      )
    }
    const transcript = await loadTranscript(ctx, handlers, chat.id)
    expect(transcript).toHaveLength(205)
    expect(transcript[0]?.parts[0]).toMatchObject({ text: 'message 0' })
    expect(transcript[204]?.parts[0]).toMatchObject({ text: 'message 204' })
  })
})
