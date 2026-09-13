import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BackendFailure } from '../errors'
import { createTestDatabase, messageInput, type TestDatabase } from './testing'

describe('db/repositories/messages', () => {
  let database: TestDatabase
  let chatId: string

  beforeEach(() => {
    database = createTestDatabase()
    chatId = database.repos.chats.create().id
  })

  afterEach(() => {
    database.cleanup()
  })

  it('creates a message and reads it back unchanged', () => {
    const created = database.repos.messages.create(
      messageInput(chatId, {
        senderType: 'agent',
        senderId: 'agent-1',
        status: 'streaming',
        round: 1,
        mentions: ['agent-2'],
        parts: [
          { type: 'reasoning', text: 'thinking' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'search', input: { q: 'x' } }
        ]
      })
    )

    expect(created.status).toBe('streaming')
    expect('usage' in created).toBe(false)
    expect('error' in created).toBe(false)
    expect(database.repos.messages.get(created.id)).toEqual(created)

    database.reopen()
    expect(database.repos.messages.get(created.id)).toEqual(created)
  })

  it('assigns a monotonic seq per chat and exposes the next one', () => {
    const otherChat = database.repos.chats.create().id

    expect(database.repos.messages.nextSeq(chatId)).toBe(1)
    const a = database.repos.messages.create(messageInput(chatId, { parts: [{ type: 'text', text: 'a' }] }))
    const b = database.repos.messages.create(messageInput(chatId, { parts: [{ type: 'text', text: 'b' }] }))
    const c = database.repos.messages.create(messageInput(chatId, { parts: [{ type: 'text', text: 'c' }] }))
    expect(database.repos.messages.nextSeq(chatId)).toBe(4)

    // seq is per chat, so a second chat starts over at 1.
    expect(database.repos.messages.nextSeq(otherChat)).toBe(1)
    database.repos.messages.create(messageInput(otherChat))
    expect(database.repos.messages.nextSeq(otherChat)).toBe(2)

    // Ordering holds even though all three share one millisecond.
    expect(database.repos.messages.listForContext(chatId).map((m) => m.id)).toEqual([
      a.id,
      b.id,
      c.id
    ])
  })

  it('lists newest first and pages with before as an exclusive cursor', () => {
    const created = ['1', '2', '3', '4', '5'].map((text) =>
      database.repos.messages.create(messageInput(chatId, { parts: [{ type: 'text', text }] }))
    )
    const ids = created.map((m) => m.id)

    const firstPage = database.repos.messages.list({ chatId, limit: 2 })
    expect(firstPage.map((m) => m.id)).toEqual([ids[4], ids[3]])

    const secondPage = database.repos.messages.list({ chatId, limit: 2, before: firstPage[1].id })
    expect(secondPage.map((m) => m.id)).toEqual([ids[2], ids[1]])

    const lastPage = database.repos.messages.list({ chatId, limit: 2, before: secondPage[1].id })
    expect(lastPage.map((m) => m.id)).toEqual([ids[0]])

    expect(database.repos.messages.list({ chatId, before: ids[0] })).toEqual([])
  })

  it('listForContext returns the whole history oldest first', () => {
    const first = database.repos.messages.create(messageInput(chatId))
    const second = database.repos.messages.create(
      messageInput(chatId, { senderType: 'agent', senderId: 'agent-1', round: 1 })
    )

    expect(database.repos.messages.listForContext(chatId).map((m) => m.id)).toEqual([
      first.id,
      second.id
    ])
  })

  it('patches parts, status, usage, mentions and error', () => {
    const created = database.repos.messages.create(
      messageInput(chatId, { status: 'streaming', parts: [] })
    )

    const streamed = database.repos.messages.update(created.id, {
      parts: [{ type: 'text', text: 'partial' }]
    })
    expect(streamed.parts).toEqual([{ type: 'text', text: 'partial' }])
    expect(streamed.status).toBe('streaming')

    const finished = database.repos.messages.update(created.id, {
      status: 'done',
      mentions: ['agent-2'],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }
    })
    expect(finished.status).toBe('done')
    expect(finished.mentions).toEqual(['agent-2'])
    expect(finished.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 })

    const failed = database.repos.messages.update(created.id, {
      status: 'error',
      error: 'provider returned 500'
    })
    expect(failed.error).toBe('provider returned 500')

    const recovered = database.repos.messages.update(created.id, { status: 'done', error: '' })
    expect('error' in recovered).toBe(false)
  })

  it('bumps the parent chat updatedAt when a message is created', () => {
    const before = database.repos.chats.get(chatId)
    const message = database.repos.messages.create(messageInput(chatId))
    const after = database.repos.chats.get(chatId)

    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt)
    expect(after.updatedAt).toBe(message.createdAt)
  })

  it('throws not_found for an unknown chat, message or cursor', () => {
    expect(() => database.repos.messages.create(messageInput('ghost'))).toThrowError(BackendFailure)
    expect(() => database.repos.messages.get('ghost')).toThrowError(BackendFailure)
    expect(() => database.repos.messages.update('ghost', { status: 'done' })).toThrowError(
      BackendFailure
    )
    expect(() => database.repos.messages.list({ chatId, before: 'ghost' })).toThrowError(
      BackendFailure
    )
  })

  it('scopes by userId', () => {
    const chat = database.repos.chats.create({ title: 'Theirs' }, 'user-a')
    const message = database.repos.messages.create(messageInput(chat.id), 'user-a')

    expect(database.repos.messages.listForContext(chat.id, 'user-a').map((m) => m.id)).toEqual([
      message.id
    ])
    expect(database.repos.messages.listForContext(chat.id, 'user-b')).toEqual([])
    expect(() => database.repos.messages.get(message.id, 'user-b')).toThrowError(BackendFailure)
  })
})
