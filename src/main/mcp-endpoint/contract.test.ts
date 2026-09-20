/**
 * The whole endpoint, end to end, with nothing stubbed but the model.
 *
 * `server.test.ts` proves the transport against a stub registry and
 * `tools.test.ts` proves the six tools against a real backend; neither one ever
 * runs the two halves together. This file does: a real `AppContext` over a
 * temporary database, the real `buildHandlers()`, the real `ChatRunner` and
 * `AgentTurn` against a `MockLanguageModelV4`, `createMcpEndpoint({ ctx,
 * handlers, token })` **without** a `tools` option — so the registry is
 * `createTools()`, the seam WP-3 closed — on a real socket, driven by the SDK
 * `Client` over Streamable HTTP. Every assertion below is about what an IDE
 * agent actually receives.
 *
 * That makes it the one place where "Frozen contracts"'s status mapping is a
 * statement about the product rather than about a module:
 *
 * | What happens | What the caller is handed |
 * |---|---|
 * | `run.finished` `completed` with a `ConclusionPart` after the question | `concluded` |
 * | `completed` without one, or `max-rounds` | `ended` + `positions` |
 * | `chat.stop` while a wait is in flight | `stopped` |
 * | the provider throws | `error` |
 * | a `permission.requested` for the chat while waiting | `needs-attention` |
 * | the caller's `maxWaitSeconds` runs out | `running` |
 *
 * Two of those rows need a run that is still going when a second call arrives,
 * and one — the deadline — cannot be faked at all: `MIN_WAIT_SECONDS` is 5, so
 * the caller's smallest legal budget is five real seconds. There is exactly one
 * test that spends them, and it is the only one with a raised timeout.
 *
 * As in `tools.test.ts`, the bus is wrapped in a counting decorator: a watcher
 * left subscribed after a request is over would keep the whole context alive,
 * and `afterEach` is where that is noticed.
 */
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGREED_TOKEN } from '@shared/markers'
import {
  CLIENT_HEADER,
  MCP_PATH,
  MCP_TOOL_NAMES,
  MIN_WAIT_SECONDS,
  type DiscussionResult,
  type McpToolName
} from '@shared/mcp-tools'
import type { Agent, Chat } from '@shared/types'
import type { AppContext } from '../app-context'
import { agentInput, createTestDatabase, providerInput, type TestDatabase } from '../db/testing'
import type { EventBus } from '../events/bus'
import { buildHandlers } from '../handlers'
import { createTestAppContext } from '../testing'
import { createMcpEndpoint, type McpEndpoint } from './server'

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = StreamResult extends { stream: ReadableStream<infer Part> } ? Part : never

/** What the SDK client hands back from `callTool`. */
type ToolResult = Awaited<ReturnType<Client['callTool']>>

const TOKEN = 'contract-token-0123456789'

/** The name the shim would put in `CLIENT_HEADER`. */
const CLIENT = 'claude-code'

const USAGE = {
  inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
} as const

/**
 * A model that answers with one whole message, optionally paced.
 *
 * `delayMs` is what makes a run outlive a tool call: `simulateReadableStream`
 * waits it out before the first chunk and between each of the five, so one turn
 * takes about `5 × delayMs` and two sequential members take twice that.
 */
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

