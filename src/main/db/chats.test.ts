import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CHAT_SETTINGS, LOCAL_USER_ID } from '@shared/types'
import { BackendFailure } from '../errors'
import { DEFAULT_CHAT_TITLE } from './repositories'
import { agentInput, createTestDatabase, messageInput, tick, type TestDatabase } from './testing'

describe('db/repositories/chats', () => {
  let database: TestDatabase

  beforeEach(() => {
    database = createTestDatabase()
  })

  afterEach(() => {
    database.cleanup()
  })

  it('creates a chat with the default title, settings and a null workdir', () => {
    const created = database.repos.chats.create()

    expect(created.title).toBe(DEFAULT_CHAT_TITLE)
    expect(created.settings).toEqual(DEFAULT_CHAT_SETTINGS)
    expect(created.workdir).toBeNull()
    expect(created.userId).toBe(LOCAL_USER_ID)
  })

  it('merges partial settings over the defaults on create and update', () => {
    const created = database.repos.chats.create({
      title: 'Design review',
      settings: { ...DEFAULT_CHAT_SETTINGS, speaking: 'parallel' }
    })
    expect(created.settings).toEqual({ ...DEFAULT_CHAT_SETTINGS, speaking: 'parallel' })

    const updated = database.repos.chats.update(created.id, {
      settings: { ...created.settings, maxAutoRounds: 5 }
    })
    expect(updated.settings).toEqual({
      ...DEFAULT_CHAT_SETTINGS,
      speaking: 'parallel',
      maxAutoRounds: 5
    })
    expect(updated.title).toBe('Design review')
  })

  it('lists chats newest updatedAt first', () => {
    const first = database.repos.chats.create({ title: 'First' })
    tick()
    const second = database.repos.chats.create({ title: 'Second' })
    expect(database.repos.chats.list().map((c) => c.id)).toEqual([second.id, first.id])

    tick()
    database.repos.chats.update(first.id, { title: 'First again' })
    expect(database.repos.chats.list().map((c) => c.id)).toEqual([first.id, second.id])
  })

  it('deleting a chat cascades to its members and messages', () => {
    const chat = database.repos.chats.create()
    const other = database.repos.chats.create({ title: 'Untouched' })
    const agent = database.repos.agents.create(agentInput())
    database.repos.chats.setMembers(LOCAL_USER_ID, chat.id, [agent.id])
    database.repos.messages.create(messageInput(chat.id))
    const survivor = database.repos.messages.create(messageInput(other.id))

    database.repos.chats.delete(chat.id)

    expect(database.repos.chats.list().map((c) => c.id)).toEqual([other.id])
    expect(database.repos.messages.listForContext(chat.id)).toEqual([])
    expect(database.repos.messages.get(survivor.id).id).toBe(survivor.id)
    const members = database.handle.sqlite.prepare('SELECT * FROM chat_members').all()
    expect(members).toEqual([])
    // The agent itself is untouched by a chat deletion.
    expect(database.repos.agents.get(agent.id).id).toBe(agent.id)
  })

  it('setMembers replaces the whole list and numbers positions by array index', () => {
    const chat = database.repos.chats.create()
    const ada = database.repos.agents.create(agentInput({ name: 'Ada' }))
    const grace = database.repos.agents.create(agentInput({ name: 'Grace' }))
    const alan = database.repos.agents.create(agentInput({ name: 'Alan' }))

    const first = database.repos.chats.setMembers(LOCAL_USER_ID, chat.id, [ada.id, grace.id])
    expect(first).toEqual([
      { chatId: chat.id, agentId: ada.id, position: 0 },
      { chatId: chat.id, agentId: grace.id, position: 1 }
    ])

    const replaced = database.repos.chats.setMembers(LOCAL_USER_ID, chat.id, [
      alan.id,
      ada.id
    ])
    expect(replaced.map((m) => m.agentId)).toEqual([alan.id, ada.id])
    expect(replaced.map((m) => m.position)).toEqual([0, 1])
    expect(database.repos.chats.listMembers(chat.id)).toEqual(replaced)

    expect(database.repos.chats.setMembers(LOCAL_USER_ID, chat.id, [])).toEqual([])
  })

  it('rejects a duplicate or unknown agent in setMembers', () => {
    const chat = database.repos.chats.create()
    const ada = database.repos.agents.create(agentInput())

    expect(() =>
      database.repos.chats.setMembers(LOCAL_USER_ID, chat.id, [ada.id, ada.id])
    ).toThrowError(BackendFailure)
    try {
      database.repos.chats.setMembers(LOCAL_USER_ID, chat.id, [ada.id, 'ghost'])
      expect.unreachable('an unknown agent must fail')
    } catch (error) {
      expect((error as BackendFailure).code).toBe('not_found')
    }
    // A rejected call leaves the previous membership untouched.
    expect(database.repos.chats.listMembers(chat.id)).toEqual([])
  })

  it('scopes by userId and throws not_found for a missing chat', () => {
    const mine = database.repos.chats.create({ title: 'Mine' }, 'user-a')
    expect(database.repos.chats.list('user-b')).toEqual([])
    expect(() => database.repos.chats.get(mine.id, 'user-b')).toThrowError(BackendFailure)
    expect(() => database.repos.chats.delete('nope')).toThrowError(BackendFailure)
    expect(() => database.repos.chats.setMembers('user-b', mine.id, [])).toThrowError(BackendFailure)
    expect(() => database.repos.chats.listMembers('nope')).toThrowError(BackendFailure)
  })
})
