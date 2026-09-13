/**
 * `ChatRunner`: the thing that decides who speaks and when, one instance per chat.
 *
 * A user message starts a **run**. A run is a sequence of **rounds**; a round has
 * one or more **speakers**; each speaker takes one `AgentTurn`. The run ends when
 * nothing schedules another round, when the automatic-round cap is reached, when
 * the user presses Stop, or when everything in a round failed.
 *
 * ```
 * send(text) ─┬─ idle    → persist, emit message.created, start the run
 *             └─ running → persist, emit message.created, add to pending
 *
 * run: emit run.started
 *      loop
 *        members  = chat_members in position order            (re-read every round)
 *        plan     = pending user messages (mode) ∪ mentions of the previous round
 *        if plan is empty                  → finish `completed` (+ noMentions notice)
 *        if no pending and round cap hit   → finish `max-rounds` (+ notice)
 *        emit run.round { round, speakers }
 *        sequential → one turn after another, each re-reading the transcript
 *        parallel   → one snapshot of the transcript, all turns at once,
 *                     awaited together — the barrier
 *        aborted                           → finish `stopped`
 *        every speaker errored             → finish `error`
 *        plan = mentions of the round that just ended
 *      emit run.finished { reason }
 * ```
 *
 * ## Decisions this file encodes
 *
 * - **A user message that arrives during a run does not interrupt it.** It is
 *   persisted and broadcast immediately (the user sees what they typed, and a
 *   crash cannot lose it) and joins the run at the **next round boundary**: it
 *   resets the automatic-round counter and its speakers are merged with the ones
 *   the finished round mentioned. There is no "queue a second run" any more — a
 *   run continues until nothing is pending, which is what makes the transcript
 *   one conversation rather than two interleaved ones. Aborting the current turn
 *   instead was rejected: it throws away a half-generated answer the user already
 *   paid for, and with several agents it would abort the ones that had nothing to
 *   do with the interruption.
 * - **`round` increases monotonically for the whole run**, and is *not* reset when
 *   a pending user message restarts the automatic counting. The number is a label
 *   the UI prints next to every message ("Round 3"), and a run whose labels went
 *   1, 2, 1, 2 would be unreadable. The cap counts separately, in
 *   `roundsSinceUser`.
 * - **Membership and settings are read at every round boundary**, never cached on
 *   the runner: a member added, removed or reordered while a reply is streaming
 *   takes effect from the next round, and never mid-turn.
 * - **One `AbortController` per run**, handed to every turn of every round, so
 *   Stop interrupts the whole chain including the other speakers of a parallel
 *   round.
 * - **An errored turn does not end the round or the run.** One provider being
 *   down must not silence the members that work. Only a round in which *every*
 *   speaker errored ends the run, with `reason: 'error'`.
 *
 * No electron here (CLAUDE.md rule #5): the runner takes an `AppContext` and
 * reaches the outside world only through `ctx.repos` and `ctx.events`.
 */
import type { BackendEvent, RunFinishReason } from '@shared/events'
import { parseMentions } from '@shared/mentions'
import type { Agent, Chat, Message } from '@shared/types'
import type { AppContext } from '../app-context'
import { runAgentTurn, type AgentTurnResult, type CreateModel } from '../agents/agent-turn'
import { validation } from '../errors'
import {
  EMPTY_PLAN,
  mergePlans,
  planFromReplies,
  planFromUserMessages,
  reachedRoundLimit,
  type RoundPlan
} from './scheduling'

/** Notice keys this runner can store; they are translated by the renderer. */
export const NOTICE_NO_MENTIONS = 'noMentions'
export const NOTICE_MAX_ROUNDS = 'maxRoundsReached'
export const NOTICE_RUN_FAILED = 'runFailed'

/** One turn that is in flight right now. Read by the tests and by S2.4. */
export interface ActiveTurn {
  agentId: string
  /** The streaming message row this turn is writing into. */
  messageId: string
  startedAt: number
}

