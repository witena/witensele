/**
 * One agent speaking once.
 *
 * `AgentTurn` is the smallest unit of the product: it creates the agent's
 * message, assembles the prompt, streams the model's answer into that message,
 * and leaves the message in a terminal state. It knows nothing about rounds,
 * speakers or barriers — that is `orchestration/chat-runner.ts` — and nothing
 * about electron, which is what lets the whole file be exercised against a
 * temporary database and a `MockLanguageModelV4` (CLAUDE.md rule #5).
 *
 * ## The shape of a turn
 *
 * 1. Persist an **empty message with `status: 'streaming'`** and emit
 *    `message.created`. The row exists before the first token, so a crash mid
 *    stream leaves a visible, explicable message rather than nothing.
 * 2. Register the turn with `ctx.supervisor` (`beginTurn`), which turns the agent
 *    `working` and starts watching it for the stall and hard timeouts.
 * 3. Call `streamText` and iterate `fullStream`, reporting every part to the
 *    supervisor as activity, appending `text-delta` and `reasoning-delta` to
 *    in-memory parts and emitting one `message.delta` each.
 * 4. Persist the accumulated parts every `FLUSH_INTERVAL_MS` or `FLUSH_EVERY_DELTAS`,
 *    whichever comes first, so a crash keeps most of the answer.
 * 5. Persist the final parts, usage and status, emit `message.updated`, and tell
 *    the supervisor how it ended (`endTurn`).
 *
 * Step 5 runs on **every** path, including abort and provider failure: a message
 * left in `streaming` would show a cursor forever.
 *
 * ## Terminal statuses
 *
 * | Status | When | `Message.error` |
 * |---|---|---|
 * | `done` | The stream finished normally | — |
 * | `passed` | …and the whole text is exactly `[PASS]` (PLAN: a deliberate abstention) | — |
 * | `skipped` | The supervisor's hard timeout aborted a silent turn | `'timeout'` |
 * | `error` | The provider failed, or the user pressed Stop | `'aborted'` when stopped |
 *
 * A user Stop is recorded as `error` / `'aborted'` rather than as its own status,
 * because the renderer has to tell "you stopped this" from "the model died". The
 * hard timeout is the one interruption that gets `skipped`, because the group —
 * not the user — decided to move on without this agent; it also inserts an
 * `agentSkipped` system notice and reports `aborted: false`, so the round barrier
 * treats it as a completed turn rather than as the run being stopped.
 *
 * ## Two signals, one turn
 *
 * `options.signal` belongs to the **run**: Stop aborts every speaker of the round
 * at once. The turn creates a second `AbortController` chained to it and hands
 * *that* one to `streamText` and to the supervisor, so the hard timeout can abort
 * one silent agent without touching its siblings. `AbortSignal.reason` carries
 * which of the two happened (see `presence/abort-reasons.ts`).
 *
 * ## AI SDK v7 names used here
 *
 * Verified against `node_modules/ai/dist/index.d.ts` (ai 7.0.99); the full table
 * with the pitfalls is in `docs/features/agent-turn/backend.md`.
 * `streamText({ model, system, messages, abortSignal, maxOutputTokens,
 * temperature, onError })`, iterated through `result.fullStream`, whose parts are
 * `text-delta` / `reasoning-delta` (both carry `text`), `finish` (carries
 * `finishReason` and `totalUsage`), `abort` and `error`.
 */
import { streamText, type LanguageModel, type LanguageModelUsage } from 'ai'
import type { BackendEvent } from '@shared/events'
import { parseMentions } from '@shared/mentions'
import type {
  Agent,
  Chat,
  Message,
  MessagePart,
  MessageStatus,
  ReasoningPart,
  TextPart,
  Usage
} from '@shared/types'
import type { AppContext } from '../app-context'
import { isTimeoutAbort, TIMEOUT_ERROR } from '../presence/abort-reasons'
import type { TurnOutcome } from '../presence/supervisor'
import { createLanguageModel } from '../providers/registry'
import { resolveProvider } from '../providers/resolve'
import { buildGroupBriefing, PASS_TOKEN, resolveMainLanguage, toBriefingMember } from './briefing'
import { toModelMessages } from './history'

