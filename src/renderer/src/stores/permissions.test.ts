/**
 * The permissions store.
 *
 * The cases worth a test are the ones where a card would otherwise outlive the
 * call it belongs to: a prompt the run stopped, a reply the backend refuses
 * because nothing is waiting any more, and a chat that was deleted while a
 * prompt was open. A stale permission card is not a cosmetic bug — it offers the
 * user a decision that nothing will act on.
 *
 * Driven through `applyBackendEvent`, like the other store suites, so the event
 * shapes in `src/shared/events.ts` are exercised rather than restated.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendClient, BackendMethod } from '@shared/backend'
import type { BackendEvent } from '@shared/events'
import type { PermissionDecision } from '@shared/types'
import { applyBackendEvent } from '../lib/event-bridge'
import { resetBackend, setBackend } from '../lib/backend-provider'
import { pendingForChat, usePermissionsStore } from './permissions'

const CHAT = 'chat-1'
const OTHER_CHAT = 'chat-2'
const AGENT = 'agent-hands'

interface Call {
  method: BackendMethod
  input: unknown
}

function fakeBackend(failure?: Error): Call[] {
  const calls: Call[] = []
  setBackend({
    invoke: (async (method: BackendMethod, input: unknown) => {
      calls.push({ method, input })
      if (failure) throw failure
      return undefined
    }) as BackendClient['invoke'],
    subscribe: () => () => {}
  })
  return calls
}

function requested(
  requestId: string,
  overrides: Partial<{ chatId: string; toolName: string; input: unknown }> = {}
): BackendEvent {
  return {
    type: 'permission.requested',
    requestId,
    chatId: overrides.chatId ?? CHAT,
    agentId: AGENT,
    toolName: overrides.toolName ?? 'write_file',
    input: overrides.input ?? { path: 'NOTES.md', content: '# Notes\n' }
  }
}

function resolved(requestId: string, decision: PermissionDecision | 'aborted'): BackendEvent {
  return { type: 'permission.resolved', requestId, chatId: CHAT, decision }
}

const idsFor = (chatId: string): string[] =>
  pendingForChat(usePermissionsStore.getState().pending, chatId).map(
    (request) => request.requestId
  )

beforeEach(() => {
  usePermissionsStore.setState({ pending: {}, replyingById: {}, seq: 0 })
})

afterEach(() => {
  resetBackend()
})

describe('permissions store', () => {
  it('holds one card per requested prompt, keyed by request id', () => {
    applyBackendEvent(requested('request-1'))

    const request = usePermissionsStore.getState().pending['request-1']
    expect(request).toMatchObject({
      requestId: 'request-1',
      chatId: CHAT,
      agentId: AGENT,
      toolName: 'write_file',
      input: { path: 'NOTES.md', content: '# Notes\n' }
    })
  })

  it('keeps several open prompts and orders them oldest first', () => {
    applyBackendEvent(requested('request-1'))
    applyBackendEvent(requested('request-2', { toolName: 'run_command' }))
    applyBackendEvent(requested('request-3', { chatId: OTHER_CHAT }))

    // A parallel round can have two prompts open in one chat, and a second chat
    // can have its own; each list is only its own chat's.
    expect(idsFor(CHAT)).toEqual(['request-1', 'request-2'])
    expect(idsFor(OTHER_CHAT)).toEqual(['request-3'])
    expect(pendingForChat(usePermissionsStore.getState().pending, null)).toEqual([])
  })

  it('sends the decision through permission.reply', async () => {
    const calls = fakeBackend()
    applyBackendEvent(requested('request-1'))

    await usePermissionsStore.getState().reply('request-1', 'allowAlways')

    expect(calls).toEqual([
      { method: 'permission.reply', input: { requestId: 'request-1', decision: 'allowAlways' } }
    ])
    // Not optimistic: the card goes away when the backend says the prompt ended.
    expect(idsFor(CHAT)).toEqual(['request-1'])

    applyBackendEvent(resolved('request-1', 'allowAlways'))
    expect(idsFor(CHAT)).toEqual([])
  })

  it('dismisses a card on resolved however the prompt ended', () => {
    for (const decision of ['allow', 'deny', 'allowAlways', 'aborted'] as const) {
      applyBackendEvent(requested(`request-${decision}`))
      applyBackendEvent(resolved(`request-${decision}`, decision))
      expect(usePermissionsStore.getState().pending[`request-${decision}`]).toBeUndefined()
    }
  })

  it('clears every open prompt when a stop resolves them as aborted', () => {
    applyBackendEvent(requested('request-1'))
    applyBackendEvent(requested('request-2'))

    // Stop closes each pending prompt through the gate, one `resolved` each.
    applyBackendEvent(resolved('request-1', 'aborted'))
    applyBackendEvent(resolved('request-2', 'aborted'))

    expect(idsFor(CHAT)).toEqual([])
  })

  it('drops the card when the backend says nothing is waiting on it', async () => {
    fakeBackend(new Error('not_found'))
    applyBackendEvent(requested('request-1'))

    await usePermissionsStore.getState().reply('request-1', 'allow')

    // Answered twice, or closed by a stop this window missed: a stale prompt
    // must stop being offered rather than sit there with an error under it.
    expect(idsFor(CHAT)).toEqual([])
    expect(usePermissionsStore.getState().replyingById['request-1']).toBeUndefined()
  })

  it('ignores a second answer while the first is in flight', async () => {
    const calls = fakeBackend()
    applyBackendEvent(requested('request-1'))

    const first = usePermissionsStore.getState().reply('request-1', 'allow')
    const second = usePermissionsStore.getState().reply('request-1', 'deny')
    await Promise.all([first, second])

    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toMatchObject({ decision: 'allow' })
  })

  it('forgets a deleted chat, and only that chat', () => {
    applyBackendEvent(requested('request-1'))
    applyBackendEvent(requested('request-2', { chatId: OTHER_CHAT }))

    applyBackendEvent({ type: 'chat.deleted', chatId: CHAT })

    expect(idsFor(CHAT)).toEqual([])
    expect(idsFor(OTHER_CHAT)).toEqual(['request-2'])
  })

  it('ignores a resolution for a prompt it never saw', () => {
    applyBackendEvent(resolved('request-ghost', 'allow'))
    expect(usePermissionsStore.getState().pending).toEqual({})
  })
})
