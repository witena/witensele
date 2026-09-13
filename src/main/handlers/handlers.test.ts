import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKEND_METHODS, type BackendMethod } from '@shared/backend'
import type { BackendEvent } from '@shared/events'
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_EDITOR_COMMAND,
  EDITOR_KINDS,
  LOCAL_USER_ID,
  THEME_SETTINGS,
  type AnthropicAuthState,
  type AnthropicAuthStatus,
  type ProviderInput
} from '@shared/types'
import type { AppContext } from '../app-context'
import { createTestDatabase, type TestDatabase } from '../db/testing'
import { createInsecureSecretStore } from '../secrets'
import type { FetchImpl } from '../providers/discovery'
import { createTestAppContext, type TestAppContext } from '../testing'
import { buildHandlers, notImplemented } from './index'
import { OPEN_IN_EDITOR_UNAVAILABLE } from './system'

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

  /**
   * The half of `system.openInEditor` the Electron-free layer really implements
   * (S5.7). The URL half rejects here and is layered over by
   * `src/main/ipc/editor.ts`; the path rules themselves are covered in
   * `src/main/editor/open.test.ts`, so these are the handler's own three answers.
   */
  describe('system.openInEditor', () => {
    let root: string
    let chatId: string

    beforeEach(() => {
      // Realpathed for the same reason `editor/open.test.ts` does it: macOS puts
      // `tmpdir()` behind the `/var` -> `/private/var` symlink.
      root = realpathSync(mkdtempSync(join(tmpdir(), 'witena-open-')))
      writeFileSync(join(root, 'a.ts'), 'export const answer = 42\n', 'utf8')
      chatId = ctx.repos.chats.create({ title: 'Bound', workdir: root }, ctx.userId).id
    })

    afterEach(() => {
      rmSync(root, { recursive: true, force: true })
    })

    it('rejects with a pointer at the overlay while the editor is a URL scheme', async () => {
      await expect(
        handlers['system.openInEditor'](ctx, { path: join(root, 'a.ts'), line: 3, chatId })
      ).rejects.toMatchObject({ code: 'internal', message: OPEN_IN_EDITOR_UNAVAILABLE })
    })

    it('runs a custom command line, with the path substituted and quoted', async () => {
      const marker = join(root, 'marker.txt')
      ctx.repos.settings.update(
        { editor: { kind: 'custom', command: `cat {path} > '${marker}'` } },
        ctx.userId
      )

      await handlers['system.openInEditor'](ctx, { path: join(root, 'a.ts'), chatId })

      // The child is detached and nothing is awaited by contract, so the file it
      // writes is the only observable and it has to be waited for.
      await expect
        .poll(() => (existsSync(marker) ? readFileSync(marker, 'utf8') : null), { timeout: 5_000 })
        .toBe('export const answer = 42\n')
    })

    it('refuses a path outside the chat folder before reading the setting', async () => {
      ctx.repos.settings.update({ editor: { kind: 'custom' } }, ctx.userId)

      await expect(
        handlers['system.openInEditor'](ctx, { path: '/etc/passwd', chatId })
      ).rejects.toMatchObject({
        code: 'validation',
        details: { reason: 'editor_path_outside_workdir' }
      })
    })

    it('refuses a relative path', async () => {
      await expect(
        handlers['system.openInEditor'](ctx, { path: 'a.ts', chatId })
      ).rejects.toMatchObject({
        code: 'validation',
        details: { reason: 'editor_path_not_absolute' }
      })
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

    it('stores each of the three themes', async () => {
      for (const theme of THEME_SETTINGS) {
        const updated = await handlers['settings.update'](ctx, { patch: { theme } })
        expect(updated.theme).toBe(theme)
      }
    })

    it('rejects a theme that is not one of them', async () => {
      // The one setting whose *value* is validated (S5.8): a stored `'sepia'`
      // would resolve to light and leave the user with a theme no control in the
      // app explains.
      await expect(
        handlers['settings.update'](ctx, { patch: { theme: 'sepia' as never } })
      ).rejects.toMatchObject({ code: 'validation' })

      await expect(handlers['settings.get'](ctx)).resolves.toEqual(DEFAULT_APP_SETTINGS)
    })

    it('rejects unknown keys instead of storing them', async () => {
      await expect(
        handlers['settings.update'](ctx, { patch: { nope: true } as never })
      ).rejects.toMatchObject({ code: 'validation' })

      await expect(handlers['settings.get'](ctx)).resolves.toEqual(DEFAULT_APP_SETTINGS)
    })

    it('stores each of the three editor kinds', async () => {
      for (const kind of EDITOR_KINDS) {
        const updated = await handlers['settings.update'](ctx, { patch: { editor: { kind } } })
        expect(updated.editor.kind).toBe(kind)
        // Field by field, like `timeouts`: the kind is a click and the command is
        // a field that commits on blur, so neither may clear the other (S5.7).
        expect(updated.editor.command).toBe(DEFAULT_EDITOR_COMMAND)
      }
    })

    it('merges the editor command without touching the kind', async () => {
      await handlers['settings.update'](ctx, { patch: { editor: { kind: 'custom' } } })
      const updated = await handlers['settings.update'](ctx, {
        patch: { editor: { command: 'subl {path}:{line}' } }
      })

      expect(updated.editor).toEqual({ kind: 'custom', command: 'subl {path}:{line}' })
    })

    it('rejects an editor kind that is not one of them', async () => {
      await expect(
        handlers['settings.update'](ctx, { patch: { editor: { kind: 'emacs' as never } } })
      ).rejects.toMatchObject({ code: 'validation' })

      await expect(handlers['settings.get'](ctx)).resolves.toEqual(DEFAULT_APP_SETTINGS)
    })

    it('rejects a blank or non-string editor command', async () => {
      for (const command of ['', '   ', 42 as never]) {
        await expect(
          handlers['settings.update'](ctx, { patch: { editor: { command } } })
        ).rejects.toMatchObject({ code: 'validation' })
      }

      await expect(handlers['settings.get'](ctx)).resolves.toEqual(DEFAULT_APP_SETTINGS)
    })

    it('rejects an editor patch that is not an object, and unknown keys in it', async () => {
      await expect(
        handlers['settings.update'](ctx, { patch: { editor: 'vscode' as never } })
      ).rejects.toMatchObject({ code: 'validation' })
      await expect(
        handlers['settings.update'](ctx, { patch: { editor: { nope: true } as never } })
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

    /* -- sign-in mode (S5.3) --------------------------------------------- */

    /** An Anthropic provider that authenticates with the user's account. */
    const signedInProvider: ProviderInput = {
      type: 'anthropic',
      name: 'Claude',
      presetId: 'anthropic',
      models: ['claude-sonnet-4-5'],
      auth: 'oauth'
    }

    /** A context whose CLI reports a logged-in profile, spawning nothing. */
    function withCli(state: AnthropicAuthState): AppContext {
      const status = (): Promise<AnthropicAuthStatus> => Promise.resolve({ state })
      return {
        ...ctx,
        anthropicCli: {
          status,
          login: status,
          logout: status,
          accessToken: () => Promise.resolve('oat-token')
        }
      }
    }

    it('saves a provider that signs in with no key at all', async () => {
      const created = await handlers['providers.create'](withCli('signed-in'), {
        input: signedInProvider
      })

      expect(created).toMatchObject({ auth: 'oauth', hasApiKey: false })
      expect(ctx.repos.providers.getApiKeyCiphertext(created.id, ctx.userId)).toBeNull()
    })

    it('refuses to sign in with a provider type that has no flow yet', async () => {
      await expect(
        handlers['providers.create'](withCli('signed-in'), {
          input: { ...signedInProvider, type: 'openai', name: 'OpenAI', presetId: 'openai' }
        })
      ).rejects.toMatchObject({
        code: 'validation',
        details: { reason: 'oauth_unsupported_provider' }
      })
    })

    it('refuses to point an account credential at a custom endpoint', async () => {
      await expect(
        handlers['providers.create'](withCli('signed-in'), {
          input: { ...signedInProvider, baseUrl: 'https://proxy.example.com' }
        })
      ).rejects.toMatchObject({
        code: 'validation',
        details: { reason: 'oauth_custom_base_url' }
      })
    })

    it('rejects an authentication mode that is not one of the two', async () => {
      await expect(
        handlers['providers.create'](ctx, {
          input: { ...signedInProvider, auth: 'magic' as never }
        })
      ).rejects.toMatchObject({ code: 'validation' })
    })

    it('refuses to save a sign-in provider when the CLI is missing or signed out', async () => {
      await expect(
        handlers['providers.create'](withCli('not-installed'), { input: signedInProvider })
      ).rejects.toMatchObject({ code: 'ant_missing' })

      await expect(
        handlers['providers.create'](withCli('signed-out'), { input: signedInProvider })
      ).rejects.toMatchObject({ code: 'ant_not_logged_in' })

      await expect(handlers['providers.list'](ctx)).resolves.toEqual([])
    })

    it('checks the merged record on update, not the patch alone', async () => {
      const keyed = await handlers['providers.create'](ctx, {
        input: {
          type: 'openai',
          name: 'OpenAI',
          presetId: 'openai',
          models: ['gpt-4o'],
          apiKey: 'sk-openai'
        }
      })

      // `{ auth: 'oauth' }` says nothing on its own; the stored type refuses it.
      await expect(
        handlers['providers.update'](withCli('signed-in'), {
          id: keyed.id,
          patch: { auth: 'oauth' }
        })
      ).rejects.toMatchObject({ details: { reason: 'oauth_unsupported_provider' } })

      const anthropic = await handlers['providers.create'](ctx, {
        input: { type: 'anthropic', name: 'Claude', models: [], apiKey: 'sk-ant' }
      })
      const switched = await handlers['providers.update'](withCli('signed-in'), {
        id: anthropic.id,
        patch: { auth: 'oauth' }
      })

      expect(switched.auth).toBe('oauth')
    })

    it('reads the model list with a bearer token and no key header', async () => {
      const seen: Record<string, string>[] = []
      const fetchImpl: FetchImpl = (_input, init) => {
        const headers: Record<string, string> = {}
        new Headers(init?.headers).forEach((value, key) => {
          headers[key] = value
        })
        seen.push(headers)
        return Promise.resolve(
          new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-4-5' }] }), { status: 200 })
        )
      }

      await expect(
        handlers['providers.fetchModels'](
          { ...withCli('signed-in'), fetchImpl },
          { provider: { draft: signedInProvider } }
        )
      ).resolves.toEqual(['claude-sonnet-4-5'])

      expect(seen[0]?.['authorization']).toBe('Bearer oat-token')
      expect(seen[0]?.['x-api-key']).toBeUndefined()
      expect(seen[0]?.['anthropic-beta']).toContain('oauth-2025-04-20')
      expect(seen[0]?.['anthropic-version']).toBe('2023-06-01')
    })

    it('answers the three auth methods straight from the CLI', async () => {
      const signedIn = withCli('signed-in')

      await expect(handlers['providers.authStatus'](signedIn)).resolves.toEqual({
        state: 'signed-in'
      })
      await expect(handlers['providers.login'](signedIn)).resolves.toEqual({ state: 'signed-in' })
      await expect(handlers['providers.logout'](withCli('signed-out'))).resolves.toEqual({
        state: 'signed-out'
      })
    })

    it('answers "not installed" as a status, but refuses to run a sign-in', async () => {
      // The default test context has no CLI at all, which is the state of a
      // machine that never installed one. Asking *about* it is fine; asking it
      // to do something is the failure the panel's error line shows.
      await expect(handlers['providers.authStatus'](ctx)).resolves.toEqual({
        state: 'not-installed'
      })
      await expect(handlers['providers.login'](ctx)).rejects.toMatchObject({
        code: 'ant_missing'
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
   * What is left is the methods that need a window: the three native dialogs
   * (`system.pickFolder`, and S5.10's `system.pickSavePath` / `system.pickPaths`)
   * implemented in `src/main/ipc/dialogs.ts`, and `system.applyTheme` (S5.8), in
   * `src/main/ipc/theme.ts`. Outside the Electron transport all of them must
   * reject rather than resolve — `null` or `[]` would look to the renderer like
   * the user cancelling, and a silent `undefined` like window chrome that was
   * tinted.
   *
   * `system.openInEditor` (S5.7) is excluded from the sweep rather than listed
   * as a stub, because it is the one method that is *conditionally* electron:
   * with `editor.kind: 'custom'` it runs here, and it reaches the database before
   * it can decide, which this sweep's context-shaped `{ userId }` has no room
   * for. Both of its branches have their own cases above.
   *
   * `chats.goalStatus` (S5.10) is excluded for the ordinary reason: it is a real
   * handler, implemented in `handlers/chats.ts`, and it is listed with the rest
   * of the implemented surface below.
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
      'memory.search',
      // S4.1, S4.3
      'chats.search',
      'messages.usageSummary',
      // S5.3
      'providers.authStatus',
      'providers.login',
      'providers.logout',
      // S5.4
      'permission.reply',
      // S5.6
      'chat.handoff',
      // S5.7 — see the comment above: half of it is implemented here.
      'system.openInEditor',
      // S5.10
      'chats.goalStatus'
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