/** The live state of the run a chat is in, or `null` when it is idle. */
export interface RunState {
  chatId: string
  /** 1-based, monotonic for the whole run. */
  round: number
  /** Agent ids speaking in the current round, in order. */
  speakers: string[]
  /** The turns that have not reached a terminal status yet. */
  activeTurns: ActiveTurn[]
  /** User messages that arrived mid-run and join at the next round boundary. */
  pendingUserMessageIds: string[]
  startedAt: number
}

export interface ChatSendInput {
  chatId: string
  text: string
  /** Agent ids the composer resolved; unioned with the ones parsed from the text. */
  mentions?: string[]
}

export interface ChatRunnerOptions {
  /** Injected by tests so no provider is built. Defaults to the registry. */
  createModel?: CreateModel
}

/** What one finished turn contributes to the next round. */
interface TurnOutcome {
  agentId: string
  result: AgentTurnResult
}

/** One chat's scheduler. Created on demand by `ChatRunnerRegistry`. */
export class ChatRunner {
  readonly chatId: string

  readonly #ctx: AppContext
  readonly #options: ChatRunnerOptions

  #controller: AbortController | null = null
  #running: Promise<void> | null = null

  /* -- the live run, exposed as `RunState` -------------------------------- */
  #startedAt = 0
  #round = 0
  #speakers: string[] = []
  #activeTurns: ActiveTurn[] = []
  /**
   * User messages that landed while a run was active. They are already in the
   * transcript; this list only records that they have not been *scheduled* yet.
   */
  #pending: Message[] = []

  constructor(ctx: AppContext, chatId: string, options: ChatRunnerOptions = {}) {
    this.#ctx = ctx
    this.chatId = chatId
    this.#options = options
  }

  /** The current run, or `null`. Read by `chat.stop`, the tests and S2.4. */
  get state(): RunState | null {
    if (this.#running === null) return null
    return {
      chatId: this.chatId,
      round: this.#round,
      speakers: [...this.#speakers],
      activeTurns: this.#activeTurns.map((turn) => ({ ...turn })),
      pendingUserMessageIds: this.#pending.map((message) => message.id),
      startedAt: this.#startedAt
    }
  }

  get isRunning(): boolean {
    return this.#running !== null
  }

  /**
   * Persists the user's message, then either starts a run or adds it to the
   * pending list of the one that is already going.
   *
   * Resolves as soon as the message is stored and the run is *scheduled* — the
   * agent's output arrives as events, which is what `chat.send`'s contract in
   * `src/shared/backend.ts` promises.
   */
  async send(input: ChatSendInput): Promise<Message> {
    if (input.chatId !== this.chatId) {
      throw validation('chat.send reached the runner of a different chat', {
        expected: this.chatId,
        received: input.chatId
      })
    }
    const text = input.text.trim()
    if (text.length === 0) throw validation('A message cannot be empty')

    // Throws `not_found` for a chat that is gone, before anything is written.
    const chat = this.#ctx.repos.chats.get(this.chatId, this.#ctx.userId)
    const members = this.#members(chat)

    // A chat nobody is in cannot answer. Rejecting here — rather than storing the
    // message and finishing a run with no speakers — keeps the transcript free of
    // questions that were never asked of anyone, and gives the composer an error
    // the member panel's "add at least one agent" hint explains.
    if (members.length === 0) throw validation('chat has no members')

    const message = this.#ctx.repos.messages.create(
      {
        chatId: chat.id,
        senderType: 'user',
        senderId: this.#ctx.userId,
        parts: [{ type: 'text', text }],
        status: 'done',
        // 0 = outside a run; rounds are 1-based and belong to the agents.
        round: 0,
        mentions: effectiveMentions(text, members, input.mentions)
      },
      this.#ctx.userId
    )
    this.#emit({ type: 'message.created', message })

    this.#pending.push(message)
    if (this.#running === null) this.#start()
    return message
  }

  /** Aborts the active run and drops anything pending. Idempotent. */
  stop(): void {
    this.#pending = []
    this.#controller?.abort()
  }

  /** Resolves when no run is active. The test seam for "wait for the reply". */
  async whenIdle(): Promise<void> {
    while (this.#running) await this.#running
  }

  /* -- internals ---------------------------------------------------------- */

  #emit(event: BackendEvent): void {
    this.#ctx.events.emit(event)
  }

  /** Starts the run loop in the background; failures can never escape into IPC. */
  #start(): void {
    const running = this.#loop().finally(() => {
      this.#running = null
      this.#controller = null
      this.#round = 0
      this.#speakers = []
      this.#activeTurns = []
      // A message that landed in the sliver between the loop's last check and
      // this line would otherwise sit in the list forever: `send` saw a run in
      // flight, and the loop had already decided it was done.
      if (this.#pending.length > 0) this.#start()
    })
    this.#running = running
    void running.catch((error: unknown) => {
      console.error(`[witena] chat runner failed for ${this.chatId}:`, error)
    })
  }

