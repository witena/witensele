/**
 * The presence state machine, driven by a clock the test owns.
 *
 * Every assertion here would otherwise take two minutes of wall time: the
 * default hard timeout is 120 s. `fakeClock()` implements the whole
 * `SupervisorClock` interface — `now`, `setInterval`, `clearInterval` — and
 * `advance(ms)` moves time forward *and* fires the registered intervals the right
 * number of times, in order, so the heartbeat under test is the real one rather
 * than a hand-called `tick()`.
 *
 * There is no database, no event bus and no network in this file: the supervisor
 * takes every one of those as an injected accessor (CLAUDE.md rule #5), which is
 * exactly what makes this suite possible.
 */
import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent, PresenceChangedEvent } from '@shared/events'
import type { AgentPresence } from '@shared/types'
import { isTimeoutAbort } from './abort-reasons'
import {
  AgentSupervisor,
  MAX_CONSECUTIVE_FAILURES,
  type AgentSupervisorOptions,
  type SupervisorClock
} from './supervisor'

interface FakeClock {
  clock: SupervisorClock
  /** Moves time forward, firing every interval whose period elapsed. */
  advance(ms: number): void
  /** Fires nothing; only moves the reading of `now()`. */
  set(ms: number): void
}

function fakeClock(start = 1_000_000): FakeClock {
  let current = start
  let nextId = 1
  const timers = new Map<number, { handler: () => void; period: number; nextAt: number }>()

  return {
    clock: {
      now: () => current,
      setInterval: (handler, ms) => {
        const id = nextId++
        timers.set(id, { handler, period: ms, nextAt: current + ms })
        return id
      },
      clearInterval: (handle) => {
        timers.delete(handle as number)
      }
    },
    set(ms) {
      current = ms
    },
    advance(ms) {
      const target = current + ms
      for (;;) {
        let due: { id: number; at: number } | null = null
        for (const [id, timer] of timers) {
          if (timer.nextAt <= target && (due === null || timer.nextAt < due.at)) {
            due = { id, at: timer.nextAt }
          }
        }
        if (!due) break
        const timer = timers.get(due.id)
        if (!timer) break
        current = due.at
        timer.nextAt = due.at + timer.period
        timer.handler()
      }
      current = target
    }
  }
}

const CHAT = 'chat-1'
const AGENT = 'agent-1'

interface Harness {
  supervisor: AgentSupervisor
  clock: FakeClock
  events: BackendEvent[]
  /** Every `presence.changed` payload, in order. */
  presences(): AgentPresence[]
  /** The `state` of every `presence.changed`, in order — the readable assertion. */
  states(): string[]
  probe: ReturnType<typeof vi.fn>
}

function harness(options: Partial<AgentSupervisorOptions> & { probeOk?: boolean } = {}): Harness {
  const clock = fakeClock()
  const events: BackendEvent[] = []
  const probe = vi.fn(async () => options.probeOk ?? false)
  const { probeOk: _probeOk, ...rest } = options

  const supervisor = new AgentSupervisor({
    emit: (event) => events.push(event),
    getTimeouts: () => ({ stallTimeoutMs: 30_000, hardTimeoutMs: 120_000 }),
    listChatIdsForAgent: () => [CHAT],
    listAgentIdsForChat: () => [AGENT],
    probeProvider: probe,
    clock: clock.clock,
    ...rest
  })

  const presences = (): AgentPresence[] =>
    events
      .filter((event): event is PresenceChangedEvent => event.type === 'presence.changed')
      .map((event) => event.presence)

  return { supervisor, clock, events, probe, presences, states: () => presences().map((p) => p.state) }
}

function begin(supervisor: AgentSupervisor, controller = new AbortController()): AbortController {
  supervisor.beginTurn({ chatId: CHAT, agentId: AGENT, messageId: 'message-1', controller })
  return controller
}

