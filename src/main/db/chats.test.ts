import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CHAT_SETTINGS, LOCAL_USER_ID } from '@shared/types'
import { BackendFailure } from '../errors'
import { CHAT_SEARCH_LIMIT, DEFAULT_CHAT_TITLE, escapeLike } from './repositories'
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

  describe('search', () => {
    it('matches a chat by its title, case-insensitively', () => {
      const zebra = database.repos.chats.create({ title: 'Zebra migration' })
      database.repos.chats.create({ title: 'Retry budget' })

      expect(database.repos.chats.search('zebra')).toEqual([zebra.id])
      expect(database.repos.chats.search('ZEBRA')).toEqual([zebra.id])
    })

    it('matches a chat by the text of any of its messages', () => {
      const withWord = database.repos.chats.create({ title: 'First' })
      const without = database.repos.chats.create({ title: 'Second' })
      database.repos.messages.create(messageInput(withWord.id, { parts: [{ type: 'text', text: 'What about a zebra?' }] }))
      database.repos.messages.create(messageInput(without.id, { parts: [{ type: 'text', text: 'Nothing striped here.' }] }))

      expect(database.repos.chats.search('zebra')).toEqual([withWord.id])
    })

    it('returns a chat once even when several of its messages match', () => {
      const chat = database.repos.chats.create({ title: 'Zebra' })
      database.repos.messages.create(messageInput(chat.id, { parts: [{ type: 'text', text: 'zebra one' }] }))
      database.repos.messages.create(messageInput(chat.id, { parts: [{ type: 'text', text: 'zebra two' }] }))

      expect(database.repos.chats.search('zebra')).toEqual([chat.id])
    })

    it('ignores anything that is not a text part, so a part type is not a hit', () => {
      const chat = database.repos.chats.create({ title: 'Tools' })
      database.repos.messages.create(
        messageInput(chat.id, {
          senderType: 'agent',
          senderId: 'agent-1',
          parts: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'zebra_lookup', input: {} },
            { type: 'tool-result', toolCallId: 'c1', output: 'striped' }
          ]
        })
      )

      // The serialized JSON contains both words; only `text` parts count.
      expect(database.repos.chats.search('zebra')).toEqual([])
      expect(database.repos.chats.search('striped')).toEqual([])
      expect(database.repos.chats.search('text')).toEqual([])
    })

    it('treats % and _ as literals rather than as wildcards', () => {
      const literal = database.repos.chats.create({ title: 'Down 50% on retries' })
      database.repos.chats.create({ title: 'Nothing to do with it' })

      expect(database.repos.chats.search('50%')).toEqual([literal.id])
      // A bare wildcard matches the one title that literally contains it, not
      // every chat in the database — which is what an unescaped `%` would do.
      expect(database.repos.chats.search('%')).toEqual([literal.id])
      expect(database.repos.chats.search('_')).toEqual([])
    })

    it('escapes the escape character itself', () => {
      expect(escapeLike('a\\b')).toBe('a\\\\b')
      expect(escapeLike('50%_')).toBe('50\\%\\_')
      expect(escapeLike('plain')).toBe('plain')
    })

    it('returns every chat, newest first, for a blank query', () => {
      const first = database.repos.chats.create({ title: 'First' })
      tick()
      const second = database.repos.chats.create({ title: 'Second' })

      expect(database.repos.chats.search('')).toEqual([second.id, first.id])
      expect(database.repos.chats.search('   ')).toEqual([second.id, first.id])
    })

    it('orders hits newest updatedAt first, exactly like list', () => {
      const first = database.repos.chats.create({ title: 'Zebra one' })
      tick()
      const second = database.repos.chats.create({ title: 'Zebra two' })

      expect(database.repos.chats.search('zebra')).toEqual([second.id, first.id])
    })

    it('is scoped by userId', () => {
      const mine = database.repos.chats.create({ title: 'Zebra' }, 'user-a')
      database.repos.chats.create({ title: 'Zebra' }, 'user-b')

      expect(database.repos.chats.search('zebra', 'user-a')).toEqual([mine.id])
    })

    it('caps the result at CHAT_SEARCH_LIMIT', () => {
      expect(CHAT_SEARCH_LIMIT).toBeGreaterThan(0)
      for (let index = 0; index < 5; index += 1) {
        database.repos.chats.create({ title: `Zebra ${index}` })
      }

      expect(database.repos.chats.search('zebra').length).toBeLessThanOrEqual(CHAT_SEARCH_LIMIT)
    })
  })
})
