/**
 * The chats store: the grouping helper the left column is built from, and the
 * event handlers that keep the list in step with the backend.
 *
 * `groupChats` gets the most attention because it is the only date arithmetic in
 * the renderer, and because "yesterday" is a calendar question rather than a
 * 24-hour one — a rule that is easy to write the wrong way and impossible to
 * notice until 23:50.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendClient, BackendMethod } from '@shared/backend'
import type { Chat, ChatMember } from '@shared/types'
import { DEFAULT_CHAT_SETTINGS, LOCAL_USER_ID } from '@shared/types'
import { applyBackendEvent } from '../lib/event-bridge'
import { BackendClientError } from '../lib/backend'
import { resetBackend, setBackend } from '../lib/backend-provider'
import { groupChats, useChatsStore } from './chats'

function chat(id: string, updatedAt: number, title = id): Chat {
  return {
    id,
    userId: LOCAL_USER_ID,
    createdAt: updatedAt,
    updatedAt,
    title,
    workdir: null,
    settings: DEFAULT_CHAT_SETTINGS
  }
}

/** 2026-09-13, 14:00 local time — a fixed "now" the buckets are measured from. */
const NOW = new Date(2026, 8, 13, 14, 0, 0).getTime()
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

beforeEach(() => {
  useChatsStore.setState({
    chats: [],
    membersByChat: {},
    status: 'idle',
    error: undefined,
    errorCode: undefined,
    errorDetails: undefined,
    selectedId: null
  })
})

afterEach(() => {
  resetBackend()
})

describe('groupChats', () => {
  it('puts today, yesterday and older chats in their own groups, newest first', () => {
    const groups = groupChats(
      [chat('a', NOW - HOUR), chat('b', NOW - DAY), chat('c', NOW - 9 * DAY)],
      NOW
    )

    expect(groups.map((group) => group.id)).toEqual(['today', 'yesterday', 'earlier'])
    expect(groups.map((group) => group.chats.map((entry) => entry.id))).toEqual([
      ['a'],
      ['b'],
      ['c']
    ])
  })

  it('omits empty groups instead of rendering a heading with nothing under it', () => {
    expect(groupChats([chat('a', NOW - HOUR)], NOW).map((group) => group.id)).toEqual(['today'])
    expect(groupChats([], NOW)).toEqual([])
  })

  it('treats the buckets as calendar days, not as rolling 24-hour windows', () => {
    // 00:10 today is barely 14 hours ago but is unambiguously "today"; 23:50 last
    // night is 14 hours ago too and has to read as "yesterday".
    const earlyToday = new Date(2026, 8, 13, 0, 10).getTime()
    const lateYesterday = new Date(2026, 8, 12, 23, 50).getTime()

    const groups = groupChats([chat('a', earlyToday), chat('b', lateYesterday)], NOW)

    expect(groups).toEqual([
      { id: 'today', chats: [chat('a', earlyToday)] },
      { id: 'yesterday', chats: [chat('b', lateYesterday)] }
    ])
  })

  it('counts the day before yesterday as earlier', () => {
    const groups = groupChats([chat('a', new Date(2026, 8, 11, 23, 0).getTime())], NOW)

    expect(groups.map((group) => group.id)).toEqual(['earlier'])
  })

  it('keeps a chat stamped slightly in the future at the top rather than in earlier', () => {
    const groups = groupChats([chat('a', NOW + HOUR)], NOW)

    expect(groups.map((group) => group.id)).toEqual(['today'])
  })

  it('preserves the order it was given inside a group', () => {
    const groups = groupChats([chat('a', NOW - HOUR), chat('b', NOW - 2 * HOUR)], NOW)

    expect(groups[0]?.chats.map((entry) => entry.id)).toEqual(['a', 'b'])
  })
})

