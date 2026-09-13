/**
 * `AgentSupervisor`: the heartbeat, the four presence states, and the two
 * timeouts that keep one dead provider from freezing a round.
 *
 * PLAN's "Heartbeat, timeouts and presence" in one object. Every (chat, agent)
 * pair that is currently speaking has a **session**: the message it is writing
 * into, the `AbortController` that can stop it, and the timestamp of its last
 * sign of life. A tick every second walks those sessions and applies two rules:
 *
 * ```
 *                   activity                     activity
 *                  ┌────────┐                   ┌────────┐
 *                  ▼        │                   ▼        │
 * available ──▶ working ────┴──▶ away ──────────┴──▶ offline
 *      ▲      beginTurn   idle >      idle >          │
 *      │                  stall       hard →          │
 *      └──────────────────────────────abort + skip ───┘
 *                        endTurn / successful probe
 * ```
 *
 * ## Decisions this file encodes
 *
 * - **`away` never interrupts anything.** It is a colour, so the user can see
 *   that a provider is queueing rather than that the app has hung. Only
 *   `hardTimeout` acts, and what it does is abort *that one turn* — the round
 *   barrier in `ChatRunner` is `allSettled`, so the aborted turn releases it and
 *   the members that answered are not held hostage.
 * - **The supervisor never touches the database.** Timeouts, membership and the
 *   provider probe all arrive as injected accessors. That is CLAUDE.md rule #5
 *   taken seriously: the whole state machine is exercised in
 *   `supervisor.test.ts` with a fake clock, no storage and no network.
 * - **Time is injected too.** `SupervisorClock` is `{ now, setInterval,
 *   clearInterval }`; the default wraps the platform timers and `unref()`s them
 *   so a heartbeat can never keep a Node process (or a vitest run) alive. A test
 *   passes a clock it advances by hand, which is the only way to assert a 120 s
 *   timeout in a millisecond.
 * - **Offline is a property of the agent, not of one chat.** A provider that is
 *   down is down everywhere, so `markOffline` writes the state into every chat
 *   the agent is a member of and emits one `presence.changed` per chat. The
 *   presence *records* stay keyed by (chat, agent), because that is what the
 *   member panel renders and what `AgentPresence` declares.
 * - **Recovery is a model-list request, never a generation.** A probe must be
 *   free and must not depend on a model being loaded; `fetchModels` answers the
 *   only question that matters — does the endpoint talk to us — and costs nothing.
 */
import type { BackendEvent } from '@shared/events'
import type { AgentPresence, PresenceState } from '@shared/types'
import { TimeoutAbortReason } from './abort-reasons'

/** How often the heartbeat walks the live sessions, in milliseconds. */
export const HEARTBEAT_INTERVAL_MS = 1_000

/** How often offline agents are re-probed for recovery, in milliseconds. */
export const PROBE_INTERVAL_MS = 60_000

/** Consecutive `error` outcomes that take an agent offline, across all chats. */
export const MAX_CONSECUTIVE_FAILURES = 3

/** What `endTurn` reports; it decides the next state and the failure counter. */
export type TurnOutcome = 'done' | 'passed' | 'error' | 'aborted' | 'skipped'

/** Why an agent was taken offline. Operator-facing detail, never UI copy. */
export type OfflineReason = 'timeout' | 'consecutive-failures' | 'probe-failed' | 'manual'

/** The two budgets a chat runs its turns under, already resolved. */
export interface PresenceTimeouts {
  stallTimeoutMs: number
  hardTimeoutMs: number
}

/** Opaque handle a `SupervisorClock` hands back from `setInterval`. */
export type TimerHandle = unknown

/**
 * The passage of time, injected.
 *
 * Three members rather than a single "every tick" callback because the two loops
 * run at very different periods and a test has to be able to drive them apart.
 */
export interface SupervisorClock {
  now(): number
  setInterval(handler: () => void, ms: number): TimerHandle
  clearInterval(handle: TimerHandle): void
}

/**
 * The platform timers, with `unref()` where it exists.
 *
 * Without the unref a 1 s interval keeps the Node event loop alive forever, which
 * turns "the test suite finished" into "the test suite hangs". Electron's main
 * process is kept alive by its windows, so nothing is lost there.
 */
