import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKEND_METHODS, type BackendMethod } from '@shared/backend'
import type { BackendEvent } from '@shared/events'
import { DEFAULT_APP_SETTINGS, LOCAL_USER_ID, type ProviderInput } from '@shared/types'
import type { AppContext } from '../app-context'
import { createTestDatabase, type TestDatabase } from '../db/testing'
import { createInsecureSecretStore } from '../secrets'
import type { FetchImpl } from '../providers/discovery'
import { createTestAppContext, type TestAppContext } from '../testing'
import { buildHandlers, notImplemented } from './index'

/**
 * An `AppContext` backed by the S1.2 test fixture: a real temporary database
 * file, an in-process bus and the insecure secret store. Handlers take the
 * context as their first argument precisely so this is possible without electron.
 *
 * The builder itself moved to `src/main/testing.ts` in S1.7, where the
 * `ChatRunner` and `AgentTurn` suites use the same one; this wrapper keeps the
 * positional `fetchImpl` argument the provider cases below read well with.
 */
function createTestContext(database: TestDatabase, fetchImpl?: FetchImpl): TestAppContext {
  return createTestAppContext(database, { ...(fetchImpl ? { fetchImpl } : {}) })
}

describe('handlers/buildHandlers', () => {
  let database: TestDatabase
  let ctx: AppContext
  let events: BackendEvent[]
  const handlers = buildHandlers()

  beforeEach(() => {
    database = createTestDatabase()
    const created = createTestContext(database)
    ctx = created.ctx
    events = created.events
  })

  afterEach(() => {
    // `ctx.close()` rather than `database.cleanup()`: it also stops the
    // `AgentSupervisor`'s heartbeat, which would otherwise keep ticking against
    // a closed database for the rest of the suite.
    ctx.close()
  })

  it('has an entry for every declared backend method', () => {
    const missing = BACKEND_METHODS.filter((method) => typeof handlers[method] !== 'function')

    expect(missing).toEqual([])
    expect(Object.keys(handlers).sort()).toEqual([...BACKEND_METHODS].sort())
  })

  /**
   * Every declared method has a real implementation as of S3.3, so the stub is
   * asserted directly rather than through a method that happens to be missing.
   * The mechanism has to keep working: the next method added to `BackendApi`
   * before its step lands must reject with a pointer rather than crash.
   */
  it('builds a rejection that names the method and points at STEPS.md', async () => {
    const failure = notImplemented('skills.list')

    expect(failure.code).toBe('internal')
    expect(failure.message).toBe('Not implemented yet: skills.list (see docs/STEPS.md)')
  })

  describe('system.ping', () => {
    it('answers pong', async () => {
      await expect(handlers['system.ping'](ctx)).resolves.toBe('pong')
    })
  })

  describe('system.emitTestEvent', () => {
    it('emits exactly one system.test event carrying the payload', async () => {
      await handlers['system.emitTestEvent'](ctx, { payload: 'hello-1' })

      expect(events).toEqual([{ type: 'system.test', payload: 'hello-1' }])
    })

    it('rejects a non-string payload with validation and emits nothing', async () => {
      await expect(
        handlers['system.emitTestEvent'](ctx, { payload: 42 } as unknown as { payload: string })
      ).rejects.toMatchObject({ code: 'validation' })

      expect(events).toEqual([])
    })
  })

  describe('settings.get / settings.update', () => {
    it('returns the defaults before anything was stored', async () => {
      await expect(handlers['settings.get'](ctx)).resolves.toEqual(DEFAULT_APP_SETTINGS)
    })

    it('merges a patch, persists it and returns the stored result', async () => {
      const updated = await handlers['settings.update'](ctx, { patch: { language: 'en' } })

      expect(updated).toEqual({ ...DEFAULT_APP_SETTINGS, language: 'en' })
      await expect(handlers['settings.get'](ctx)).resolves.toEqual(updated)
    })

    it('merges timeouts field by field', async () => {
      const updated = await handlers['settings.update'](ctx, {
        patch: { timeouts: { toolTimeoutMs: 1_000 } }
      })

      expect(updated.timeouts).toEqual({ ...DEFAULT_APP_SETTINGS.timeouts, toolTimeoutMs: 1_000 })
    })

    it('rejects a patch that is not an object', async () => {
      await expect(
        handlers['settings.update'](ctx, { patch: null as never })
      ).rejects.toMatchObject({ code: 'validation' })
    })

    it('rejects unknown keys instead of storing them', async () => {
      await expect(
        handlers['settings.update'](ctx, { patch: { nope: true } as never })
      ).rejects.toMatchObject({ code: 'validation' })

      await expect(handlers['settings.get'](ctx)).resolves.toEqual(DEFAULT_APP_SETTINGS)
    })

    it('scopes reads and writes to the context user', async () => {
      await handlers['settings.update'](ctx, { patch: { language: 'zh-CN' } })

      const other: AppContext = { ...ctx, userId: 'someone-else' }
      await expect(handlers['settings.get'](other)).resolves.toEqual(DEFAULT_APP_SETTINGS)
    })
  })

  describe('providers.*', () => {
    const deepseek: ProviderInput = {
      type: 'openai-compatible',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      presetId: 'deepseek',
      models: ['deepseek-chat'],
      apiKey: 'sk-secret'
    }

    it('creates a provider, stores the key as ciphertext and reports only its presence', async () => {
      const created = await handlers['providers.create'](ctx, { input: deepseek })

      expect(created).toMatchObject({ name: 'DeepSeek', hasApiKey: true })
      // The plaintext key must not appear in anything that crosses IPC.
      expect(JSON.stringify(created)).not.toContain('sk-secret')

      const stored = ctx.repos.providers.getApiKeyCiphertext(created.id, ctx.userId)
      expect(stored).not.toBeNull()
      expect(stored).not.toBe('sk-secret')
      expect(ctx.secrets.decrypt(stored as string)).toBe('sk-secret')

      await expect(handlers['providers.list'](ctx)).resolves.toEqual([created])
      await expect(handlers['providers.get'](ctx, { id: created.id })).resolves.toEqual(created)
    })

    it('rejects a provider with no name', async () => {
      await expect(
        handlers['providers.create'](ctx, { input: { ...deepseek, name: '  ' } })
      ).rejects.toMatchObject({ code: 'validation' })
      await expect(handlers['providers.list'](ctx)).resolves.toEqual([])
    })

    it('rejects an unknown provider type', async () => {
      await expect(
        handlers['providers.create'](ctx, {
          input: { ...deepseek, type: 'llama.cpp' as never }
        })
      ).rejects.toMatchObject({ code: 'validation' })
    })

    it('rejects an OpenAI-compatible provider with no base URL', async () => {
      await expect(
        handlers['providers.create'](ctx, { input: { ...deepseek, baseUrl: '' } })
      ).rejects.toMatchObject({ code: 'validation' })
    })

    it('rejects a preset that requires a key when none is given', async () => {
      await expect(
        handlers['providers.create'](ctx, { input: { ...deepseek, apiKey: '' } })
      ).rejects.toMatchObject({ code: 'validation' })
    })

    it('accepts a local preset with no key at all', async () => {
      const created = await handlers['providers.create'](ctx, {
        input: {
          type: 'openai-compatible',
          name: 'Ollama',
          baseUrl: 'http://localhost:11434/v1',
          presetId: 'ollama',
          models: []
        }
      })

      expect(created).toMatchObject({ hasApiKey: false, presetId: 'ollama' })
    })

    it('keeps the stored key when the patch omits apiKey, and clears it on an empty string', async () => {
      const created = await handlers['providers.create'](ctx, { input: deepseek })

      const renamed = await handlers['providers.update'](ctx, {
        id: created.id,
        patch: { name: 'DeepSeek (work)' }
      })
      expect(renamed).toMatchObject({ name: 'DeepSeek (work)', hasApiKey: true })

      const cleared = await handlers['providers.update'](ctx, {
        id: created.id,
        patch: { apiKey: '' }
      })
      expect(cleared.hasApiKey).toBe(false)
      expect(ctx.repos.providers.getApiKeyCiphertext(created.id, ctx.userId)).toBeNull()
    })

    it('replaces the model list on update', async () => {
      const created = await handlers['providers.create'](ctx, { input: deepseek })

      const updated = await handlers['providers.update'](ctx, {
        id: created.id,
        patch: { models: ['deepseek-chat', 'deepseek-reasoner'] }
      })

      expect(updated.models).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    })

    it('rejects a malformed patch rather than storing it', async () => {
      const created = await handlers['providers.create'](ctx, { input: deepseek })

      await expect(
        handlers['providers.update'](ctx, { id: created.id, patch: { models: 'nope' as never } })
      ).rejects.toMatchObject({ code: 'validation' })
      await expect(
        handlers['providers.update'](ctx, { id: created.id, patch: { name: '' } })
      ).rejects.toMatchObject({ code: 'validation' })
    })

    it('deletes a provider and then reports it as not found', async () => {
      const created = await handlers['providers.create'](ctx, { input: deepseek })

      await handlers['providers.delete'](ctx, { id: created.id })

      await expect(handlers['providers.list'](ctx)).resolves.toEqual([])
      await expect(handlers['providers.get'](ctx, { id: created.id })).rejects.toMatchObject({
        code: 'not_found'
      })
    })

    it('scopes every read to the context user', async () => {
      const created = await handlers['providers.create'](ctx, { input: deepseek })
      const other: AppContext = { ...ctx, userId: 'someone-else' }

      await expect(handlers['providers.list'](other)).resolves.toEqual([])
      await expect(handlers['providers.get'](other, { id: created.id })).rejects.toMatchObject({
        code: 'not_found'
      })
    })

    it('fetches models for an unsaved draft, before the provider exists', async () => {
      const requests: string[] = []
      const fetchImpl: FetchImpl = (input, init) => {
        requests.push(String((init?.headers as Record<string, string>)?.['Authorization'] ?? ''))
        expect(String(input)).toBe('https://api.deepseek.com/v1/models')
        return Promise.resolve(
          new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }), { status: 200 })
        )
      }
      const drafting = createTestContext(database, fetchImpl)

      await expect(
        handlers['providers.fetchModels'](drafting.ctx, { provider: { draft: deepseek } })
      ).resolves.toEqual(['deepseek-chat'])

      // The draft's plaintext key is used directly: nothing was stored to decrypt.
      expect(requests).toEqual(['Bearer sk-secret'])
      await expect(handlers['providers.list'](drafting.ctx)).resolves.toEqual([])
    })

    it('fetches models for a saved provider by decrypting the stored key', async () => {
      const created = await handlers['providers.create'](ctx, { input: deepseek })
      const seen: string[] = []
      const fetchImpl: FetchImpl = (_input, init) => {
        seen.push(String((init?.headers as Record<string, string>)?.['Authorization'] ?? ''))
        return Promise.resolve(
          new Response(JSON.stringify({ data: [{ id: 'deepseek-reasoner' }] }), { status: 200 })
        )
      }

      await expect(
        handlers['providers.fetchModels'](
          { ...ctx, fetchImpl },
          { provider: { id: created.id } }
        )
      ).resolves.toEqual(['deepseek-reasoner'])

      expect(seen).toEqual(['Bearer sk-secret'])
    })

    it('surfaces a provider HTTP failure as provider_error with its status', async () => {
      const fetchImpl: FetchImpl = () => Promise.resolve(new Response('nope', { status: 401 }))

      await expect(
        handlers['providers.fetchModels'](
          { ...ctx, fetchImpl },
          { provider: { draft: deepseek } }
        )
      ).rejects.toMatchObject({ code: 'provider_error', details: { status: 401 } })
    })

    it('rejects a malformed provider reference', async () => {
      await expect(
        handlers['providers.fetchModels'](ctx, { provider: {} as never })
      ).rejects.toMatchObject({ code: 'validation' })
    })
  })
})

