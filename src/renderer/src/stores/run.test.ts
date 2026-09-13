/**
 * The run store: the state behind the Stop button.
 *
 * The rule worth a test is that the state comes from the **events**, not from the
 * local `send()` call — a message sent during an active run joins that run at its
 * next round boundary and starts no second one, so a store that flipped its own
 * flag would show a Stop button for a run that does not exist and leave it
 * showing after the real one finished.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendClient, BackendMethod } from '@shared/backend'
import { LOCAL_USER_ID, type Message } from '@shared/types'
import { applyBackendEvent } from '../lib/event-bridge'
import { resetBackend, setBackend } from '../lib/backend-provider'
import { useRunStore } from './run'

const CHAT = 'chat-1'

interface Call {
  method: BackendMethod
  input: unknown
}

const stored: Message = {
  id: 'm1',
  userId: LOCAL_USER_ID,
  createdAt: 1,
  updatedAt: 1,
  chatId: CHAT,
  senderType: 'user',
  senderId: LOCAL_USER_ID,
  parts: [{ type: 'text', text: 'Hi' }],
  status: 'done',
  round: 0,
  mentions: []
}

function fakeBackend(failure: Error | null = null): Call[] {
  const calls: Call[] = []
  setBackend({
    invoke: (async (method: BackendMethod, input: unknown) => {
      calls.push({ method, input })
      if (failure) throw failure
      return method === 'chat.send' ? stored : undefined
    }) as BackendClient['invoke'],
    subscribe: () => () => {}
  })
  return calls
}

const active = () => useRunStore.getState().activeByChat[CHAT]

beforeEach(() => {
  useRunStore.setState({
    activeByChat: {},
    sendingByChat: {},
    error: undefined,
    errorCode: undefined
  })
})

afterEach(() => {
  resetBackend()
})

describe('run store', () => {
  it('starts idle', () => {
    expect(active()).toBeUndefined()
  })

  it('follows run.started, run.round and run.finished', () => {
    applyBackendEvent({ type: 'run.started', chatId: CHAT, round: 1 })
    expect(active()).toEqual({ round: 1, speakers: [] })

    applyBackendEvent({ type: 'run.round', chatId: CHAT, round: 1, speakers: ['agent-1'] })
    expect(active()).toEqual({ round: 1, speakers: ['agent-1'] })

    applyBackendEvent({ type: 'run.finished', chatId: CHAT, reason: 'completed' })
    expect(active()).toBeUndefined()
  })

  it('clears the run whatever the finish reason is', () => {
    for (const reason of ['completed', 'stopped', 'max-rounds', 'error'] as const) {
      applyBackendEvent({ type: 'run.started', chatId: CHAT, round: 1 })
      applyBackendEvent({ type: 'run.finished', chatId: CHAT, reason })
      expect(active()).toBeUndefined()
    }
  })

  it('keeps runs of different chats apart', () => {
    applyBackendEvent({ type: 'run.started', chatId: CHAT, round: 1 })
    applyBackendEvent({ type: 'run.started', chatId: 'chat-2', round: 1 })
    applyBackendEvent({ type: 'run.finished', chatId: 'chat-2', reason: 'completed' })

    expect(active()).toEqual({ round: 1, speakers: [] })
  })

  it('clears the run when the chat is deleted', () => {
    applyBackendEvent({ type: 'run.started', chatId: CHAT, round: 1 })
    applyBackendEvent({ type: 'chat.deleted', chatId: CHAT })

    expect(active()).toBeUndefined()
  })

  it('sends the trimmed text and reports success', async () => {
    const calls = fakeBackend()

    await expect(useRunStore.getState().send(CHAT, '  Hi  ')).resolves.toBe(true)

    expect(calls).toEqual([{ method: 'chat.send', input: { chatId: CHAT, text: 'Hi' } }])
    // Nothing is active yet: only `run.started` may say that.
    expect(active()).toBeUndefined()
  })

  it('passes the composer’s resolved mentions through, and omits an empty list', async () => {
    const calls = fakeBackend()

    await useRunStore.getState().send(CHAT, '@Ada hello', ['agent-ada'])
    await useRunStore.getState().send(CHAT, 'hello', [])

    expect(calls).toEqual([
      { method: 'chat.send', input: { chatId: CHAT, text: '@Ada hello', mentions: ['agent-ada'] } },
      { method: 'chat.send', input: { chatId: CHAT, text: 'hello' } }
    ])
  })

  it('refuses an empty message without calling the backend', async () => {
    const calls = fakeBackend()

    await expect(useRunStore.getState().send(CHAT, '   ')).resolves.toBe(false)

    expect(calls).toEqual([])
  })

  it('records a failed send as state and reports failure', async () => {
    fakeBackend(new Error('no provider with models'))

    await expect(useRunStore.getState().send(CHAT, 'Hi')).resolves.toBe(false)

    expect(useRunStore.getState().error).toContain('no provider with models')
    expect(useRunStore.getState().sendingByChat[CHAT]).toBeUndefined()
  })

  it('marks the chat as sending only for the duration of the call', async () => {
    let release = (): void => {}
    setBackend({
      invoke: (async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return stored
      }) as BackendClient['invoke'],
      subscribe: () => () => {}
    })

    const sending = useRunStore.getState().send(CHAT, 'Hi')
    expect(useRunStore.getState().sendingByChat[CHAT]).toBe(true)

    release()
    await sending
    expect(useRunStore.getState().sendingByChat[CHAT]).toBeUndefined()
  })

  it('calls chat.stop and leaves the clearing to run.finished', async () => {
    const calls = fakeBackend()
    applyBackendEvent({ type: 'run.started', chatId: CHAT, round: 1 })

    await useRunStore.getState().stop(CHAT)

    expect(calls).toEqual([{ method: 'chat.stop', input: { chatId: CHAT } }])
    expect(active()).toEqual({ round: 1, speakers: [] })

    applyBackendEvent({ type: 'run.finished', chatId: CHAT, reason: 'stopped' })
    expect(active()).toBeUndefined()
  })

  it('swallows a failed stop into state', async () => {
    fakeBackend(new Error('gone'))

    await expect(useRunStore.getState().stop(CHAT)).resolves.toBeUndefined()
    expect(useRunStore.getState().error).toContain('gone')
  })
})
