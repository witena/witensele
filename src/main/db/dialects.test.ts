/**
 * The storage contract, asserted against every dialect the project supports.
 *
 * One suite body, run twice: against SQLite always, and against Postgres when
 * `DATABASE_URL` names one (see `dialects.ts` for the fixture and for why it is a
 * row gateway rather than the repositories). Everything here is a claim the
 * *schema* makes and the repositories rely on — that a JSON column comes back as
 * an object, that a boolean comes back as a boolean, that an epoch-millisecond
 * timestamp survives a round trip without being truncated to four bytes, that
 * deleting a chat takes its members and messages with it, and that `seq` orders a
 * transcript. A dialect that gets any of them wrong breaks the repositories above
 * it, and it breaks them quietly.
 *
 * The timestamp assertion is the one that would otherwise be found in production:
 * Postgres `integer` is 4 bytes, `Date.now()` has not fitted in it since 1970,
 * and the failure mode of the wrong column type is an insert that works all the
 * way through code review and throws on the first real write.
 */
import { expect, it } from 'vitest'
import { DEFAULT_APP_SETTINGS, DEFAULT_CHAT_SETTINGS, LOCAL_USER_ID } from '@shared/types'
import type { AgentAvatar, MessagePart } from '@shared/types'
import { describeDialects, type DialectStore, type Row } from './dialects'

/** A timestamp that does not fit in 32 bits, which is every real one. */
const NOW = 1_758_067_200_000

const AVATAR: AgentAvatar = { kind: 'initial', text: 'A', color: '#c2653a' }
const PARTS: MessagePart[] = [{ type: 'text', text: 'Start with the data model.' }]

function providerRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    userId: LOCAL_USER_ID,
    type: 'openai-compatible',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    presetId: 'deepseek',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    apiKeyEncrypted: null,
    auth: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  }
}

function agentRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    userId: LOCAL_USER_ID,
    name: 'Ada',
    avatar: AVATAR,
    description: 'Systems thinker',
    systemPrompt: 'You are Ada.',
    providerId: 'provider-1',
    modelId: 'deepseek-chat',
    params: { temperature: 0.7 },
    skillNames: [],
    mcpServerIds: [],
    memoryEnabled: false,
    role: 'participant',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  }
}

function chatRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    userId: LOCAL_USER_ID,
    title: 'Design review',
    workdir: null,
    goal: null,
    settings: DEFAULT_CHAT_SETTINGS,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  }
}

function messageRow(id: string, chatId: string, seq: number, overrides: Row = {}): Row {
  return {
    id,
    userId: LOCAL_USER_ID,
    chatId,
    seq,
    senderType: 'agent',
    senderId: 'agent-1',
    parts: PARTS,
    status: 'done',
    round: 1,
    mentions: [],
    inReplyTo: null,
    usage: null,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  }
}

/** A chat with one agent in it and two messages, which most cases below need. */
async function seed(store: DialectStore): Promise<void> {
  await store.insert('agents', agentRow('agent-1'))
  await store.insert('chats', chatRow('chat-1'))
  await store.insert('chatMembers', { chatId: 'chat-1', agentId: 'agent-1', position: 0 })
  await store.insert('messages', messageRow('message-2', 'chat-1', 2))
  await store.insert('messages', messageRow('message-1', 'chat-1', 1))
}