describe('Witena over MCP, end to end', () => {
  const handlers = buildHandlers()

  let database: TestDatabase
  let ctx: AppContext
  let listeners: () => number
  let endpoint: McpEndpoint
  let http: HttpServer
  let client: Client
  let ada: Agent
  let lin: Agent
  let chat: Chat
  /** Swapped per test; the injected `createModel` always hands back this one. */
  let model: MockLanguageModelV4

  beforeEach(async () => {
    database = createTestDatabase()
    model = saying(`Ship it, the migration is safe. ${AGREED_TOKEN}`)
    ctx = createTestAppContext(database, { runner: { createModel: () => model } }).ctx

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

    // No `tools`: the endpoint builds `createTools()` itself, which is the join
    // this whole file exists to exercise.
    endpoint = createMcpEndpoint({ ctx, handlers, token: TOKEN })
    http = createServer((req, res) => {
      void endpoint.handle(req, res)
    })
    await new Promise<void>((settle) => http.listen(0, '127.0.0.1', settle))

    client = new Client({ name: CLIENT, version: '0.0.0-test' })
    const transport = new StreamableHTTPClientTransport(new URL(`${origin()}${MCP_PATH}`), {
      requestInit: {
        headers: { authorization: `Bearer ${TOKEN}`, [CLIENT_HEADER]: CLIENT }
      }
    })
    // The same cast `server.test.ts` and `src/main/mcp/manager.ts` document:
    // `sessionId` is `string | undefined` where `Transport` declares
    // `sessionId?: string`, which differ under `exactOptionalPropertyTypes`.
    await client.connect(transport as unknown as Transport)
  })

  afterEach(async () => {
    await client.close()
    await endpoint.close()
    await new Promise<void>((settle) => {
      http.close(() => settle())
      http.closeAllConnections()
    })

    // A test may leave a run in flight on purpose; nothing is asserted after
    // this point except that the endpoint let go of the bus.
    ctx.runners.stopAll()
    for (const open of await handlers['chats.list'](ctx)) {
      await ctx.runners.for(open.id).whenIdle()
    }
    expect(listeners()).toBe(0)
    ctx.close()
  })

  function origin(): string {
    return `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  }

  /** One `tools/call`, as the SDK client makes it. */
  function callRaw(name: McpToolName, args: Record<string, unknown>): Promise<ToolResult> {
    return client.callTool({ name, arguments: args })
  }

  /** The text block of a result, which is what a model reads first. */
  function rendered(result: ToolResult): string {
    const content = result.content as unknown as { type: string; text?: string }[]
    return content.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('\n')
  }

  /** A call that is expected to succeed, as its `structuredContent`. */
  async function call<T>(name: McpToolName, args: Record<string, unknown> = {}): Promise<T> {
    const result = await callRaw(name, args)
    if (result.isError === true) throw new Error(`${name} answered: ${rendered(result)}`)
    return result.structuredContent as T
  }

  /** Seeds a run that is still going when the next call arrives. */
  async function startSlowRun(): Promise<void> {
    model = saying('Still typing, give me a moment.', 200)
    await handlers['chat.send'](ctx, { chatId: chat.id, text: 'Go.' })
    expect(ctx.runners.getState(chat.id)).not.toBeNull()
  }

  /* ---------------------------------------------------------------------- */
  /* The round trip                                                          */
  /* ---------------------------------------------------------------------- */

  it('takes a question from two agent names to the group’s conclusion', async () => {
    const listed = await client.listTools()
    expect(listed.tools.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES])

    const agents = await call<{ agents: { name: string; invitable: boolean }[]; hint: string }>(
      'list_agents'
    )
    expect(agents.agents.map((agent) => agent.name).sort()).toEqual(['Ada', 'Lin'])
    expect(agents.agents.every((agent) => agent.invitable)).toBe(true)

    const started = await callRaw('start_discussion', {
      question: 'Is this migration safe?\nThe second line is not the title.',
      context: 'diff --git a/migrations/003.sql b/migrations/003.sql',
      agents: ['Ada', 'lin']
    })
    const result = started.structuredContent as unknown as DiscussionResult
    expect(started.isError).toBeUndefined()
    expect(result.status).toBe('concluded')
    expect(result.conclusion?.agentName).toBe('Ada')
    expect(result.conclusion?.markdown).toContain('Ship it, the migration is safe.')
    // The closure marker is how the group talks to the runner; the caller never
    // sees it, on either half of the result.
    expect(result.conclusion?.markdown).not.toContain(AGREED_TOKEN)
    expect(result.url).toBe(`witena://chat/${result.chatId}`)
    expect(result.chatId).not.toBe(chat.id)
    expect(result.usage?.totalTokens).toBeGreaterThan(0)
    expect(result.hint).toMatch(/apply the conclusion/i)
    expect(rendered(started)).toContain('Conclusion by Ada')
    expect(rendered(started).endsWith(result.hint)).toBe(true)
    expect(rendered(started)).not.toContain(AGREED_TOKEN)

    const chats = await call<{ chats: { id: string; title: string; memberNames: string[] }[] }>(
      'list_chats',
      { query: 'migration' }
    )
    const created = chats.chats.find((entry) => entry.id === result.chatId)
    expect(created?.title).toBe('Is this migration safe?')
    expect(created?.memberNames).toEqual(['Ada', 'Lin'])

    const transcript = await call<{ markdown: string; messageCount: number }>('get_discussion', {
      chatId: result.chatId,
      detail: 'transcript'
    })
    expect(transcript.markdown).toContain('**Ada**')
    expect(transcript.markdown).toContain('**Lin**')
    // The question and the context arrived as one message, and the caller can
    // read back what it sent.
    expect(transcript.markdown).toContain('diff --git a/migrations/003.sql')
    expect(transcript.messageCount).toBeGreaterThan(2)
  })

  it('refuses a group it cannot resolve as isError, in words the caller can act on', async () => {
    const result = await callRaw('start_discussion', { question: 'Well?', agents: ['Adaa'] })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    // `<code>: <message>`, with the message WP-3 wrote for exactly this reader.
    expect(rendered(result)).toMatch(/^validation: /)
    expect(rendered(result)).toContain('Ada, Lin')
    expect(await handlers['chats.list'](ctx)).toHaveLength(1)
  })

  /* ---------------------------------------------------------------------- */
  /* The status mapping, row by row                                          */
  /* ---------------------------------------------------------------------- */

  describe('the status mapping', () => {
    it('completed with a conclusion after the question → concluded', async () => {
      const result = await call<DiscussionResult>('start_discussion', {
        question: 'Is it safe?',
        chatId: chat.id
      })
      expect(result.status).toBe('concluded')
      expect(result.conclusion?.markdown).toContain('Ship it')
      expect(result.positions).toBeUndefined()
      expect(result.round).toBeGreaterThanOrEqual(1)
    })

    it('the rounds running out without agreement → ended, with every position', async () => {
      model = saying('I am not convinced, and here is why.')

      const result = await call<DiscussionResult>('start_discussion', {
        question: 'What do you think?',
        chatId: chat.id,
        rounds: 1
      })

      expect(result.status).toBe('ended')
      expect(result.conclusion).toBeUndefined()
      expect(result.positions?.map((position) => position.agentName)).toEqual(['Ada', 'Lin'])
      expect(result.positions?.every((position) => position.truncated)).toBe(false)
      expect(result.hint).toMatch(/positions/i)
    })

    it('a run stopped while a wait is in flight → stopped', async () => {
      await startSlowRun()

      // The runner is live, so this attaches a watcher rather than reading the
      // transcript — which is the only way a caller ever sees `stopped`.
      const waiting = call<DiscussionResult>('wait_for_discussion', { chatId: chat.id })
      await expect.poll(() => listeners()).toBeGreaterThan(0)

      const stopped = await call<{ wasRunning: boolean; chatId: string; hint: string }>(
        'stop_discussion',
        { chatId: chat.id }
      )
      expect(stopped).toMatchObject({ chatId: chat.id, wasRunning: true })

      const result = await waiting
      expect(result.status).toBe('stopped')
      expect(result.hint).toMatch(/stopped/i)
    })

    it('a provider that throws → error, with what the transcript recorded', async () => {
      model = failing()

      const result = await call<DiscussionResult>('start_discussion', {
        question: 'Will this work?',
        chatId: chat.id
      })

      expect(result.status).toBe('error')
      expect(result.error).toBeTruthy()
      expect(result.hint).toMatch(/failed/i)
    })

    it('a permission prompt while waiting → needs-attention, and the run goes on', async () => {
      await startSlowRun()

      const waiting = call<DiscussionResult>('wait_for_discussion', { chatId: chat.id })
      await expect.poll(() => listeners()).toBeGreaterThan(0)
      ctx.events.emit({
        type: 'permission.requested',
        requestId: 'request-1',
        chatId: chat.id,
        agentId: ada.id,
        toolName: 'write_file',
        input: { path: 'README.md' }
      })

      const result = await waiting
      expect(result.status).toBe('needs-attention')
      expect(result.hint).toContain(`witena://chat/${chat.id}`)
      // Only the *wait* ended: nobody stopped the discussion.
      expect(ctx.runners.getState(chat.id)).not.toBeNull()
    })

    it(
      'the caller’s budget running out → running, and the next wait gets the answer',
      async () => {
        // Five chunks at 700 ms is about 3.5 s per turn, so two sequential
        // members cannot both have spoken inside `MIN_WAIT_SECONDS`.
        model = saying(`Ship it. ${AGREED_TOKEN}`, 700)

        const started = await call<DiscussionResult>('start_discussion', {
          question: 'Take your time.',
          chatId: chat.id,
          maxWaitSeconds: MIN_WAIT_SECONDS
        })
        expect(started.status).toBe('running')
        expect(started.chatId).toBe(chat.id)
        expect(started.hint).toMatch(/wait_for_discussion/)

        // The pacing has done its job. `createModel` is asked again for every
        // turn, so dropping it here lets the rest of the discussion run at full
        // speed — and says the thing the row is about: the budget was the
        // caller's, and the run never knew about it.
        model = saying(`Ship it. ${AGREED_TOKEN}`)

        const final = await call<DiscussionResult>('wait_for_discussion', { chatId: chat.id })
        expect(final.status).toBe('concluded')
        expect(final.conclusion?.markdown).toBe('Ship it.')
      },
      60_000
    )
  })

  /* ---------------------------------------------------------------------- */
  /* Resources and the prompt (WP-15)                                        */
  /* ---------------------------------------------------------------------- */

  describe('the parts of MCP beyond tools', () => {
    /** The text of a `resources/read`, which is the only content kind we send. */
    function bodyOf(read: Awaited<ReturnType<Client['readResource']>>): string {
      const content = read.contents[0]
      return content !== undefined && 'text' in content ? content.text : ''
    }

    it('advertises the three capabilities it serves, and promises no notifications', () => {
      const capabilities = client.getServerCapabilities()
      expect(capabilities?.tools).toEqual({})
      expect(capabilities?.resources).toEqual({})
      expect(capabilities?.prompts).toEqual({})
      // Stateless: a request-scoped `Server` has nobody to notify a moment
      // later, so neither `subscribe` nor `listChanged` is offered.
      expect(capabilities?.resources?.subscribe).toBeUndefined()
      expect(capabilities?.resources?.listChanged).toBeUndefined()
    })

    it('lists the recent chats as witena://chat/<id>, newest first', async () => {
      await handlers['chats.create'](ctx, {
        input: { title: 'Another group', memberAgentIds: [ada.id] }
      })

      const listed = await client.listResources()
      // The order is `chats.list`'s, which is `updatedAt` descending — the
      // discussion the user had ten minutes ago is the one they are about to
      // mention. Asserted against the handler rather than against two hard-coded
      // ids, so it states the rule instead of one instance of it.
      expect(listed.resources.map((resource) => resource.uri)).toEqual(
        (await handlers['chats.list'](ctx)).map((entry) => `witena://chat/${entry.id}`)
      )
      expect(listed.resources.map((resource) => resource.name).sort()).toEqual([
        'Another group',
        'Migration'
      ])
      expect(listed.resources.every((resource) => resource.mimeType === 'text/markdown')).toBe(true)
      // Nothing was started by looking: the list is a read.
      expect(ctx.runners.getState(chat.id)).toBeNull()
    })

    it('offers at most twenty of them, because the list is a mention menu', async () => {
      for (let index = 0; index < 25; index += 1) {
        await handlers['chats.create'](ctx, {
          input: { title: `Chat ${index}`, memberAgentIds: [ada.id] }
        })
      }
      expect(await handlers['chats.list'](ctx)).toHaveLength(26)

      const listed = await client.listResources()
      expect(listed.resources).toHaveLength(20)
      // Every one of them is a link the reader can hand straight back to
      // `resources/read`; there is no `nextCursor`, because a caller that wants
      // the older ones wants `list_chats` and its query.
      expect(listed.resources.every((resource) => resource.uri.startsWith('witena://chat/'))).toBe(
        true
      )
      expect(listed.nextCursor).toBeUndefined()
    })

    it('reads a chat as the same markdown get_discussion renders', async () => {
      const result = await call<DiscussionResult>('start_discussion', {
        question: 'Is this migration safe?',
        chatId: chat.id
      })
      expect(result.status).toBe('concluded')

      const read = await client.readResource({ uri: `witena://chat/${chat.id}` })
      const body = bodyOf(read)
      expect(read.contents[0]?.uri).toBe(`witena://chat/${chat.id}`)
      expect(read.contents[0]?.mimeType).toBe('text/markdown')
      expect(body).toContain('# Migration')
      expect(body).toContain('**Ada**')
      expect(body).toContain('**Lin**')
      expect(body).not.toContain(AGREED_TOKEN)

      // The `@`-mention body and the tool result are one document, not two
      // renderings that have to be kept in step.
      const transcript = await call<{ markdown: string }>('get_discussion', {
        chatId: chat.id,
        detail: 'transcript'
      })
      expect(body).toBe(transcript.markdown)
    })

    it('reads a chat nobody has spoken in as its heading alone', async () => {
      // Not an error and not an empty body: the chat exists, and what it has to
      // say is its name. An `@`-mention of it is a legal thing to do.
      expect(bodyOf(await client.readResource({ uri: `witena://chat/${chat.id}` })).trim()).toBe(
        '# Migration'
      )
    })

    it('distinguishes a uri that is not ours from a chat that is not there', async () => {
      // Strict parsing first: this never reached the database.
      await expect(client.readResource({ uri: 'https://example.test/chat/1' })).rejects.toThrow(
        /not a Witena chat resource/
      )
      await expect(
        client.readResource({ uri: 'witena://chat/not-a-uuid' })
      ).rejects.toThrow(/not a Witena chat resource/)

      // And a well-formed link whose chat is gone is `not_found`, raised by
      // `chats.get` and turned into the resource error a model can act on.
      await expect(
        client.readResource({ uri: 'witena://chat/3f2504e0-4f89-41d3-9a0c-0305e82c3301' })
      ).rejects.toThrow(/no Witena chat at/)
    })

    it('offers the consult prompt, expanded with the question the user typed', async () => {
      const listed = await client.listPrompts()
      expect(listed.prompts.map((prompt) => prompt.name)).toEqual(['consult'])
      expect(listed.prompts[0]?.arguments?.map((argument) => argument.name)).toEqual([
        'question',
        'chat',
        'agents'
      ])

      const got = await client.getPrompt({
        name: 'consult',
        arguments: { question: 'Is this migration safe?', agents: 'Ada, Lin' }
      })
      const content = got.messages[0]?.content
      const text = content?.type === 'text' ? content.text : ''
      expect(text).toContain('Is this migration safe?')
      expect(text).toContain('`agents: ["Ada","Lin"]`')
      expect(text).toContain('wait_for_discussion')

      // WP-0b: Codex never asks for this, so nothing may depend on it — the
      // prompt starts no discussion and touches no chat.
      expect(await handlers['chats.list'](ctx)).toHaveLength(1)
    })

    it('refuses a prompt request the tools would refuse, before anything runs', async () => {
      await expect(client.getPrompt({ name: 'consult' })).rejects.toThrow(/question/)
      await expect(client.getPrompt({ name: 'summon' })).rejects.toThrow(/Unknown prompt/)
      expect(await handlers['chats.list'](ctx)).toHaveLength(1)
    })
  })

  /* ---------------------------------------------------------------------- */
  /* The door is the same door                                               */
  /* ---------------------------------------------------------------------- */

  it('refuses a caller without the token, and one that smells like a browser', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    }

    const noToken = await fetch(`${origin()}${MCP_PATH}`, { method: 'POST', headers, body })
    expect(noToken.status).toBe(401)

    const withOrigin = await fetch(`${origin()}${MCP_PATH}`, {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${TOKEN}`, origin: 'https://evil.test' },
      body
    })
    expect(withOrigin.status).toBe(403)

    // And the tools behind the door are untouched by either.
    expect(await handlers['chats.list'](ctx)).toHaveLength(1)
  })
})
