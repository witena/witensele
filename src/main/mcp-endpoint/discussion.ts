/**
 * Watching one discussion on behalf of an MCP caller, and reading the result.
 *
 * A coding agent that calls `start_discussion` is not a renderer: it cannot
 * follow a stream of deltas, it has one tool timeout, and it wants a single
 * answer. This module is the adapter between the two worlds — the event bus a
 * run announces itself on, and the one `DiscussionResult` the tool hands back.
 *
 * Two functions, one shape:
 *
 * | Function | Waits | Used by |
 * |---|---|---|
 * | `watchDiscussion` | until the run ends, the user is asked something, the deadline passes or the caller goes away | `start_discussion`, `wait_for_discussion` |
 * | `readDiscussion` | never | `get_discussion`, and `wait_for_discussion` on a chat that is idle |
 *
 * ## Why the subscription happens before the message is sent
 *
 * `watchDiscussion` subscribes **synchronously**, which is what lets WP-3 call
 * it *before* `chat.send`. A watcher attached afterwards would race the run: a
 * short discussion can reach `run.finished` inside the same turn of the event
 * loop that `chat.send` resolved in, and a caller that missed it would then wait
 * for its whole deadline for an event that has already happened. Subscribing
 * first makes the race impossible rather than unlikely.
 *
 * ## What it does *not* do
 *
 * Aborting the wait never stops the run. `signal` is the MCP request's, and an
 * IDE that cancelled a tool call (or whose socket died) has said nothing about
 * whether the group should stop talking — the discussion is an ordinary chat
 * that stays alive in the window. `stop_discussion` is the tool that stops it.
 *
 * ## `afterSeq`, and why a position is a `seq`
 *
 * A discussion is "everything said after the question", and the repository's
 * per-chat `seq` is the only total order over a transcript. `seq` is internal,
 * though: it is not on the shared `Message` type and never crosses IPC, and this
 * module reads through `HandlerMap` rather than through repositories (the same
 * rule the tools follow, and what lets the endpoint be mounted on the server
 * host later). The bridge is that `seq` is **dense**: it is assigned as
 * `max(seq) + 1` inside the insert transaction and no message row is ever
 * deleted on its own, so the *k*-th message of a chat in ascending order has
 * `seq === k`. `loadTranscript` below reads the whole chat in that order, and
 * `afterSeq` indexes straight into it. A test pins the equality against
 * `repos.messages.nextSeq`.
 *
 * No electron here (CLAUDE.md rule 5), and nothing from `src/main` beyond the
 * context and the handler map's type.
 */
import type { RunFinishReason } from '@shared/events'
import { stripTrailingMarkers } from '@shared/markers'
import { chatUrl, MAX_POSITION_CHARS, type DiscussionResult, type DiscussionStatus } from '@shared/mcp-tools'
import type { Agent, Message } from '@shared/types'
import type { AppContext } from '../app-context'
import type { HandlerMap } from '../handlers/types'

/**
 * Progress, as the MCP request reports it while the group is still talking.
 *
 * Declared here rather than taken from `tools.ts` (WP-3) so this module compiles
 * on its own; the frozen contract's `ToolCallContext['progress']` is this type,
 * and WP-3 is expected to write `progress?: DiscussionProgress` rather than a
 * second spelling of the same signature.
 *
 * It is best-effort by construction: the transport only turns it into a
 * `notifications/progress` when the caller supplied a `progressToken`, and
 * nothing in the result depends on a single update having been delivered.
 */
export type DiscussionProgress = (update: { message: string; round?: number }) => void

export interface WatchOptions {
  chatId: string
  /** Only messages with `seq` greater than this belong to the discussion. */
  afterSeq: number
  /**
   * When to give up and answer `running`, as an **absolute** epoch-millisecond
   * timestamp — `Date.now() + maxWaitSeconds * 1000` at the call site.
   *
   * Absolute rather than a duration because the caller's budget starts when the
   * *tool call* arrives, not when the subscription is made, and because a
   * deadline that has already passed is then a legal input with an obvious
   * meaning (answer immediately) instead of a negative duration.
   */
  deadlineMs: number
  /** Aborted when the MCP request is cancelled or the socket closes. */
  signal: AbortSignal
  progress?: DiscussionProgress
}

