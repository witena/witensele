import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BackendFailure } from '../errors'
import { agentInput, createTestDatabase, type TestDatabase } from './testing'

describe('db/repositories/agents', () => {
  let database: TestDatabase

  beforeEach(() => {
    database = createTestDatabase()
  })

  afterEach(() => {
    database.cleanup()
  })

  it('creates, reads, lists, updates and deletes an agent', () => {
    const created = database.repos.agents.create(agentInput())
    expect(created.role).toBe('participant')
    expect(created.memoryEnabled).toBe(false)

    expect(database.repos.agents.get(created.id)).toEqual(created)
    expect(database.repos.agents.list()).toEqual([created])

    const updated = database.repos.agents.update(created.id, {
      name: 'Ada Lovelace',
      memoryEnabled: true,
      skillNames: ['research'],
      mcpServerIds: ['server-1'],
      params: { temperature: 0.2, maxTokens: 2048, reasoning: true }
    })
    expect(updated.name).toBe('Ada Lovelace')
    expect(updated.memoryEnabled).toBe(true)
    expect(updated.skillNames).toEqual(['research'])
    expect(updated.mcpServerIds).toEqual(['server-1'])
    expect(updated.params).toEqual({ temperature: 0.2, maxTokens: 2048, reasoning: true })

    database.repos.agents.delete(created.id)
    expect(database.repos.agents.list()).toEqual([])
  })

  it('round-trips the JSON columns unchanged', () => {
    const created = database.repos.agents.create(
      agentInput({ avatar: { kind: 'initial', text: 'GR', color: '#3a6ec2' } })
    )
    database.reopen()

    const reloaded = database.repos.agents.get(created.id)
    expect(reloaded.avatar).toEqual({ kind: 'initial', text: 'GR', color: '#3a6ec2' })
    expect(reloaded.params).toEqual({ temperature: 0.7 })
    expect(reloaded.skillNames).toEqual([])
  })

  it('removes the agent from every chat when it is deleted', () => {
    const chat = database.repos.chats.create()
    const keep = database.repos.agents.create(agentInput({ name: 'Keep' }))
    const drop = database.repos.agents.create(agentInput({ name: 'Drop' }))
    database.repos.chats.setMembers('local', chat.id, [keep.id, drop.id])

    database.repos.agents.delete(drop.id)

    expect(database.repos.chats.listMembers(chat.id).map((m) => m.agentId)).toEqual([keep.id])
  })

  it('scopes by userId and throws not_found for a missing agent', () => {
    const mine = database.repos.agents.create(agentInput(), 'user-a')
    expect(database.repos.agents.list('user-b')).toEqual([])
    expect(() => database.repos.agents.get(mine.id, 'user-b')).toThrowError(BackendFailure)
    expect(() => database.repos.agents.update('nope', { name: 'x' })).toThrowError(BackendFailure)
    expect(() => database.repos.agents.delete('nope')).toThrowError(BackendFailure)
  })
})
