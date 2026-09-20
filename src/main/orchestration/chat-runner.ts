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
 *        drop speakers the supervisor calls offline
 *        if none are left                  → finish `completed` (+ allOffline notice)
 *        if no pending and round cap hit   → finish `max-rounds` (+ notice)
 *        emit run.round { round, speakers }
 *        sequential → one turn after another, each re-reading the transcript
 *        parallel   → one snapshot of the transcript, all turns at once,
 *                     awaited together — the barrier
 *        aborted                           → finish `stopped`
 *        every speaker errored             → finish `error`
 *        plan = mentions of the round that just ended
 *        this message's own `rounds` spent  → finish `max-rounds` (+ voteClosed)
 *        everybody wrote `[AGREED]`         → consensus notice, one closing
 *                                             turn, then — for a document goal
 *                                             with an executor and a folder —
 *                                             the deliver hand-off and its
 *                                             review round, finish `completed`
 *      title the chat, if it is still called `New chat`
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
 *   round. Each turn chains a controller of its own to it, which is what lets
 *   `AgentSupervisor` abort a single stalled speaker without touching the rest.
 * - **An errored turn does not end the round or the run.** One provider being
 *   down must not silence the members that work. Only a round in which *every*
 *   speaker errored ends the run, with `reason: 'error'`. A turn the supervisor
 *   *skipped* is not an error either: `Promise.allSettled` releases the barrier,
 *   the members that answered are kept, and the run continues.
 * - **Offline agents are not scheduled.** `AgentSupervisor.isOffline` is consulted
 *   at every round boundary, so a provider that died mid-conversation stops being
 *   asked instead of timing out once per round. A round that has nobody left to
 *   ask finishes `completed` with the `allOffline` notice rather than in silence.
 *
 * - **"Hand to executor" is two scheduled rounds, not a special mode** (S5.6).
 *   `handoff()` stores an ordinary user message carrying the `handoff` notice
 *   key and mentioning the executor, then the loop schedules the executor alone
 *   — whatever the chat's `mode` says, because one member writes and the rest
 *   read (PLAN.md) — and after it exactly one review round with everybody else.
 *   From there the ordinary `@` mechanics resume, so a reviewer that writes
 *   `@Hands` starts another executor round and `maxAutoRounds` caps the chain
 *   exactly as it does for a typed message. Since S5.12 the call carries an
 *   `intent` — `implement` or `deliver` — which changes the notice it stores and
 *   the paragraph the executor's briefing gains, and nothing else; and the
 *   review round tells its speakers that is what they are doing, so they judge
 *   the diff against the chat's goal instead of guessing why they were woken.
 *   Since S5.16 a `deliver` hand-off also quotes the chat's latest conclusion in
 *   the message it stores (`conclusionQuote`), so the executor writes out *that*
 *   answer even after the transcript it came from has been trimmed.
 *
 * - **A discussion that has agreed stops itself** (S5.14, S5.16). The briefing
 *   asks every participant to end an automatic reply with `[AGREED]` or
 *   `[CONTINUE]`; a round in which everybody who spoke wrote `[AGREED]`, with
 *   nothing mentioned and nothing pending, ends the chain: the `consensus`
 *   notice, then **one closing turn** briefed to write the group's conclusion
 *   for the user rather than another argument. Executors do not vote, a
 *   hand-off's two rounds are exempt, and a single `[CONTINUE]` — or no marker
 *   at all — carries on under `maxAutoRounds` exactly as before. Since S5.16 the
 *   rule applies in `mention-only` too (a round that mentions somebody carries
 *   on, which is that mode's own rule), the speaker is the chat's
 *   `closingAgentId` when it can be (`closingSpeaker`), and the message it
 *   writes carries a `ConclusionPart`. See `#agreed` and `#runClosing`.
 *
 * - **A closed discussion delivers its own document** (S5.18). When the closing
 *   turn produced a conclusion and the chat is one S5.12's "Write the
 *   deliverable" would have been offered on — a `document` goal with a
 *   deliverable, a working directory, an executor member, and `autoDeliver` not
 *   switched off — the runner starts that very hand-off itself, in the same run:
 *   the same notice, the same quoted conclusion, the same permission prompt, the
 *   same review round. Nothing is clicked. See `#autoDeliver` for the bug that
 *   argument comes from and `autoDeliverExecutor` for the conditions.
 * - **A message may cap its own chain** (S5.14). `ChatSendInput.rounds`
 *   overrides `maxAutoRounds` for the chain that message starts and nothing
 *   else; the Actions card's "Start a vote" sends `1`, so every member answers
 *   once and the run closes with `voteClosed`. The cap is checked at the *end*
 *   of a round as well as at the top of one, because a vote whose answers
 *   mention nobody would otherwise end in silence.
 * - **A message may say a tool sent it** (S10.4). `ChatSendInput.origin` becomes
 *   an `OriginPart` in front of the user message's text and changes nothing else
 *   about the run: the MCP endpoint's question is scheduled, mentioned and
 *   answered exactly like a typed one, and the flag exists so the transcript can
 *   later say which IDE asked. See `originParts`.
 *
 * - **Three things are announced by the runner rather than by the turn** (S4.2,
 *   S4.3, S5.11), because each is a fact about a *run* and `AgentTurn` does not
 *   know one is happening: the `contextTruncated` notice, stored once per run per
 *   agent from the `droppedMessages` each turn reports; the `materialsTruncated`
 *   notice, stored once per **chat** from the `materialsOmitted` each turn
 *   reports; and the automatic title, which replaces `New chat` once the run has
 *   produced one finished agent reply. See `#noticeTruncation`,
 *   `#noticeMaterials` and `#maybeTitle`.
 *
 * No electron here (CLAUDE.md rule #5): the runner takes an `AppContext` and
 * reaches the outside world only through `ctx.repos` and `ctx.events`.
 */
import type { BackendEvent, RunFinishReason } from '@shared/events'
import { closureMarker } from '@shared/markers'
import { parseMentions } from '@shared/mentions'
import {
  HANDOFF_INTENTS,
  type Agent,
  type Chat,
  type HandoffIntent,
  type Message,
  type MessagePart
} from '@shared/types'
import type { AppContext } from '../app-context'
import {
  createModelFromRegistry,
  runAgentTurn,
  type AgentTurnResult,
  type CreateModel
} from '../agents/agent-turn'
import {
  fallbackTitle,
  generateChatTitle,
  sanitizeTitle,
  type GenerateTitle
} from '../agents/title'
import { DEFAULT_CHAT_TITLE } from '../db/repositories'
import { validation } from '../errors'
import {
  EMPTY_PLAN,
  mergePlans,
  planFromHandoff,
  planFromReplies,
  planFromReview,
  planFromUserMessages,
  reachedRoundLimit,
  type RoundPlan
} from './scheduling'

/** Notice keys this runner can store; they are translated by the renderer. */
export const NOTICE_NO_MENTIONS = 'noMentions'
export const NOTICE_MAX_ROUNDS = 'maxRoundsReached'
export const NOTICE_RUN_FAILED = 'runFailed'
export const NOTICE_ALL_OFFLINE = 'allOffline'
/** Stored once per run per agent when `fitHistory` had to drop messages (S4.2). */
export const NOTICE_CONTEXT_TRUNCATED = 'contextTruncated'
/** Stored once per chat when the goal's materials did not fit a turn's prompt (S5.11). */
export const NOTICE_MATERIALS_TRUNCATED = 'materialsTruncated'
/**
 * The key on the **user** message "Hand to executor" writes (S5.6).
 *
 * A notice part rather than a sentence for the usual reason (CLAUDE.md rule #4),
 * and on a `user` message rather than a `system` one because the click *is* the
 * user speaking: it is what the executor is replying to, it carries the mention
 * that schedules the turn, and `history.ts` renders it into every later prompt
 * as the request it was.
 */
export const NOTICE_HANDOFF = 'handoff'
/**
 * The same message for `intent: 'deliver'` — the "Write the deliverable" action
 * (S5.12).
 *
 * A key of its own rather than a parameter on `handoff`, because the sentence
 * the user reads is a different sentence and not the same one with a word
 * swapped: one says "implement what the group decided", the other names a file.
 * It carries the deliverable's **relative** path, which is what the goal stores
 * and what the header chip shows — an absolute path in a transcript is the
 * user's home directory printed into every later prompt.
 */
export const NOTICE_HANDOFF_DELIVER = 'handoffDeliver'
/**
 * The group agreed and the chain stopped by itself (S5.14).
 *
 * Stored **before** the closing turn rather than after it, so the transcript
 * reads in the order the events happened: the group finished, and then somebody
 * wrote down what it concluded.
 */
export const NOTICE_CONSENSUS = 'consensus'
/**
 * A chain whose message carried an explicit `rounds` cap has run them (S5.14).
 *
 * Its only producer today is the Actions card's "Start a vote", which sends
 * `rounds: 1` — hence the name. `maxRoundsReached` is the wrong sentence for it:
 * that one says "the chat hit its automatic limit, send a message to continue",
 * while this run ended exactly where the user asked it to.
 */
export const NOTICE_VOTE_CLOSED = 'voteClosed'

/**
 * How much of a conclusion a `deliver` hand-off quotes (S5.16).
 *
 * A conclusion is a few paragraphs by design — the closing briefing asks for
 * one — so this is a guard against a model that ignored that, not a budget: the
 * quote is stored in the transcript and read into every later prompt, and an
 * essay pasted into the instruction would be paid for on every round of the
 * hand-off. The same order of magnitude as `MAX_GOAL_DESCRIPTION_CHARS`, for the
 * same reason.
 */
export const MAX_CONCLUSION_QUOTE_CHARS = 2_000

/**
 * Which round of a hand-off `#runRound` is running, if it is one (S5.6, S5.12).
 *
 * One object rather than three parameters because the three are one fact: a
 * round is the executor's, or the review of it, or neither, and a call that
 * could say both would be a state that does not exist.
 */
interface HandoffStage {
  /** The executor being handed the work this round, or `null`. */
  implementing: string | null
  /** What it is being handed; only read when `implementing` is set. */
  intent: HandoffIntent
  /** True in the round after that one, for everybody speaking in it. */
  reviewing: boolean
  /** True for the single closing turn of an agreed discussion (S5.14). */
  closing?: boolean
}

/** The stage of an ordinary round: not a hand-off, not a closing turn. */
const ORDINARY_STAGE: HandoffStage = {
  implementing: null,
  intent: 'implement',
  reviewing: false
}

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
  /**
   * How many automatic rounds **the chain this message starts** may run, instead
   * of the chat's `maxAutoRounds` (S5.14).
   *
   * `1 … MAX_AUTO_ROUNDS`, validated in the handler. The Actions card's "Start a
   * vote" sends `1`: a vote is one question and one answer per member, and a
   * chat set to three automatic rounds would otherwise answer it twice more.
   *
   * It is a property of the message rather than of the chat on purpose — it is
   * not a setting the user changed, it is what this one request needs — so it
   * lives on the send and dies with the chain: the next typed message goes back
   * to `chat.settings.maxAutoRounds`.
   */
  rounds?: number
  /**
   * Who sent this message on the user's behalf (S10.4), when it was not the
   * human at the composer.
   *
   * Stored verbatim as the message's `OriginPart`, and read by nothing here: the
   * scheduling, the mentions, the round and the pending list are identical
   * either way, because a question asked through the MCP endpoint *is* a user
   * message. `client` has already been sanitised by the `chat.send` handler when
   * it reaches the runner — see `OriginPart` — so this layer neither trims it
   * nor has to decide what an empty client name would mean.
   */
  origin?: { client: string }
}

export interface ChatRunnerOptions {
  /** Injected by tests so no provider is built. Defaults to the registry. */
  createModel?: CreateModel
  /**
   * How a chat with the default title gets named (S4.3). Injected by tests so
   * the whole path can be asserted without a provider; defaults to
   * `generateChatTitle`, which asks the first member's own model.
   */
  generateTitle?: GenerateTitle
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
  /**
   * Agents this run has already told the user about a truncated context for.
   *
   * Per **run**, not per round and not per chat: a conversation long enough to
   * overflow overflows again on every round for the rest of its life, and a
   * notice per round would bury the discussion under the same sentence. Per chat
   * would be the other extreme — a user who comes back the next day and asks
   * something else deserves to be told again that the agent cannot see the
   * beginning any more.
   */
  #truncationNoticed = new Set<string>()
  /**
   * Whether this chat has already been told that its materials did not all fit.
   *
   * Per **chat**, not per run: the materials are a property of the goal and they
   * do not change between rounds or between runs, so the second sentence would
   * say exactly what the first one said. The flag only short-circuits the
   * database check below — the transcript itself is the durable record, which is
   * what makes the rule survive a restart.
   */
  #materialsNoticed = false
  /**
   * The hand-off a `handoff()` call scheduled, until `#loop` picks it up: which
   * executor, and which of the two things it is being asked for (S5.12).
   *
   * A field rather than a message on `#pending`, because the two rounds a
   * hand-off schedules are not what a user message schedules: the executor
   * speaks alone whatever the chat's `mode` says, and the round after it is a
   * review by everybody else. Consumed at the top of the run, so the restart in
   * `#start`'s `finally` cannot replay it.
   */
  #handoff: { agentId: string; intent: HandoffIntent } | null = null
  /**
   * The `rounds` cap the next batch of pending messages carries, or `null` for
   * the chat's own `maxAutoRounds` (S5.14).
   *
   * Beside `#pending` rather than on the stored `Message`, because it is not
   * part of the transcript: the row is what the user said, and how many rounds
   * the app was told to run it for is scheduling. Last send wins — two messages
   * that land in the same gap are answered in one round either way, so there is
   * one chain and it can only have one cap.
   */
  #pendingRounds: number | null = null

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
        // S10.4: the origin flag goes **first**, where `markConclusion` puts the
        // other flag part, so a reader that only wants the body can stop at the
        // first `text` part. It is written only for a message a tool sent — a
        // message the human typed carries no mark, because "nobody sent this for
        // me" is the ordinary case and an `origin: 'user'` on every row would be
        // a word the transcript repeats forever to say nothing.
        parts: originParts(input.origin, text),
        status: 'done',
        // 0 = outside a run; rounds are 1-based and belong to the agents.
        round: 0,
        mentions: effectiveMentions(text, members, input.mentions)
      },
      this.#ctx.userId
    )
    this.#emit({ type: 'message.created', message })

    this.#pending.push(message)
    // S5.14: the cap this chain runs under, replaced rather than merged — see
    // `#pendingRounds`. `undefined` clears an earlier one, so a typed message
    // that joins a vote mid-run puts the chat's own limit back.
    this.#pendingRounds = input.rounds ?? null
    if (this.#running === null) this.#start()
    return message
  }

  /**
   * "Hand to executor" (S5.6): the discussion is over, one member implements it,
   * and the others review what it did.
   *
   * PLAN.md's workflow — *discuss → hand to executor → it implements the group's
   * conclusion → posts a diff summary back to the chat → other agents review →
   * iterate* — is three decisions, and all three are made here rather than in the
   * renderer:
   *
   * - **Who the executor is** is `executorWorkdir`'s rule, the same one that
   *   decides which agent the file tools were attached to: the first `executor`
   *   in `position` order. A renderer that named the executor itself could name
   *   the one that has no tools (S5.2's known gap).
   * - **What is stored** is an ordinary `user` message whose single part is the
   *   `handoff` notice key and whose mention set is the executor alone. Nothing
   *   about the transcript is special-cased afterwards: the turn reads it like
   *   any other request, the UI renders it like any other message, and a user
   *   scrolling back sees what was asked.
   * - **What runs** is one round for the executor and then exactly one review
   *   round, scheduled by `#loop` from `#handoffTo`. After those, the ordinary
   *   `@` mechanics resume — a reviewer that writes `@Hands` starts another
   *   executor round — and `maxAutoRounds` caps that chain as it always does.
   *
   * `intent` (S5.12) is the fourth decision and the only one the renderer makes:
   * `'implement'` — the default, and S5.6 unchanged — or `'deliver'`, the "Write
   * the deliverable" action, which stores a different notice and briefs the
   * executor to write the `document` goal's file instead of implementing the
   * conclusion. Everything else on this path is identical, which is why it is an
   * argument rather than a second method: the executor is chosen by the same
   * rule, the same message shape is stored, and the same two rounds run.
   *
   * Refused with `validation` in the four states the buttons are disabled in, so
   * a stale window, a second client or a folder deleted since the last render
   * meets the same rule the UI shows.
   */
  async handoff(input: { chatId: string; intent?: HandoffIntent }): Promise<Message> {
    if (input.chatId !== this.chatId) {
      throw validation('chat.handoff reached the runner of a different chat', {
        expected: this.chatId,
        received: input.chatId
      })
    }
    const intent: HandoffIntent = input.intent ?? 'implement'
    if (!HANDOFF_INTENTS.includes(intent)) {
      throw validation(`Unknown hand-off intent: ${String(input.intent)}`)
    }
    // `not_found` for a chat that is gone, before anything else is read.
    const chat = this.#ctx.repos.chats.get(this.chatId, this.#ctx.userId)
    if (typeof chat.workdir !== 'string' || chat.workdir.trim().length === 0) {
      throw validation('this chat is not bound to a working directory', {
        reason: 'handoff_no_workdir'
      })
    }

    const members = this.#members(chat)
    // The same tie-break `executorWorkdir` applies, and for the same reason: the
    // agent that gets the turn has to be the agent that has the tools.
    const executor = members.find((member) => member.role === 'executor')
    if (!executor) {
      throw validation('this chat has no executor member', { reason: 'handoff_no_executor' })
    }

    // Before the run check, so the two configuration mistakes are both reported
    // while they can be fixed and the transient one is reported last: a user
    // whose chat has no deliverable *and* is running should be told about the
    // deliverable, which is the one that will still be true in a minute.
    const deliverable = chat.goal?.kind === 'document' ? chat.goal.deliverable : undefined
    if (intent === 'deliver' && (typeof deliverable !== 'string' || deliverable.length === 0)) {
      throw validation('this chat has no deliverable to write', {
        reason: 'handoff_no_deliverable'
      })
    }

    // A hand-off is not a message that can join a running chain: it schedules
    // two rounds of its own, and merging them into a round somebody else's
    // mentions already filled would make "the executor speaks alone" untrue.
    if (this.#running !== null) {
      throw validation('a run is already active in this chat', { reason: 'handoff_run_active' })
    }

    const message = this.#storeHandoff(chat, executor, intent, deliverable ?? null)

    this.#handoff = { agentId: executor.id, intent }
    this.#start()
    return message
  }

  /**
   * The `user` message a hand-off is: its notice key, and — for `deliver` — the
   * conclusion quoted beside it (S5.6, S5.12, S5.16).
   *
   * Extracted from `handoff()` in S5.18, because the automatic delivery below
   * stores exactly the same row from inside a run that `handoff()` refuses to
   * join. Everything a reader of the transcript sees, everything a later prompt
   * is built from, and everything the executor is answering is identical whether
   * the user clicked or the discussion closed by itself — which is the whole
   * claim S5.18 makes, so there is one function that produces it.
   */
  #storeHandoff(
    chat: Chat,
    executor: Agent,
    intent: HandoffIntent,
    deliverable: string | null
  ): Message {
    const notice =
      intent === 'deliver'
        ? {
            type: 'system-notice' as const,
            key: NOTICE_HANDOFF_DELIVER,
            params: { agent: executor.name, path: deliverable ?? '' }
          }
        : { type: 'system-notice' as const, key: NOTICE_HANDOFF, params: { agent: executor.name } }

    // S5.16: a `deliver` hand-off quotes the group's conclusion, when the chat
    // has one, so the executor is told *which* answer to write out rather than
    // being left to find it in a transcript that may have been trimmed. An
    // `implement` hand-off does not: what it is being asked for is the whole
    // discussion above it, and quoting one message would narrow it.
    const quote =
      intent === 'deliver'
        ? conclusionQuote(this.#ctx.repos.messages.listForContext(chat.id, this.#ctx.userId))
        : null

    const message = this.#ctx.repos.messages.create(
      {
        chatId: chat.id,
        senderType: 'user',
        senderId: this.#ctx.userId,
        parts: quote === null ? [notice] : [notice, { type: 'text', text: quote }],
        status: 'done',
        round: 0,
        mentions: [executor.id]
      },
      this.#ctx.userId
    )
    this.#emit({ type: 'message.created', message })
    return message
  }

  /** Aborts the active run and drops anything pending. Idempotent. */
  stop(): void {
    this.#pending = []
    this.#pendingRounds = null
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
    this.#truncationNoticed.clear()

    let started = false
    let reason: RunFinishReason = 'completed'
    /** Rounds run since the last user message; what `maxAutoRounds` caps. */
    let roundsSinceUser = 0
    /**
     * The two rounds a hand-off owns, consumed one per iteration (S5.6).
     *
     * Taken here rather than read per round so `#start`'s restart — the sliver
     * where a message lands as the loop ends — cannot hand the same chat to its
     * executor twice.
     */
    const handoff = this.#takeHandoff()
    let handoffStage: 'executor' | 'review' | 'done' = handoff ? 'executor' : 'done'
    /** What the round that just ended scheduled. */
    let carried: RoundPlan = EMPTY_PLAN
    let chat: Chat | null = null
    /**
     * The `rounds` cap the last batch of user messages carried, or `null` for
     * the chat's own `maxAutoRounds` (S5.14).
     *
     * A loop local rather than a field, because it belongs to the chain and not
     * to the runner: it is taken from `#pendingRounds` at the same boundary that
     * resets `roundsSinceUser`, and a run that ends forgets it.
     */
    let roundsCap: number | null = null

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
          // …and brings its own cap with it, or puts the chat's back (S5.14).
          roundsCap = this.#takePendingRounds()
          plan = mergePlans(
            memberIds,
            planFromUserMessages(chat.settings.mode, memberIds, pending),
            carried
          )
        }
        carried = EMPTY_PLAN

        // The hand-off's own two rounds, in order, merged with whatever else was
        // scheduled rather than replacing it: a user message that landed while
        // the executor was working is still answered in the review round.
        //
        // `implementing` is the agent that is being handed the work *this*
        // round; it is what extends its briefing (see `#runRound`), and it is
        // null in the review round and in every ordinary run. `reviewing` is the
        // other half of the same fact (S5.12): in the round after it, everybody
        // who speaks is reading what the executor changed, and is told so.
        let implementing: string | null = null
        let reviewing = false
        if (handoff !== null && handoffStage !== 'done') {
          if (handoffStage === 'executor') {
            implementing = handoff.agentId
            plan = mergePlans(memberIds, planFromHandoff(memberIds, handoff.agentId), plan)
            handoffStage = 'review'
          } else {
            reviewing = true
            plan = mergePlans(memberIds, planFromReview(memberIds, handoff.agentId), plan)
            handoffStage = 'done'
          }
        }

        if (plan.speakers.length === 0) {
          // `mention-only` with nothing mentioned: say so, or the silence looks
          // like a failure.
          if (pending.length > 0) this.#notice(chat, NOTICE_NO_MENTIONS)
          break
        }

        // Agents the supervisor has taken offline are dropped from the round
        // rather than asked and timed out again: the probe loop (and the Retry
        // button) is what brings them back. They are filtered *after* the plan is
        // computed so an `@mention` of an offline member still resolves — the
        // reason nobody answered is then the notice below, not a silent nothing.
        const speaking = plan.speakers.filter((id) => !this.#ctx.supervisor.isOffline(id))
        if (speaking.length === 0) {
          this.#notice(chat, NOTICE_ALL_OFFLINE)
          break
        }
        plan = { ...plan, speakers: speaking }

        // The chain's cap: what this message asked for, or the chat's setting.
        const limit = roundsCap ?? chat.settings.maxAutoRounds
        if (reachedRoundLimit(roundsSinceUser, limit)) {
          // An explicit cap ends with its own sentence: "the vote is closed" is
          // not "this chat hit its automatic limit" (S5.14).
          if (roundsCap !== null) this.#notice(chat, NOTICE_VOTE_CLOSED)
          else this.#notice(chat, NOTICE_MAX_ROUNDS, { max: limit })
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
        const stage: HandoffStage = {
          implementing,
          intent: handoff?.intent ?? 'implement',
          reviewing
        }
        const outcomes = await this.#runRound(
          chat,
          members,
          speakers,
          plan,
          controller.signal,
          stage
        )
        this.#noticeTruncation(chat, members, outcomes)
        this.#noticeMaterials(chat, members, outcomes)

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

        // A capped chain ends **here**, not at the top of the next iteration
        // (S5.14). The check up there only fires when something is still
        // scheduled, and a vote whose answers mention nobody schedules nothing —
        // which would end the run in silence, with no line saying the vote was
        // the point. Checked before consensus because the user named the number:
        // one round means one round, agreement or not.
        if (roundsCap !== null && reachedRoundLimit(roundsSinceUser, roundsCap)) {
          this.#notice(chat, NOTICE_VOTE_CLOSED)
          reason = 'max-rounds'
          break
        }

        // …and an *uncapped* discussion ends when the group says it has (S5.14).
        if (this.#agreed(members, outcomes, carried, stage)) {
          this.#notice(chat, NOTICE_CONSENSUS)
          const concluded = await this.#runClosing(chat, members, controller.signal)
          // S5.18: and a chat whose goal is a file writes it, in the same run.
          if (concluded) await this.#autoDeliver(chat, members, controller.signal)
          reason = controller.signal.aborted ? 'stopped' : 'completed'
          break
        }
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

    // Before `run.finished`, so a renderer that reloads the list on that event
    // already has the new title, and after everything else, so the title is
    // written from a finished transcript rather than from a half-streamed one.
    if (started) await this.#maybeTitle(controller.signal)

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
    signal: AbortSignal,
    /** Which round of a hand-off this is, if it is one (S5.6, S5.12, S5.14). */
    stage: HandoffStage = ORDINARY_STAGE
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
          // Only the agent the work was handed to, and only in that round: the
          // extra briefing tells it to implement the conclusion above — or to
          // write the deliverable (S5.12) — rather than re-open the discussion,
          // which is wrong advice for a reviewer.
          ...(stage.implementing === agent.id ? { handoff: stage.intent } : {}),
          // …and the round after that one, where everybody who speaks is reading
          // what it changed and is told to judge it against the chat's goal.
          ...(stage.reviewing ? { reviewing: true } : {}),
          // S5.14: the single turn that writes the conclusion of an agreed
          // discussion, which is told the discussion is over.
          ...(stage.closing ? { closing: true } : {}),
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
            aborted: signal.aborted,
            droppedMessages: 0,
            materialsOmitted: 0
          }
        })
      }
    }
    return outcomes
  }

  /**
   * Whether the round that just ended was the group agreeing that it is done
   * (S5.14).
   *
   * The briefing asks every participant to end an automatic reply with
   * `[AGREED]` or `[CONTINUE]`, and this is the one place that reads them. Every
   * condition below is a way of being conservative — the failure that matters is
   * a discussion cut short, not one that runs a round too long:
   *
   * - **Both modes, since S5.16.** `mention-only` used to be excluded on the
   *   grounds that "everybody agreed" is not a statement one named member can
   *   make. It is the wrong reading of the rule: what closes a chain is that
   *   *everybody who spoke this round* is finished **and nothing is left
   *   scheduled*, and in `mention-only` the second half is the stronger
   *   statement — the speakers were the ones the previous turn asked for, and
   *   they answered without asking anyone else. A round that mentions somebody
   *   still carries on, through the `carried.speakers` rule below, which is
   *   exactly how that mode already ends a chain.
   * - **Not a hand-off's rounds.** The executor's round and the review round
   *   after it keep their S5.6 behaviour exactly; a reviewer that has nothing to
   *   add is not a discussion reaching a conclusion.
   * - **Executors do not vote.** They write files rather than positions, and a
   *   chat with one would otherwise need its executor to agree before the
   *   participants could finish.
   * - **Somebody has to have spoken.** A round of nothing but abstentions,
   *   errors and skips is not consensus; `[PASS]` deliberately answers `null`
   *   here (see `@shared/markers`).
   * - **Nothing may be pending.** An `@mention` in the round's replies, or a
   *   user message that landed while it ran, is a question that has not been
   *   answered yet, and closing on top of one would drop it.
   */
  #agreed(
    members: Agent[],
    outcomes: TurnOutcome[],
    carried: RoundPlan,
    stage: HandoffStage
  ): boolean {
    if (stage.implementing !== null || stage.reviewing) return false
    if (carried.speakers.length > 0) return false
    if (this.#pending.length > 0) return false

    const executors = new Set(
      members.filter((member) => member.role === 'executor').map((member) => member.id)
    )
    const voters = outcomes.filter(
      (outcome) => !executors.has(outcome.agentId) && outcome.result.status === 'done'
    )
    if (voters.length === 0) return false
    return voters.every((outcome) => closureMarker(textOf(outcome.result.message)) === 'agreed')
  }

  /**
   * The one turn that hands the user the group's conclusion (S5.14, S5.16).
   *
   * **Who writes it** is `closingSpeaker` below: the member the chat's
   * `closingAgentId` names when that member can, and otherwise the first one in
   * speaking order that is not offline — which is what S5.14 always did. Not the
   * last speaker, not a vote among them: a conclusion is one voice, and the
   * chat's member order is the one ordering the user set by hand, so the same
   * chat closes with the same voice every time.
   *
   * It is an ordinary round of exactly one speaker, so Stop, the barrier, the
   * presence machinery and the usage accounting need no special case; the only
   * thing that differs is `closing`, which swaps the discussion rules in the
   * briefing for "state the conclusion, add nothing, write no marker" and marks
   * the message it produces with a `ConclusionPart` (S5.16). Whatever it
   * mentions is ignored, because the caller breaks out of the loop immediately
   * afterwards — that is the point of closing.
   *
   * Answers **whether a conclusion was actually written**, which is what S5.18's
   * automatic delivery is gated on: a closing turn that errored, was skipped or
   * was stopped produced no answer, and handing an executor a file to write from
   * nothing would put an invented document on the user's disk.
   */
  async #runClosing(chat: Chat, members: Agent[], signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false
    const speaker = closingSpeaker(chat, members, (id) => this.#ctx.supervisor.isOffline(id))
    // Every member offline is already the `allOffline` case's territory; there
    // is nobody left to write a conclusion and the notice above stands alone.
    if (!speaker) return false

    this.#round += 1
    this.#speakers = [speaker.id]
    this.#emit({ type: 'run.round', chatId: chat.id, round: this.#round, speakers: [speaker.id] })
    const outcomes = await this.#runRound(chat, members, [speaker], EMPTY_PLAN, signal, {
      ...ORDINARY_STAGE,
      closing: true
    })
    return outcomes.some((outcome) => outcome.result.status === 'done')
  }

  /**
   * The deliverable, written without being asked for a second time (S5.18).
   *
   * The bug this closes is the whole argument for it. A chat configured with a
   * `document` goal, an executor and a folder discussed, agreed, and closed with
   * a conclusion that ended "please have the executor write the text above to
   * `conclusion.md`" — a file name the model invented — and then **nothing
   * happened**: the product had everything it needed to write the real
   * deliverable and waited for a click instead. The briefing half of the fix is
   * in `closingSection`; this is the other half. A chat that says what it
   * produces, in a folder, with a member whose job is writing files, has already
   * said what to do when the discussion ends.
   *
   * It is the **same hand-off** S5.12's button starts, deliberately and in every
   * detail: the same `#storeHandoff` row with the same notice key and the same
   * quoted conclusion, the same `deliver` briefing, the same permission prompt
   * in front of `write_file`, and the same review round afterwards. What it is
   * not is a second path through delivery — `handoff()` cannot be reused only
   * because it refuses to join a run, which is right for a button and wrong for
   * the run that just produced the thing being delivered.
   *
   * Five conditions, four of them S5.12's own and the fifth the user's switch:
   *
   * | Condition | Why it is checked here |
   * |---|---|
   * | The goal is a `document` with a deliverable | There is no file to write otherwise; `handoff_no_deliverable` is the same refusal the button gives |
   * | The chat has a working directory | Nothing outside one can be written, and the deliverable's path is relative to it |
   * | The chat has an executor member | Participants never get a writing tool, whatever the goal says (PLAN's one-writer rule) |
   * | `settings.autoDeliver` is not `false` | The user turned it off for this chat; the conclusion card's manual action is still there |
   * | The executor is not offline | The supervisor already dropped it from rounds; a turn scheduled for it would time out instead of writing |
   *
   * When any of them fails, nothing at all happens — no notice, no round, no
   * half-stored request — and the chat is exactly what S5.16 left behind: a
   * conclusion card with **Write to the deliverable** on it.
   */
  async #autoDeliver(chat: Chat, members: Agent[], signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    const executor = autoDeliverExecutor(chat, members)
    if (!executor) return
    if (this.#ctx.supervisor.isOffline(executor.id)) return
    const deliverable = chat.goal?.deliverable ?? null

    this.#storeHandoff(chat, executor, 'deliver', deliverable)

    const memberIds = members.map((member) => member.id)
    const writing = planFromHandoff(memberIds, executor.id)
    this.#round += 1
    this.#speakers = [executor.id]
    this.#emit({ type: 'run.round', chatId: chat.id, round: this.#round, speakers: [executor.id] })
    await this.#runRound(chat, members, [executor], writing, signal, {
      implementing: executor.id,
      intent: 'deliver',
      reviewing: false
    })
    if (signal.aborted) return

    // …and then the review round, for the same reason S5.6 runs one: a file
    // nobody read is not a delivered document. Offline members are dropped from
    // it exactly as the main loop drops them, and a chat whose only other member
    // is the executor simply has nobody to review.
    const review = planFromReview(memberIds, executor.id)
    const speaking = review.speakers.filter((id) => !this.#ctx.supervisor.isOffline(id))
    if (speaking.length === 0) return
    const reviewers = speaking
      .map((id) => members.find((member) => member.id === id))
      .filter((member): member is Agent => member !== undefined)
    if (reviewers.length === 0) return

    this.#round += 1
    this.#speakers = speaking
    this.#emit({ type: 'run.round', chatId: chat.id, round: this.#round, speakers: speaking })
    await this.#runRound(chat, members, reviewers, { ...review, speakers: speaking }, signal, {
      implementing: null,
      intent: 'deliver',
      reviewing: true
    })
  }

  /**
   * Tells the user, once per run per agent, that an agent could not see the whole
   * conversation (S4.2).
   *
   * The turn itself only *reports* the number it dropped (`droppedMessages`);
   * storing the notice is the runner's job because only the runner knows a run is
   * under way and can dedupe across its rounds.
   */
  #noticeTruncation(chat: Chat, members: Agent[], outcomes: TurnOutcome[]): void {
    for (const outcome of outcomes) {
      if (outcome.result.droppedMessages <= 0) continue
      if (this.#truncationNoticed.has(outcome.agentId)) continue
      this.#truncationNoticed.add(outcome.agentId)
      const agent = members.find((member) => member.id === outcome.agentId)
      this.#notice(chat, NOTICE_CONTEXT_TRUNCATED, {
        agent: agent?.name ?? outcome.agentId,
        dropped: outcome.result.droppedMessages
      })
    }
  }

  /**
   * Tells the user, once per chat, that the goal's materials did not all fit
   * (S5.11).
   *
   * The grain is the difference between this and `#noticeTruncation`. A truncated
   * history is a fact about one long conversation and is worth repeating in a new
   * run, because what the agent can no longer see keeps changing; materials that
   * are too large are a fact about the *goal*, identical in every round of every
   * run until the user changes the list. So the transcript is consulted rather
   * than a per-run set: an existing notice anywhere in this chat is the end of it,
   * which also means a relaunch does not repeat the sentence.
   *
   * The first agent that had to trim is the one named. Members can have different
   * context windows and therefore different budgets, and naming each of them in
   * turn would be the same complaint written four ways.
   */
  #noticeMaterials(chat: Chat, members: Agent[], outcomes: TurnOutcome[]): void {
    if (this.#materialsNoticed) return
    const trimmed = outcomes.find((outcome) => outcome.result.materialsOmitted > 0)
    if (!trimmed) return
    this.#materialsNoticed = true
    if (this.#alreadyNoticed(NOTICE_MATERIALS_TRUNCATED)) return
    const agent = members.find((member) => member.id === trimmed.agentId)
    this.#notice(chat, NOTICE_MATERIALS_TRUNCATED, {
      agent: agent?.name ?? trimmed.agentId,
      omitted: trimmed.result.materialsOmitted
    })
  }

  /** True when this chat's transcript already carries a notice with that key. */
  #alreadyNoticed(key: string): boolean {
    return this.#ctx.repos.messages
      .listForContext(this.chatId, this.#ctx.userId)
      .some((message) =>
        message.parts.some((part) => part.type === 'system-notice' && part.key === key)
      )
  }

  /**
   * Names a chat that is still called `New chat`, once the run produced a real
   * answer (S4.3).
   *
   * Everything about this is deliberately conservative:
   *
   * - **Only the default title is replaced.** A chat the user renamed, or one
   *   created with a title, is never touched. The comparison is the whole
   *   mechanism; there is no "generated" flag to keep in sync.
   * - **Only after a `done` agent message exists.** A run that errored, was
   *   stopped or in which everyone passed has nothing worth naming, and a title
   *   generated from an error would stick forever.
   * - **Never fatal.** The model call is already error-swallowing
   *   (`generateChatTitle`), and the fallback — the first words of the question —
   *   means the chat always ends up with something better than `New chat`.
   * - **Silent when the chat is gone.** A chat deleted while the run was
   *   unwinding makes the write throw; nobody is waiting for the title.
   */
  async #maybeTitle(signal: AbortSignal): Promise<void> {
    let chat: Chat
    try {
      chat = this.#ctx.repos.chats.get(this.chatId, this.#ctx.userId)
    } catch {
      return
    }
    if (chat.title !== DEFAULT_CHAT_TITLE) return

    const transcript = this.#ctx.repos.messages.listForContext(this.chatId, this.#ctx.userId)
    const question = transcript.find((message) => message.senderType === 'user')
    const reply = transcript.find(
      (message) => message.senderType === 'agent' && message.status === 'done'
    )
    if (!question || !reply) return

    const questionText = textOf(question)
    const fallback = fallbackTitle(questionText)
    let title = fallback

    const members = this.#members(chat)
    const first = members[0]
    if (first) {
      try {
        const generate = this.#options.generateTitle ?? generateChatTitle
        const model = (this.#options.createModel ?? createModelFromRegistry)(this.#ctx, first)
        const generated = await generate({
          model,
          question: questionText,
          reply: textOf(reply),
          signal
        })
        const clean = generated === null ? '' : sanitizeTitle(generated)
        if (clean.length > 0) title = clean
      } catch (error) {
        // Building the model can throw (a provider deleted mid-run); the
        // fallback title is already in hand.
        console.debug(`[witena] could not build a model to title ${this.chatId}: ${describe(error)}`)
      }
    }

    if (title.length === 0 || title === chat.title) return
    try {
      this.#emit({
        type: 'chat.updated',
        chat: this.#ctx.repos.chats.update(chat.id, { title }, this.#ctx.userId)
      })
    } catch (error) {
      console.debug(`[witena] could not store a title for ${this.chatId}: ${describe(error)}`)
    }
  }

  /** Takes the pending hand-off, if there is one, and forgets it. */
  #takeHandoff(): { agentId: string; intent: HandoffIntent } | null {
    const handoff = this.#handoff
    this.#handoff = null
    return handoff
  }

  /** Empties the pending list and returns what was in it. */
  #takePending(): Message[] {
    const pending = this.#pending
    this.#pending = []
    return pending
  }

  /** Takes the `rounds` cap those pending messages carried, if any (S5.14). */
  #takePendingRounds(): number | null {
    const rounds = this.#pendingRounds
    this.#pendingRounds = null
    return rounds
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
 * The parts of a user message: its text, behind an `OriginPart` when a tool sent
 * it (S10.4).
 *
 * The flag is **first**, which is where `markConclusion` puts the other flag
 * part, so the body is always the parts from the first `text` onwards. A message
 * the human typed gets no flag at all: "nobody sent this for me" is the ordinary
 * case, and a mark on every row would be a word the transcript repeats forever
 * to say nothing.
 */
