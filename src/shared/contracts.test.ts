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
  IDLE_UPDATE_STATUS,
  UNSUPPORTED_REASONS,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_STATES,
  type UnsupportedReason,
  type UpdateState,
  type UpdateStatus
} from '@shared/updates'
import {
  COMMAND_RISK_REASONS,
  DEFAULT_APP_SETTINGS,
  DEFAULT_CHAT_SETTINGS,
  DEFAULT_EDITOR_COMMAND,
  EDITOR_KINDS,
  LOCAL_USER_ID,
  type CommandRisk,
  type CommandRiskReason,
  type CommandVerdict,
  type HandoffIntent,
  type Message,
  type MessagePart,
  type PermissionDecision,
  type PermissionGrant,
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
  'system.updateStatus',
  'system.checkForUpdates',
  'system.installUpdate',
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
  'providers.setQuotaProject',
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
  'permissions.grants.list',
  'permissions.grants.revoke',
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
      // Two namespaces rather than one, and deliberately: `permission.reply`
      // answers **a** prompt and `permissions.grants.*` manages the standing
      // grants of a chat. Folding the second into the first would have made
      // `permission.grants.revoke` read as an operation on the pending request.
      'permission',
      'permissions',
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
      // S5.15: `run_command` is confined by `sandbox-exec` unless the user turns
      // it off. The safe value is the default, because the setting exists for
      // the command the profile is too tight for, not the other way round.
      executor: {
        sandbox: 'workdir-write'
      },
      timeouts: {
        stallTimeoutMs: 30000,
        hardTimeoutMs: 120000,
        toolTimeoutMs: 60000,
        // S5.15: five minutes, much longer than the other three, because what is
        // being waited for is a person reading a diff.
        permissionTimeoutMs: 300000
      },
      // S7.5: the first-run card has not been skipped on an installation that
      // has never been opened, which is the only way it can ever be shown.
      onboardingDismissed: false
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
    // S5.14: the per-chain round cap "Start a vote" sends, optional so every
    // ordinary send is unchanged.
    expectTypeOf<Parameters<BackendApi['chat.send']>[0]['rounds']>().toEqualTypeOf<
      number | undefined
    >()
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
    // S5.15 added `'timeout'`: a prompt nobody answered is a different fact
    // about the user than one they looked at and declined.
    expectTypeOf<EventOf<'permission.resolved'>['decision']>().toEqualTypeOf<
      PermissionDecision | 'aborted' | 'timeout'
    >()
    expectTypeOf<Parameters<BackendApi['permission.reply']>[0]>().toEqualTypeOf<{
      requestId: string
      decision: PermissionDecision
    }>()
  })

  it('carries the command policy verdict on a run_command prompt (S5.15)', () => {
    // Optional, because only `run_command` has a verdict and a `normal` one is
    // not sent at all: a card with nothing to warn about must draw no warning.
    expectTypeOf<EventOf<'permission.requested'>['risk']>().toEqualTypeOf<CommandRisk | undefined>()
    expectTypeOf<CommandRisk['verdict']>().toEqualTypeOf<CommandVerdict>()
    expectTypeOf<CommandRisk['reason']>().toEqualTypeOf<CommandRiskReason | null>()
    expect(COMMAND_RISK_REASONS).toContain('privilege-escalation')
  })

  it('lists and revokes the standing grants of one chat (S5.15)', () => {
    expectTypeOf<Parameters<BackendApi['permissions.grants.list']>[0]>().toEqualTypeOf<{
      chatId: string
    }>()
    expectTypeOf<Parameters<BackendApi['permissions.grants.revoke']>[0]>().toEqualTypeOf<{
      chatId: string
      toolName: string
    }>()
    // Revoke answers with what is left rather than `void`: the settings list is
    // redrawn from the backend's answer, never from an optimistic removal.
    expectTypeOf<ReturnType<BackendApi['permissions.grants.revoke']>>().toEqualTypeOf<
      Promise<PermissionGrant[]>
    >()
    expectTypeOf<PermissionGrant>().toHaveProperty('createdAt')
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

  it('carries the auto-update status and its two announcements (S7.4)', () => {
    // The status is the *whole* answer: the screen shows the state, the version
    // and the reason a build cannot update, so none of them may be squeezed out
    // into a second call.
    expectTypeOf<ReturnType<BackendApi['system.updateStatus']>>().toEqualTypeOf<
      Promise<UpdateStatus>
    >()
    expectTypeOf<ReturnType<BackendApi['system.checkForUpdates']>>().toEqualTypeOf<
      Promise<UpdateStatus>
    >()
    expectTypeOf<Parameters<BackendApi['system.installUpdate']>>().toEqualTypeOf<[]>()
    expectTypeOf<UpdateStatus['state']>().toEqualTypeOf<UpdateState>()
    expectTypeOf<UpdateStatus['reason']>().toEqualTypeOf<UnsupportedReason | undefined>()

    // Both events name the version: a notice bar that said "an update is ready"
    // without saying which would be untestable and unhelpful in a bug report.
    expectTypeOf<EventOf<'update.available'>['version']>().toBeString()
    expectTypeOf<EventOf<'update.downloaded'>['version']>().toBeString()
  })

  it('names every update state and every unsupported reason exactly once', () => {
    expect([...UPDATE_STATES]).toEqual([
      'idle',
      'checking',
      'available',
      'downloading',
      'downloaded',
      'up-to-date',
      'error',
      'unsupported'
    ])
    expect([...UNSUPPORTED_REASONS]).toEqual(['unsigned', 'development'])
    expect(IDLE_UPDATE_STATUS).toEqual({ state: 'idle' })
    // Six hours, as S7.4 specifies.
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000)
  })

  it('returns an unsubscribe function from subscribe', () => {
    expectTypeOf<ReturnType<BackendClient['subscribe']>>().toEqualTypeOf<() => void>()
  })
})
