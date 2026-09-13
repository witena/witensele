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
 * 2. Emit `presence.changed` → `working` for this (chat, agent).
 * 3. Call `streamText` and iterate `fullStream`, appending `text-delta` and
 *    `reasoning-delta` to in-memory parts and emitting one `message.delta` each.
 * 4. Persist the accumulated parts every `FLUSH_INTERVAL_MS` or `FLUSH_EVERY_DELTAS`,
 *    whichever comes first, so a crash keeps most of the answer.
 * 5. Persist the final parts, usage and status, emit `message.updated`, and emit
 *    `presence.changed` → `available`.
 *
 * Step 5 runs on **every** path, including abort and provider failure: a message
 * left in `streaming` would show a cursor forever.
 *
 * ## Terminal statuses
 *
 * | Status | When |
 * |---|---|
 * | `done` | The stream finished normally |
 * | `passed` | …and the whole text is exactly `[PASS]` (PLAN: a deliberate abstention) |
 * | `error` | The provider failed, or the run was stopped — `error` is `'aborted'` then |
 *
 * An aborted turn is recorded as `error` with the detail `'aborted'` rather than
 * as its own status, because `MessageStatus` reserves `skipped` for the
 * supervisor's hard timeout (S2.4) and the renderer needs to tell "you stopped
 * this" from "the model died". S2.3 may refine it once `run.finished` reasons and
 * message statuses are reconciled across a multi-agent round.
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
import type {
  Agent,
  AgentPresence,
  Chat,
  Message,
  MessagePart,
  MessageStatus,
  PresenceState,
  ReasoningPart,
  TextPart,
  Usage
} from '@shared/types'
import type { AppContext } from '../app-context'
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

  const presence = (state: PresenceState): void => {
    const now = Date.now()
    const value: AgentPresence = {
      chatId: chat.id,
      agentId: agent.id,
      state,
      since: now,
      lastActivityAt: now
    }
    emit({ type: 'presence.changed', presence: value })
  }

  const created = ctx.repos.messages.create(
    {
      chatId: chat.id,
      senderType: 'agent',
      senderId: agent.id,
      parts: [],
      status: 'streaming',
      round,
      // S2.3 scans the finished text for `@name` and fills this in; until then a
      // reply never schedules another round.
      mentions: []
    },
    ctx.userId
  )
  emit({ type: 'message.created', message: created })
  // A plain emit, not a supervisor: S2.4 introduces `AgentSupervisor`, which owns
  // the session, the heartbeat and the away / offline transitions.
  presence('working')

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
    if (signal.aborted) throw new TurnAborted()

    const model = options.model ?? (options.createModel ?? createModelFromRegistry)(ctx, agent)
    const agentsById = Object.fromEntries(members.map((member) => [member.id, member]))

    const result = streamText({
      model,
      system: buildSystemPrompt(ctx, agent, members),
      messages: toModelMessages({
        self: agent,
        agentsById,
        messages: ctx.repos.messages.listForContext(chat.id, ctx.userId)
      }),
      abortSignal: signal,
      ...(agent.params.maxTokens ? { maxOutputTokens: agent.params.maxTokens } : {}),
      ...(agent.params.temperature !== undefined ? { temperature: agent.params.temperature } : {}),
      // The SDK's default handler logs the error itself; the `error` part below
      // is the one that decides what the user sees, so silence the duplicate.
      onError: () => {}
    })

    for await (const part of result.fullStream) {
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
    if (signal.aborted) aborted = true
    else failure = describe(error)
  }

  if (signal.aborted) aborted = true

  const text = textOf(parts).trim()
  const status: MessageStatus = aborted || failure ? 'error' : text === PASS_TOKEN ? 'passed' : 'done'
  const error = aborted ? ABORTED_ERROR : failure

  const message = ctx.repos.messages.update(
    created.id,
    {
      parts: structuredClone(parts),
      status,
      ...(usage ? { usage } : {}),
      ...(error ? { error } : {})
    },
    ctx.userId
  )

  emit({ type: 'message.updated', message })
  presence('available')

  return { message, status, aborted }
}
