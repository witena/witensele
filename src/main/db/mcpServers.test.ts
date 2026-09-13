import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BackendFailure } from '../errors'
import { createTestDatabase, mcpServerInput, type TestDatabase } from './testing'

describe('db/repositories/mcpServers', () => {
  let database: TestDatabase

  beforeEach(() => {
    database = createTestDatabase()
  })

  afterEach(() => {
    database.cleanup()
  })

  it('creates, reads, lists, updates and deletes a stdio server', () => {
    const created = database.repos.mcpServers.create(mcpServerInput())
    expect(created.transport).toBe('stdio')
    expect(created.args).toEqual(['-y', '@modelcontextprotocol/server-everything'])
    expect(created.env).toEqual({ NODE_ENV: 'production' })
    expect(created.enabled).toBe(true)
    expect(created.sideEffects).toBe(false)
    expect('url' in created).toBe(false)

    expect(database.repos.mcpServers.get(created.id)).toEqual(created)
    expect(database.repos.mcpServers.list()).toEqual([created])

    const updated = database.repos.mcpServers.update(created.id, {
      enabled: false,
      sideEffects: true,
      args: []
    })
    expect(updated.enabled).toBe(false)
    expect(updated.sideEffects).toBe(true)
    expect(updated.args).toEqual([])

    database.repos.mcpServers.delete(created.id)
    expect(database.repos.mcpServers.list()).toEqual([])
  })

  it('stores an http server without the stdio half', () => {
    const created = database.repos.mcpServers.create({
      name: 'remote',
      transport: 'http',
      url: 'https://example.test/mcp',
      enabled: true,
      sideEffects: true
    })

    expect(created.url).toBe('https://example.test/mcp')
    expect('command' in created).toBe(false)
    expect('args' in created).toBe(false)
    expect('env' in created).toBe(false)
  })

  it('scopes by userId and throws not_found for a missing server', () => {
    const mine = database.repos.mcpServers.create(mcpServerInput(), 'user-a')
    expect(database.repos.mcpServers.list('user-b')).toEqual([])
    expect(() => database.repos.mcpServers.get(mine.id, 'user-b')).toThrowError(BackendFailure)
    expect(() => database.repos.mcpServers.delete('nope')).toThrowError(BackendFailure)
  })
})