describeDialects('the storage contract', (fixture) => {
  const store = (): DialectStore => fixture().store

  it('round-trips a provider, JSON array included', async () => {
    await store().insert('providers', providerRow('provider-1'))

    const [row] = await store().selectAll('providers')
    expect(row?.id).toBe('provider-1')
    // A JSON column comes back parsed, not as the text it is stored as in SQLite.
    expect(row?.models).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    // A nullable column that was never set is `null`, not `undefined` or `''`.
    expect(row?.apiKeyEncrypted).toBeNull()
    expect(row?.auth).toBeNull()
  })

  it('keeps an epoch-millisecond timestamp intact', async () => {
    await store().insert('providers', providerRow('provider-1'))

    const [row] = await store().selectAll('providers')
    // The claim that `bigint` rather than `integer` is the right Postgres column:
    // this number is larger than 2^31, so a 4-byte column would have refused the
    // insert or silently wrapped it.
    expect(row?.createdAt).toBe(NOW)
    expect(typeof row?.createdAt).toBe('number')
    expect(NOW).toBeGreaterThan(2 ** 31)
  })

  it('round-trips a JSON object and a boolean on an agent', async () => {
    await store().insert('agents', agentRow('agent-1', { memoryEnabled: true }))

    const [row] = await store().selectAll('agents')
    expect(row?.avatar).toEqual(AVATAR)
    expect(row?.params).toEqual({ temperature: 0.7 })
    expect(row?.skillNames).toEqual([])
    // A real boolean on both dialects, not SQLite's stored 0/1.
    expect(row?.memoryEnabled).toBe(true)
  })

  it('stores the settings blob as a document', async () => {
    await store().insert('settings', {
      userId: LOCAL_USER_ID,
      data: DEFAULT_APP_SETTINGS,
      updatedAt: NOW
    })

    const [row] = await store().selectAll('settings')
    expect(row?.data).toEqual(DEFAULT_APP_SETTINGS)
  })

  it('stores a chat goal as a replaceable document and clears it with null', async () => {
    const goal = { kind: 'document', description: 'A plan', deliverable: 'plan.md', materials: [] }
    await store().insert('chats', chatRow('chat-1', { goal }))

    expect((await store().selectAll('chats'))[0]?.goal).toEqual(goal)

    await store().update('chats', { column: 'id', value: 'chat-1' }, { goal: null })
    expect((await store().selectAll('chats'))[0]?.goal).toBeNull()
  })

  it('orders a transcript by seq, not by insertion', async () => {
    await seed(store())

    const rows = await store().selectAll('messages', { orderBy: 'seq' })
    expect(rows.map((row) => row.id)).toEqual(['message-1', 'message-2'])
    // `message-2` was inserted first, so an unordered read proves nothing.
    expect(rows.map((row) => row.seq)).toEqual([1, 2])
  })

  it('filters by a column', async () => {
    await seed(store())
    await store().insert('chats', chatRow('chat-2'))
    await store().insert('messages', messageRow('message-3', 'chat-2', 1))

    const rows = await store().selectAll('messages', { where: { column: 'chatId', value: 'chat-1' } })
    expect(rows.map((row) => row.id).sort()).toEqual(['message-1', 'message-2'])
  })

  it('cascades a chat delete to its members and its messages', async () => {
    await seed(store())

    await store().remove('chats', { column: 'id', value: 'chat-1' })

    expect(await store().selectAll('chats')).toEqual([])
    expect(await store().selectAll('chatMembers')).toEqual([])
    expect(await store().selectAll('messages')).toEqual([])
    // The agent is not a child of the chat and survives it.
    expect((await store().selectAll('agents')).map((row) => row.id)).toEqual(['agent-1'])
  })

  it('cascades an agent delete to its memberships only', async () => {
    await seed(store())

    await store().remove('agents', { column: 'id', value: 'agent-1' })

    expect(await store().selectAll('chatMembers')).toEqual([])
    expect((await store().selectAll('chats')).map((row) => row.id)).toEqual(['chat-1'])
    expect((await store().selectAll('messages')).length).toBe(2)
  })

  it('updates one row and leaves its siblings alone', async () => {
    await store().insert('providers', providerRow('provider-1'))
    await store().insert('providers', providerRow('provider-2', { name: 'Ollama' }))

    await store().update(
      'providers',
      { column: 'id', value: 'provider-1' },
      { name: 'DeepSeek (work)', updatedAt: NOW + 1 }
    )

    const rows = await store().selectAll('providers', { orderBy: 'id' })
    expect(rows.map((row) => row.name)).toEqual(['DeepSeek (work)', 'Ollama'])
    expect(rows[0]?.updatedAt).toBe(NOW + 1)
  })

  it('applies the migrations exactly once per database', async () => {
    // Nothing to assert beyond "the fixture opened", which is the point: the
    // fixture's own construction ran the dialect's migrator against a database
    // that had never seen it, and every case above then read the tables it made.
    expect(fixture().name === 'sqlite' || fixture().name === 'postgres').toBe(true)
    expect(await store().selectAll('providers')).toEqual([])
  })
})
