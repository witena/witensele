/**
 * The bootstrap agent, against a real temporary database.
 *
 * Three things have to hold, and each of them is a way a first run can break:
 * it creates exactly one agent, it reuses that agent afterwards instead of
 * breeding a new one per chat, and it refuses with a `validation` failure the
 * renderer can turn into "add a provider first" rather than producing an agent
 * bound to a provider with no model.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppContext } from '../app-context'
import { createTestDatabase, providerInput, type TestDatabase } from '../db/testing'
import { createTestAppContext } from '../testing'
import {
  DEFAULT_AGENT_DESCRIPTION,
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_SYSTEM_PROMPT,
  ensureDefaultAgent
} from './default-agent'

describe('ensureDefaultAgent', () => {
  let database: TestDatabase
  let ctx: AppContext

  beforeEach(() => {
    database = createTestDatabase()
    ctx = createTestAppContext(database).ctx
  })

  afterEach(() => {
    database.cleanup()
  })

  it('creates one assistant bound to the first provider that has a model', async () => {
    ctx.repos.providers.create(providerInput({ name: 'No models', models: [] }), ctx.userId)
    const usable = ctx.repos.providers.create(
      providerInput({ name: 'DeepSeek', models: ['deepseek-chat', 'deepseek-reasoner'] }),
      ctx.userId
    )

    const agent = await ensureDefaultAgent(ctx)

    expect(agent).toMatchObject({
      name: DEFAULT_AGENT_NAME,
      description: DEFAULT_AGENT_DESCRIPTION,
      systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
      role: 'participant',
      providerId: usable.id,
      modelId: 'deepseek-chat',
      memoryEnabled: false
    })
    expect(agent.avatar).toEqual({
      kind: 'initial',
      text: 'A',
      palette: 1,
      color: expect.stringMatching(/^#/)
    })
    expect(ctx.repos.agents.list(ctx.userId)).toHaveLength(1)
  })

  it('reuses the existing agent instead of creating another one', async () => {
    ctx.repos.providers.create(providerInput(), ctx.userId)

    const first = await ensureDefaultAgent(ctx)
    const second = await ensureDefaultAgent(ctx)

    expect(second.id).toBe(first.id)
    expect(ctx.repos.agents.list(ctx.userId)).toHaveLength(1)
  })

  it('returns a user-created agent rather than adding a default beside it', async () => {
    const provider = ctx.repos.providers.create(providerInput(), ctx.userId)
    const mine = ctx.repos.agents.create(
      {
        name: 'Reviewer',
        avatar: { kind: 'initial', text: 'R', color: '#2f3d4a' },
        description: 'Finds the failure path',
        systemPrompt: 'You review.',
        providerId: provider.id,
        modelId: 'deepseek-chat',
        params: {},
        skillNames: [],
        mcpServerIds: [],
        memoryEnabled: false,
        role: 'participant'
      },
      ctx.userId
    )

    await expect(ensureDefaultAgent(ctx)).resolves.toMatchObject({ id: mine.id })
    expect(ctx.repos.agents.list(ctx.userId)).toHaveLength(1)
  })

  it('rejects with validation when no provider has a model', async () => {
    ctx.repos.providers.create(providerInput({ models: [] }), ctx.userId)

    await expect(ensureDefaultAgent(ctx)).rejects.toMatchObject({
      code: 'validation',
      message: 'no provider with models'
    })
    expect(ctx.repos.agents.list(ctx.userId)).toEqual([])
  })

  it('rejects with validation when there is no provider at all', async () => {
    await expect(ensureDefaultAgent(ctx)).rejects.toMatchObject({ code: 'validation' })
  })
})
