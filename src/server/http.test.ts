/**
 * The contract test: a real server on a real ephemeral port, driven the way
 * `HttpBackendClient` (S8.3) will drive it.
 *
 * Nothing here is stubbed except the model. The server opens a temporary SQLite
 * file, builds the whole `AppContext`, mounts `buildHandlers()` and runs a chat
 * through the real `ChatRunner` and the real `AgentTurn` against a
 * `MockLanguageModelV4` — the same injection `agent-turn.test.ts` and
 * `chat-runner.test.ts` use — so the assertion "the frames arrive over the
 * WebSocket" is about the transport and the orchestration together, which is the
 * only way it means anything.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendEvent } from '@shared/events'
import type { Chat, Message, Provider } from '@shared/types'
import { buildHandlers } from '../main/handlers'
import { PICK_FOLDER_UNAVAILABLE } from '../main/handlers/system'
import type { InvokeResponse } from '../main/ipc-protocol'
import { agentInput, providerInput } from '../main/db/testing'
import type { ServerConfig } from './config'
import { DEFAULT_HOST } from './config'
import { createServerContext } from './context'
import { createWitenaServer, HEALTH_PATH, type WitenaServer } from './http'

/* -------------------------------------------------------------------------- */
/* Mock model                                                                  */
/* -------------------------------------------------------------------------- */

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = StreamResult extends { stream: ReadableStream<infer Part> } ? Part : never

const USAGE = {
  inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
} as const

/** A model that streams `deltas` and stops. */
function mockModel(deltas: string[]): MockLanguageModelV4 {
  const chunks: StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '0' },
    ...deltas.map((delta): StreamPart => ({ type: 'text-delta', id: '0', delta })),
    { type: 'text-end', id: '0' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE }
  ]
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doStream: async () => ({ stream: simulateReadableStream({ chunks }) })
  })
}

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