  /**
   * One whole run: rounds until nothing schedules another.
   *
   * Every exit path goes through the single `run.finished` at the bottom, and the
   * only way to leave the loop without one is the "chat has no members" case,
   * which deliberately emits nothing at all.
   */
  async #loop(): Promise<void> {
    const controller = new AbortController()
    this.#controller = controller
    this.#startedAt = Date.now()
    this.#round = 0

    let started = false
    let reason: RunFinishReason = 'completed'
    /** Rounds run since the last user message; what `maxAutoRounds` caps. */
    let roundsSinceUser = 0
    /** What the round that just ended scheduled. */
    let carried: RoundPlan = EMPTY_PLAN
    let chat: Chat | null = null

    try {
      for (;;) {
        chat = this.#ctx.repos.chats.get(this.chatId, this.#ctx.userId)
        const members = this.#members(chat)
        // A chat the user has emptied is not an error. Before the first round it
        // emits nothing at all, so the composer never waits for a reply that was
        // never scheduled.
        if (members.length === 0) {
          if (!started) return
          break
        }
        if (!started) {
          started = true
          this.#emit({ type: 'run.started', chatId: chat.id, round: 1 })
        }
        if (controller.signal.aborted) {
          reason = 'stopped'
          break
        }

        const memberIds = members.map((member) => member.id)
        const pending = this.#takePending()
        let plan = carried
        if (pending.length > 0) {
          // A user message resets the automatic counter and joins whatever the
          // previous round mentioned, rather than replacing it.
          roundsSinceUser = 0
          plan = mergePlans(
            memberIds,
            planFromUserMessages(chat.settings.mode, memberIds, pending),
            carried
          )
        }
        carried = EMPTY_PLAN

        if (plan.speakers.length === 0) {
          // `mention-only` with nothing mentioned: say so, or the silence looks
          // like a failure.
          if (pending.length > 0) this.#notice(chat, NOTICE_NO_MENTIONS)
          break
        }
        if (reachedRoundLimit(roundsSinceUser, chat.settings.maxAutoRounds)) {
          this.#notice(chat, NOTICE_MAX_ROUNDS, { max: chat.settings.maxAutoRounds })
          reason = 'max-rounds'
          break
        }

        this.#round += 1
        roundsSinceUser += 1
        this.#speakers = plan.speakers
        this.#emit({
          type: 'run.round',
          chatId: chat.id,
          round: this.#round,
          speakers: plan.speakers
        })

        const speakers = plan.speakers
          .map((id) => members.find((member) => member.id === id))
          .filter((member): member is Agent => member !== undefined)
        const outcomes = await this.#runRound(chat, members, speakers, plan, controller.signal)

