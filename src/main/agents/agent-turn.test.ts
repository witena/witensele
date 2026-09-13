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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendEvent, MessageDeltaEvent } from '@shared/events'
import type { Agent, Chat, McpServer, Message } from '@shared/types'
import type { AppContext } from '../app-context'
import { skillsDir } from '../app-context'
import {
  agentInput,
  createTestDatabase,
  mcpServerInput,
  providerInput,
  type TestDatabase
} from '../db/testing'
import { failingTransport, inMemoryTransport } from '../mcp/testing'
import { invalidateSkillCache } from '../skills/loader'
import { createTestAppContext } from '../testing'
import {
  FLUSH_EVERY_DELTAS,
  NOTICE_TOOLS_UNSUPPORTED,
  looksLikeToolRejection,
  runAgentTurn,
  toUsage
} from './agent-turn'

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
    // `ctx.close()` rather than `database.cleanup()`: it also stops the
    // `AgentSupervisor`'s heartbeat, which would otherwise keep ticking against
    // a closed database for the rest of the suite.
    ctx.close()
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

/* -------------------------------------------------------------------------- */
/* Tools (S3.1)                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The tool loop, end to end: a real `streamText`, a real MCP server running in
 * this process (`mcp/testing.ts`), and a mock model that asks for a tool on its
 * first call and answers on its second.
 *
 * The point of the fixture is that nothing about the tool path is stubbed —
 * discovery, the `${slug}__${tool}` naming, `tools/call` over the protocol, the
 * content-block mapping and the SDK's own step loop all run.
 */
