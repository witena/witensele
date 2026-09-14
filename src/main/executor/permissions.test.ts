/**
 * The permission gate on its own: an array of events and an `AbortController`.
 *
 * The gate is the one object in the executor feature with no filesystem and no
 * model in it, so it is tested exactly as it is written — `ask` in, events out,
 * `reply` back in. The cases are the five the step names (allow, deny, always,
 * abort by signal, an unknown `requestId`) plus the two invariants that make the
 * renderer's job possible: one `permission.resolved` per `permission.requested`,
 * always, and a remembered grant that never asks again.
 */
import { describe, expect, it } from 'vitest'
import type { BackendEvent, PermissionRequestedEvent } from '@shared/events'
import { isBackendFailure } from '../errors'
import { createPermissionGate, type PermissionGate } from './permissions'

interface Harness {
  gate: PermissionGate
  events: BackendEvent[]
  requested: () => PermissionRequestedEvent[]
  resolvedDecisions: () => string[]
}

function harness(): Harness {
  const events: BackendEvent[] = []
  let counter = 0
  const gate = createPermissionGate({
    emit: (event) => events.push(event),
    newRequestId: () => `request-${(counter += 1)}`
  })
  return {
    gate,
    events,
    requested: () =>
      events.filter((event): event is PermissionRequestedEvent => event.type === 'permission.requested'),
    resolvedDecisions: () =>
      events
        .filter((event) => event.type === 'permission.resolved')
        .map((event) => (event as { decision: string }).decision)
  }
}

const ask = (gate: PermissionGate, options: { toolName?: string; chatId?: string; signal?: AbortSignal } = {}) =>
  gate.ask({
    chatId: options.chatId ?? 'chat-1',
    agentId: 'agent-1',
    toolName: options.toolName ?? 'write_file',
    input: { path: 'README.md' },
    signal: options.signal ?? new AbortController().signal
  })

describe('PermissionGate', () => {
  it('emits permission.requested and waits', async () => {
    const { gate, requested } = harness()

    const pending = ask(gate)
    await Promise.resolve()

    expect(requested()).toEqual([
      {
        type: 'permission.requested',
        requestId: 'request-1',
        chatId: 'chat-1',
        agentId: 'agent-1',
        toolName: 'write_file',
        input: { path: 'README.md' }
      }
    ])
    expect(gate.pending()).toEqual(['request-1'])

    gate.reply({ requestId: 'request-1', decision: 'allow' })
    await expect(pending).resolves.toEqual({ allowed: true, remembered: false })
    expect(gate.pending()).toEqual([])
  })

  it('resolves as denied when the user declines', async () => {
    const { gate, resolvedDecisions } = harness()

    const pending = ask(gate)
    gate.reply({ requestId: 'request-1', decision: 'deny' })

    await expect(pending).resolves.toEqual({ allowed: false, reason: 'denied' })
    expect(resolvedDecisions()).toEqual(['deny'])
  })

  it('remembers allowAlways per chat and tool, and stops asking', async () => {
    const { gate, requested } = harness()

    const first = ask(gate)
    gate.reply({ requestId: 'request-1', decision: 'allowAlways' })
    await expect(first).resolves.toEqual({ allowed: true, remembered: true })

    // The second call of the same tool in the same chat never reaches the user.
    await expect(ask(gate)).resolves.toEqual({ allowed: true, remembered: true })
    expect(requested()).toHaveLength(1)
  })

  it('does not carry a grant to another tool or another chat', async () => {
    const { gate } = harness()

    const first = ask(gate)
    gate.reply({ requestId: 'request-1', decision: 'allowAlways' })
    await first

    const otherTool = ask(gate, { toolName: 'run_command' })
    const otherChat = ask(gate, { chatId: 'chat-2' })
    expect(gate.pending()).toEqual(['request-2', 'request-3'])

    gate.reply({ requestId: 'request-2', decision: 'deny' })
    gate.reply({ requestId: 'request-3', decision: 'deny' })
    await expect(otherTool).resolves.toEqual({ allowed: false, reason: 'denied' })
    await expect(otherChat).resolves.toEqual({ allowed: false, reason: 'denied' })
  })

  it('closes a pending prompt when the turn is aborted', async () => {
    const { gate, resolvedDecisions } = harness()
    const controller = new AbortController()

    const pending = ask(gate, { signal: controller.signal })
    expect(gate.pending()).toEqual(['request-1'])
    controller.abort()

    await expect(pending).resolves.toEqual({ allowed: false, reason: 'aborted' })
    expect(resolvedDecisions()).toEqual(['aborted'])
    expect(gate.pending()).toEqual([])
  })

  it('answers a signal that was already aborted without drawing a card', async () => {
    const { gate, events } = harness()
    const controller = new AbortController()
    controller.abort()

    await expect(ask(gate, { signal: controller.signal })).resolves.toEqual({
      allowed: false,
      reason: 'aborted'
    })
    // Neither event: a card that was dead before it was drawn is worse than none.
    expect(events).toEqual([])
  })

  it('rejects a reply to an unknown request id', () => {
    const { gate } = harness()

    expect(() => gate.reply({ requestId: 'request-404', decision: 'allow' })).toThrow(
      /Permission request not found/
    )
    try {
      gate.reply({ requestId: 'request-404', decision: 'allow' })
    } catch (error) {
      expect(isBackendFailure(error) && error.code).toBe('not_found')
    }
  })

  it('rejects the second reply to the same request', async () => {
    const { gate } = harness()

    const pending = ask(gate)
    gate.reply({ requestId: 'request-1', decision: 'allow' })
    await pending

    expect(() => gate.reply({ requestId: 'request-1', decision: 'deny' })).toThrow(/not found/)
  })

  it('emits exactly one resolution per request, however it ended', async () => {
    const { gate, events } = harness()
    const controller = new AbortController()

    const pending = ask(gate, { signal: controller.signal })
    gate.reply({ requestId: 'request-1', decision: 'allow' })
    // The abort lands after the answer; it must not produce a second resolution.
    controller.abort()
    await pending

    expect(events.map((event) => event.type)).toEqual([
      'permission.requested',
      'permission.resolved'
    ])
  })

  it('closes everything still open when the context shuts down', async () => {
    const { gate, resolvedDecisions } = harness()

    const first = ask(gate)
    const second = ask(gate, { toolName: 'run_command' })
    gate.abortAll()

    await expect(first).resolves.toEqual({ allowed: false, reason: 'aborted' })
    await expect(second).resolves.toEqual({ allowed: false, reason: 'aborted' })
    expect(resolvedDecisions()).toEqual(['aborted', 'aborted'])
    expect(gate.pending()).toEqual([])
  })
})