describe('handlers/stubs', () => {
  /**
   * What is left is `system.pickFolder`, which is declared here and implemented
   * in `src/main/ipc/dialogs.ts` because it is the one method that needs a
   * window. Outside the Electron transport it must reject rather than resolve
   * `null`, which would look to the renderer like the user cancelling.
   */
  it('every method the Electron-free layer cannot implement rejects rather than resolving undefined', async () => {
    const handlers = buildHandlers()
    const implemented = new Set<BackendMethod>([
      'system.ping',
      'system.emitTestEvent',
      'settings.get',
      'settings.update',
      'providers.list',
      'providers.get',
      'providers.create',
      'providers.update',
      'providers.delete',
      'providers.fetchModels',
      'providers.testConnection',
      // S1.7
      'agents.list',
      // S2.1
      'agents.get',
      'agents.create',
      'agents.update',
      'agents.delete',
      'chats.list',
      'chats.get',
      'chats.create',
      'chats.update',
      'chats.delete',
      'chats.members.list',
      'chats.members.set',
      'messages.list',
      'chat.send',
      'chat.stop',
      // S2.4
      'presence.list',
      'presence.retry',
      // S3.1
      'mcp.list',
      'mcp.create',
      'mcp.update',
      'mcp.delete',
      'mcp.testConnection',
      'mcp.tools',
      'mcp.log',
      // S3.2
      'skills.list',
      'skills.import',
      'skills.read',
      'skills.delete',
      // S3.3
      'memory.list',
      'memory.read',
      'memory.write',
      'memory.delete',
      'memory.search'
    ])
    const ctx = { userId: LOCAL_USER_ID } as AppContext

    for (const method of BACKEND_METHODS) {
      if (implemented.has(method)) continue
      const call = handlers[method] as (context: AppContext, input?: unknown) => Promise<unknown>
      await expect(call(ctx, {})).rejects.toMatchObject({ code: 'internal' })
    }
  })
})

describe('handlers/secret store warning', () => {
  it('does not warn until a secret is actually handled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createInsecureSecretStore()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