export interface DiscussionWatch {
  /**
   * Settles exactly once, and **never rejects**: a caller that has already
   * given up (`cancel()`) must not be handed a floating rejection, and a read
   * that fails while building the result is reported inside the result.
   */
  result: Promise<DiscussionResult>
  /**
   * Stops watching. Idempotent, and safe to call after the result settled.
   *
   * WP-3 calls it when `chat.send` throws, so the subscription made in front of
   * the send does not outlive the failed call.
   */
  cancel(): void
}

/** Why the watch stopped. `now` is `readDiscussion`, which never waits. */
type Settlement =
  | { kind: 'finished'; reason: RunFinishReason }
  | { kind: 'permission' }
  | { kind: 'deadline' }
  | { kind: 'aborted' }
  | { kind: 'now' }

/**
 * Subscribes synchronously, so call it **before** `chat.send`; settle with
 * `result`.
 *
 * Settles on the first of: `run.finished` for this chat, `permission.requested`
 * for this chat (`needs-attention`, and the run keeps going), the deadline
 * (`running`), or `signal` being aborted (`running`). Every path releases the
 * subscription, the timer and the abort listener before the result is built.
 */
export function watchDiscussion(
  ctx: AppContext,
  handlers: HandlerMap,
  options: WatchOptions
): DiscussionWatch {
  let done = false
  /** Highest round this watch has seen announced; 0 before round 1. */
  let round = 0
  /** Message ids already announced, so a second `message.updated` says nothing. */
  const announced = new Set<string>()

  let settle!: (settlement: Settlement) => void
  const settled = new Promise<Settlement>((resolve) => {
    settle = resolve
  })

  let unsubscribe: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const onAbort = (): void => finish({ kind: 'aborted' })

  function release(): void {
    unsubscribe?.()
    unsubscribe = null
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    options.signal.removeEventListener('abort', onAbort)
  }

  function finish(settlement: Settlement): void {
    if (done) return
    done = true
    release()
    settle(settlement)
  }

  /**
   * The agent names, read once and shared by every progress update.
   *
   * Lazy, because a caller that passed no `progress` never needs them, and
   * memoised on one promise so the updates keep their order: callbacks attached
   * to the same settled promise run in the order they were attached.
   */
  let names: Promise<Map<string, string>> | null = null
  function nameOf(): Promise<Map<string, string>> {
    names ??= handlers['agents.list'](ctx)
      .then((agents) => new Map(agents.map((agent) => [agent.id, agent.name])))
      // A failed read must not take the discussion down with it; ids are a
      // worse message than names, and still a true one.
      .catch(() => new Map<string, string>())
    return names
  }

  function announce(message: (names: Map<string, string>) => string, at?: number): void {
    const progress = options.progress
    if (progress === undefined) return
    void nameOf()
      .then((map) => {
        // The request this would have been reported to is over.
        if (done) return
        progress({ message: message(map), ...(at === undefined ? {} : { round: at }) })
      })
      .catch(() => undefined)
  }

  unsubscribe = ctx.events.subscribe((event) => {
    switch (event.type) {
      case 'run.round': {
        if (event.chatId !== options.chatId) return
        round = event.round
        const speakers = event.speakers
        announce(
          (map) =>
            `Round ${event.round} — ${speakers.map((id) => map.get(id) ?? id).join(', ')}`,
          event.round
        )
        return
      }
      case 'message.updated': {
        const message = event.message
        if (message.chatId !== options.chatId) return
        if (message.senderType !== 'agent') return
        // Still streaming: the turn has not finished, so nobody has spoken yet.
        if (message.status === 'streaming') return
        if (announced.has(message.id)) return
        announced.add(message.id)
        announce(
          (map) => `${map.get(message.senderId) ?? message.senderId} has spoken`,
          message.round
        )
        return
      }
      case 'run.finished': {
        if (event.chatId !== options.chatId) return
        finish({ kind: 'finished', reason: event.reason })
        return
      }
      case 'permission.requested': {
        if (event.chatId !== options.chatId) return
        // The run is *not* stopped: the executor is suspended inside a tool call
        // waiting for the user, and only the user can answer it (PLAN.md).
        finish({ kind: 'permission' })
        return
      }
      default:
        return
    }
  })

  timer = setTimeout(
    () => finish({ kind: 'deadline' }),
    Math.max(0, options.deadlineMs - Date.now())
  )
  options.signal.addEventListener('abort', onAbort)
  // A signal that was already aborted when the watch was made; `addEventListener`
  // would never fire for it.
  if (options.signal.aborted) finish({ kind: 'aborted' })

  const result = settled.then((settlement) =>
    buildResult(ctx, handlers, {
      chatId: options.chatId,
      afterSeq: options.afterSeq,
      settlement,
      round,
      tolerant: true
    })
  )

  return { result, cancel: () => finish({ kind: 'aborted' }) }
}

