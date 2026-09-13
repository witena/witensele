import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  BACKEND_METHODS,
  isBackendMethod,
  type BackendApi,
  type BackendClient,
  type BackendMethod
} from '@shared/backend'
import type { BackendEvent, BackendEventType, EventOf, MessageDelta } from '@shared/events'
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_CHAT_SETTINGS,
  DEFAULT_EDITOR_COMMAND,
  EDITOR_KINDS,
  LOCAL_USER_ID,
  type HandoffIntent,
  type Message,
  type MessagePart,
  type PermissionDecision,
  type Provider
} from '@shared/types'

/**
 * The expected method list is written out by hand on purpose: it must fail when
 * someone renames or drops a method, which a list derived from `BackendApi`
 * never would.
 */
const EXPECTED_METHODS = [
  'system.ping',
  'system.emitTestEvent',
  'system.pickFolder',
  'system.pickSavePath',
  'system.pickPaths',
  'system.applyTheme',
  'system.openInEditor',
  'settings.get',
  'settings.update',
  'providers.list',
  'providers.get',
  'providers.create',
  'providers.update',
  'providers.delete',
  'providers.fetchModels',
  'providers.testConnection',
  'providers.authStatus',
  'providers.login',
  'providers.logout',
  'agents.list',
  'agents.get',
  'agents.create',
  'agents.update',
  'agents.delete',
  'mcp.list',
  'mcp.create',
  'mcp.update',
  'mcp.delete',
  'mcp.testConnection',
  'mcp.tools',
  'mcp.log',
  'skills.list',
  'skills.import',
  'skills.read',
  'skills.delete',
  'memory.list',
  'memory.read',
  'memory.write',
  'memory.delete',
  'memory.search',
  'chats.list',
  'chats.get',
  'chats.create',
  'chats.update',
  'chats.delete',
  'chats.search',
  'chats.goalStatus',
  'chats.members.list',
  'chats.members.set',
  'presence.list',
  'presence.retry',
  'messages.list',
  'messages.usageSummary',
  'permission.reply',
  'chat.send',
  'chat.stop',
  'chat.handoff'
]

describe('BACKEND_METHODS', () => {
  it('lists exactly the expected methods', () => {
    expect([...BACKEND_METHODS].sort()).toEqual([...EXPECTED_METHODS].sort())
  })

  it('has no duplicates', () => {
    expect(new Set(BACKEND_METHODS).size).toBe(BACKEND_METHODS.length)
  })

  it('uses namespace.method names only', () => {
    for (const method of BACKEND_METHODS) {
      expect(method).toMatch(/^[a-z]+(\.[a-zA-Z]+)+$/)
    }
  })

  it('covers every namespace the MVP needs', () => {
    const namespaces = new Set(BACKEND_METHODS.map((method) => method.split('.')[0]))
    expect([...namespaces].sort()).toEqual([
      'agents',
      'chat',
      'chats',
      'mcp',
      'memory',
      'messages',
      'permission',
      'presence',
      'providers',
      'settings',
      'skills',
      'system'
    ])
  })
})

describe('isBackendMethod', () => {
  it('accepts a declared method', () => {
    expect(isBackendMethod('system.ping')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isBackendMethod('system.reboot')).toBe(false)
    expect(isBackendMethod(42)).toBe(false)
    expect(isBackendMethod(undefined)).toBe(false)
  })
})

describe('defaults', () => {
  it('starts a chat in roundrobin / sequential with three automatic rounds', () => {
    expect(DEFAULT_CHAT_SETTINGS).toEqual({
      mode: 'roundrobin',
      speaking: 'sequential',
      maxAutoRounds: 3
    })
  })

  it('leaves the per-chat timeout overrides unset', () => {
    expect(DEFAULT_CHAT_SETTINGS.stallTimeoutMs).toBeUndefined()
    expect(DEFAULT_CHAT_SETTINGS.hardTimeoutMs).toBeUndefined()
  })

  it('follows the system language and appearance on a fresh installation', () => {
    expect(DEFAULT_APP_SETTINGS).toEqual({
      language: 'system',
      // S5.8: `theme` used to be the single value `dark`. A stored `'dark'` still
      // means dark; only a *fresh* installation now follows the machine.
      theme: 'system',
      // S5.7: VS Code by default, because it is the editor the product tour
      // shows and the one whose URL scheme needs nothing on the `PATH`. The
      // command template is only read for `kind: 'custom'`, but it is stored
      // from the start so switching to custom offers a working line rather than
      // an empty field.
      editor: {
        kind: 'vscode',
        command: 'code -g {path}:{line}'
      },
      timeouts: {
        stallTimeoutMs: 30000,
        hardTimeoutMs: 120000,
        toolTimeoutMs: 60000
      }
    })
    expect(DEFAULT_APP_SETTINGS.editor.command).toBe(DEFAULT_EDITOR_COMMAND)
    expect(EDITOR_KINDS).toEqual(['vscode', 'cursor', 'custom'])
  })

  it('fixes the local user id', () => {
    expect(LOCAL_USER_ID).toBe('local')
  })
})

