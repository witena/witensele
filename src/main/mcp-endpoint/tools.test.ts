/**
 * The six tools, against the real backend.
 *
 * Nothing is stubbed except the model: a real `AppContext` over a temporary
 * database, the real `buildHandlers()`, the real `ChatRunner` and a
 * `MockLanguageModelV4`, exactly as `discussion.test.ts` and
 * `src/server/http.test.ts` do it. A tool's job is to turn one MCP call into the
 * right sequence of handler calls, so a suite over fake handlers would assert
 * only that this file calls the functions this file calls.
 *
 * Two invariants ride along in every case, in `afterEach`: the event bus ends
 * with as many listeners as it started with — a tool that returned without
 * releasing its watcher would keep the whole context alive — and no tool ever
 * throws, which is the contract `server.ts` is written against.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGREED_TOKEN } from '@shared/markers'
import {
  MAX_DISCUSSION_INPUT_CHARS,
  MAX_POSITION_CHARS,
  MCP_TOOL_NAMES,
  type DiscussionResult
} from '@shared/mcp-tools'
import type { Agent, Chat } from '@shared/types'
import type { AppContext } from '../app-context'
import { agentInput, createTestDatabase, providerInput, type TestDatabase } from '../db/testing'
import type { EventBus } from '../events/bus'
import { buildHandlers } from '../handlers'
import { createTestAppContext } from '../testing'
import type { ToolCallContext, ToolOutcome, ToolRegistry } from './tool-types'
import { createTools } from './tools'

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

/** The `structured` of a successful outcome, or a failed assertion. */
function structured<T>(outcome: ToolOutcome): T {
  if (!outcome.ok) throw new Error(`expected a successful outcome, got ${outcome.code}: ${outcome.message}`)
  return outcome.structured as T
}