describe('AgentSupervisor', () => {
  it('starts an agent with no session as available', () => {
    const { supervisor } = harness()

    expect(supervisor.get(CHAT, AGENT).state).toBe('available')
    expect(supervisor.isOffline(AGENT)).toBe(false)
  })

  it('turns an agent working when its turn begins', () => {
    const { supervisor, states } = harness()

    begin(supervisor)

    expect(supervisor.get(CHAT, AGENT).state).toBe('working')
    expect(states()).toEqual(['working'])
  })

  it('goes away once the stall timeout passes with no activity', () => {
    const { supervisor, clock, states } = harness()
    begin(supervisor)

    clock.advance(29_000)
    expect(supervisor.get(CHAT, AGENT).state).toBe('working')

    clock.advance(2_000)
    expect(supervisor.get(CHAT, AGENT).state).toBe('away')
    expect(states()).toEqual(['working', 'away'])
  })

  it('keeps the last activity timestamp when it goes away', () => {
    const { supervisor, clock, presences } = harness()
    const startedAt = clock.clock.now()
    begin(supervisor)

    clock.advance(31_000)

    const away = presences().at(-1) as AgentPresence
    expect(away.state).toBe('away')
    // `since` is when it went away; `lastActivityAt` is still the last sign of
    // life, which is what the member panel counts its "away · Ns" from.
    expect(away.lastActivityAt).toBe(startedAt)
    expect(away.since).toBeGreaterThan(startedAt)
  })

  it('comes back from away on the next stream part', () => {
    const { supervisor, clock, states } = harness()
    begin(supervisor)
    clock.advance(31_000)
    expect(supervisor.get(CHAT, AGENT).state).toBe('away')

    expect(supervisor.activity(CHAT, AGENT)).toBe('working')

    expect(supervisor.get(CHAT, AGENT).state).toBe('working')
    expect(states()).toEqual(['working', 'away', 'working'])
  })

  it('emits nothing for activity that does not change the state', () => {
    const { supervisor, clock, states } = harness()
    begin(supervisor)

    clock.advance(5_000)
    supervisor.activity(CHAT, AGENT)
    supervisor.activity(CHAT, AGENT)

    // One delta per token must not be one IPC message per token.
    expect(states()).toEqual(['working'])
  })

  it('never goes away while activity keeps arriving', () => {
    const { supervisor, clock, states } = harness()
    begin(supervisor)

    for (let elapsed = 0; elapsed < 120_000; elapsed += 20_000) {
      clock.advance(20_000)
      supervisor.activity(CHAT, AGENT)
    }

    expect(supervisor.get(CHAT, AGENT).state).toBe('working')
    expect(states()).toEqual(['working'])
  })

  it('aborts the turn with a timeout reason and goes offline at the hard timeout', () => {
    const { supervisor, clock, states } = harness()
    const controller = begin(supervisor)
    const abort = vi.spyOn(controller, 'abort')

    clock.advance(121_000)

    expect(abort).toHaveBeenCalledTimes(1)
    expect(isTimeoutAbort(controller.signal.reason)).toBe(true)
    expect(supervisor.get(CHAT, AGENT).state).toBe('offline')
    expect(supervisor.isOffline(AGENT)).toBe(true)
    expect(supervisor.offlineReason(AGENT)).toBe('timeout')
    expect(states()).toEqual(['working', 'away', 'offline'])
  })

  it('aborts a stalled turn exactly once, however long it takes to unwind', () => {
    const { supervisor, clock } = harness()
    const controller = begin(supervisor)
    const abort = vi.spyOn(controller, 'abort')

    clock.advance(300_000)

    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('leaves a skipped turn offline when it finally ends', () => {
    const { supervisor, clock, states } = harness()
    begin(supervisor)
    clock.advance(121_000)

    supervisor.endTurn({ chatId: CHAT, agentId: AGENT, outcome: 'skipped' })

    expect(supervisor.get(CHAT, AGENT).state).toBe('offline')
    expect(states()).toEqual(['working', 'away', 'offline'])
  })

  it('prefers the per-chat timeout override over the global setting', () => {
    const { supervisor, clock, states } = harness({
      getTimeouts: (chatId) =>
        chatId === CHAT
          ? { stallTimeoutMs: 1_000, hardTimeoutMs: 4_000 }
          : { stallTimeoutMs: 30_000, hardTimeoutMs: 120_000 }
    })
    const controller = begin(supervisor)

    clock.advance(2_000)
    expect(supervisor.get(CHAT, AGENT).state).toBe('away')

    clock.advance(3_000)
    expect(supervisor.get(CHAT, AGENT).state).toBe('offline')
    expect(isTimeoutAbort(controller.signal.reason)).toBe(true)
    expect(states()).toEqual(['working', 'away', 'offline'])
  })

  it('returns to available when a turn finishes normally', () => {
    const { supervisor, states } = harness()
    begin(supervisor)

    supervisor.endTurn({ chatId: CHAT, agentId: AGENT, outcome: 'done' })

    expect(supervisor.get(CHAT, AGENT).state).toBe('available')
    expect(states()).toEqual(['working', 'available'])
  })

  it('treats an abstention like a normal answer', () => {
    const { supervisor } = harness()
    begin(supervisor)

    supervisor.endTurn({ chatId: CHAT, agentId: AGENT, outcome: 'passed' })

    expect(supervisor.get(CHAT, AGENT).state).toBe('available')
  })

  it('stays available after a user Stop', () => {
    const { supervisor } = harness()
    begin(supervisor)

    supervisor.endTurn({ chatId: CHAT, agentId: AGENT, outcome: 'aborted' })

    // Stop says nothing about the provider, so it neither counts as a failure
    // nor changes the colour beyond going idle.
    expect(supervisor.get(CHAT, AGENT).state).toBe('available')
    expect(supervisor.isOffline(AGENT)).toBe(false)
  })

  it('goes offline after three consecutive errors and not before', () => {
    const { supervisor } = harness()

    for (let attempt = 1; attempt < MAX_CONSECUTIVE_FAILURES; attempt += 1) {
      begin(supervisor)
      supervisor.endTurn({ chatId: CHAT, agentId: AGENT, outcome: 'error' })
      expect(supervisor.get(CHAT, AGENT).state).toBe('available')
    }

    begin(supervisor)
    supervisor.endTurn({ chatId: CHAT, agentId: AGENT, outcome: 'error' })

    expect(supervisor.get(CHAT, AGENT).state).toBe('offline')
    expect(supervisor.offlineReason(AGENT)).toBe('consecutive-failures')
  })

  it('resets the failure counter on a successful turn', () => {
    const { supervisor } = harness()

    for (let attempt = 0; attempt < MAX_CONSECUTIVE_FAILURES - 1; attempt += 1) {
      begin(supervisor)
      supervisor.endTurn({ chatId: CHAT, agentId: AGENT, outcome: 'error' })
    }
    begin(supervisor)
    supervisor.endTurn({ chatId: CHAT, agentId: AGENT, outcome: 'done' })

    begin(supervisor)
    supervisor.endTurn({ chatId: CHAT, agentId: AGENT, outcome: 'error' })

    expect(supervisor.isOffline(AGENT)).toBe(false)
  })

  it('brings an agent back when a probe succeeds', async () => {
    const { supervisor, probe, states } = harness({ probeOk: true })
    supervisor.markOffline(AGENT, 'timeout')

    await expect(supervisor.probe(AGENT)).resolves.toBe(true)

    expect(probe).toHaveBeenCalledWith(AGENT)
    expect(supervisor.isOffline(AGENT)).toBe(false)
    expect(supervisor.get(CHAT, AGENT).state).toBe('available')
    expect(states()).toEqual(['offline', 'available'])
  })

  it('keeps an agent offline when the probe fails', async () => {
    const { supervisor } = harness({ probeOk: false })
    supervisor.markOffline(AGENT, 'timeout')

    await expect(supervisor.probe(AGENT)).resolves.toBe(false)

    expect(supervisor.isOffline(AGENT)).toBe(true)
    expect(supervisor.offlineReason(AGENT)).toBe('probe-failed')
  })

  it('treats a rejected probe as a failed one rather than throwing', async () => {
    const { supervisor } = harness({
      probeProvider: () => Promise.reject(new Error('socket hang up'))
    })

    await expect(supervisor.probe(AGENT)).resolves.toBe(false)
    expect(supervisor.isOffline(AGENT)).toBe(true)
  })

  it('answers retry with the presence the probe produced', async () => {
    const { supervisor, probe } = harness({ probeOk: true })
    supervisor.markOffline(AGENT, 'consecutive-failures')

    await expect(supervisor.retry(CHAT, AGENT)).resolves.toMatchObject({
      chatId: CHAT,
      agentId: AGENT,
      state: 'available'
    })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('re-probes offline agents on the probe interval and only them', async () => {
    const { supervisor, clock, probe } = harness({ probeOk: true, probeIntervalMs: 10_000 })

    clock.advance(11_000)
    expect(probe).not.toHaveBeenCalled()

    supervisor.markOffline(AGENT, 'timeout')
    clock.advance(11_000)
    // The loop is async; let its promise settle before reading the result.
    await Promise.resolve()

    expect(probe).toHaveBeenCalledWith(AGENT)
  })

  it('lists every member of a chat, including those that never spoke', () => {
    const { supervisor } = harness({ listAgentIdsForChat: () => ['agent-1', 'agent-2'] })
    begin(supervisor)

    expect(supervisor.list(CHAT)).toEqual([
      expect.objectContaining({ agentId: 'agent-1', state: 'working' }),
      expect.objectContaining({ agentId: 'agent-2', state: 'available' })
    ])
  })

  it('lists a globally offline member as offline even with no session', () => {
    const { supervisor } = harness({
      listAgentIdsForChat: () => ['agent-1', 'agent-2'],
      listChatIdsForAgent: () => []
    })
    supervisor.markOffline('agent-2', 'probe-failed')

    expect(supervisor.list(CHAT)).toEqual([
      expect.objectContaining({ agentId: 'agent-1', state: 'available' }),
      expect.objectContaining({ agentId: 'agent-2', state: 'offline' })
    ])
  })

  it('fans a global offline mark out over every chat the agent is in', () => {
    const { supervisor, presences } = harness({
      listChatIdsForAgent: () => ['chat-1', 'chat-2']
    })

    supervisor.markOffline(AGENT, 'timeout')

    expect(presences().map((presence) => presence.chatId)).toEqual(['chat-1', 'chat-2'])
    expect(supervisor.get('chat-2', AGENT).state).toBe('offline')
  })

  it('stops both loops when it is stopped', () => {
    const { supervisor, clock } = harness()
    const controller = begin(supervisor)

    supervisor.stop()
    clock.advance(600_000)

    expect(controller.signal.aborted).toBe(false)
  })
})