describe('chats store', () => {
  it('loads the list newest first and each chat members', async () => {
    const members: Record<string, ChatMember[]> = {
      a: [{ chatId: 'a', agentId: 'agent-1', position: 0 }],
      b: []
    }
    setBackend({
      invoke: (async (method: BackendMethod, input: unknown) => {
        if (method === 'chats.list') return [chat('b', 2), chat('a', 5)]
        if (method === 'chats.members.list') {
          return members[(input as { chatId: string }).chatId] ?? []
        }
        throw new Error(`unexpected method ${method}`)
      }) as BackendClient['invoke'],
      subscribe: () => () => {}
    })

    await useChatsStore.getState().load()

    expect(useChatsStore.getState().chats.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(useChatsStore.getState().membersByChat).toEqual({ a: ['agent-1'], b: [] })
    expect(useChatsStore.getState().status).toBe('ready')
  })

  it('records a failed load as state rather than throwing', async () => {
    setBackend({
      invoke: (async () => {
        throw new Error('transport is down')
      }) as BackendClient['invoke'],
      subscribe: () => () => {}
    })

    await expect(useChatsStore.getState().load()).resolves.toBeUndefined()

    expect(useChatsStore.getState().status).toBe('error')
    expect(useChatsStore.getState().error).toContain('transport is down')
  })

  it('creates a chat, selects it and remembers the failure when it cannot', async () => {
    const created = chat('new', 9)
    setBackend({
      invoke: (async (method: BackendMethod) => {
        if (method === 'chats.create') return created
        if (method === 'chats.members.list') return []
        throw new Error(`unexpected method ${method}`)
      }) as BackendClient['invoke'],
      subscribe: () => () => {}
    })

    await expect(useChatsStore.getState().create()).resolves.toEqual(created)
    expect(useChatsStore.getState().selectedId).toBe('new')
    expect(useChatsStore.getState().chats).toEqual([created])

    setBackend({
      invoke: (async () => {
        throw new Error('no provider with models')
      }) as BackendClient['invoke'],
      subscribe: () => () => {}
    })
    await expect(useChatsStore.getState().create()).resolves.toBeNull()
    expect(useChatsStore.getState().error).toContain('no provider with models')
  })

  it('upserts on chat.updated and keeps the list sorted', () => {
    useChatsStore.setState({ chats: [chat('a', 5), chat('b', 2)] })

    applyBackendEvent({ type: 'chat.updated', chat: chat('b', 9, 'renamed') })

    expect(useChatsStore.getState().chats.map((entry) => entry.id)).toEqual(['b', 'a'])
    expect(useChatsStore.getState().chats[0]?.title).toBe('renamed')
    expect(useChatsStore.getState().chats).toHaveLength(2)
  })

  it('inserts an unknown chat on chat.updated rather than dropping it', () => {
    applyBackendEvent({ type: 'chat.updated', chat: chat('a', 1) })

    expect(useChatsStore.getState().chats.map((entry) => entry.id)).toEqual(['a'])
  })

  it('removes the chat and its selection on chat.deleted', () => {
    useChatsStore.setState({
      chats: [chat('a', 5), chat('b', 2)],
      membersByChat: { a: ['agent-1'], b: [] },
      selectedId: 'a'
    })

    applyBackendEvent({ type: 'chat.deleted', chatId: 'a' })

    expect(useChatsStore.getState().chats.map((entry) => entry.id)).toEqual(['b'])
    expect(useChatsStore.getState().membersByChat).toEqual({ b: [] })
    expect(useChatsStore.getState().selectedId).toBeNull()
  })

  it('keeps the selection when a different chat is deleted', () => {
    useChatsStore.setState({ chats: [chat('a', 5), chat('b', 2)], selectedId: 'b' })

    applyBackendEvent({ type: 'chat.deleted', chatId: 'a' })

    expect(useChatsStore.getState().selectedId).toBe('b')
  })

  it('binds a working directory and applies the chat the backend returned', async () => {
    const bound: Chat = { ...chat('a', 5), workdir: '/Users/ada/code/witena' }
    const calls: { method: BackendMethod; input: unknown }[] = []
    setBackend({
      invoke: (async (method: BackendMethod, input: unknown) => {
        calls.push({ method, input })
        return bound
      }) as BackendClient['invoke'],
      subscribe: () => () => {}
    })

    await useChatsStore.getState().setWorkdir('a', '/Users/ada/code/witena')

    expect(calls).toEqual([
      { method: 'chats.update', input: { id: 'a', patch: { workdir: '/Users/ada/code/witena' } } }
    ])
    expect(useChatsStore.getState().chats).toEqual([bound])
    expect(useChatsStore.getState().error).toBeUndefined()
  })

  it('sends null to unbind, which is what Clear does', async () => {
    const cleared = chat('a', 6)
    const patches: unknown[] = []
    setBackend({
      invoke: (async (_method: BackendMethod, input: unknown) => {
        patches.push((input as { patch: unknown }).patch)
        return cleared
      }) as BackendClient['invoke'],
      subscribe: () => () => {}
    })

    await useChatsStore.getState().setWorkdir('a', null)

    expect(patches).toEqual([{ workdir: null }])
    expect(useChatsStore.getState().chats[0]?.workdir).toBeNull()
  })

  it('keeps the rejection reason so the line can say which rule was broken', async () => {
    setBackend({
      invoke: (async () => {
        throw new BackendClientError({
          code: 'validation',
          message: 'workdir does not exist: /gone',
          details: { reason: 'workdir_missing' }
        })
      }) as BackendClient['invoke'],
      subscribe: () => () => {}
    })

    await expect(useChatsStore.getState().setWorkdir('a', '/gone')).resolves.toBeUndefined()

    expect(useChatsStore.getState().errorCode).toBe('validation')
    expect(useChatsStore.getState().errorDetails).toEqual({ reason: 'workdir_missing' })
  })

  it('picks a folder and binds it, and does nothing at all when the dialog is cancelled', async () => {
    const calls: BackendMethod[] = []
    setBackend({
      invoke: (async (method: BackendMethod) => {
        calls.push(method)
        if (method === 'system.pickFolder') return '/Users/ada/code/witena'
        return { ...chat('a', 5), workdir: '/Users/ada/code/witena' }
      }) as BackendClient['invoke'],
      subscribe: () => () => {}
    })

    await useChatsStore.getState().chooseWorkdir('a')
    expect(calls).toEqual(['system.pickFolder', 'chats.update'])

    calls.length = 0
    setBackend({
      invoke: (async (method: BackendMethod) => {
        calls.push(method)
        return null
      }) as BackendClient['invoke'],
      subscribe: () => () => {}
    })

    await useChatsStore.getState().chooseWorkdir('a')

    // Cancelling is an answer, not a failure: no write, and no error left behind.
    expect(calls).toEqual(['system.pickFolder'])
    expect(useChatsStore.getState().error).toBeUndefined()
  })

  it('ignores a rename to an empty title without calling the backend', async () => {
    let called = false
    setBackend({
      invoke: (async () => {
        called = true
      }) as BackendClient['invoke'],
      subscribe: () => () => {}
    })

    await useChatsStore.getState().rename('a', '   ')

    expect(called).toBe(false)
  })
})