describe('the HTTP + WebSocket transport', () => {
  let dir: string
  let server: WitenaServer
  let stop: () => Promise<void>
  let origin: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'witena-server-'))
    const config: ServerConfig = {
      host: DEFAULT_HOST,
      // 0: the OS picks a free port, so parallel suites never collide.
      port: 0,
      dataDir: dir,
      databasePath: join(dir, 'witena.db'),
      secretsKeyPath: join(dir, 'secrets.key')
    }
    const ctx = createServerContext(config, {
      log: () => undefined,
      context: { runner: { createModel: () => mockModel(['Ship ', 'the ', 'schema.']) } }
    })
    server = createWitenaServer({ ctx, handlers: buildHandlers(), log: () => undefined })
    await server.listen(config.host, config.port)
    origin = server.origin
    stop = async () => {
      await server.close()
      ctx.close()
    }
  })

  afterEach(async () => {
    await stop()
    rmSync(dir, { recursive: true, force: true })
  })

  /** One `POST /api/<method>`, returning the envelope and the status. */
  async function call(
    method: string,
    input?: unknown
  ): Promise<{ status: number; body: InvokeResponse }> {
    const response = await fetch(`${origin}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) })
    })
    return { status: response.status, body: (await response.json()) as InvokeResponse }
  }

  /** The value of a call that must succeed. */
  async function ok<T>(method: string, input?: unknown): Promise<T> {
    const { status, body } = await call(method, input)
    if (!body.ok) throw new Error(`${method} failed with ${status}: ${body.error.message}`)
    return body.value as T
  }

  /** Opens a client and collects every frame until `until` is satisfied. */
  function listen(): {
    events: BackendEvent[]
    waitFor: (predicate: (events: BackendEvent[]) => boolean, label: string) => Promise<void>
    close: () => void
  } {
    const events: BackendEvent[] = []
    const socket = new WebSocket(`${origin.replace('http://', 'ws://')}/ws`)
    const opened = new Promise<void>((settle, reject) => {
      socket.once('open', () => settle())
      socket.once('error', reject)
    })
    socket.on('message', (data) => events.push(JSON.parse(String(data)) as BackendEvent))

    return {
      events,
      async waitFor(predicate, label) {
        await opened
        const deadline = Date.now() + 5_000
        while (!predicate(events)) {
          if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${label}; saw ${events.map((e) => e.type)}`)
          }
          await new Promise((settle) => setTimeout(settle, 10))
        }
      },
      close: () => socket.close()
    }
  }

  /* -- the plain routes --------------------------------------------------- */

  it('answers the liveness probe without touching the database', async () => {
    const response = await fetch(`${origin}${HEALTH_PATH}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  it('mounts every backend method at POST /api/<method>', async () => {
    expect(await ok('system.ping')).toBe('pong')
    // A method with no arguments is called with an empty body, exactly as IPC
    // calls it with `undefined`.
    const settings = await ok<{ language: string }>('settings.get')
    expect(typeof settings.language).toBe('string')
  })

  it('serialises a BackendError into a status and the IPC envelope', async () => {
    const { status, body } = await call('chats.get', { id: 'nope' })
    expect(status).toBe(404)
    expect(body.ok).toBe(false)
    if (body.ok) return
    expect(body.error.code).toBe('not_found')
  })

  it('refuses an unknown method and a wrong verb', async () => {
    const unknown = await call('chats.explode')
    expect(unknown.status).toBe(404)

    const wrongVerb = await fetch(`${origin}/api/system.ping`, { method: 'GET' })
    expect(wrongVerb.status).toBe(400)
    expect(wrongVerb.headers.get('allow')).toBe('POST')
  })

  it('answers the electron-only methods with their Electron-free rejection', async () => {
    const { status, body } = await call('system.pickFolder')
    expect(status).toBe(500)
    expect(body.ok).toBe(false)
    if (body.ok) return
    expect(body.error.message).toBe(PICK_FOLDER_UNAVAILABLE)

    for (const method of ['system.pickSavePath', 'system.pickPaths', 'system.applyTheme']) {
      const rejected = await call(method, {})
      expect(rejected.body.ok, method).toBe(false)
    }
  })

  it('rejects a body that is not JSON', async () => {
    const response = await fetch(`${origin}/api/system.ping`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json'
    })
    expect(response.status).toBe(400)
  })

  /* -- the push channel --------------------------------------------------- */

  it('forwards bus events to every connected client as one JSON frame each', async () => {
    const a = listen()
    const b = listen()
    await a.waitFor(() => server.clients === 2, 'both clients to connect')

    await ok('system.emitTestEvent', { payload: 'hello' })

    await a.waitFor((events) => events.some((e) => e.type === 'system.test'), 'a to see the event')
    await b.waitFor((events) => events.some((e) => e.type === 'system.test'), 'b to see the event')
    expect(a.events[0]).toEqual({ type: 'system.test', payload: 'hello' })
    expect(b.events[0]).toEqual({ type: 'system.test', payload: 'hello' })

    a.close()
    b.close()
  })

  it('refuses a WebSocket upgrade on any other path', async () => {
    const socket = new WebSocket(`${origin.replace('http://', 'ws://')}/nope`)
    await expect(
      new Promise((_settle, reject) => {
        socket.once('open', () => reject(new Error('the upgrade was accepted')))
        socket.once('error', (error) => reject(error))
      })
    ).rejects.toThrow()
  })

  /* -- the whole path ----------------------------------------------------- */

  it('streams a reply: chats.create, chat.send, then the frames', async () => {
    const client = listen()
    await client.waitFor(() => server.clients === 1, 'the client to connect')

    // A real key, encrypted by the server's own `FileKeySecretStore` on the way
    // in: `providers.create` refuses a key-authenticated provider without one,
    // and the model is injected anyway, so nothing ever decrypts it.
    const provider = await ok<Provider>('providers.create', {
      input: providerInput({ apiKey: 'sk-not-a-real-key' })
    })
    const agent = await ok<{ id: string }>('agents.create', {
      input: agentInput({ name: 'Ada', providerId: provider.id, modelId: 'deepseek-chat' })
    })
    const chat = await ok<Chat>('chats.create', {
      input: { title: 'Design review', memberAgentIds: [agent.id] }
    })

    const sent = await ok<Message>('chat.send', { chatId: chat.id, text: 'Where do we start?' })
    expect(sent.senderType).toBe('user')

    await client.waitFor(
      (events) => events.some((event) => event.type === 'run.finished'),
      'the run to finish'
    )

    const types = client.events.map((event) => event.type)
    expect(types).toContain('message.created')
    expect(types).toContain('message.delta')
    expect(types).toContain('run.finished')

    // The deltas are the model's own tokens, so what crossed the socket is the
    // agent's stream and not a summary of it.
    const text = client.events
      .filter(
        (event): event is Extract<BackendEvent, { type: 'message.delta' }> =>
          event.type === 'message.delta'
      )
      .map((event) => (event.delta.kind === 'text' ? event.delta.text : ''))
      .join('')
    expect(text).toBe('Ship the schema.')

    // And the transcript agrees with the stream.
    const stored = await ok<Message[]>('messages.list', { chatId: chat.id })
    const reply = stored.find((message) => message.senderId === agent.id)
    expect(reply?.parts).toEqual([{ type: 'text', text: 'Ship the schema.' }])

    client.close()
  })
})
