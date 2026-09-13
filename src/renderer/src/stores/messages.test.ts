/**
 * The messages store, with the delta rules as the main subject.
 *
 * `message.delta` carries an increment and the append rule is stated in
 * `src/shared/events.ts`; getting it wrong produces a duplicated or truncated
 * reply that no type checker can catch. So the rules get a case each, driven
 * through `applyBackendEvent` — the same path the real bridge takes — rather than
 * by calling the store's actions directly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendClient, BackendMethod } from '@shared/backend'
import type { Message, MessagePart } from '@shared/types'
import { LOCAL_USER_ID } from '@shared/types'
import { applyBackendEvent } from '../lib/event-bridge'
import { resetBackend, setBackend } from '../lib/backend-provider'
import { applyDeltaToParts, useMessagesStore } from './messages'

const CHAT = 'chat-1'

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    userId: LOCAL_USER_ID,
    createdAt: 1,
    updatedAt: 1,
    chatId: CHAT,
    senderType: 'agent',
    senderId: 'agent-1',
    parts: [],
    status: 'streaming',
    round: 1,
    mentions: [],
    ...overrides
  }
}

/** The transcript of the test chat, as the components see it. */
const transcript = (): Message[] => useMessagesStore.getState().byChat[CHAT] ?? []

const parts = (index = 0): MessagePart[] => transcript()[index]?.parts ?? []

beforeEach(() => {
  useMessagesStore.setState({ byChat: {}, status: {}, error: undefined, errorCode: undefined })
})

afterEach(() => {
  resetBackend()
})