describe('runAgentTurn with MCP tools', () => {
  let database: TestDatabase
  let ctx: AppContext
  let events: BackendEvent[]
  let agent: Agent
  let chat: Chat
  let server: McpServer

  /**
   * A model that calls `everything__echo` once, then answers.
   *
   * The V4 stream part carries `input` as a **stringified** JSON object, unlike
   * the `ai`-level `tool-call` part where it is already parsed.
   */
  function toolThenAnswer(toolName = 'everything__echo'): MockLanguageModelV4 {
    let calls = 0
    return new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'mock-model',
      doStream: async () => {
        calls += 1
        const chunks: StreamPart[] =
          calls === 1
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'call-1',
                  toolName,
                  input: JSON.stringify({ message: 'WITENA-42' })
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: USAGE
                }
              ]
            : textChunks(['It returned ', 'Echo: WITENA-42.'])
        return { stream: simulateReadableStream({ chunks }) }
      }
    })
  }

  function bind(options: { sideEffects?: boolean; role?: Agent['role'] } = {}): void {
    server = ctx.repos.mcpServers.create(
      mcpServerInput({ name: 'everything', sideEffects: options.sideEffects ?? false }),
      ctx.userId
    )
    agent = ctx.repos.agents.update(
      agent.id,
      { mcpServerIds: [server.id], ...(options.role ? { role: options.role } : {}) },
      ctx.userId
    )
  }

  beforeEach(() => {
    database = createTestDatabase()
    const created = createTestAppContext(database, {
      // A genuine MCP server over `InMemoryTransport`: no child process, no npx.
      mcp: { createTransport: inMemoryTransport() }
    })
    ctx = created.ctx
    events = created.events

    const provider = ctx.repos.providers.create(providerInput(), ctx.userId)
    agent = ctx.repos.agents.create(
      agentInput({ name: 'Ada', providerId: provider.id, modelId: 'deepseek-chat' }),
      ctx.userId
    )
    chat = ctx.repos.chats.create({ title: 'Tooling' }, ctx.userId)
    ctx.repos.chats.setMembers(ctx.userId, chat.id, [agent.id])
    ctx.repos.messages.create(
      {
        chatId: chat.id,
        senderType: 'user',
        senderId: ctx.userId,
        parts: [{ type: 'text', text: 'Echo WITENA-42 for me.' }],
        status: 'done',
        round: 0,
        mentions: []
      },
      ctx.userId
    )
    events.length = 0
  })

  afterEach(() => {
    ctx.close()
  })

  const turn = (model: MockLanguageModelV4) =>
    runAgentTurn({ ctx, chat, agent, members: [agent], round: 1, signal: new AbortController().signal, model })

  /** Answers every permission prompt with `allow`. Returns the unsubscribe. */
  const allowEveryPrompt = (): (() => void) =>
    ctx.events.subscribe((event) => {
      if (event.type === 'permission.requested') {
        ctx.permissions.reply({ requestId: event.requestId, decision: 'allow' })
      }
    })

  it('runs the tool and stores the call, the result and the answer in order', async () => {
    bind()

    const result = await turn(toolThenAnswer())

    expect(result.status).toBe('done')
    expect(result.message.parts).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        // The tool's own name, not the `everything__echo` key the model saw.
        toolName: 'echo',
        input: { message: 'WITENA-42' },
        serverId: server.id,
        serverName: 'everything'
      },
      { type: 'tool-result', toolCallId: 'call-1', output: 'Echo: WITENA-42' },
      { type: 'text', text: 'It returned Echo: WITENA-42.' }
    ])
  })

  it('emits the call and the result as part deltas before the text', async () => {
    bind()

    await turn(toolThenAnswer())

    const kinds = events
      .filter((event): event is MessageDeltaEvent => event.type === 'message.delta')
      .map((event) => event.delta.kind)
    expect(kinds).toEqual(['part', 'part', 'text', 'text'])
  })

  it('adds up the usage of every step of the loop', async () => {
    bind()

    const result = await turn(toolThenAnswer())

    // Two model calls, 11 in / 4 out each.
    expect(result.message.usage).toEqual({ inputTokens: 22, outputTokens: 8, totalTokens: 30 })
  })

  it('stores a failed tool as an errored result the card can mark red', async () => {
    bind()

    const result = await turn(toolThenAnswer('everything__fail'))

    const parts = result.message.parts
    expect(parts[0]).toMatchObject({ type: 'tool-call', toolName: 'fail' })
    expect(parts[1]).toMatchObject({ type: 'tool-result', isError: true })
    expect(result.status).toBe('done')
  })

  it('withholds a side-effecting server from a participant', async () => {
    bind({ sideEffects: true })
    const model = toolThenAnswer()

    await turn(model)

    // The rule from PLAN.md: the model is never even offered the tools.
    expect(model.doStreamCalls[0]?.tools ?? []).toEqual([])
  })

  it('attaches the same server to an executor, and confirms every call (S5.4)', async () => {
    bind({ sideEffects: true, role: 'executor' })
    const model = toolThenAnswer()
    // Nobody is at the keyboard in a unit test, so the answer is automatic; what
    // is being asserted is that the call *waited* for one.
    const stopAllowing = allowEveryPrompt()

    const result = await turn(model)

    expect((model.doStreamCalls[0]?.tools ?? []).map((tool) => tool.name)).toEqual([
      'everything__echo',
      'everything__fail',
      'everything__slow'
    ])
    const prompts = events.filter((event) => event.type === 'permission.requested')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ toolName: 'echo', input: { message: 'WITENA-42' } })
    expect(result.message.parts[1]).toMatchObject({ type: 'tool-result', output: 'Echo: WITENA-42' })
    stopAllowing()
  })

  it('returns a tool error the model can read when a side-effecting call is denied', async () => {
    bind({ sideEffects: true, role: 'executor' })
    const stopDenying = ctx.events.subscribe((event) => {
      if (event.type === 'permission.requested') {
        ctx.permissions.reply({ requestId: event.requestId, decision: 'deny' })
      }
    })

    const result = await turn(toolThenAnswer())

    expect(result.message.parts[1]).toMatchObject({ type: 'tool-result', isError: true })
    expect(String((result.message.parts[1] as { output: unknown }).output)).toMatch(/declined/)
    stopDenying()
  })

  it('offers no tools at all when the server is disabled', async () => {
    bind()
    ctx.repos.mcpServers.update(server.id, { enabled: false }, ctx.userId)
    const model = toolThenAnswer()

    await turn(model)

    expect(model.doStreamCalls[0]?.tools ?? []).toEqual([])
  })

  it('answers without tools, and says so once, when the provider rejects them', async () => {
    bind()
    let calls = 0
    const model = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'mock-model',
      doStream: async () => {
        calls += 1
        if (calls === 1) throw new Error('model qwen2.5:1.5b does not support tools')
        return { stream: simulateReadableStream({ chunks: textChunks(['Plain answer.']) }) }
      }
    })

    const result = await turn(model)

    expect(result.status).toBe('done')
    expect(result.message.parts).toEqual([{ type: 'text', text: 'Plain answer.' }])
    const notices = events
      .filter((event) => event.type === 'message.created')
      .flatMap((event) => (event as { message: Message }).message.parts)
      .filter((part) => part.type === 'system-notice')
    expect(notices).toEqual([
      { type: 'system-notice', key: NOTICE_TOOLS_UNSUPPORTED, params: { agent: 'Ada' } }
    ])
  })

  it('does not repeat the notice on a later turn in the same chat', async () => {
    bind()
    const rejecting = (): MockLanguageModelV4 => {
      let calls = 0
      return new MockLanguageModelV4({
        provider: 'mock',
        modelId: 'mock-model',
        doStream: async () => {
          calls += 1
          if (calls === 1) throw new Error('tools are not supported by this model')
          return { stream: simulateReadableStream({ chunks: textChunks(['Again.']) }) }
        }
      })
    }

    await turn(rejecting())
    events.length = 0
    await turn(rejecting())

    const notices = events
      .filter((event) => event.type === 'message.created')
      .flatMap((event) => (event as { message: Message }).message.parts)
      .filter((part) => part.type === 'system-notice')
    expect(notices).toEqual([])
  })

  it('still answers when the MCP server cannot be reached', async () => {
    bind()
    const broken = createTestAppContext(database, { mcp: { createTransport: failingTransport() } })
    const result = await runAgentTurn({
      ctx: broken.ctx,
      chat,
      agent,
      members: [agent],
      round: 1,
      signal: new AbortController().signal,
      model: mockModel(textChunks(['No tools, but an answer.']))
    })

    expect(result.status).toBe('done')
    expect(result.message.parts).toEqual([{ type: 'text', text: 'No tools, but an answer.' }])
    broken.ctx.supervisor.stop()
  })
})