        if (controller.signal.aborted || outcomes.some((outcome) => outcome.result.aborted)) {
          reason = 'stopped'
          break
        }
        // One failing provider must not silence the members that work; a round in
        // which nobody got through is the end of the line.
        if (outcomes.length > 0 && outcomes.every((outcome) => outcome.result.status === 'error')) {
          reason = 'error'
          break
        }

        carried = planFromReplies(
          memberIds,
          outcomes.map((outcome) => ({
            agentId: outcome.agentId,
            mentions: outcome.result.message.mentions,
            passed: outcome.result.status === 'passed'
          }))
        )
      }
    } catch (error) {
      // Nothing above is expected to throw — `runAgentTurn` never does — but a
      // run left marked active would leave the composer showing Stop forever.
      reason = controller.signal.aborted ? 'stopped' : 'error'
      if (reason === 'error') {
        console.error(`[witena] chat runner failed in chat ${this.chatId}:`, error)
        if (chat) this.#notice(chat, NOTICE_RUN_FAILED, { message: describe(error) })
      }
      // Whatever was waiting is dropped rather than replayed into the same
      // failure on the next iteration.
      this.#pending = []
    }

    this.#emit({ type: 'run.finished', chatId: this.chatId, reason })
  }

  /**
   * One round: every speaker takes a turn, and the round is over when all of them
   * have reached a terminal status — the barrier from PLAN's "Round barrier".
   *
   * Sequential satisfies the barrier by construction and rebuilds the transcript
   * per turn, so the second speaker reads the first one's answer. Parallel takes
   * **one snapshot** before starting, hands the same one to every speaker, and
   * waits with `Promise.allSettled` so one failure cannot leave a sibling
   * unawaited.
   */
  async #runRound(
    chat: Chat,
    members: Agent[],
    speakers: Agent[],
    plan: RoundPlan,
    signal: AbortSignal
  ): Promise<TurnOutcome[]> {
    const round = this.#round
    const parallel = chat.settings.speaking === 'parallel'
    const snapshot = parallel
      ? this.#ctx.repos.messages.listForContext(chat.id, this.#ctx.userId)
      : undefined

    const take = async (agent: Agent): Promise<TurnOutcome> => {
      const turn: ActiveTurn = { agentId: agent.id, messageId: '', startedAt: Date.now() }
      this.#activeTurns.push(turn)
      try {
        const result = await runAgentTurn({
          ctx: this.#ctx,
          chat,
          agent,
          members,
          round,
          signal,
          ...(plan.inReplyTo[agent.id] ? { inReplyTo: plan.inReplyTo[agent.id] } : {}),
          ...(snapshot ? { history: snapshot } : {}),
          ...(this.#options.createModel ? { createModel: this.#options.createModel } : {}),
          // The turn's own events pass straight through; the wrapper only picks
          // the message id out of them so `RunState` can name the row each turn
          // is writing into (S2.4's supervisor aborts by that id).
          onEvent: (event) => {
            if (event.type === 'message.created' && event.message.senderId === agent.id) {
              turn.messageId = event.message.id
            }
            this.#emit(event)
          }
        })
        return { agentId: agent.id, result }
      } finally {
        this.#activeTurns = this.#activeTurns.filter((entry) => entry !== turn)
      }
    }

    if (!parallel) {
      const outcomes: TurnOutcome[] = []
      for (const speaker of speakers) {
        outcomes.push(await take(speaker))
        // Stop must not start the next speaker of the round it interrupted.
        if (signal.aborted) break
      }
      return outcomes
    }

    const settled = await Promise.allSettled(speakers.map(take))
    const outcomes: TurnOutcome[] = []
    for (const [index, entry] of settled.entries()) {
      if (entry.status === 'fulfilled') {
        outcomes.push(entry.value)
        continue
      }
      // `runAgentTurn` promises never to throw; if it ever does, the round still
      // has to end with a decision rather than with an unhandled rejection.
      console.error(
        `[witena] agent turn rejected in chat ${this.chatId}:`,
        entry.reason
      )
      const agent = speakers[index]
      if (agent) {
        outcomes.push({
          agentId: agent.id,
          result: {
            message: { mentions: [] } as unknown as Message,
            status: 'error',
            aborted: signal.aborted
          }
        })
      }
    }
    return outcomes
  }

  /** Empties the pending list and returns what was in it. */
  #takePending(): Message[] {
    const pending = this.#pending
    this.#pending = []
    return pending
  }

  /**
   * Stores a `system-notice` message and broadcasts it.
   *
   * A key plus parameters, never a sentence: the backend does not know the UI
   * language and the row outlives any language choice (CLAUDE.md rule #4).
   */
  #notice(chat: Chat, key: string, params?: Record<string, string | number>): void {
    const message = this.#ctx.repos.messages.create(
      {
        chatId: chat.id,
        senderType: 'system',
        senderId: 'system',
        parts: [{ type: 'system-notice', key, ...(params ? { params } : {}) }],
        status: 'done',
        round: this.#round,
        mentions: []
      },
      this.#ctx.userId
    )
    this.#emit({ type: 'message.created', message })
  }

  /** The chat's members as agent records, in `position` order. */
  #members(chat: Chat): Agent[] {
    return this.#ctx.repos.chats
      .listMembers(chat.id, this.#ctx.userId)
      .map((member) => this.#ctx.repos.agents.get(member.agentId, this.#ctx.userId))
  }
}