describe('applyDeltaToParts', () => {
  it('appends to the last part of the same kind', () => {
    expect(
      applyDeltaToParts([{ type: 'text', text: 'Hel' }], { kind: 'text', text: 'lo' })
    ).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('starts a new part when the last one is of a different kind', () => {
    expect(
      applyDeltaToParts([{ type: 'reasoning', text: 'hmm' }], { kind: 'text', text: 'Hi' })
    ).toEqual([
      { type: 'reasoning', text: 'hmm' },
      { type: 'text', text: 'Hi' }
    ])
  })

  it('starts the first part when there are none', () => {
    expect(applyDeltaToParts([], { kind: 'text', text: 'Hi' })).toEqual([
      { type: 'text', text: 'Hi' }
    ])
  })

  it('pushes a whole part for the part kind', () => {
    const part: MessagePart = { type: 'system-notice', key: 'runStopped' }
    expect(applyDeltaToParts([{ type: 'text', text: 'Hi' }], { kind: 'part', part })).toEqual([
      { type: 'text', text: 'Hi' },
      part
    ])
  })

  it('does not mutate the array it was given', () => {
    const original: MessagePart[] = [{ type: 'text', text: 'Hel' }]
    applyDeltaToParts(original, { kind: 'text', text: 'lo' })
    expect(original).toEqual([{ type: 'text', text: 'Hel' }])
  })
})

describe('messages store', () => {
  it('appends a created message to its chat', () => {
    applyBackendEvent({ type: 'message.created', message: message() })

    expect(transcript()).toHaveLength(1)
    expect(transcript()[0]).toMatchObject({ id: 'm1', status: 'streaming' })
  })

  it('does not duplicate a message that is created twice', () => {
    applyBackendEvent({ type: 'message.created', message: message() })
    applyBackendEvent({ type: 'message.created', message: message() })

    expect(transcript()).toHaveLength(1)
  })

  it('builds a reply token by token from deltas', () => {
    applyBackendEvent({ type: 'message.created', message: message() })
    for (const text of ['Start ', 'with ', 'the ', 'data model.']) {
      applyBackendEvent({
        type: 'message.delta',
        chatId: CHAT,
        messageId: 'm1',
        delta: { kind: 'text', text }
      })
    }

    expect(parts()).toEqual([{ type: 'text', text: 'Start with the data model.' }])
  })

  it('keeps reasoning and text in separate parts', () => {
    applyBackendEvent({ type: 'message.created', message: message() })
    applyBackendEvent({
      type: 'message.delta',
      chatId: CHAT,
      messageId: 'm1',
      delta: { kind: 'reasoning', text: 'Thinking.' }
    })
    applyBackendEvent({
      type: 'message.delta',
      chatId: CHAT,
      messageId: 'm1',
      delta: { kind: 'text', text: 'Answer.' }
    })

    expect(parts()).toEqual([
      { type: 'reasoning', text: 'Thinking.' },
      { type: 'text', text: 'Answer.' }
    ])
  })

  it('ignores a delta for a message it never saw created', () => {
    applyBackendEvent({ type: 'message.created', message: message() })
    applyBackendEvent({
      type: 'message.delta',
      chatId: CHAT,
      messageId: 'unknown',
      delta: { kind: 'text', text: 'nope' }
    })

    expect(parts()).toEqual([])
  })

  it('ignores a delta for a chat that is not loaded', () => {
    applyBackendEvent({
      type: 'message.delta',
      chatId: 'other',
      messageId: 'm1',
      delta: { kind: 'text', text: 'nope' }
    })

    expect(useMessagesStore.getState().byChat['other']).toBeUndefined()
  })

  it('replaces the message wholesale on update, which is authoritative', () => {
    applyBackendEvent({ type: 'message.created', message: message() })
    applyBackendEvent({
      type: 'message.delta',
      chatId: CHAT,
      messageId: 'm1',
      delta: { kind: 'text', text: 'partial' }
    })
    applyBackendEvent({
      type: 'message.updated',
      message: message({
        parts: [{ type: 'text', text: 'the whole answer' }],
        status: 'done',
        usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 }
      })
    })

    expect(transcript()).toHaveLength(1)
    expect(transcript()[0]).toMatchObject({
      status: 'done',
      usage: { totalTokens: 8 }
    })
    expect(parts()).toEqual([{ type: 'text', text: 'the whole answer' }])
  })

  it('keeps message order: the user message stays in front of the reply', () => {
    applyBackendEvent({
      type: 'message.created',
      message: message({ id: 'user-1', senderType: 'user', status: 'done', round: 0 })
    })
    applyBackendEvent({ type: 'message.created', message: message() })
    applyBackendEvent({ type: 'message.updated', message: message({ status: 'done' }) })

    expect(transcript().map((entry) => entry.id)).toEqual(['user-1', 'm1'])
  })

  it('forgets a chat transcript when the chat is deleted', () => {
    applyBackendEvent({ type: 'message.created', message: message() })
    applyBackendEvent({ type: 'chat.deleted', chatId: CHAT })

    expect(useMessagesStore.getState().byChat[CHAT]).toBeUndefined()
  })

  it('loads a page and reverses it into oldest-first order', async () => {
    const newestFirst = [
      message({ id: 'm3', status: 'done' }),
      message({ id: 'm2', status: 'done' }),
      message({ id: 'm1', status: 'done' })
    ]
    setBackend({
      invoke: (async (method: BackendMethod) => {
        if (method === 'messages.list') return newestFirst
        throw new Error(`unexpected method ${method}`)
      }) as BackendClient['invoke'],
      subscribe: () => () => {}
    })

    await useMessagesStore.getState().load(CHAT)

    expect(transcript().map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3'])
    expect(useMessagesStore.getState().status[CHAT]).toBe('ready')
  })

  it('records a failed load as state rather than throwing', async () => {
    setBackend({
      invoke: (async () => {
        throw new Error('transport is down')
      }) as BackendClient['invoke'],
      subscribe: () => () => {}
    })

    await expect(useMessagesStore.getState().load(CHAT)).resolves.toBeUndefined()

    expect(useMessagesStore.getState().status[CHAT]).toBe('error')
    expect(useMessagesStore.getState().error).toContain('transport is down')
  })
})