/** Partial text is written to the database at least this often, in milliseconds. */
export const FLUSH_INTERVAL_MS = 500

/** …and at least this often in deltas, for a model that streams faster than that. */
export const FLUSH_EVERY_DELTAS = 40

/** Detail stored in `Message.error` when the user pressed Stop. */
export const ABORTED_ERROR = 'aborted'

/** Notice inserted when the supervisor's hard timeout skipped an agent's turn. */
export const NOTICE_AGENT_SKIPPED = 'agentSkipped'

/** The terminal status a turn ends in, mapped to what the supervisor is told. */
function outcomeOf(status: MessageStatus, aborted: boolean): TurnOutcome {
  if (status === 'skipped') return 'skipped'
  if (status === 'passed') return 'passed'
  if (status === 'done') return 'done'
  return aborted ? 'aborted' : 'error'
}

/** Builds the model client for an agent. Injected by tests; defaults to the registry. */
export type CreateModel = (ctx: AppContext, agent: Agent) => LanguageModel

/** The default: resolve the provider (decrypting its key) and build the adapter. */
export const createModelFromRegistry: CreateModel = (ctx, agent) =>
  createLanguageModel(resolveProvider(ctx, { id: agent.providerId }), agent.modelId)

export interface AgentTurnOptions {
  ctx: AppContext
  chat: Chat
  /** The agent taking this turn. */
  agent: Agent
  /** Everyone in the chat, in speaking order, for the briefing's member list. */
  members: Agent[]
  /** 1-based round this message belongs to. */
  round: number
  /**
   * Who asked for this reply: agent ids, plus the literal `'user'`. Stored on
   * the message so the UI can print "replying to @x"; see `Message.inReplyTo`.
   */
  inReplyTo?: string[]
  /**
   * The transcript this turn should see, oldest first.
   *
   * Omitted — the sequential case — the turn reads the whole transcript from the
   * database itself, so it sees the replies given earlier in the same round. In
   * **parallel** speaking mode the runner reads it once at the start of the round
   * and hands the same snapshot to every speaker, which is what makes "replies
   * within a round are not visible to each other" (PLAN, "Orchestration") true
   * rather than a race between concurrent turns.
   */
  history?: Message[]
  /** Aborting it stops the turn; the message ends as `error` / `'aborted'`. */
  signal: AbortSignal
  /** A model client built by the caller. Omitted, `createModel` builds one. */
  model?: LanguageModel
  createModel?: CreateModel
  /** Where events go. Defaults to `ctx.events.emit`. */
  onEvent?: (event: BackendEvent) => void
}

export interface AgentTurnResult {
  /** The message in its final, persisted state. */
  message: Message
  status: MessageStatus
  /** True when the turn ended because `signal` was aborted. */
  aborted: boolean
}

