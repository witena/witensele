/**
 * `permission.reply` against a real context.
 *
 * The handler is three lines of validation over `ctx.permissions`, so the cases
 * here are about what a *wrong* call does — the happy path is proved end to end
 * in `agents/agent-turn.test.ts`, where a model really calls `write_file` and
 * the reply really releases it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendEvent, PermissionRequestedEvent } from '@shared/events'
import type { AppContext } from '../app-context'
import { createTestDatabase, type TestDatabase } from '../db/testing'
import { createTestAppContext } from '../testing'
import { buildHandlers, type HandlerMap } from './index'

let database: TestDatabase
let ctx: AppContext
let events: BackendEvent[]
let handlers: HandlerMap

beforeEach(() => {
  database = createTestDatabase()
  let counter = 0
  const created = createTestAppContext(database, { newRequestId: () => `request-${(counter += 1)}` })
  ctx = created.ctx
  events = created.events
  handlers = buildHandlers()
})

afterEach(() => {
  ctx.close()
})

/** Starts a prompt the way an executor tool would. */
function ask(): Promise<unknown> {
  return ctx.permissions.ask({
    chatId: 'chat-1',
    agentId: 'agent-1',
    toolName: 'write_file',
    input: { path: 'README.md' },
    signal: new AbortController().signal
  })
}

describe('permission.reply', () => {
  it('releases the waiting call and resolves it as allowed', async () => {
    const pending = ask()
    const requested = events.find(
      (event): event is PermissionRequestedEvent => event.type === 'permission.requested'
    )
    expect(requested?.requestId).toBe('request-1')

    await handlers['permission.reply'](ctx, { requestId: 'request-1', decision: 'allow' })

    await expect(pending).resolves.toEqual({ allowed: true, remembered: false })
    expect(events.map((event) => event.type)).toEqual([
      'permission.requested',
      'permission.resolved'
    ])
  })

  it('denies when asked to', async () => {
    const pending = ask()
    await handlers['permission.reply'](ctx, { requestId: 'request-1', decision: 'deny' })
    await expect(pending).resolves.toEqual({ allowed: false, reason: 'denied' })
  })

  it('rejects an id nothing is waiting on', async () => {
    await expect(
      handlers['permission.reply'](ctx, { requestId: 'request-404', decision: 'allow' })
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects a missing request id', async () => {
    await expect(
      handlers['permission.reply'](ctx, { requestId: '', decision: 'allow' })
    ).rejects.toMatchObject({ code: 'validation' })
  })

  it('rejects a decision it does not know, rather than treating it as deny', async () => {
    const pending = ask()
    await expect(
      handlers['permission.reply'](ctx, {
        requestId: 'request-1',
        decision: 'maybe' as never
      })
    ).rejects.toMatchObject({ code: 'validation' })

    // Still waiting: a refused reply must not settle the call either way.
    expect(ctx.permissions.pending()).toEqual(['request-1'])
    ctx.permissions.abortAll()
    await pending
  })
})
