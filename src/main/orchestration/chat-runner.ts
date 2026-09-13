/**
 * `ChatRunner`: the thing that decides who speaks and when, one instance per chat.
 *
 * S1.7 needs the smallest version of it that is still the real shape — a user
 * message starts a run, the run has rounds, a round has speakers, each speaker
 * takes an `AgentTurn`, and the whole chain is cancellable. What it does **not**
 * do yet is schedule more than one round or more than one speaker: S2.3 fills in
 * `#speakersFor` and `#nextRound`, and nothing outside this file has to change
 * when it does. That is the point of the split below.
 *
 * ## What is deliberately fixed now, and what S2.3 replaces
 *
 * | Now (S1.7) | S2.3 |
 * |---|---|
 * | `#speakersFor` returns the first member | roundrobin / mention-only, `memberOrder` |
 * | Speakers run in a sequential `for` loop | `sequential` \| `parallel` with a barrier |
 * | A run is exactly one round | `@name` in a reply schedules the next round, up to `maxAutoRounds` |
 * | `mentions` on a stored message is `[]` | parsed from the finished text |
 *
 * ## A message sent while a run is active
 *
 * **Decided here, and the decision is load-bearing:** the message is persisted
 * and broadcast *immediately* (so the user sees what they typed, and so a crash
 * cannot lose it), and it is taken into account **from the next round boundary**.
 * The runner never injects a message into a turn that is already streaming.
 * Concretely, with one agent: the queued message is picked up by the run that
 * starts when the current one finishes, and it needs no re-reading — every turn
 * rebuilds its view from the whole stored transcript, so "queued" only means "a
 * run is owed", never "text is held somewhere".
 *
 * The alternative — aborting the current turn to react sooner — was rejected: it
 * throws away a half-generated answer the user already paid for, and with several
 * agents it would abort the ones that had nothing to do with the interruption.
 *
 * No electron here either (CLAUDE.md rule #5): the runner takes an `AppContext`
 * and reaches the outside world only through `ctx.repos` and `ctx.events`.
 */
import type { BackendEvent, RunFinishReason } from '@shared/events'
import type { Agent, Chat, Message } from '@shared/types'
import type { AppContext } from '../app-context'
import { runAgentTurn, type CreateModel } from '../agents/agent-turn'
import { validation } from '../errors'

/** The live state of the run a chat is in, or `null` when it is idle. */
export interface RunState {
  chatId: string
  /** 1-based; S1.7 never goes past 1. */
  round: number
  /** Agent ids speaking in the current round, in order. */
  speakers: string[]
  startedAt: number
}

export interface ChatSendInput {
  chatId: string
  text: string
  /** Agent ids the user @mentioned. Stored now; used for scheduling in S2.3. */
  mentions?: string[]
}

export interface ChatRunnerOptions {
  /** Injected by tests so no provider is built. Defaults to the registry. */
  createModel?: CreateModel
}

/** One chat's scheduler. Created on demand by `ChatRunnerRegistry`. */
export class ChatRunner {
  readonly chatId: string

  readonly #ctx: AppContext
  readonly #options: ChatRunnerOptions

  #controller: AbortController | null = null
  #state: RunState | null = null
  /**
   * Ids of user messages that landed while a run was active. They are already in
   * the transcript; the queue only records that another run is owed.
   */
  #queued: string[] = []
  #running: Promise<void> | null = null

  constructor(ctx: AppContext, chatId: string, options: ChatRunnerOptions = {}) {
    this.#ctx = ctx
    this.chatId = chatId
    this.#options = options
  }

  /** The current run, or `null`. Read by `chat.stop` and by the tests. */
  get state(): RunState | null {
    return this.#state
  }

  get isRunning(): boolean {
    return this.#running !== null
  }