describe('the MCP discussion tools', () => {
  const handlers = buildHandlers()

  let database: TestDatabase
  let ctx: AppContext
  let tools: ToolRegistry
  let listeners: () => number
  let ada: Agent
  let lin: Agent
  let chat: Chat
  /** Swapped per test; the injected `createModel` always hands back this one. */
  let model: MockLanguageModelV4

  beforeEach(async () => {
    database = createTestDatabase()
    model = saying(`Ship it. ${AGREED_TOKEN}`)
    ctx = createTestAppContext(database, { runner: { createModel: () => model } }).ctx

    const wrapped = counting(ctx.events)
    ctx.events = wrapped.bus
    listeners = wrapped.listeners

    tools = createTools()

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

  afterEach(async () => {
    ctx.runners.stopAll()
    await ctx.runners.for(chat.id).whenIdle()
    expect(listeners()).toBe(0)
    ctx.close()
  })

  /** The context one `tools/call` would arrive with. */
  function call(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
    return {
      ctx,
      handlers,
      signal: new AbortController().signal,
      ...overrides
    }
  }

  describe('list_chats', () => {
    it('lists the chats with their members, and says what to do with them', async () => {
      const outcome = await tools.list_chats({}, call())
      const listed = structured<{ chats: { id: string; memberNames: string[] }[]; hint: string }>(
        outcome
      )

      expect(listed.chats).toHaveLength(1)
      expect(listed.chats[0]).toMatchObject({
        id: chat.id,
        title: 'Migration',
        url: `witena://chat/${chat.id}`,
        memberNames: ['Ada', 'Lin'],
        goalKind: null,
        running: false
      })
      expect(outcome.ok && outcome.text).toContain('Migration')
      expect(outcome.ok && outcome.text.endsWith(listed.hint)).toBe(true)
    })

    it('filters case-insensitively over titles and member names', async () => {
      await handlers['chats.create'](ctx, { input: { title: 'Elsewhere', memberAgentIds: [] } })

      const byTitle = structured<{ chats: { title: string }[] }>(
        await tools.list_chats({ query: 'MIGRA' }, call())
      )
      expect(byTitle.chats.map((entry) => entry.title)).toEqual(['Migration'])

      const byMember = structured<{ chats: { title: string }[] }>(
        await tools.list_chats({ query: 'lin' }, call())
      )
      expect(byMember.chats.map((entry) => entry.title)).toEqual(['Migration'])

      const noMatch = structured<{ chats: unknown[]; hint: string }>(
        await tools.list_chats({ query: 'nothing here' }, call())
      )
      expect(noMatch.chats).toEqual([])
      expect(noMatch.hint).toMatch(/list_agents/)
    })
  })

  describe('list_agents', () => {
    it('lists every agent and flags the executor as not invitable', async () => {
      const provider = ctx.repos.providers.list(ctx.userId)[0] as { id: string }
      ctx.repos.agents.create(
        agentInput({ name: 'Rex', role: 'executor', providerId: provider.id }),
        ctx.userId
      )

      const outcome = await tools.list_agents({}, call())
      const listed = structured<{
        agents: { name: string; model: string; invitable: boolean }[]
        hint: string
      }>(outcome)

      expect(listed.agents.map((agent) => agent.name).sort()).toEqual(['Ada', 'Lin', 'Rex'])
      expect(listed.agents.find((agent) => agent.name === 'Ada')).toMatchObject({
        invitable: true,
        model: 'DeepSeek · deepseek-chat'
      })
      expect(listed.agents.find((agent) => agent.name === 'Rex')?.invitable).toBe(false)
      expect(outcome.ok && outcome.text).toContain('executor, cannot be invited')
    })
  })

  describe('start_discussion', () => {
    it('creates a chat from agent names and returns the group’s conclusion', async () => {
      const outcome = await tools.start_discussion(
        { question: 'Is this migration safe?\nSecond line.', agents: ['ada', 'LIN'] },
        call()
      )
      const result = structured<DiscussionResult>(outcome)

      expect(result.status).toBe('concluded')
      expect(result.conclusion?.agentName).toBe('Ada')
      expect(result.conclusion?.markdown).toBe('Ship it.')
      expect(result.url).toBe(`witena://chat/${result.chatId}`)

      const created = await handlers['chats.get'](ctx, { id: result.chatId })
      // The default title is the question's first line, and nothing after it.
      expect(created.title).toBe('Is this migration safe?')
      const members = await handlers['chats.members.list'](ctx, { chatId: result.chatId })
      expect(members.map((member) => member.agentId)).toEqual([ada.id, lin.id])

      expect(outcome.ok && outcome.text).toContain('Conclusion by Ada')
      expect(outcome.ok && outcome.text.endsWith(result.hint)).toBe(true)
    })

    it('puts the context under the question, separated by a blank line', async () => {
      const result = structured<DiscussionResult>(
        await tools.start_discussion(
          { question: 'Safe?', context: 'diff --git a/x b/x', agents: [ada.id] },
          call()
        )
      )

      const sent = await handlers['messages.list'](ctx, { chatId: result.chatId, limit: 50 })
      const question = sent.find((message) => message.senderType === 'user')
      expect(question?.parts[0]).toMatchObject({ text: 'Safe?\n\ndiff --git a/x b/x' })
    })

    it('continues an existing chat and reports the positions when nobody agrees', async () => {
      model = saying(`${'a'.repeat(MAX_POSITION_CHARS + 50)} tail`)

      const result = structured<DiscussionResult>(
        await tools.start_discussion(
          { question: 'What do you think?', chatId: chat.id, rounds: 1 },
          call()
        )
      )

      expect(result.status).toBe('ended')
      expect(result.chatId).toBe(chat.id)
      expect(result.positions?.map((position) => position.agentName)).toEqual(['Ada', 'Lin'])
      for (const position of result.positions ?? []) {
        expect(position.truncated).toBe(true)
        expect(position.markdown).toHaveLength(MAX_POSITION_CHARS)
      }
    })

    it('resolves an agent by id as well as by name', async () => {
      const result = structured<DiscussionResult>(
        await tools.start_discussion({ question: 'Well?', agents: [ada.id, 'Lin'] }, call())
      )
      const members = await handlers['chats.members.list'](ctx, { chatId: result.chatId })
      expect(members.map((member) => member.agentId)).toEqual([ada.id, lin.id])
    })

    it('refuses an unknown agent and lists the ones there are', async () => {
      const outcome = await tools.start_discussion(
        { question: 'Well?', agents: ['Adaa'] },
        call()
      )
      expect(outcome).toMatchObject({ ok: false, code: 'validation' })
      expect(!outcome.ok && outcome.message).toContain('Adaa')
      expect(!outcome.ok && outcome.message).toContain('Ada, Lin')
    })

    it('refuses an ambiguous name and names the candidates with their ids', async () => {
      const provider = ctx.repos.providers.list(ctx.userId)[0] as { id: string }
      const twin = ctx.repos.agents.create(
        agentInput({ name: 'ada', providerId: provider.id }),
        ctx.userId
      )

      const outcome = await tools.start_discussion({ question: 'Well?', agents: ['Ada'] }, call())
      expect(outcome).toMatchObject({ ok: false, code: 'validation' })
      expect(!outcome.ok && outcome.message).toContain(ada.id)
      expect(!outcome.ok && outcome.message).toContain(twin.id)
      expect(!outcome.ok && outcome.message).toMatch(/Pass the id/)
    })

    it('refuses an executor, because the caller is the executor', async () => {
      const provider = ctx.repos.providers.list(ctx.userId)[0] as { id: string }
      ctx.repos.agents.create(
        agentInput({ name: 'Rex', role: 'executor', providerId: provider.id }),
        ctx.userId
      )

      const outcome = await tools.start_discussion({ question: 'Well?', agents: ['Rex'] }, call())
      expect(outcome).toMatchObject({ ok: false, code: 'validation' })
      expect(!outcome.ok && outcome.message).toMatch(/you are the executor/i)
    })

    it('refuses a chat that is already talking, with busy', async () => {
      model = saying('Still typing.', 50)
      const controller = new AbortController()
      // Aborted before the watch is made, so the first call returns as soon as
      // the message is away and the run keeps going in the chat.
      controller.abort()
      const first = await tools.start_discussion(
        { question: 'Go.', chatId: chat.id },
        call({ signal: controller.signal })
      )
      expect(structured<DiscussionResult>(first).status).toBe('running')
      expect(ctx.runners.getState(chat.id)).not.toBeNull()

      const second = await tools.start_discussion({ question: 'Again.', chatId: chat.id }, call())
      expect(second).toMatchObject({ ok: false, code: 'busy' })
      expect(!second.ok && second.message).toContain(chat.id)
    })

    it('refuses more than MAX_DISCUSSION_INPUT_CHARS of question and context', async () => {
      const outcome = await tools.start_discussion(
        {
          question: 'Review this.',
          context: 'x'.repeat(MAX_DISCUSSION_INPUT_CHARS),
          agents: [ada.id]
        },
        call()
      )
      expect(outcome).toMatchObject({ ok: false, code: 'validation' })
      expect(!outcome.ok && outcome.message).toContain(String(MAX_DISCUSSION_INPUT_CHARS))
    })

    it('refuses a relative workdir and one that is not there', async () => {
      const relative = await tools.start_discussion(
        { question: 'Well?', agents: [ada.id], workdir: 'relative/path' },
        call()
      )
      expect(relative).toMatchObject({ ok: false, code: 'validation' })

      const missing = await tools.start_discussion(
        { question: 'Well?', agents: [ada.id], workdir: '/definitely/not/here' },
        call()
      )
      expect(missing).toMatchObject({ ok: false, code: 'validation' })
      expect(!missing.ok && missing.message).toContain('/definitely/not/here')

      // And no chat was created by either refusal.
      expect(await handlers['chats.list'](ctx)).toHaveLength(1)
    })

    it('accepts a workdir that exists', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'witena-workdir-'))
      try {
        const result = structured<DiscussionResult>(
          await tools.start_discussion(
            { question: 'Well?', agents: [ada.id], workdir: dir },
            call()
          )
        )
        expect((await handlers['chats.get'](ctx, { id: result.chatId })).workdir).toBe(dir)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('releases the watcher when the send itself fails', async () => {
      // A chat with no members refuses `chat.send`, which is the one failure that
      // happens *after* the watcher has been attached.
      const empty = await handlers['chats.create'](ctx, {
        input: { title: 'Nobody', memberAgentIds: [] }
      })

      const outcome = await tools.start_discussion(
        { question: 'Anyone?', chatId: empty.id },
        call()
      )
      expect(outcome).toMatchObject({ ok: false, code: 'validation' })
      // The assertion that `cancel()` ran: `afterEach` would fail on a leak, and
      // this says so at the moment it matters.
      expect(listeners()).toBe(0)
    })

    it('passes zod’s own words through when the two ways of naming a group are mixed', async () => {
      const both = await tools.start_discussion(
        { question: 'Well?', chatId: chat.id, agents: [ada.id] },
        call()
      )
      expect(both).toMatchObject({ ok: false, code: 'validation' })
      expect(!both.ok && both.message).toMatch(/exactly one of/i)

      const neither = await tools.start_discussion({ question: 'Well?' }, call())
      expect(neither).toMatchObject({ ok: false, code: 'validation' })

      const titled = await tools.start_discussion(
        { question: 'Well?', chatId: chat.id, title: 'No' },
        call()
      )
      expect(titled).toMatchObject({ ok: false, code: 'validation' })
      expect(!titled.ok && titled.message).toContain('`title`')
    })

    it('reports progress when the caller asked for it', async () => {
      const updates: { message: string; round?: number }[] = []
      await tools.start_discussion(
        { question: 'Is it safe?', chatId: chat.id },
        call({ progress: (update) => updates.push(update) })
      )
      expect(updates.some((update) => update.message.startsWith('Round 1'))).toBe(true)
      expect(updates.some((update) => update.message === 'Ada has spoken')).toBe(true)
    })
  })

  describe('wait_for_discussion', () => {
    it('answers immediately from an idle chat that concluded', async () => {
      await tools.start_discussion({ question: 'Is it safe?', chatId: chat.id }, call())

      const result = structured<DiscussionResult>(
        await tools.wait_for_discussion({ chatId: chat.id }, call())
      )
      expect(result.status).toBe('concluded')
      expect(result.conclusion?.markdown).toBe('Ship it.')
    })

    it('answers ended for an idle chat that never concluded', async () => {
      model = saying('No agreement here.')
      await tools.start_discussion({ question: 'Is it safe?', chatId: chat.id, rounds: 1 }, call())

      const result = structured<DiscussionResult>(
        await tools.wait_for_discussion({ chatId: chat.id }, call())
      )
      expect(result.status).toBe('ended')
      expect(result.positions).toHaveLength(2)
      // The window is the last question onwards, so the answer is about the
      // exchange that just happened and not about the whole chat.
      expect(result.positions?.[0]?.markdown).toBe('No agreement here.')
    })

    it('waits for a run that is still going, and gives up at the deadline', async () => {
      model = saying('Thinking.', 50)
      const controller = new AbortController()
      controller.abort()
      await tools.start_discussion(
        { question: 'Go.', chatId: chat.id },
        call({ signal: controller.signal })
      )

      const waiting = new AbortController()
      const pending = tools.wait_for_discussion({ chatId: chat.id }, call({ signal: waiting.signal }))
      waiting.abort()
      expect(structured<DiscussionResult>(await pending).status).toBe('running')
    })

    it('refuses a chat that does not exist', async () => {
      const outcome = await tools.wait_for_discussion({ chatId: 'invented' }, call())
      expect(outcome).toMatchObject({ ok: false, code: 'not_found' })
    })
  })

  describe('get_discussion', () => {
    it('reads the conclusion without waiting', async () => {
      await tools.start_discussion({ question: 'Is it safe?', chatId: chat.id }, call())

      const result = structured<DiscussionResult>(
        await tools.get_discussion({ chatId: chat.id, detail: 'conclusion' }, call())
      )
      expect(result.status).toBe('concluded')
      expect(result.conclusion?.markdown).toBe('Ship it.')
    })

    it('renders the transcript as markdown, and can start after a message', async () => {
      await tools.start_discussion({ question: 'Is it safe?', chatId: chat.id }, call())

      const whole = structured<{ markdown: string; messageCount: number; lastMessageId: string }>(
        await tools.get_discussion({ chatId: chat.id, detail: 'transcript' }, call())
      )
      expect(whole.markdown).toContain('# Migration')
      expect(whole.markdown).toContain('**User**')
      expect(whole.markdown).toContain('**Ada** (round 1)')
      expect(whole.markdown).toContain('**Lin** (round 1)')
      expect(whole.markdown).toContain('conclusion')
      // The closure marker is protocol; the caller never sees it.
      expect(whole.markdown).not.toContain(AGREED_TOKEN)

      const tail = structured<{ messageCount: number }>(
        await tools.get_discussion(
          { chatId: chat.id, detail: 'transcript', afterMessageId: whole.lastMessageId },
          call()
        )
      )
      expect(tail.messageCount).toBe(0)
    })

    it('refuses an afterMessageId that belongs to no message of the chat', async () => {
      const outcome = await tools.get_discussion(
        { chatId: chat.id, detail: 'transcript', afterMessageId: 'not-a-message' },
        call()
      )
      expect(outcome).toMatchObject({ ok: false, code: 'validation' })
      expect(!outcome.ok && outcome.message).toContain('not-a-message')
    })

    it('surfaces a BackendFailure with its own code', async () => {
      const outcome = await tools.get_discussion(
        { chatId: 'invented', detail: 'conclusion' },
        call()
      )
      expect(outcome).toMatchObject({ ok: false, code: 'not_found' })
    })
  })

  describe('stop_discussion', () => {
    it('cancels a run that is going', async () => {
      model = saying('Still typing.', 50)
      const controller = new AbortController()
      controller.abort()
      await tools.start_discussion(
        { question: 'Go.', chatId: chat.id },
        call({ signal: controller.signal })
      )

      const outcome = await tools.stop_discussion({ chatId: chat.id }, call())
      expect(structured<{ wasRunning: boolean }>(outcome).wasRunning).toBe(true)
      await ctx.runners.for(chat.id).whenIdle()
      expect(ctx.runners.getState(chat.id)).toBeNull()
    })

    it('is not an error on an idle chat, and says so', async () => {
      const outcome = await tools.stop_discussion({ chatId: chat.id }, call())
      const stopped = structured<{ wasRunning: boolean; hint: string }>(outcome)
      expect(stopped.wasRunning).toBe(false)
      expect(stopped.hint).toMatch(/not running/i)
    })

    it('refuses a chat that does not exist', async () => {
      expect(await tools.stop_discussion({ chatId: 'invented' }, call())).toMatchObject({
        ok: false,
        code: 'not_found'
      })
    })
  })

  it('answers every tool name in the contract, and refuses garbage instead of throwing', async () => {
    expect(Object.keys(createTools()).sort()).toEqual([...MCP_TOOL_NAMES].sort())
    for (const name of MCP_TOOL_NAMES) {
      const outcome = await tools[name](
        { chatId: 42, detail: 'nonsense', question: 7, agents: 'no' },
        call()
      )
      // `list_chats` and `list_agents` take nothing that this object can break,
      // so they succeed; the four that need arguments refuse with `validation`.
      if (!outcome.ok) expect(outcome.code).toBe('validation')
    }
  })
})
