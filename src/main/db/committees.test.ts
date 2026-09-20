/**
 * The committee repository (S9.1): CRUD, the ordered membership that rides on
 * the entity, and the two cascades that make a committee safe to delete.
 *
 * Validation that a human can trigger from the page — a blank name, a second
 * executor — is the handler's, and lives in `../handlers/committees.test.ts`.
 * What is here is the storage contract underneath it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOCAL_USER_ID } from '@shared/types'
import { agentInput, createTestDatabase, tick, type TestDatabase } from './testing'

describe('db/repositories/committees', () => {
  let database: TestDatabase

  beforeEach(() => {
    database = createTestDatabase()
  })

  afterEach(() => {
    database.cleanup()
  })

  const createAgent = (name: string): string =>
    database.repos.agents.create(agentInput({ name })).id

  it('creates a committee with its members in the order they were given', () => {
    const ada = createAgent('Ada')
    const bob = createAgent('Bob')

    const created = database.repos.committees.create({
      name: 'Architecture review',
      description: 'The people who read a design twice',
      memberAgentIds: [bob, ada]
    })

    expect(created.name).toBe('Architecture review')
    expect(created.description).toBe('The people who read a design twice')
    expect(created.memberAgentIds).toEqual([bob, ada])
    expect(created.userId).toBe(LOCAL_USER_ID)
    expect(database.repos.committees.get(created.id).memberAgentIds).toEqual([bob, ada])
  })

  it('survives a reopen with its order intact', () => {
    const ada = createAgent('Ada')
    const bob = createAgent('Bob')
    const cy = createAgent('Cy')
    const created = database.repos.committees.create({
      name: 'Review',
      description: '',
      memberAgentIds: [cy, ada, bob]
    })

    expect(database.reopen().repos.committees.get(created.id).memberAgentIds).toEqual([
      cy,
      ada,
      bob
    ])
  })

  it('replaces the whole member list on update, so a reorder is a write of the new order', () => {
    const ada = createAgent('Ada')
    const bob = createAgent('Bob')
    const cy = createAgent('Cy')
    const created = database.repos.committees.create({
      name: 'Review',
      description: '',
      memberAgentIds: [ada, bob, cy]
    })

    const reordered = database.repos.committees.update(created.id, {
      memberAgentIds: [cy, bob, ada]
    })
    expect(reordered.memberAgentIds).toEqual([cy, bob, ada])

    // And a removal: a merge could never delete the last member.
    expect(
      database.repos.committees.update(created.id, { memberAgentIds: [] }).memberAgentIds
    ).toEqual([])
  })

  it('leaves the members alone when a patch does not mention them', () => {
    const ada = createAgent('Ada')
    const created = database.repos.committees.create({
      name: 'Review',
      description: 'Old',
      memberAgentIds: [ada]
    })

    const renamed = database.repos.committees.update(created.id, { name: 'Renamed' })
    expect(renamed.name).toBe('Renamed')
    expect(renamed.description).toBe('Old')
    expect(renamed.memberAgentIds).toEqual([ada])
  })

  it('lists newest updatedAt first', () => {
    const first = database.repos.committees.create({ name: 'A', description: '', memberAgentIds: [] })
    tick()
    const second = database.repos.committees.create({
      name: 'B',
      description: '',
      memberAgentIds: []
    })
    expect(database.repos.committees.list().map((c) => c.id)).toEqual([second.id, first.id])

    tick()
    database.repos.committees.update(first.id, { description: 'touched' })
    expect(database.repos.committees.list().map((c) => c.id)).toEqual([first.id, second.id])
  })

  it('refuses a duplicate member and an id that names no agent', () => {
    const ada = createAgent('Ada')

    expect(() =>
      database.repos.committees.create({ name: 'Twice', description: '', memberAgentIds: [ada, ada] })
    ).toThrowError(/twice/)
    expect(() =>
      database.repos.committees.create({ name: 'Ghost', description: '', memberAgentIds: ['ghost'] })
    ).toThrowError(/agent not found/)
    // Nothing was written by either attempt.
    expect(database.repos.committees.list()).toEqual([])
  })

  it('drops a deleted agent from the committee and closes the position gap', () => {
    const ada = createAgent('Ada')
    const bob = createAgent('Bob')
    const cy = createAgent('Cy')
    const created = database.repos.committees.create({
      name: 'Review',
      description: '',
      memberAgentIds: [ada, bob, cy]
    })

    // The cascade leaves positions 0 and 2 behind; reading them as an array is
    // what closes the hole, and the next write renumbers from 0.
    database.repos.agents.delete(bob)
    expect(database.repos.committees.get(created.id).memberAgentIds).toEqual([ada, cy])

    const reordered = database.repos.committees.update(created.id, { memberAgentIds: [cy, ada] })
    expect(reordered.memberAgentIds).toEqual([cy, ada])
  })

  it('leaves a deleted committee’s topics with their members and no provenance', () => {
    const ada = createAgent('Ada')
    const committee = database.repos.committees.create({
      name: 'Review',
      description: '',
      memberAgentIds: [ada]
    })
    const chat = database.repos.chats.create({ title: 'Topic', committeeId: committee.id })
    database.repos.chats.setMembers(LOCAL_USER_ID, chat.id, [ada])
    expect(database.repos.chats.get(chat.id).committeeId).toBe(committee.id)
    expect(database.repos.chats.listChatIdsForCommittee(committee.id)).toEqual([chat.id])

    database.repos.committees.delete(committee.id)

    expect(database.repos.chats.get(chat.id).committeeId).toBeNull()
    expect(database.repos.chats.listMembers(chat.id).map((member) => member.agentId)).toEqual([ada])
    expect(database.repos.chats.listChatIdsForCommittee(committee.id)).toEqual([])
  })

  it('reads a chat written before committees as having no committee', () => {
    expect(database.repos.chats.create({ title: 'Plain' }).committeeId).toBeNull()
  })

  it('rejects an unknown id rather than returning undefined', () => {
    expect(() => database.repos.committees.get('ghost')).toThrowError(/committee not found/)
    expect(() => database.repos.committees.update('ghost', { name: 'x' })).toThrowError(
      /committee not found/
    )
    expect(() => database.repos.committees.delete('ghost')).toThrowError(/committee not found/)
  })
})
