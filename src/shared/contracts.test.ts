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
  LOCAL_USER_ID,
  type Message,
  type MessagePart,
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
  'settings.get',
  'settings.update',
  'providers.list',
  'providers.get',
  'providers.create',
  'providers.update',
  'providers.delete',
  'providers.fetchModels',
  'providers.testConnection',
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
  'memory.list',
  'memory.read',
  'memory.write',
  'chats.list',
  'chats.get',
  'chats.create',
  'chats.update',
  'chats.delete',
  'chats.members.list',
  'chats.members.set',
  'presence.list',
  'presence.retry',
  'messages.list',
  'chat.send',
  'chat.stop'
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

  it('follows the system language on a fresh installation', () => {
    expect(DEFAULT_APP_SETTINGS).toEqual({
      language: 'system',
      theme: 'dark',
      timeouts: {
        stallTimeoutMs: 30000,
        hardTimeoutMs: 120000,
        toolTimeoutMs: 60000
      }
    })
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

  it('returns an unsubscribe function from subscribe', () => {
    expectTypeOf<ReturnType<BackendClient['subscribe']>>().toEqualTypeOf<() => void>()
  })
})