  /**
   * Persists the user's message, then either starts a run or queues one.
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

    const message = this.#ctx.repos.messages.create(
      {
        chatId: chat.id,
        senderType: 'user',
        senderId: this.#ctx.userId,
        parts: [{ type: 'text', text }],
        status: 'done',
        // 0 = outside a run; rounds are 1-based and belong to the agents.
        round: 0,
        mentions: input.mentions ?? []
      },
      this.#ctx.userId
    )
    this.#emit({ type: 'message.created', message })

    if (this.#running) {
      this.#queued.push(message.id)
      return message
    }

    this.#start()
    return message
  }

  /** Aborts the active run and drops anything queued. Idempotent. */
  stop(): void {
    this.#queued = []
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
    })
    this.#running = running
    void running.catch((error: unknown) => {
      console.error(`[witena] chat runner failed for ${this.chatId}:`, error)
    })
  }

  /**
   * Runs one run, then another if a message arrived meanwhile.
   *
   * The queue is cleared *before* the next run rather than after: the queued
   * messages are already in the transcript, so one run answers all of them, and
   * clearing first means a message that lands during that run queues another.
   */
  async #loop(): Promise<void> {
    for (;;) {
      await this.#runOnce()
      if (this.#queued.length === 0) return
      this.#queued = []
    }
  }

  async #runOnce(): Promise<void> {
    const chat = this.#ctx.repos.chats.get(this.chatId, this.#ctx.userId)
    const members = this.#members(chat)
    // Nothing to run: a chat with no members is a chat the user has emptied.
    // No `run.started` is emitted, so the composer never waits for a reply.
    if (members.length === 0) return

    const round = 1
    const speakers = this.#speakersFor(round, members)
    const controller = new AbortController()
    this.#controller = controller
    this.#state = { chatId: chat.id, round, speakers: speakers.map((a) => a.id), startedAt: Date.now() }

    this.#emit({ type: 'run.started', chatId: chat.id, round })
    this.#emit({ type: 'run.round', chatId: chat.id, round, speakers: this.#state.speakers })

    let reason: RunFinishReason = 'completed'
    try {
      // Sequential on purpose: S2.3 swaps this loop for a barrier that can also
      // run the speakers with `Promise.all` when the chat is set to parallel.
      for (const speaker of speakers) {
        const result = await runAgentTurn({
          ctx: this.#ctx,
          chat,
          agent: speaker,
          members,
          round,
          signal: controller.signal,
          ...(this.#options.createModel ? { createModel: this.#options.createModel } : {})
        })
        if (result.aborted) {
          reason = 'stopped'
          break
        }
        if (result.status === 'error') reason = 'error'
      }
    } catch (error) {
      reason = controller.signal.aborted ? 'stopped' : 'error'
      if (reason === 'error') {
        console.error(`[witena] agent turn failed in chat ${this.chatId}:`, error)
      }
    } finally {
      this.#controller = null
      this.#state = null
    }

    this.#emit({ type: 'run.finished', chatId: chat.id, reason })
  }

  /** The chat's members as agent records, in `position` order. */
  #members(chat: Chat): Agent[] {
    return this.#ctx.repos.chats
      .listMembers(chat.id, this.#ctx.userId)
      .map((member) => this.#ctx.repos.agents.get(member.agentId, this.#ctx.userId))
  }

  /**
   * Who speaks in a round.
   *
   * S1.7: the first member, always. S2.3 replaces the body with the real rule —
   * `roundrobin` gives every member, `mention-only` gives the ones the previous
   * round @mentioned — and the signature is already the one it needs.
   */
  #speakersFor(_round: number, members: Agent[]): Agent[] {
    return members.slice(0, 1)
  }
}

/**
 * One runner per chat, held on the `AppContext`.
 *
 * A map rather than a runner created per call, because a run outlives the IPC
 * call that started it: `chat.stop` has to reach the *same* `AbortController`
 * that `chat.send` created, and the queue has to survive between calls.
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
  state(chatId: string): RunState | null {
    return this.#runners.get(chatId)?.state ?? null
  }

  /** Stops everything. Called when the application context is closed. */
  stopAll(): void {
    for (const runner of this.#runners.values()) runner.stop()
  }
}