/**
 * The mention set stored on a user message: what the text says, plus whatever the
 * composer resolved explicitly, minus anything that is not a member of this chat.
 *
 * Both halves parse with the same function (`@shared/mentions`), so the union is
 * normally the parsed set on its own; the explicit list exists so a future
 * autocomplete can name a member the plain text does not spell out.
 */
function effectiveMentions(
  text: string,
  members: Agent[],
  explicit: string[] | undefined
): string[] {
  const parsed = parseMentions(
    text,
    members.map((member) => ({ agentId: member.id, name: member.name }))
  )
  const result = [...parsed]
  for (const agentId of explicit ?? []) {
    if (!result.includes(agentId) && members.some((member) => member.id === agentId)) {
      result.push(agentId)
    }
  }
  return result
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One runner per chat, held on the `AppContext`.
 *
 * A map rather than a runner created per call, because a run outlives the IPC
 * call that started it: `chat.stop` has to reach the *same* `AbortController`
 * that `chat.send` created, and the pending list has to survive between calls.
 */
export class ChatRunnerRegistry {
  readonly #ctx: AppContext
  readonly #options: ChatRunnerOptions
  readonly #runners = new Map<string, ChatRunner>()

  constructor(ctx: AppContext, options: ChatRunnerOptions = {}) {
    this.#ctx = ctx
    this.#options = options
  }

  /** The runner for a chat, created on first use. */
  for(chatId: string): ChatRunner {
    const existing = this.#runners.get(chatId)
    if (existing) return existing
    const runner = new ChatRunner(this.#ctx, chatId, this.#options)
    this.#runners.set(chatId, runner)
    return runner
  }

  send(input: ChatSendInput): Promise<Message> {
    return this.for(input.chatId).send(input)
  }

  /** Aborts a chat's run. Safe when nothing is running or the chat is unknown. */
  stop(chatId: string): void {
    this.#runners.get(chatId)?.stop()
  }

  /** Stops the run and forgets the runner. Called by `chats.delete`. */
  remove(chatId: string): void {
    this.stop(chatId)
    this.#runners.delete(chatId)
  }

  /** The live run state of a chat, or `null`. */
  getState(chatId: string): RunState | null {
    return this.#runners.get(chatId)?.state ?? null
  }

  /** Alias of `getState`, kept because it is what S1.7's callers were written to. */
  state(chatId: string): RunState | null {
    return this.getState(chatId)
  }

  /** Stops everything. Called when the application context is closed. */
  stopAll(): void {
    for (const runner of this.#runners.values()) runner.stop()
  }
}