function originParts(origin: ChatSendInput['origin'], text: string): MessagePart[] {
  const body: MessagePart = { type: 'text', text }
  return origin === undefined ? [body] : [{ type: 'origin', client: origin.client }, body]
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

/**
 * Who writes the conclusion of a chat that has agreed (S5.16).
 *
 * The chat's `closingAgentId` is a preference, not a promise, and the three
 * fallbacks are the three ways a preference can go stale between being saved and
 * being used:
 *
 * | The named member… | Why it falls back |
 * |---|---|
 * | is no longer in the chat | Membership is edited long after the setting; the id is simply not in `members` any more |
 * | is offline | The supervisor took it out of the round for a reason, and a turn scheduled for it would time out instead of producing an answer |
 * | is the executor | It writes files rather than positions: it does not vote on the consensus that got here (`#agreed`), so it is the wrong voice to state what was concluded |
 *
 * The fallback is **S5.14's own rule, unchanged**: the first member in speaking
 * order that is not offline — deliberately including an executor, because a
 * one-executor chat that agreed must still hand back an answer, and the rule
 * that was there before this setting existed is the one it should return to.
 * `undefined` means every member is offline, which is `allOffline` territory.
 *
 * Exported and pure so all four branches are a unit test rather than four runs.
 */
export function closingSpeaker(
  chat: Chat,
  members: Agent[],
  isOffline: (agentId: string) => boolean
): Agent | undefined {
  const wanted = chat.settings.closingAgentId
  if (typeof wanted === 'string' && wanted.length > 0) {
    const chosen = members.find((member) => member.id === wanted)
    if (chosen && chosen.role !== 'executor' && !isOffline(chosen.id)) return chosen
  }
  return members.find((member) => !isOffline(member.id))
}

/**
 * The executor that writes this chat's deliverable when the discussion closes,
 * or `null` when nothing should happen (S5.18).
 *
 * Four of the five conditions in `#autoDeliver`'s table, in one pure function,
 * so each of them is a unit test rather than a run: the fifth — the executor
 * being offline — needs the supervisor and stays at the call site.
 *
 * The rule is **`autoDeliver !== false`**, not `=== true`. The setting was added
 * to a JSON column that every existing chat lacks, so "absent" has to mean the
 * default, and the default is on: a chat that names a file, a folder and a
 * writer has already said what to do when the talking stops (see
 * `ChatSettings.autoDeliver`).
 *
 * The executor is chosen by `executorWorkdir`'s rule — the first `executor` in
 * `position` order — because the agent that gets the turn has to be the agent
 * that has the tools, which is the same sentence `handoff()` is written around.
 */
export function autoDeliverExecutor(chat: Chat, members: readonly Agent[]): Agent | null {
  if (chat.settings.autoDeliver === false) return null
  if (typeof chat.workdir !== 'string' || chat.workdir.trim().length === 0) return null
  const goal = chat.goal
  if (!goal || goal.kind !== 'document') return null
  if (typeof goal.deliverable !== 'string' || goal.deliverable.trim().length === 0) return null
  return members.find((member) => member.role === 'executor') ?? null
}

/**
 * The latest conclusion in a transcript, quoted for the executor (S5.16).
 *
 * "Write the deliverable" on a conclusion card is a `deliver` hand-off like any
 * other, and this is the one thing that makes it read like an answer to *that*
 * conclusion: the text of the last message carrying a `ConclusionPart`, as a
 * markdown block quote, stored as a second part of the hand-off's user message.
 *
 * Why quote at all, when the conclusion is already in the transcript the
 * executor is given: because the transcript is budgeted (`fitHistory`) and the
 * oldest messages fall out of it first, while the instruction never does — and
 * because a quote next to the request is what makes "write *this*" unambiguous
 * in a chat that has since gone on talking.
 *
 * The quote is **capped** and the app adds no words of its own: the sentence the
 * user reads is the `handoffDeliver` notice beside it, which is an i18n key
 * (rule #4), and everything here is content the group wrote.
 */
export function conclusionQuote(transcript: readonly Message[]): string | null {
  const conclusion = [...transcript]
    .reverse()
    .find(
      (message) =>
        message.senderType === 'agent' &&
        message.parts.some((part) => part.type === 'conclusion')
    )
  if (!conclusion) return null

  const text = textOf(conclusion)
  if (text.length === 0) return null
  const capped =
    text.length > MAX_CONCLUSION_QUOTE_CHARS
      ? `${text.slice(0, MAX_CONCLUSION_QUOTE_CHARS)}…`
      : text
  return capped
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n')
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The concatenated text of a message's `text` parts; what the titler is shown. */
function textOf(message: Message): string {
  return message.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim()
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

  /** Hands a chat to its executor and starts the implement/review run (S5.6). */
  handoff(input: { chatId: string; intent?: HandoffIntent }): Promise<Message> {
    return this.for(input.chatId).handoff(input)
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