describe('type contracts', () => {
  it('narrows events by their type tag', () => {
    expectTypeOf<EventOf<'message.delta'>>().toHaveProperty('delta')
    expectTypeOf<EventOf<'message.delta'>['delta']>().toEqualTypeOf<MessageDelta>()
    expectTypeOf<EventOf<'message.created'>['message']>().toEqualTypeOf<Message>()
    expectTypeOf<EventOf<'system.test'>['payload']>().toBeString()
    expectTypeOf<BackendEventType>().toEqualTypeOf<BackendEvent['type']>()
  })

  it('takes a single object argument on every write method', () => {
    expectTypeOf<Parameters<BackendApi['chat.send']>[0]>().toHaveProperty('chatId')
    expectTypeOf<Parameters<BackendApi['chat.send']>[0]['text']>().toBeString()
    expectTypeOf<Parameters<BackendApi['chats.members.set']>[0]>().toEqualTypeOf<{
      chatId: string
      agentIds: string[]
    }>()
    expectTypeOf<Parameters<BackendApi['system.ping']>>().toEqualTypeOf<[]>()
    expectTypeOf<ReturnType<BackendApi['system.ping']>>().toEqualTypeOf<Promise<'pong'>>()
  })

  it('keeps every method name assignable to BackendMethod', () => {
    expectTypeOf<(typeof BACKEND_METHODS)[number]>().toEqualTypeOf<BackendMethod>()
  })

  it('never exposes an api key to the renderer', () => {
    expectTypeOf<Provider>().not.toHaveProperty('apiKey')
    expectTypeOf<Provider['hasApiKey']>().toBeBoolean()
  })

  it('carries timestamps as epoch milliseconds', () => {
    expectTypeOf<Message['createdAt']>().toBeNumber()
    expectTypeOf<Message['updatedAt']>().toBeNumber()
  })

  it('sends system copy as an i18n key rather than a sentence', () => {
    type SystemNotice = Extract<MessagePart, { type: 'system-notice' }>
    expectTypeOf<SystemNotice['key']>().toBeString()
    expectTypeOf<SystemNotice>().not.toHaveProperty('text')
  })

  it('carries the executor permission prompt and its resolution (S5.4)', () => {
    expectTypeOf<EventOf<'permission.requested'>['requestId']>().toBeString()
    expectTypeOf<EventOf<'permission.requested'>['toolName']>().toBeString()
    expectTypeOf<EventOf<'permission.resolved'>['decision']>().toEqualTypeOf<
      PermissionDecision | 'aborted'
    >()
    expectTypeOf<Parameters<BackendApi['permission.reply']>[0]>().toEqualTypeOf<{
      requestId: string
      decision: PermissionDecision
    }>()
  })

  it('hands a chat to its executor with the chat id and an optional intent (S5.6, S5.12)', () => {
    // The executor, the folder and the review round are all decided in the
    // backend from the chat record: a renderer that had to name the executor
    // could name a different one than `executorWorkdir` attaches the tools to.
    //
    // `intent` is the one thing the renderer does say, and it is **optional**:
    // S5.6's button sends nothing and gets `'implement'`, S5.12's quick action
    // sends `'deliver'`. A second method would have been `handoff()` copied for
    // the sake of one paragraph of briefing.
    expectTypeOf<Parameters<BackendApi['chat.handoff']>[0]>().toEqualTypeOf<{
      chatId: string
      intent?: HandoffIntent
    }>()
    expectTypeOf<HandoffIntent>().toEqualTypeOf<'implement' | 'deliver'>()
    // The stored hand-off message comes back, like `chat.send`'s.
    expectTypeOf<ReturnType<BackendApi['chat.handoff']>>().toEqualTypeOf<Promise<Message>>()
  })

  it('returns an unsubscribe function from subscribe', () => {
    expectTypeOf<ReturnType<BackendClient['subscribe']>>().toEqualTypeOf<() => void>()
  })
})