export const realClock: SupervisorClock = {
  now: () => Date.now(),
  setInterval: (handler, ms) => {
    const handle = setInterval(handler, ms)
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
}

/** Everything the supervisor is not allowed to reach for itself. */
export interface AgentSupervisorOptions {
  /** Where `presence.changed` goes. */
  emit: (event: BackendEvent) => void
  /** The chat's override merged over the global setting. Never reads the DB here. */
  getTimeouts: (chatId: string) => PresenceTimeouts
  /** Chats an agent is a member of; a global offline mark fans out over these. */
  listChatIdsForAgent: (agentId: string) => string[]
  /** A chat's members, so `list` can answer for agents that never spoke. */
  listAgentIdsForChat: (chatId: string) => string[]
  /** Resolves true when the agent's provider answered. Must never generate. */
  probeProvider: (agentId: string) => Promise<boolean>
  clock?: SupervisorClock
  heartbeatIntervalMs?: number
  probeIntervalMs?: number
}

/** One turn the supervisor is watching. */
interface AgentSession {
  chatId: string
  agentId: string
  messageId: string
  controller: AbortController
  startedAt: number
}

export interface BeginTurnInput {
  chatId: string
  agentId: string
  /** The streaming message row this turn writes into. */
  messageId: string
  /** Aborted with a `TimeoutAbortReason` when the hard timeout is reached. */
  controller: AbortController
}

export interface EndTurnInput {
  chatId: string
  agentId: string
  outcome: TurnOutcome
}

function key(chatId: string, agentId: string): string {
  return `${chatId}:${agentId}`
}

export class AgentSupervisor {
  readonly #options: AgentSupervisorOptions
  readonly #clock: SupervisorClock

  /** Live turns, keyed by (chat, agent). */
  readonly #sessions = new Map<string, AgentSession>()
  /** The last state emitted for a (chat, agent), so a tick emits only on change. */
  readonly #presence = new Map<string, AgentPresence>()
  /** Agents the whole app considers down, with why. */
  readonly #offline = new Map<string, OfflineReason>()
  /** Consecutive `error` outcomes per agent, across every chat. */
  readonly #failures = new Map<string, number>()

  #heartbeat: TimerHandle | null = null
  #prober: TimerHandle | null = null
  /** Guards the periodic loop against overlapping probes of the same agent. */
  readonly #probing = new Set<string>()

  constructor(options: AgentSupervisorOptions) {
    this.#options = options
    this.#clock = options.clock ?? realClock
    this.start()
  }

  /* -- lifecycle ---------------------------------------------------------- */

  /** Starts both loops. Idempotent; the constructor already called it. */
  start(): void {
    if (this.#heartbeat === null) {
      this.#heartbeat = this.#clock.setInterval(
        () => this.tick(),
        this.#options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
      )
    }
    if (this.#prober === null) {
      this.#prober = this.#clock.setInterval(
        () => void this.probeOffline(),
        this.#options.probeIntervalMs ?? PROBE_INTERVAL_MS
      )
    }
  }

  /** Stops both loops. Called from `AppContext.close()`; safe to call twice. */
  stop(): void {
    if (this.#heartbeat !== null) this.#clock.clearInterval(this.#heartbeat)
    if (this.#prober !== null) this.#clock.clearInterval(this.#prober)
    this.#heartbeat = null
    this.#prober = null
  }

  /* -- the turn lifecycle ------------------------------------------------- */

  /** Registers a turn and turns the agent red. */
  beginTurn(input: BeginTurnInput): void {
    const now = this.#clock.now()
    this.#sessions.set(key(input.chatId, input.agentId), {
      chatId: input.chatId,
      agentId: input.agentId,
      messageId: input.messageId,
      controller: input.controller,
      startedAt: now
    })
    this.#set(input.chatId, input.agentId, 'working', now)
  }

  /**
   * A sign of life from a running turn: a text or reasoning delta today, a tool
   * event once S3.1 lands.
   *
   * Returns the state the agent is in afterwards, so a caller can tell that it
   * just came back from `away` without reading it again.
   */
  activity(chatId: string, agentId: string): PresenceState {
    const session = this.#sessions.get(key(chatId, agentId))
    if (!session) return this.get(chatId, agentId).state

    const now = this.#clock.now()
    const current = this.#presence.get(key(chatId, agentId))
    if (current?.state === 'away') {
      // Back from away: a new `since`, because the *working* state started now.
      this.#set(chatId, agentId, 'working', now)
      return 'working'
    }
    if (current) {
      // Not a state change, so nothing is emitted — a delta every few
      // milliseconds must not become an IPC message every few milliseconds.
      current.lastActivityAt = now
    }
    return current?.state ?? 'working'
  }

  /**
   * The turn reached a terminal status.
   *
   * `done` and `passed` clear the failure counter — the provider demonstrably
   * works. `error` increments it, and the third consecutive one takes the agent
   * offline everywhere. `skipped` is the hard timeout, which already marked it
   * offline, so the state is left alone. `aborted` is the user pressing Stop and
   * says nothing about the provider at all.
   */
  endTurn(input: EndTurnInput): void {
    const { chatId, agentId, outcome } = input
    this.#sessions.delete(key(chatId, agentId))

    if (outcome === 'done' || outcome === 'passed') {
      this.#failures.delete(agentId)
      if (this.isOffline(agentId)) {
        // It answered, so whatever took it offline is over.
        this.markAvailable(agentId)
        return
      }
      this.#set(chatId, agentId, 'available', this.#clock.now())
      return
    }

    if (outcome === 'error') {
      const failures = (this.#failures.get(agentId) ?? 0) + 1
      this.#failures.set(agentId, failures)
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        this.markOffline(agentId, 'consecutive-failures')
        return
      }
      // An agent already offline for another reason stays offline: one more
      // failure is not evidence that it recovered.
      if (!this.isOffline(agentId)) this.#set(chatId, agentId, 'available', this.#clock.now())
      return
    }

    // `skipped`: the tick already emitted `offline`. `aborted`: the user stopped
    // the run, which is not the agent's fault — but an agent that was already
    // offline stays offline either way.
    if (outcome === 'skipped' || this.isOffline(agentId)) return
    this.#set(chatId, agentId, 'available', this.#clock.now())
  }

  /* -- the heartbeat ------------------------------------------------------ */

  /**
   * One heartbeat: `working` → `away` at the stall budget, `away` → `offline`
   * plus an abort at the hard budget.
   *
   * The hard timeout is checked first, so a stall budget that was raised above
   * the hard one (or a tick that was delayed past both) still aborts rather than
   * parking the turn in `away` for another second.
   */
  tick(): void {
    const now = this.#clock.now()

    for (const session of [...this.#sessions.values()]) {
      const current = this.#presence.get(key(session.chatId, session.agentId))
      if (!current) continue

      const idleMs = now - current.lastActivityAt
      const { stallTimeoutMs, hardTimeoutMs } = this.#options.getTimeouts(session.chatId)

      if (idleMs > hardTimeoutMs) {
        this.#sessions.delete(key(session.chatId, session.agentId))
        // The reason is what tells `runAgentTurn` to store `skipped` rather than
        // the `error` a user Stop produces.
        session.controller.abort(
          new TimeoutAbortReason({ agentId: session.agentId, hardTimeoutMs, idleMs })
        )
        this.markOffline(session.agentId, 'timeout')
        continue
      }

      if (idleMs > stallTimeoutMs && current.state === 'working') {
        this.#set(session.chatId, session.agentId, 'away', now, current.lastActivityAt)
      }
    }
  }

  /* -- reading ------------------------------------------------------------ */

  /** The presence of one agent in one chat. Never throws, never returns null. */
  get(chatId: string, agentId: string): AgentPresence {
    const stored = this.#presence.get(key(chatId, agentId))
    if (stored) return { ...stored }

    const now = this.#clock.now()
    return {
      chatId,
      agentId,
      state: this.isOffline(agentId) ? 'offline' : 'available',
      since: now,
      lastActivityAt: now
    }
  }

  /**
   * Every member of a chat, in membership order.
   *
   * A member that has never spoken has no record, and is reported `available` —
   * unless the agent is offline globally, which is exactly the case the member
   * panel has to grey out before anyone tries to talk to it.
   */
  list(chatId: string): AgentPresence[] {
    return this.#options
      .listAgentIdsForChat(chatId)
      .map((agentId) => this.get(chatId, agentId))
  }

  /** True when the agent is considered down everywhere. */
  isOffline(agentId: string): boolean {
    return this.#offline.has(agentId)
  }

  /** Why the agent is offline, or `undefined` when it is not. */
  offlineReason(agentId: string): OfflineReason | undefined {
    return this.#offline.get(agentId)
  }

  /* -- global state changes ----------------------------------------------- */

  /** Takes an agent offline in every chat it belongs to, and emits one each. */
  markOffline(agentId: string, reason: OfflineReason): void {
    this.#offline.set(agentId, reason)
    const now = this.#clock.now()
    for (const chatId of this.#chatsOf(agentId)) {
      this.#set(chatId, agentId, 'offline', now)
    }
  }

  /** Brings an agent back: clears the failure counter and emits `available`. */
  markAvailable(agentId: string): void {
    this.#offline.delete(agentId)
    this.#failures.delete(agentId)
    const now = this.#clock.now()
    for (const chatId of this.#chatsOf(agentId)) {
      this.#set(chatId, agentId, 'available', now)
    }
  }

  /* -- recovery ----------------------------------------------------------- */

  /**
   * Asks the agent's provider whether it is there.
   *
   * A success brings the agent back; a failure takes it offline (which is a
   * no-op when it already was). Never throws: `probeProvider` is expected to
   * answer `false` rather than reject, and a rejection is treated as `false`.
   */
  async probe(agentId: string): Promise<boolean> {
    if (this.#probing.has(agentId)) return !this.isOffline(agentId)
    this.#probing.add(agentId)
    try {
      const ok = await this.#options.probeProvider(agentId)
      if (ok) this.markAvailable(agentId)
      else this.markOffline(agentId, 'probe-failed')
      return ok
    } catch {
      this.markOffline(agentId, 'probe-failed')
      return false
    } finally {
      this.#probing.delete(agentId)
    }
  }

  /** The manual "Retry" button: probe once, then report what the agent is now. */
  async retry(chatId: string, agentId: string): Promise<AgentPresence> {
    await this.probe(agentId)
    return this.get(chatId, agentId)
  }

  /** The periodic loop's body: probe every offline agent, in parallel. */
  async probeOffline(): Promise<void> {
    const agentIds = [...this.#offline.keys()]
    await Promise.all(agentIds.map((agentId) => this.probe(agentId)))
  }

  /* -- internals ---------------------------------------------------------- */

  /**
   * Chats to fan a global state change out over: everything the agent is a
   * member of, plus any chat it is mid-turn in (a member removed while it was
   * still streaming would otherwise keep a red dot forever).
   */
  #chatsOf(agentId: string): string[] {
    const chatIds = new Set<string>()
    try {
      for (const chatId of this.#options.listChatIdsForAgent(agentId)) chatIds.add(chatId)
    } catch (error) {
      // Membership is read through an injected accessor that may touch storage;
      // a failure there must not stop the agent from being marked offline.
      console.error(`[witena] could not list chats for agent ${agentId}:`, error)
    }
    for (const session of this.#sessions.values()) {
      if (session.agentId === agentId) chatIds.add(session.chatId)
    }
    for (const presence of this.#presence.values()) {
      if (presence.agentId === agentId) chatIds.add(presence.chatId)
    }
    return [...chatIds]
  }

  /** Writes a presence record and emits it. Emits even when the state repeats. */
  #set(
    chatId: string,
    agentId: string,
    state: PresenceState,
    now: number,
    lastActivityAt = now
  ): void {
    const presence: AgentPresence = { chatId, agentId, state, since: now, lastActivityAt }
    this.#presence.set(key(chatId, agentId), presence)
    this.#options.emit({ type: 'presence.changed', presence: { ...presence } })
  }
}