/** No waiting: what the transcript says right now. */
export function readDiscussion(
  ctx: AppContext,
  handlers: HandlerMap,
  options: { chatId: string; afterSeq: number }
): Promise<DiscussionResult> {
  return buildResult(ctx, handlers, {
    chatId: options.chatId,
    afterSeq: options.afterSeq,
    settlement: { kind: 'now' },
    round: 0,
    // A chat that does not exist is `not_found`, not an empty discussion: WP-3
    // turns the `BackendFailure` into the tool's own error, and inventing a
    // result for a chat id the caller made up would be worse than refusing.
    tolerant: false
  })
}

/**
 * The whole transcript of a chat, oldest first, read through `messages.list`.
 *
 * Exported because WP-3 needs the same two numbers this module indexes by: the
 * `afterSeq` of a message about to be sent is `(await loadTranscript(…)).length`,
 * and `wait_for_discussion`'s "the `seq` of the last user message minus one" is
 * the index of that message in this array. Deriving both from one function keeps
 * the dense-`seq` assumption documented above in a single place.
 *
 * `messages.list` is newest-first and paged, so this walks backwards with the
 * `before` cursor until a short page says the chat has no more, and reverses.
 * Paging all the way to the first message is what makes the index equal the
 * `seq`; stopping early would only give positions relative to an unknown total.
 */
export async function loadTranscript(
  ctx: AppContext,
  handlers: HandlerMap,
  chatId: string
): Promise<Message[]> {
  const page = 200
  /** 500 pages is 100 000 messages; a chat that long is a bug, not a transcript. */
  const maxPages = 500
  const newestFirst: Message[] = []
  let before: string | undefined

  for (let index = 0; index < maxPages; index += 1) {
    const batch = await handlers['messages.list'](ctx, {
      chatId,
      limit: page,
      ...(before === undefined ? {} : { before })
    })
    newestFirst.push(...batch)
    if (batch.length < page) break
    const oldest = batch[batch.length - 1]
    if (oldest === undefined) break
    before = oldest.id
  }

  return newestFirst.reverse()
}

interface BuildOptions {
  chatId: string
  afterSeq: number
  settlement: Settlement
  /** The highest round the watcher saw announced, if it was watching. */
  round: number
  /** `true` reports a failed read inside the result instead of throwing. */
  tolerant: boolean
}

async function buildResult(
  ctx: AppContext,
  handlers: HandlerMap,
  options: BuildOptions
): Promise<DiscussionResult> {
  try {
    return await readResult(ctx, handlers, options)
  } catch (error) {
    if (!options.tolerant) throw error
    // The only caller that gets here has already stopped waiting (an abort, a
    // cancel, or a chat deleted while the run was unwinding), so the honest
    // answer is the little that is known for certain.
    const status = statusWithoutTranscript(options.settlement)
    return {
      status,
      chatId: options.chatId,
      url: chatUrl(options.chatId),
      round: options.round,
      ...(status === 'error' ? { error: describe(error) } : {}),
      hint: hintFor(status, options.chatId)
    }
  }
}