/** `LanguageModelUsage` (numbers or `undefined`) → the stored `Usage`. */
export function toUsage(usage: LanguageModelUsage): Usage {
  const inputTokens = usage.inputTokens ?? 0
  const outputTokens = usage.outputTokens ?? 0
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.totalTokens ?? inputTokens + outputTokens
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Thrown internally when the turn is stopped before the first request goes out. */
class TurnAborted extends Error {
  constructor() {
    super(ABORTED_ERROR)
    this.name = 'TurnAborted'
  }
}

/** The concatenated text of every `text` part, which is what `[PASS]` is tested against. */
function textOf(parts: MessagePart[]): string {
  return parts
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

/**
 * Appends to the last part of `kind`, or starts a new one — the exact rule
 * `MessageDelta` in `src/shared/events.ts` documents for the renderer, applied
 * here so the in-memory copy and the renderer's copy can never diverge.
 */
function appendDelta(parts: MessagePart[], kind: 'text' | 'reasoning', text: string): void {
  const last = parts[parts.length - 1]
  if (last && last.type === kind) {
    ;(last as TextPart | ReasoningPart).text += text
    return
  }
  parts.push(kind === 'text' ? { type: 'text', text } : { type: 'reasoning', text })
}

/** The system prompt: the agent's own instructions, then the group briefing. */
export function buildSystemPrompt(ctx: AppContext, agent: Agent, members: Agent[]): string {
  const language = resolveMainLanguage(ctx.repos.settings.get(ctx.userId).language)
  const briefing = buildGroupBriefing({
    language,
    self: toBriefingMember(agent),
    members: members.map(toBriefingMember)
  })
  const own = agent.systemPrompt.trim()
  return own.length > 0 ? `${own}\n\n${briefing}` : briefing
}

/** Runs one turn to completion. Never throws: every failure is a stored status. */
export async function runAgentTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
  const { ctx, chat, agent, members, round, signal } = options
  const emit = options.onEvent ?? ((event: BackendEvent) => ctx.events.emit(event))

  // A controller of this turn's own, chained to the run's signal.
  //
  // The runner hands every speaker of a round the *same* signal, because Stop
  // interrupts the whole chain. The supervisor's hard timeout is the opposite:
  // it must abort exactly one silent agent and leave the others streaming. So
  // the turn owns a controller, forwards the run's abort into it, and hands only
  // this one to the supervisor and to `streamText`.
  const controller = new AbortController()
  const turnSignal = controller.signal
  const forwardAbort = (): void => controller.abort(signal.reason)
  if (signal.aborted) forwardAbort()
  else signal.addEventListener('abort', forwardAbort, { once: true })

  const created = ctx.repos.messages.create(
    {
      chatId: chat.id,
      senderType: 'agent',
      senderId: agent.id,
      parts: [],
      status: 'streaming',
      round,
      // Filled in at the terminal update, once there is a finished text to scan.
      mentions: [],
      ...(options.inReplyTo && options.inReplyTo.length > 0
        ? { inReplyTo: options.inReplyTo }
        : {})
    },
    ctx.userId
  )
  emit({ type: 'message.created', message: created })
  // From here on presence is the supervisor's: it owns the session, the
  // heartbeat, the away / offline transitions and the abort above.
  ctx.supervisor.beginTurn({
    chatId: chat.id,
    agentId: agent.id,
    messageId: created.id,
    controller
  })

  const parts: MessagePart[] = []
  let usage: Usage | undefined
  let failure: string | undefined
  let aborted = false

  let lastFlushAt = Date.now()
  let deltasSinceFlush = 0

  const flush = (): void => {
    ctx.repos.messages.update(created.id, { parts: structuredClone(parts) }, ctx.userId)
    lastFlushAt = Date.now()
    deltasSinceFlush = 0
  }

  const onDelta = (kind: 'text' | 'reasoning', text: string): void => {
    if (text.length === 0) return
    appendDelta(parts, kind, text)
    emit({ type: 'message.delta', chatId: chat.id, messageId: created.id, delta: { kind, text } })

    deltasSinceFlush += 1
    if (deltasSinceFlush >= FLUSH_EVERY_DELTAS || Date.now() - lastFlushAt >= FLUSH_INTERVAL_MS) {
      flush()
    }
  }

  try {
    // Stopped before the first request: nothing to stream, and `streamText`
    // would reject with a provider-shaped error for what is a user action.
    if (turnSignal.aborted) throw new TurnAborted()

    const model = options.model ?? (options.createModel ?? createModelFromRegistry)(ctx, agent)
    const agentsById = Object.fromEntries(members.map((member) => [member.id, member]))

    const result = streamText({
      model,
      system: buildSystemPrompt(ctx, agent, members),
      messages: toModelMessages({
        self: agent,
        agentsById,
        messages: options.history ?? ctx.repos.messages.listForContext(chat.id, ctx.userId)
      }),
      abortSignal: turnSignal,
      ...(agent.params.maxTokens ? { maxOutputTokens: agent.params.maxTokens } : {}),
      ...(agent.params.temperature !== undefined ? { temperature: agent.params.temperature } : {}),
      // The SDK's default handler logs the error itself; the `error` part below
      // is the one that decides what the user sees, so silence the duplicate.
      onError: () => {}
    })

    for await (const part of result.fullStream) {
      // Every part is a heartbeat, not only the ones that carry text: a model
      // that streams nothing but reasoning, or (from S3.1) tool events, is
      // working, and the stall timeout must not fire underneath it.
      ctx.supervisor.activity(chat.id, agent.id)

      switch (part.type) {
        case 'text-delta':
          onDelta('text', part.text)
          break
        case 'reasoning-delta':
          onDelta('reasoning', part.text)
          break
        case 'finish':
          usage = toUsage(part.totalUsage)
          break
        case 'abort':
          aborted = true
          break
        case 'error':
          failure = describe(part.error)
          break
        default:
          break
      }
    }
  } catch (error) {
    // An abort reaches us as a rejection from some providers and as an `abort`
    // part from others; both have to end in the same state.
    if (turnSignal.aborted) aborted = true
    else failure = describe(error)
  } finally {
    signal.removeEventListener('abort', forwardAbort)
  }

  if (turnSignal.aborted) aborted = true

  // The supervisor's hard timeout and the user's Stop both arrive as an abort;
  // only the reason tells them apart, and they end in different statuses.
  const timedOut = isTimeoutAbort(turnSignal.reason)

  const text = textOf(parts).trim()
  const status: MessageStatus = timedOut
    ? 'skipped'
    : aborted || failure
      ? 'error'
      : text === PASS_TOKEN
        ? 'passed'
        : 'done'
  const error = timedOut ? TIMEOUT_ERROR : aborted ? ABORTED_ERROR : failure

  // Parsed here rather than in the runner: this is where the finished text is,
  // and one update keeps a single `message.updated` per turn. Deciding *who*
  // speaks next from these ids is `orchestration/scheduling.ts`'s job, which is
  // also where a self-mention is dropped — the stored set is what the agent
  // actually wrote.
  const mentions =
    status === 'passed' || status === 'skipped'
      ? []
      : parseMentions(text, members.map((member) => ({ agentId: member.id, name: member.name })))

  // `finally`, so the session is closed even when the terminal write fails —
  // a chat deleted mid-turn makes the update throw, and a leaked session would
  // keep the heartbeat poking at a row that is gone.
  try {
    const message = ctx.repos.messages.update(
      created.id,
      {
        parts: structuredClone(parts),
        status,
        mentions,
        ...(usage ? { usage } : {}),
        ...(error ? { error } : {})
      },
      ctx.userId
    )
    emit({ type: 'message.updated', message })

    // "X did not respond and was skipped this round" — a separate system message
    // rather than a part of the agent's own, so the transcript reads as the group
    // noticing the silence. A key plus parameters, never a sentence (rule #4).
    if (timedOut) {
      const notice = ctx.repos.messages.create(
        {
          chatId: chat.id,
          senderType: 'system',
          senderId: 'system',
          parts: [
            { type: 'system-notice', key: NOTICE_AGENT_SKIPPED, params: { agent: agent.name } }
          ],
          status: 'done',
          round,
          mentions: []
        },
        ctx.userId
      )
      emit({ type: 'message.created', message: notice })
    }

    // A timeout is *not* reported as an abort: the round barrier reads this flag
    // to decide whether the user stopped the run, and one skipped agent must
    // leave the others' answers and the next round alone.
    return { message, status, aborted: aborted && !timedOut }
  } finally {
    ctx.supervisor.endTurn({
      chatId: chat.id,
      agentId: agent.id,
      outcome: outcomeOf(status, aborted)
    })
  }
}
