/**
 * The presence store: seeding, the event stream, and the Retry button.
 *
 * The rule worth a test is that **the seed and the events cannot fight**. The
 * supervisor has been running since the app started, so a chat opened later has
 * to read `presence.list` once — but an event that arrives while that read is in
 * flight, or after it, must win. Everything else here is the same reducer shape
 * the other stores have.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendClient, BackendMethod } from '@shared/backend'
import type { AgentPresence, PresenceState } from '@shared/types'
import { applyBackendEvent } from '../lib/event-bridge'
import { resetBackend, setBackend } from '../lib/backend-provider'
import { presenceKey, usePresenceStore } from './presence'

const CHAT = 'chat-1'
const GHOST = 'agent-ghost'
const REVIEWER = 'agent-reviewer'

interface Call {
  method: BackendMethod
  input: unknown
}

function presence(agentId: string, state: PresenceState, at = 1_000): AgentPresence {
  return { chatId: CHAT, agentId, state, since: at, lastActivityAt: at }
}

function fakeBackend(answers: Partial<Record<BackendMethod, unknown>>, failure?: Error): Call[] {
  const calls: Call[] = []
  setBackend({
    invoke: (async (method: BackendMethod, input: unknown) => {
      calls.push({ method, input })
      if (failure) throw failure
      return answers[method]
    }) as BackendClient['invoke'],
    subscribe: () => () => {}
  })
  return calls
}

const stateOf = (agentId: string): PresenceState | undefined =>
  usePresenceStore.getState().byChatAgent[presenceKey(CHAT, agentId)]?.state

beforeEach(() => {
  usePresenceStore.setState({ byChatAgent: {}, retryingByChatAgent: {} })
})

afterEach(() => {
  resetBackend()
})

describe('presence store', () => {
  it('seeds every member of a chat from presence.list', async () => {
    const calls = fakeBackend({
      'presence.list': [presence(GHOST, 'offline'), presence(REVIEWER, 'available')]
    })

    await usePresenceStore.getState().load(CHAT)

    expect(calls).toEqual([{ method: 'presence.list', input: { chatId: CHAT } }])
    expect(stateOf(GHOST)).toBe('offline')
    expect(stateOf(REVIEWER)).toBe('available')
  })

  it('leaves the store untouched when the seed fails', async () => {
    fakeBackend({}, new Error('backend is gone'))

    await expect(usePresenceStore.getState().load(CHAT)).resolves.toBeUndefined()

    expect(usePresenceStore.getState().byChatAgent).toEqual({})
  })

  it('applies a presence.changed event', () => {
    applyBackendEvent({ type: 'presence.changed', presence: presence(GHOST, 'away', 2_000) })

    expect(usePresenceStore.getState().byChatAgent[presenceKey(CHAT, GHOST)]).toEqual(
      presence(GHOST, 'away', 2_000)
    )
  })

  it('lets a later event override the seeded value', async () => {
    fakeBackend({ 'presence.list': [presence(GHOST, 'available')] })
    await usePresenceStore.getState().load(CHAT)

    applyBackendEvent({ type: 'presence.changed', presence: presence(GHOST, 'working', 3_000) })

    expect(stateOf(GHOST)).toBe('working')
  })

  it('keeps presences of other chats when one is seeded', async () => {
    applyBackendEvent({
      type: 'presence.changed',
      presence: { chatId: 'chat-2', agentId: GHOST, state: 'offline', since: 1, lastActivityAt: 1 }
    })
    fakeBackend({ 'presence.list': [presence(REVIEWER, 'available')] })

    await usePresenceStore.getState().load(CHAT)

    expect(usePresenceStore.getState().byChatAgent[presenceKey('chat-2', GHOST)]?.state).toBe(
      'offline'
    )
  })

  it('stores what the retry probe answered and clears the pending flag', async () => {
    usePresenceStore.getState().apply(presence(GHOST, 'offline'))
    const calls = fakeBackend({ 'presence.retry': presence(GHOST, 'available', 9_000) })

    await usePresenceStore.getState().retry(CHAT, GHOST)

    expect(calls).toEqual([
      { method: 'presence.retry', input: { chatId: CHAT, agentId: GHOST } }
    ])
    expect(stateOf(GHOST)).toBe('available')
    expect(usePresenceStore.getState().retryingByChatAgent).toEqual({})
  })

  it('leaves an offline agent offline when the retry call itself fails', async () => {
    usePresenceStore.getState().apply(presence(GHOST, 'offline'))
    fakeBackend({}, new Error('transport died'))

    await expect(usePresenceStore.getState().retry(CHAT, GHOST)).resolves.toBeUndefined()

    expect(stateOf(GHOST)).toBe('offline')
    expect(usePresenceStore.getState().retryingByChatAgent).toEqual({})
  })

  it('drops a deleted chat and nothing else', () => {
    usePresenceStore.getState().apply(presence(GHOST, 'offline'))
    usePresenceStore.getState().apply({
      chatId: 'chat-2',
      agentId: GHOST,
      state: 'working',
      since: 1,
      lastActivityAt: 1
    })

    applyBackendEvent({ type: 'chat.deleted', chatId: CHAT })

    expect(stateOf(GHOST)).toBeUndefined()
    expect(usePresenceStore.getState().byChatAgent[presenceKey('chat-2', GHOST)]?.state).toBe(
      'working'
    )
  })
})