async function readResult(
  ctx: AppContext,
  handlers: HandlerMap,
  options: BuildOptions
): Promise<DiscussionResult> {
  // First, because `messages.list` answers an unknown chat with an empty page
  // and a discussion invented for a chat id the caller made up would be worse
  // than a refusal. WP-3 turns this `BackendFailure` into the tool's `not_found`.
  await handlers['chats.get'](ctx, { id: options.chatId })

  const transcript = await loadTranscript(ctx, handlers, options.chatId)
  const said = transcript.slice(Math.max(0, options.afterSeq))

  const conclusion = [...said]
    .reverse()
    .find(
      (message) =>
        message.senderType === 'agent' &&
        message.parts.some((part) => part.type === 'conclusion')
    )

  const live = ctx.runners.getState(options.chatId)
  const status = statusFor(options.settlement, conclusion !== undefined, live !== null)

  const agents = await handlers['agents.list'](ctx)
  const byId = new Map(agents.map((agent) => [agent.id, agent]))

  const round = Math.max(
    options.round,
    live?.round ?? 0,
    ...said.map((message) => message.round),
    0
  )

  const result: DiscussionResult = {
    status,
    chatId: options.chatId,
    url: chatUrl(options.chatId),
    round,
    hint: hintFor(status, options.chatId)
  }

  if (conclusion !== undefined) {
    result.conclusion = {
      messageId: conclusion.id,
      agentName: byId.get(conclusion.senderId)?.name ?? conclusion.senderId,
      markdown: textOf(conclusion)
    }
  }

  // Only when the group finished without agreeing: the disagreement *is* the
  // answer there, while a `running` or `concluded` result would only be repeating
  // what the transcript already said (PLAN.md, "the discussion result").
  if (status === 'ended') {
    result.positions = await positionsOf(ctx, handlers, options.chatId, said, byId)
  }

  if (status === 'error') {
    const failure = errorOf(said)
    if (failure !== null) result.error = failure
  }

  const usage = await usageOf(ctx, handlers, options.chatId)
  if (usage !== null) result.usage = usage

  return result
}

/**
 * The last word of every participant, for a discussion that ended without a
 * conclusion.
 *
 * Members rather than speakers: somebody who was silent in the final round still
 * said something earlier, and their position is the last thing they actually
 * said. Executors are left out — they write files rather than positions, and a
 * chat reached through the endpoint has no executor of its own anyway (PLAN.md:
 * the calling agent is the executor).
 */
async function positionsOf(
  ctx: AppContext,
  handlers: HandlerMap,
  chatId: string,
  said: Message[],
  byId: Map<string, Agent>
): Promise<NonNullable<DiscussionResult['positions']>> {
  const members = await handlers['chats.members.list'](ctx, { chatId })
  const positions: NonNullable<DiscussionResult['positions']> = []

  for (const member of members) {
    const agent = byId.get(member.agentId)
    if (agent?.role === 'executor') continue
    const last = [...said]
      .reverse()
      .find(
        (message) =>
          message.senderType === 'agent' &&
          message.senderId === member.agentId &&
          message.status === 'done'
      )
    if (last === undefined) continue
    const markdown = textOf(last)
    if (markdown.length === 0) continue
    const truncated = markdown.length > MAX_POSITION_CHARS
    positions.push({
      agentName: agent?.name ?? member.agentId,
      markdown: truncated ? markdown.slice(0, MAX_POSITION_CHARS) : markdown,
      truncated
    })
  }

  return positions
}

/**
 * The chat's token usage, or `null` when nothing has been spent.
 *
 * Chat-wide rather than discussion-wide, because `messages.usageSummary` is the
 * one handler that prices a transcript and it prices all of it. For a chat the
 * endpoint created — the common case — the two are the same number, and for a
 * chat that was continued the total is still the honest answer to "what has this
 * conversation cost". Never fatal: usage is a nicety beside the conclusion.
 */