describe('looksLikeToolRejection', () => {
  it('matches the ways providers say a model cannot use tools', () => {
    expect(looksLikeToolRejection('model x does not support tools')).toBe(true)
    expect(looksLikeToolRejection('tools are not supported')).toBe(true)
    expect(looksLikeToolRejection('unknown parameter: tools')).toBe(true)
  })

  it('does not match a tool that merely failed', () => {
    expect(looksLikeToolRejection('the echo tool threw ENOENT')).toBe(false)
    expect(looksLikeToolRejection('rate limit exceeded')).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* Skills and memory (S3.2, S3.3)                                              */
/* -------------------------------------------------------------------------- */

/**
 * The built-in tools, end to end: a real `streamText`, a real skills folder and
 * a real memory directory under the context's own temporary `userDataDir`, and a
 * mock model that calls one built-in tool on its first step and answers on its
 * second.
 *
 * Nothing about the path is stubbed — the prompt assembly, the tool schemas, the
 * SDK's step loop, the traversal guards and the files on disk all run — which is
 * what makes this an integration test rather than three unit tests in a trench
 * coat.
 */
describe('runAgentTurn with skills and memory', () => {
  let database: TestDatabase
  let ctx: AppContext
  let agent: Agent
  let chat: Chat

  /** Writes a skill into the context's own library. */
  function writeSkill(folder: string, frontmatter: string, body: string): string {
    const dir = join(skillsDir(ctx), folder)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8')
    invalidateSkillCache(skillsDir(ctx))
    return dir
  }

  /** A model that calls `toolName` with `input` once, then answers. */
  function callThenAnswer(
    toolName: string,
    input: Record<string, unknown>,
    answer = 'Done.'
  ): MockLanguageModelV4 {
    let calls = 0
    return new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'mock-model',
      doStream: async () => {
        calls += 1
        const chunks: StreamPart[] =
          calls === 1
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'call-1',
                  toolName,
                  input: JSON.stringify(input)
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: USAGE
                }
              ]
            : textChunks([answer])
        return { stream: simulateReadableStream({ chunks }) }
      }
    })
  }

  beforeEach(() => {
    database = createTestDatabase()
    ctx = createTestAppContext(database).ctx
    invalidateSkillCache()

    const provider = ctx.repos.providers.create(providerInput(), ctx.userId)
    agent = ctx.repos.agents.create(
      agentInput({ name: 'Ada', providerId: provider.id, modelId: 'deepseek-chat' }),
      ctx.userId
    )
    chat = ctx.repos.chats.create({ title: 'Capabilities' }, ctx.userId)
    ctx.repos.chats.setMembers(ctx.userId, chat.id, [agent.id])
    ctx.repos.messages.create(
      {
        chatId: chat.id,
        senderType: 'user',
        senderId: ctx.userId,
        parts: [{ type: 'text', text: 'Review this design.' }],
        status: 'done',
        round: 0,
        mentions: []
      },
      ctx.userId
    )
  })

  afterEach(() => {
    invalidateSkillCache()
    ctx.close()
  })

  const turn = (model: MockLanguageModelV4) =>
    runAgentTurn({
      ctx,
      chat,
      agent,
      members: [agent],
      round: 1,
      signal: new AbortController().signal,
      model
    })

  /** Gives the agent one skill and returns its folder. */
  function giveSkill(): string {
    const dir = writeSkill(
      'architecture-review',
      'name: architecture-review\ndescription: Review a design before it is built',
      '# Architecture review\n\nStart by restating the design in three sentences.'
    )
    writeFileSync(join(dir, 'checklist.md'), '# Checklist\n\n1. Boundaries\n', 'utf8')
    invalidateSkillCache(skillsDir(ctx))
    agent = ctx.repos.agents.update(agent.id, { skillNames: ['architecture-review'] }, ctx.userId)
    return dir
  }

  describe('skills', () => {
    it('lists the enabled skill in the prompt and answers read_skill with its body', async () => {
      giveSkill()
      const model = callThenAnswer('read_skill', { name: 'architecture-review' })

      const result = await turn(model)

      // Progressive disclosure: the description is in the prompt, the body is not.
      const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt)
      expect(prompt).toContain('Skills available to you:')
      expect(prompt).toContain('architecture-review — Review a design before it is built')
      expect(prompt).not.toContain('restating the design in three sentences')

      // Both tools were offered, and the call came back with the body.
      expect((model.doStreamCalls[0]?.tools ?? []).map((tool) => tool.name)).toEqual([
        'read_skill',
        'read_skill_file'
      ])
      const parts = result.message.parts
      expect(parts[0]).toMatchObject({ type: 'tool-call', toolName: 'read_skill' })
      expect(parts[1]).toMatchObject({ type: 'tool-result', toolCallId: 'call-1' })
      expect(String((parts[1] as { output: unknown }).output)).toContain(
        'restating the design in three sentences'
      )
      expect(parts[2]).toEqual({ type: 'text', text: 'Done.' })
      expect(result.status).toBe('done')
    })

    it('has no server behind the built-in tools, so the card shows the bare name', async () => {
      giveSkill()

      const result = await turn(callThenAnswer('read_skill', { name: 'architecture-review' }))

      expect(result.message.parts[0]).not.toHaveProperty('serverId')
      expect(result.message.parts[0]).not.toHaveProperty('serverName')
    })

    it('reads a bundled file through read_skill_file', async () => {
      giveSkill()

      const result = await turn(
        callThenAnswer('read_skill_file', { name: 'architecture-review', path: 'checklist.md' })
      )

      expect(String((result.message.parts[1] as { output: unknown }).output)).toContain('Boundaries')
    })

    it('refuses a path that climbs out of the skill folder', async () => {
      giveSkill()
      writeFileSync(join(database.dir, 'secret.txt'), 'sk-live-1234', 'utf8')

      const result = await turn(
        callThenAnswer('read_skill_file', {
          name: 'architecture-review',
          path: '../../secret.txt'
        })
      )

      const failed = result.message.parts[1] as { isError?: boolean; output: unknown }
      expect(failed.isError).toBe(true)
      expect(String(failed.output)).not.toContain('sk-live-1234')
    })

    it('attaches nothing and says nothing when the agent has no skills', async () => {
      const model = mockModel(textChunks(['Plain answer.']))

      await turn(model)

      expect(model.doStreamCalls[0]?.tools ?? []).toEqual([])
      expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).not.toContain('Skills available')
    })

    it('skips a skill whose folder is gone rather than failing the turn', async () => {
      agent = ctx.repos.agents.update(agent.id, { skillNames: ['deleted-skill'] }, ctx.userId)
      const model = mockModel(textChunks(['Still answered.']))

      const result = await turn(model)

      expect(result.status).toBe('done')
      expect(model.doStreamCalls[0]?.tools ?? []).toEqual([])
    })
  })

  describe('memory', () => {
    /** Turns memory on for the agent. */
    function enableMemory(): void {
      agent = ctx.repos.agents.update(agent.id, { memoryEnabled: true }, ctx.userId)
    }

    it('writes the note and appends the index line when the model calls memory_save', async () => {
      enableMemory()

      const result = await turn(
        callThenAnswer('memory_save', {
          title: 'Project name',
          content: 'The project is called Witena.'
        })
      )

      expect(result.status).toBe('done')
      const entries = ctx.memory.listEntries(agent.id)
      expect(entries).toHaveLength(1)
      expect(entries[0]?.title).toBe('Project name')

      // The file is really on disk, under the agent's own folder.
      const file = join(database.dir, 'memory', agent.id, entries[0]?.path as string)
      expect(existsSync(file)).toBe(true)
      expect(readFileSync(file, 'utf8')).toContain('The project is called Witena.')

      // …and the index line links to it.
      expect(ctx.memory.readIndex(agent.id)).toContain(`](${entries[0]?.path})`)
    })

    it('carries the index into the next turn and answers memory_search from it', async () => {
      enableMemory()
      ctx.memory.saveNote(agent.id, {
        title: 'Project name',
        content: 'The project is called Witena.'
      })
      const model = callThenAnswer('memory_search', { query: 'project' })

      const result = await turn(model)

      const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt)
      expect(prompt).toContain('MEMORY.md')
      expect(prompt).toContain('Project name')
      expect(String((result.message.parts[1] as { output: unknown }).output)).toContain('Witena')
    })

    it('adds the memory rule to the briefing only while memory is on', async () => {
      const without = mockModel(textChunks(['ok']))
      await turn(without)
      expect(JSON.stringify(without.doStreamCalls[0]?.prompt)).not.toContain('memory_save')

      enableMemory()
      const with_ = mockModel(textChunks(['ok']))
      await turn(with_)
      expect(JSON.stringify(with_.doStreamCalls[0]?.prompt)).toContain('memory_save')
    })

    it('attaches no memory tools and no memory section when memory is off', async () => {
      const model = mockModel(textChunks(['Plain answer.']))

      await turn(model)

      expect(model.doStreamCalls[0]?.tools ?? []).toEqual([])
      const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt)
      expect(prompt).not.toContain('MEMORY.md')
      expect(prompt).not.toContain('memory_search')
    })

    it('offers both built-in families at once', async () => {
      giveSkill()
      enableMemory()
      const model = mockModel(textChunks(['ok']))

      await turn(model)

      expect((model.doStreamCalls[0]?.tools ?? []).map((tool) => tool.name)).toEqual([
        'read_skill',
        'read_skill_file',
        'memory_save',
        'memory_search'
      ])
    })

    it('keeps one agent out of another agent’s memory', async () => {
      enableMemory()
      const other = ctx.repos.agents.create(
        agentInput({ name: 'Bob', providerId: agent.providerId, modelId: 'deepseek-chat' }),
        ctx.userId
      )
      ctx.memory.saveNote(other.id, { title: 'Theirs', content: 'A secret of Bob.' })

      const result = await turn(callThenAnswer('memory_search', { query: 'secret' }))

      expect(String((result.message.parts[1] as { output: unknown }).output)).not.toContain(
        'A secret of Bob'
      )
    })
  })
})

