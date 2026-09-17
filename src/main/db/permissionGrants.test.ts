/**
 * `permission_grants`: stored, listed, revoked, and gone when the chat is.
 *
 * The reopen case is the one S5.15 exists for — S5.4 kept grants in a `Set`
 * precisely so they could **not** survive a restart — and the cascade case is
 * the one a join table gets wrong by forgetting the `references`: a grant whose
 * chat has been deleted would otherwise sit in the table forever, and be handed
 * straight back to a new chat that happened to reuse the id.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase, tick, type TestDatabase } from './testing'

describe('db/repositories/permissionGrants', () => {
  let database: TestDatabase

  beforeEach(() => {
    database = createTestDatabase()
  })

  afterEach(() => {
    database.cleanup()
  })

  it('has nothing for a chat nobody granted anything in', () => {
    const chat = database.repos.chats.create()
    expect(database.repos.permissionGrants.list(chat.id)).toEqual([])
    expect(database.repos.permissionGrants.has(chat.id, 'run_command')).toBe(false)
  })

  it('records a grant and answers the point read with it', () => {
    const chat = database.repos.chats.create()
    database.repos.permissionGrants.grant(chat.id, 'run_command')

    expect(database.repos.permissionGrants.has(chat.id, 'run_command')).toBe(true)
    expect(database.repos.permissionGrants.list(chat.id)).toEqual([
      { chatId: chat.id, toolName: 'run_command', createdAt: expect.any(Number) }
    ])
  })

  it('is scoped to one chat', () => {
    const first = database.repos.chats.create()
    const second = database.repos.chats.create()
    database.repos.permissionGrants.grant(first.id, 'write_file')

    expect(database.repos.permissionGrants.has(second.id, 'write_file')).toBe(false)
    expect(database.repos.permissionGrants.list(second.id)).toEqual([])
  })

  it('survives a restart, which is the whole point of the table', () => {
    const chat = database.repos.chats.create()
    database.repos.permissionGrants.grant(chat.id, 'run_command')

    database.reopen()

    expect(database.repos.permissionGrants.has(chat.id, 'run_command')).toBe(true)
  })

  it('keeps the original timestamp when the same pair is granted twice', async () => {
    const chat = database.repos.chats.create()
    database.repos.permissionGrants.grant(chat.id, 'run_command')
    const first = database.repos.permissionGrants.list(chat.id)[0]?.createdAt

    await tick()
    database.repos.permissionGrants.grant(chat.id, 'run_command')

    const rows = database.repos.permissionGrants.list(chat.id)
    // One row, and it says when the **user** decided rather than when the
    // executor last called the tool.
    expect(rows).toHaveLength(1)
    expect(rows[0]?.createdAt).toBe(first)
  })

  it('lists newest first', async () => {
    const chat = database.repos.chats.create()
    database.repos.permissionGrants.grant(chat.id, 'write_file')
    await tick()
    database.repos.permissionGrants.grant(chat.id, 'run_command')

    expect(database.repos.permissionGrants.list(chat.id).map((row) => row.toolName)).toEqual([
      'run_command',
      'write_file'
    ])
  })

  it('revokes one grant and leaves the others', () => {
    const chat = database.repos.chats.create()
    database.repos.permissionGrants.grant(chat.id, 'run_command')
    database.repos.permissionGrants.grant(chat.id, 'write_file')

    database.repos.permissionGrants.revoke(chat.id, 'run_command')

    expect(database.repos.permissionGrants.has(chat.id, 'run_command')).toBe(false)
    expect(database.repos.permissionGrants.has(chat.id, 'write_file')).toBe(true)
  })

  it('is not an error to revoke what was never granted', () => {
    const chat = database.repos.chats.create()
    expect(() => database.repos.permissionGrants.revoke(chat.id, 'run_command')).not.toThrow()
  })

  it('deletes a chat’s grants with the chat', () => {
    const chat = database.repos.chats.create()
    database.repos.permissionGrants.grant(chat.id, 'run_command')

    database.repos.chats.delete(chat.id)

    // Read straight from the table: `list` would answer `[]` for a chat that no
    // longer exists whether the cascade worked or not.
    const rows = database.handle.sqlite
      .prepare('SELECT chat_id FROM permission_grants')
      .all() as Array<{ chat_id: string }>
    expect(rows).toEqual([])
  })
})