async function usageOf(
  ctx: AppContext,
  handlers: HandlerMap,
  chatId: string
): Promise<NonNullable<DiscussionResult['usage']> | null> {
  try {
    const summary = await handlers['messages.usageSummary'](ctx, { chatId })
    if (summary.total.totalTokens <= 0) return null
    return {
      inputTokens: summary.total.inputTokens,
      outputTokens: summary.total.outputTokens,
      totalTokens: summary.total.totalTokens
    }
  } catch {
    return null
  }
}

/** What went wrong, as the transcript recorded it. */
function errorOf(said: Message[]): string | null {
  for (const message of [...said].reverse()) {
    // The runner's own `runFailed` notice carries the thrown message; it is the
    // closest thing to a cause, so it wins over a single agent's failure.
    for (const part of message.parts) {
      if (part.type === 'system-notice' && part.key === 'runFailed') {
        const detail = part.params?.message
        if (typeof detail === 'string' && detail.length > 0) return detail
      }
    }
    if (message.status === 'error' && typeof message.error === 'string' && message.error.length > 0) {
      return message.error
    }
  }
  return null
}

/**
 * The status mapping of `tasks.md`, which WP-6's contract test asserts row by
 * row:
 *
 * | Settlement | Status |
 * |---|---|
 * | `run.finished` `completed` with a conclusion after `afterSeq` | `concluded` |
 * | `completed` without one, or `max-rounds` | `ended` (+ `positions`) |
 * | `stopped` | `stopped` |
 * | `error` | `error` |
 * | `permission.requested` while waiting | `needs-attention` |
 * | the deadline, or the caller going away | `running` |
 *
 * `now` is `readDiscussion`'s own row, and the only one that is not in the
 * table: with no run to have finished, a chat whose runner is busy is `running`
 * and an idle one is read exactly as a finished `completed` run would be.
 */
function statusFor(
  settlement: Settlement,
  hasConclusion: boolean,
  isRunning: boolean
): DiscussionStatus {
  switch (settlement.kind) {
    case 'finished':
      return finishedStatus(settlement.reason, hasConclusion)
    case 'permission':
      return 'needs-attention'
    case 'deadline':
    case 'aborted':
      return 'running'
    case 'now':
      if (isRunning) return 'running'
      return hasConclusion ? 'concluded' : 'ended'
  }
}

/** The `RunFinishReason` half of the table above. */
function finishedStatus(reason: RunFinishReason, hasConclusion: boolean): DiscussionStatus {
  switch (reason) {
    case 'completed':
      return hasConclusion ? 'concluded' : 'ended'
    case 'max-rounds':
      return 'ended'
    case 'stopped':
      return 'stopped'
    case 'error':
      return 'error'
  }
}

/** The same mapping for a result that could not be read; see `buildResult`. */
function statusWithoutTranscript(settlement: Settlement): DiscussionStatus {
  switch (settlement.kind) {
    case 'deadline':
    case 'aborted':
      return 'running'
    default:
      return 'error'
  }
}

/** One English sentence telling the calling model what to do next. */
function hintFor(status: DiscussionStatus, chatId: string): string {
  switch (status) {
    case 'running':
      return 'The group is still talking. Call wait_for_discussion with the same chatId to keep waiting.'
    case 'concluded':
      return 'The group agreed. You are the executor: apply the conclusion yourself, because Witena changed nothing.'
    case 'ended':
      return 'The group finished without agreeing. Read positions — the disagreement is the answer — or ask again with a narrower question.'
    case 'stopped':
      return 'The discussion was stopped. Nothing more is coming; start another one if you still need an answer.'
    case 'error':
      return 'The run failed. Report the error to the user instead of retrying blindly.'
    case 'needs-attention':
      return `Witena is waiting for the user to answer a permission prompt. Ask them to open ${chatUrl(chatId)}, then call wait_for_discussion again.`
  }
}

/**
 * A message's text, as the calling model should read it.
 *
 * The same two rules the renderer and the history transform apply: only `text`
 * parts (a flag, a tool call or a reasoning block is not prose), and a trailing
 * protocol marker is stripped — `[AGREED]` is how the group talks to the runner,
 * not something an IDE agent should be handed.
 */
function textOf(message: Message): string {
  const text = message.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('')
  return stripTrailingMarkers(text).trim()
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