/* -------------------------------------------------------------------------- */
/* S5.4: the executor's own tools and the permission prompt                    */
/* -------------------------------------------------------------------------- */

/**
 * A whole turn of the executor, against a real temporary folder.
 *
 * The point of these cases is the seam the unit suites cannot reach: a model
 * really asks for `write_file`, `collectAgentTools` really decides whether that
 * agent may have it, the gate really suspends the turn inside `streamText`'s
 * tool loop, and `permission.reply` really releases it. The "user" is an event
 * subscriber that answers instantly — which is also why the denial case is
 * worth having, since the turn has to survive being told no.
 */
describe('runAgentTurn with executor tools', () => {
  let database: TestDatabase
  let ctx: AppContext
  let events: BackendEvent[]
  let agent: Agent
  let chat: Chat
  let workdir: string

  /** A model that calls `toolName` with `input` once, then answers. */
  function callThenAnswer(toolName: string, input: Record<string, unknown>): MockLanguageModelV4 {
    let calls = 0
    return new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'mock-model',
      doStream: async () => {
        calls += 1
        const chunks: StreamPart[] =
          calls === 1
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'call-1',
                  toolName,
                  input: JSON.stringify(input)
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: USAGE
                }
              ]
            : textChunks(['Done.'])
        return { stream: simulateReadableStream({ chunks }) }
      }
    })
  }

  beforeEach(() => {
    database = createTestDatabase()
    const created = createTestAppContext(database)
    ctx = created.ctx
    events = created.events

    workdir = mkdtempSync(join(tmpdir(), 'witena-turn-executor-'))
    writeFileSync(join(workdir, 'README.md'), '# Project\n\nHello.\n', 'utf8')

    const provider = ctx.repos.providers.create(providerInput(), ctx.userId)
    agent = ctx.repos.agents.create(
      agentInput({
        name: 'Ada',
        providerId: provider.id,
        modelId: 'deepseek-chat',
        role: 'executor'
      }),
      ctx.userId
    )
    chat = ctx.repos.chats.create({ title: 'Implementation', workdir }, ctx.userId)
    ctx.repos.chats.setMembers(ctx.userId, chat.id, [agent.id])
    ctx.repos.messages.create(
      {
        chatId: chat.id,
        senderType: 'user',
        senderId: ctx.userId,
        parts: [{ type: 'text', text: 'Add a NOTES.md.' }],
        status: 'done',
        round: 0,
        mentions: []
      },
      ctx.userId
    )
    events.length = 0
  })

  afterEach(() => {
    ctx.close()
    rmSync(workdir, { recursive: true, force: true })
  })

  const turn = (model: MockLanguageModelV4, members: Agent[] = [agent]) =>
    runAgentTurn({
      ctx,
      chat,
      agent,
      members,
      round: 1,
      signal: new AbortController().signal,
      model
    })

  /** Answers every prompt with `decision`. Returns the unsubscribe. */
  const answerEveryPrompt = (decision: 'allow' | 'deny' | 'allowAlways'): (() => void) =>
    ctx.events.subscribe((event) => {
      if (event.type === 'permission.requested') {
        ctx.permissions.reply({ requestId: event.requestId, decision })
      }
    })

  const writeCall = (): MockLanguageModelV4 =>
    callThenAnswer('write_file', { path: 'NOTES.md', content: '# Notes\n' })

  it('offers the seven tools and names the folder in the prompt', async () => {
    const stop = answerEveryPrompt('allow')
    const model = writeCall()

    await turn(model)

    expect((model.doStreamCalls[0]?.tools ?? []).map((tool) => tool.name)).toEqual([
      'read_file',
      'list_dir',
      'search_files',
      'write_file',
      'edit_file',
      'run_command',
      'git_diff'
    ])
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain(workdir)
    stop()
  })

  it('asks before writing, and the file appears once the user allows', async () => {
    const stop = answerEveryPrompt('allow')

    const result = await turn(writeCall())

    const prompts = events.filter((event) => event.type === 'permission.requested')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({
      chatId: chat.id,
      agentId: agent.id,
      toolName: 'write_file',
      input: { path: 'NOTES.md', content: '# Notes\n' }
    })
    expect(events.filter((event) => event.type === 'permission.resolved')).toHaveLength(1)

    expect(readFileSync(join(workdir, 'NOTES.md'), 'utf8')).toBe('# Notes\n')
    expect(result.status).toBe('done')
    expect(result.message.parts[0]).toMatchObject({ type: 'tool-call', toolName: 'write_file' })
    const done = result.message.parts[1] as { type: string; isError?: boolean; output: unknown }
    expect(done.type).toBe('tool-result')
    expect(done.isError).toBeUndefined()
    expect(done.output).toMatchObject({ path: 'NOTES.md', created: true })
    expect(String((done.output as { patch: string }).patch)).toContain('+# Notes')
    stop()
  })

  it('writes nothing and stores a tool error when the user denies', async () => {
    const stop = answerEveryPrompt('deny')

    const result = await turn(writeCall())

    expect(existsSync(join(workdir, 'NOTES.md'))).toBe(false)
    const failed = result.message.parts[1] as { type: string; isError?: boolean; output: unknown }
    expect(failed).toMatchObject({ type: 'tool-result', isError: true })
    expect(String(failed.output)).toMatch(/declined/)
    // The turn itself is fine: the model was told no and answered anyway.
    expect(result.status).toBe('done')
    stop()
  })

  it('does not ask a second time after "always allow in this chat"', async () => {
    const stop = answerEveryPrompt('allowAlways')

    await turn(writeCall())
    await turn(callThenAnswer('write_file', { path: 'MORE.md', content: 'more\n' }))

    expect(events.filter((event) => event.type === 'permission.requested')).toHaveLength(1)
    expect(readFileSync(join(workdir, 'MORE.md'), 'utf8')).toBe('more\n')
    stop()
  })

  it('gives a participant in the same chat no executor tools at all', async () => {
    agent = ctx.repos.agents.update(agent.id, { role: 'participant' }, ctx.userId)
    const model = writeCall()

    await turn(model)

    expect(model.doStreamCalls[0]?.tools ?? []).toEqual([])
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).not.toContain(workdir)
  })

  it('gives an executor in a chat without a folder no executor tools', async () => {
    chat = ctx.repos.chats.update(chat.id, { workdir: null }, ctx.userId)
    const model = writeCall()

    await turn(model)

    expect(model.doStreamCalls[0]?.tools ?? []).toEqual([])
  })

  it('arms only the first executor when a chat somehow holds two', async () => {
    // `agents.update` can still promote a participant that is already a member,
    // which S5.2 recorded as a known gap: the tie is broken by `position`.
    const second = ctx.repos.agents.create(
      agentInput({
        name: 'Bob',
        providerId: agent.providerId,
        modelId: 'deepseek-chat',
        role: 'executor'
      }),
      ctx.userId
    )
    ctx.repos.chats.setMembers(ctx.userId, chat.id, [agent.id])
    const members = [agent, second]
    const stop = answerEveryPrompt('allow')

    const first = writeCall()
    await turn(first, members)
    expect((first.doStreamCalls[0]?.tools ?? []).length).toBe(7)

    const model = writeCall()
    await runAgentTurn({
      ctx,
      chat,
      agent: second,
      members,
      round: 1,
      signal: new AbortController().signal,
      model
    })
    expect(model.doStreamCalls[0]?.tools ?? []).toEqual([])
    stop()
  })

  it('does not confirm a read-only tool', async () => {
    const result = await turn(callThenAnswer('read_file', { path: 'README.md' }))

    expect(events.filter((event) => event.type === 'permission.requested')).toEqual([])
    expect(result.message.parts[1]).toMatchObject({
      type: 'tool-result',
      output: { path: 'README.md', content: '# Project\n\nHello.\n' }
    })
  })

  it('refuses a path that leaves the folder without asking the user', async () => {
    const result = await turn(callThenAnswer('read_file', { path: '../../etc/passwd' }))

    expect(events.filter((event) => event.type === 'permission.requested')).toEqual([])
    const failed = result.message.parts[1] as { isError?: boolean; output: unknown }
    expect(failed.isError).toBe(true)
    expect(String(failed.output)).toMatch(/outside the working directory/)
  })
})
