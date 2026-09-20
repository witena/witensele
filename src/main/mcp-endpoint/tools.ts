/**
 * The six discussion tools, over `HandlerMap` and nothing else.
 *
 * This is the whole of what an IDE agent can do to Witena. `server.ts` decides
 * *who* may call (the token, the loopback checks) and turns one HTTP request
 * into one MCP exchange; this module decides what each call means. It owns no
 * business logic of its own: every read and every write goes through a handler,
 * exactly as the IPC and HTTP transports do, which is what lets the endpoint be
 * mounted on the Node host later without a second implementation (PLAN.md,
 * "Online version"). Nothing here touches `ctx.repos`.
 *
 * ```
 * tools/call → parse with MCP_TOOL_INPUTS[name] → handlers → ToolOutcome
 * ```
 *
 * Four rules hold for every tool in the table:
 *
 * 1. **Parse first, with the zod schema.** `z.toJSONSchema` silently drops
 *    `start_discussion`'s refinements, so a caller that validated against the
 *    published JSON Schema can still send `{ chatId, agents }`. The schema in
 *    `MCP_TOOL_INPUTS` is the only complete statement of what is legal, and its
 *    messages were written to be handed to a model unchanged — so they are.
 * 2. **Never throw.** A throw would become `internal: <message>` in `server.ts`
 *    and hide the bug; every failure is a `{ ok: false, code, message }` the
 *    calling model can read and correct itself from. A `BackendFailure` keeps
 *    its `BackendErrorCode`, anything else is `internal` with the message and no
 *    stack.
 * 3. **`structured` is an object.** MCP's `structuredContent` is a JSON object or
 *    nothing, and `server.ts` drops a non-object rather than inventing a wrapper
 *    key. `text` is a complete rendering of the same value, ending with the
 *    `hint` — the one sentence that tells the caller what to do next.
 * 4. **The caller is the executor.** No tool starts a hand-off, no chat created
 *    here may contain an executor agent, and every `hint` on a conclusion says
 *    that applying it is the caller's job (PLAN.md, "the role split").
 *
 * No electron (CLAUDE.md rule 5); `no-electron.test.ts` in this folder proves it
 * for the whole closure.
 */
import type { z } from 'zod'
import {
  chatUrl,
  DEFAULT_WAIT_SECONDS,
  MAX_DISCUSSION_INPUT_CHARS,
  MCP_TOOL_INPUTS,
  type DiscussionResult,
  type McpToolName
} from '@shared/mcp-tools'
import type { Agent, Chat, Message } from '@shared/types'
import type { AppContext } from '../app-context'
import { isBackendFailure } from '../errors'
import type { HandlerMap } from '../handlers/types'
import { loadTranscript, readDiscussion, watchDiscussion } from './discussion'
import type { ToolCallContext, ToolOutcome, ToolRegistry } from './tool-types'
import { renderTranscript } from './transcript'

/**
 * The frozen contract puts these three beside `createTools()`, and this is where
 * every reader of it looks for them. They are declared in `./tool-types.ts`
 * because WP-4 needed them before this file existed; the re-export is what makes
 * the contract read as written.
 */
export type { ToolCallContext, ToolOutcome, ToolRegistry } from './tool-types'

/** Longest default title made from a question's first line. */
const MAX_TITLE_CHARS = 60

/** The title a question with no readable first line falls back to. */
const FALLBACK_TITLE = 'Discussion'

/* -------------------------------------------------------------------------- */
/* The registry                                                                */
/* -------------------------------------------------------------------------- */

export function createTools(): ToolRegistry {
  return {
    list_chats: tool('list_chats', listChats),
    list_agents: tool('list_agents', listAgents),
    start_discussion: tool('start_discussion', startDiscussion),
    wait_for_discussion: tool('wait_for_discussion', waitForDiscussion),
    get_discussion: tool('get_discussion', getDiscussion),
    stop_discussion: tool('stop_discussion', stopDiscussion)
  }
}

/** The argument type one tool's implementation receives, after parsing. */
type ToolArgs<N extends McpToolName> = z.infer<(typeof MCP_TOOL_INPUTS)[N]>

type ToolImpl<N extends McpToolName> = (
  args: ToolArgs<N>,
  call: ToolCallContext
) => Promise<ToolOutcome>

/**
 * Parsing and the two failure rules, once, for every tool.
 *
 * The wrapper is what makes rules 1 and 2 of the header structural rather than
 * something each of the six has to remember: an implementation below receives
 * arguments that are already valid and may throw a `BackendFailure` freely,
 * because the only way out of this function is a `ToolOutcome`.
 */
function tool<N extends McpToolName>(name: N, implementation: ToolImpl<N>): ToolRegistry[N] {
  return async (args, call) => {
    const parsed = MCP_TOOL_INPUTS[name].safeParse(args)
    if (!parsed.success) {
      return { ok: false, code: 'validation', message: zodMessage(parsed.error) }
    }
    try {
      return await implementation(parsed.data as ToolArgs<N>, call)
    } catch (cause) {
      return failure(cause)
    }
  }
}

/**
 * zod's own words, passed through.
 *
 * The schema's messages were written for this reader (`mcp-tools.ts`: "the wire
 * schema describes the fields and the *message* of a refusal describes the
 * rule"), so rewriting them here would throw away the one place the rule is
 * stated in prose. A field path is prefixed when there is one — `question` says
 * nothing about which argument it was — and several issues are joined rather
 * than dropped, because zod reports the cross-field refinements together and a
 * caller that got one of three would fix one of three.
 */
function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map((segment) => String(segment)).join('.')
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message
    })
    .join(' ')
}

/** A refusal of the caller's input, in the tool's own words. */
function refuse(message: string): ToolOutcome {
  return { ok: false, code: 'validation', message }
}

/** Anything thrown below, as an outcome. A `BackendFailure` keeps its code. */
function failure(cause: unknown): ToolOutcome {
  if (isBackendFailure(cause)) return { ok: false, code: cause.code, message: cause.message }
  return {
    ok: false,
    code: 'internal',
    message: cause instanceof Error ? cause.message : String(cause)
  }
}

/* -------------------------------------------------------------------------- */
/* list_chats                                                                  */
/* -------------------------------------------------------------------------- */

interface ChatSummary {
  id: string
  title: string
  url: string
  memberNames: string[]
  /** The goal's kind, or `null` for a chat nobody has given a goal. */
  goalKind: string | null
  /** ISO 8601, because the caller is not a UI and has no locale. */
  updatedAt: string
  /** True while a run is in flight; `start_discussion` would answer `busy`. */
  running: boolean
}

/**
 * The chats, most recently active first.
 *
 * `query` filters over titles **and member names**, which is how a caller finds
 * "the one the architects were in" without remembering what it was called. It is
 * deliberately not `chats.search`: that handler also searches message bodies and
 * returns ids, and a tool whose answer changed because a word appeared inside a
 * message would be a surprising thing to give a model.
 */
async function listChats(
  args: ToolArgs<'list_chats'>,
  call: ToolCallContext
): Promise<ToolOutcome> {
  const { ctx, handlers } = call
  const chats = await handlers['chats.list'](ctx)
  const names = await agentNames(ctx, handlers)

  const query = args.query?.trim().toLowerCase() ?? ''
  const summaries: ChatSummary[] = []

  for (const chat of chats) {
    const members = await handlers['chats.members.list'](ctx, { chatId: chat.id })
    const memberNames = members.map((member) => names.get(member.agentId) ?? member.agentId)
    if (query.length > 0 && !matches(chat, memberNames, query)) continue
    summaries.push({
      id: chat.id,
      title: chat.title,
      url: chatUrl(chat.id),
      memberNames,
      goalKind: chat.goal?.kind ?? null,
      updatedAt: new Date(chat.updatedAt).toISOString(),
      running: ctx.runners.getState(chat.id) !== null
    })
  }

  const hint =
    summaries.length === 0
      ? 'No chat matched. Call list_agents and start_discussion with a fresh group instead.'
      : 'Pass one of these chatIds to start_discussion to continue that group, or to get_discussion to read it.'

  const lines = summaries.map(
    (chat) =>
      `- ${chat.title} — ${chat.id}${chat.running ? ' (running)' : ''}\n  members: ${
        chat.memberNames.join(', ') || 'none'
      }\n  updated: ${chat.updatedAt}${chat.goalKind === null ? '' : `\n  goal: ${chat.goalKind}`}`
  )

  return {
    ok: true,
    structured: { chats: summaries, hint },
    text: [`${summaries.length} chat(s).`, ...lines, '', hint].join('\n')
  }
}

function matches(chat: Chat, memberNames: string[], query: string): boolean {
  if (chat.title.toLowerCase().includes(query)) return true
  return memberNames.some((name) => name.toLowerCase().includes(query))
}

/* -------------------------------------------------------------------------- */
/* list_agents                                                                 */
/* -------------------------------------------------------------------------- */

interface AgentSummary {
  id: string
  name: string
  role: Agent['role']
  /** `<provider> · <model>`, or the model alone when the provider is gone. */
  model: string
  description: string
  /**
   * False for an executor: the caller is the executor, so inviting Witena's own
   * would be two writers over one folder (PLAN.md, "the role split").
   */
  invitable: boolean
}

async function listAgents(
  _args: ToolArgs<'list_agents'>,
  call: ToolCallContext
): Promise<ToolOutcome> {
  const { ctx, handlers } = call
  const agents = await handlers['agents.list'](ctx)
  const providers = await handlers['providers.list'](ctx)
  const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]))

  const summaries: AgentSummary[] = agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    role: agent.role,
    model: label(providerNames.get(agent.providerId), agent.modelId),
    description: agent.description,
    invitable: agent.role !== 'executor'
  }))

  const invitable = summaries.filter((agent) => agent.invitable)
  const hint =
    invitable.length === 0
      ? 'No agent can be invited. Ask the user to create participant agents in Witena first.'
      : 'Pass the names of the agents you want in `agents` on start_discussion. Executors cannot be invited: you are the executor.'

  const lines = summaries.map(
    (agent) =>
      `- ${agent.name} — ${agent.model}${agent.invitable ? '' : ' (executor, cannot be invited)'}`
  )

  return {
    ok: true,
    structured: { agents: summaries, hint },
    text: [`${summaries.length} agent(s).`, ...lines, '', hint].join('\n')
  }
}

function label(providerName: string | undefined, modelId: string): string {
  return providerName === undefined ? modelId : `${providerName} · ${modelId}`
}

/* -------------------------------------------------------------------------- */
/* start_discussion                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Ask a group, and wait for as long as the caller's budget allows.
 *
 * The order of the four steps is the whole of the tool, and it is not free to
 * rearrange:
 *
 * 1. The deadline is taken **first**, so the budget measures the caller's wait
 *    rather than the wait that was left after a chat was created.
 * 2. The chat is resolved or created, and refused (`busy`) if it is already
 *    talking — a second run over one chat would double-speak.
 * 3. `watchDiscussion` subscribes **before** `chat.send`, because a short
 *    discussion can finish inside the same turn of the event loop the send
 *    resolved in.
 * 4. Only then is the message sent. If the send throws, the watcher is
 *    cancelled: a subscription made in front of a send that never happened must
 *    not outlive the call.
 */
async function startDiscussion(
  args: ToolArgs<'start_discussion'>,
  call: ToolCallContext
): Promise<ToolOutcome> {
  const { ctx, handlers } = call
  const deadlineMs = deadlineFor(args.maxWaitSeconds)

  const total = args.question.length + (args.context?.length ?? 0)
  if (total > MAX_DISCUSSION_INPUT_CHARS) {
    return refuse(
      `question and context are ${total} characters together, and the limit is ${MAX_DISCUSSION_INPUT_CHARS}. Send the relevant excerpt rather than the whole file.`
    )
  }

  let chatId: string
  if (args.chatId !== undefined) {
    // `not_found` for an id the model invented, before anything is sent.
    await handlers['chats.get'](ctx, { id: args.chatId })
    if (ctx.runners.getState(args.chatId) !== null) {
      return {
        ok: false,
        code: 'busy',
        message: `That discussion is still running. Call wait_for_discussion with chatId ${args.chatId}, or stop_discussion to end it first.`
      }
    }
    chatId = args.chatId
  } else {
    const members = await resolveAgents(args.agents ?? [], ctx, handlers)
    if ('refusal' in members) return members.refusal
    const chat = await handlers['chats.create'](ctx, {
      input: {
        title: args.title ?? titleFrom(args.question),
        memberAgentIds: members.agentIds,
        // `workdir` is validated by `chats.create` against the real filesystem
        // (absolute, exists, is a directory) and refused before the row is
        // written, so a bad path never leaves a half-created chat behind. The
        // tool does not re-check it: the handler owns that boundary, and its
        // refusals already name the path they rejected.
        ...(args.workdir === undefined ? {} : { workdir: args.workdir })
      }
    })
    chatId = chat.id
  }

  const text =
    args.context === undefined || args.context.length === 0
      ? args.question
      : `${args.question}\n\n${args.context}`

  const afterSeq = (await loadTranscript(ctx, handlers, chatId)).length
  const watch = watchDiscussion(ctx, handlers, {
    chatId,
    afterSeq,
    deadlineMs,
    signal: call.signal,
    ...(call.progress === undefined ? {} : { progress: call.progress })
  })

  try {
    await handlers['chat.send'](ctx, {
      chatId,
      text,
      ...(args.rounds === undefined ? {} : { rounds: args.rounds })
    })
  } catch (cause) {
    watch.cancel()
    throw cause
  }

  return discussion(await watch.result)
}

/** The first line of the question, as the new chat's name. */
function titleFrom(question: string): string {
  const line = question
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0)
  if (line === undefined) return FALLBACK_TITLE
  return line.slice(0, MAX_TITLE_CHARS)
}

/**
 * The members of a new chat, from names or ids.
 *
 * Resolution is **id first, then a case-insensitive exact name**. Exact rather
 * than fuzzy because the caller has just been handed the list by `list_agents`
 * and a near-match is far more likely to be a different agent than a typo;
 * case-insensitive because a model writing prose will capitalise a name the way
 * the sentence wants it.
 *
 * Every refusal names what it could not use *and what it could have used*: a
 * model that is told "unknown agent" can only guess again, while one that is
 * handed the list corrects itself in the next call.
 */
async function resolveAgents(
  wanted: string[],
  ctx: AppContext,
  handlers: HandlerMap
): Promise<{ agentIds: string[] } | { refusal: ToolOutcome }> {
  const agents = await handlers['agents.list'](ctx)
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const invitable = agents.filter((agent) => agent.role !== 'executor').map((agent) => agent.name)

  const agentIds: string[] = []
  for (const entry of wanted) {
    const needle = entry.trim()
    const byIdMatch = byId.get(needle)
    const candidates =
      byIdMatch !== undefined
        ? [byIdMatch]
        : agents.filter((agent) => agent.name.toLowerCase() === needle.toLowerCase())

    if (candidates.length === 0) {
      return {
        refusal: refuse(
          `There is no agent called "${entry}". Available agents: ${
            invitable.join(', ') || 'none'
          }. Call list_agents to see them with their models.`
        )
      }
    }
    if (candidates.length > 1) {
      return {
        refusal: refuse(
          `"${entry}" matches more than one agent: ${candidates
            .map((agent) => `${agent.name} (${agent.id})`)
            .join(', ')}. Pass the id instead of the name.`
        )
      }
    }

    const agent = candidates[0] as Agent
    if (agent.role === 'executor') {
      return {
        refusal: refuse(
          `${agent.name} is an executor and cannot be invited: you are the executor. Witena's group reads and argues, and you apply the conclusion. Pick from: ${
            invitable.join(', ') || 'none'
          }.`
        )
      }
    }
    // The same agent named twice is one member: `setMembers` rejects a duplicate
    // outright, and a caller that wrote a name and then its id meant one seat.
    if (!agentIds.includes(agent.id)) agentIds.push(agent.id)
  }

  return { agentIds }
}

/* -------------------------------------------------------------------------- */
/* wait_for_discussion                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Keep waiting for a discussion that is already going.
 *
 * `afterSeq` is "the seq of the chat's last **user** message minus one", which
 * is the index of that message in the ascending transcript: the discussion this
 * result describes is the question *and* everything said after it, not just the
 * replies. A chat nobody has written to yet answers from position 0.
 *
 * The idle check is made after the transcript has been read and **before** the
 * subscription, both synchronously, so there is no window in which a run could
 * finish unobserved: either the runner was idle and the transcript already holds
 * the answer, or the watcher was attached while it was still going.
 */
async function waitForDiscussion(
  args: ToolArgs<'wait_for_discussion'>,
  call: ToolCallContext
): Promise<ToolOutcome> {
  const { ctx, handlers } = call
  const deadlineMs = deadlineFor(args.maxWaitSeconds)

  await handlers['chats.get'](ctx, { id: args.chatId })
  const afterSeq = lastQuestionAt(await loadTranscript(ctx, handlers, args.chatId))

  if (ctx.runners.getState(args.chatId) === null) {
    return discussion(await readDiscussion(ctx, handlers, { chatId: args.chatId, afterSeq }))
  }

  const watch = watchDiscussion(ctx, handlers, {
    chatId: args.chatId,
    afterSeq,
    deadlineMs,
    signal: call.signal,
    ...(call.progress === undefined ? {} : { progress: call.progress })
  })
  return discussion(await watch.result)
}

/**
 * The position of the last user message: where the current discussion began.
 *
 * `0` for a chat with no user message at all, which reads the whole transcript —
 * the honest answer for a chat nobody has asked anything in.
 */
function lastQuestionAt(transcript: Message[]): number {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.senderType === 'user') return index
  }
  return 0
}

/* -------------------------------------------------------------------------- */
/* get_discussion                                                              */
/* -------------------------------------------------------------------------- */

async function getDiscussion(
  args: ToolArgs<'get_discussion'>,
  call: ToolCallContext
): Promise<ToolOutcome> {
  const { ctx, handlers } = call
  const chat = await handlers['chats.get'](ctx, { id: args.chatId })
  const transcript = await loadTranscript(ctx, handlers, args.chatId)

  let from = 0
  if (args.afterMessageId !== undefined) {
    const index = transcript.findIndex((message) => message.id === args.afterMessageId)
    if (index < 0) {
      return refuse(
        `afterMessageId ${args.afterMessageId} is not a message of chat ${args.chatId}. Use an id from an earlier transcript of this chat, or leave it out.`
      )
    }
    from = index + 1
  }

  if (args.detail === 'transcript') {
    const said = transcript.slice(from)
    const markdown = renderTranscript(said, {
      title: chat.title,
      names: await agentNames(ctx, handlers)
    })
    const last = said[said.length - 1]
    const hint =
      'This is what was said, not a verdict. Call get_discussion with detail "conclusion" for the result, or pass the last message id as afterMessageId to read only what follows.'
    return {
      ok: true,
      structured: {
        chatId: args.chatId,
        url: chatUrl(args.chatId),
        detail: 'transcript',
        markdown,
        messageCount: said.length,
        ...(last === undefined ? {} : { lastMessageId: last.id }),
        hint
      },
      text: `${markdown}\n\n${hint}`
    }
  }

  // Without an `afterMessageId`, a conclusion is read from the last question
  // onwards — the same window `wait_for_discussion` uses, so the two agree on a
  // finished chat, which is what the tool's description promises.
  const afterSeq = args.afterMessageId === undefined ? lastQuestionAt(transcript) : from
  return discussion(await readDiscussion(ctx, handlers, { chatId: args.chatId, afterSeq }))
}

/* -------------------------------------------------------------------------- */
/* stop_discussion                                                             */
/* -------------------------------------------------------------------------- */

/**
 * End a run. Idempotent, like the handler underneath it.
 *
 * It does not report the resulting `DiscussionResult`: the turns are still
 * unwinding when `chat.stop` returns, so anything read here would describe a
 * discussion mid-abort rather than the one the caller stopped. `get_discussion`
 * a moment later is the honest way to see what was said.
 */
async function stopDiscussion(
  args: ToolArgs<'stop_discussion'>,
  call: ToolCallContext
): Promise<ToolOutcome> {
  const { ctx, handlers } = call
  // `chat.stop` is idempotent and asks no questions, so the existence check is
  // this tool's: a chat id the model invented must come back as `not_found`
  // rather than as a successful stop of nothing.
  await handlers['chats.get'](ctx, { id: args.chatId })
  const wasRunning = ctx.runners.getState(args.chatId) !== null
  await handlers['chat.stop'](ctx, { chatId: args.chatId })

  const hint = wasRunning
    ? 'The run was cancelled. Everything said so far is still in Witena — read it with get_discussion.'
    : 'That discussion was not running, so nothing was cancelled. Read it with get_discussion.'

  return {
    ok: true,
    structured: { chatId: args.chatId, url: chatUrl(args.chatId), wasRunning, hint },
    text: [`Discussion ${args.chatId}`, chatUrl(args.chatId), '', hint].join('\n')
  }
}

/* -------------------------------------------------------------------------- */
/* Shared rendering                                                            */
/* -------------------------------------------------------------------------- */

/** `Date.now()` plus the caller's budget, defaulted. */
function deadlineFor(maxWaitSeconds: number | undefined): number {
  return Date.now() + (maxWaitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000
}

/** Agent id → name, read once per call through the handler. */
async function agentNames(ctx: AppContext, handlers: HandlerMap): Promise<Map<string, string>> {
  const agents = await handlers['agents.list'](ctx)
  return new Map(agents.map((agent) => [agent.id, agent.name]))
}

/**
 * A `DiscussionResult` as the three waiting tools return it.
 *
 * The structured half is the result verbatim — one shape for `start_discussion`,
 * `wait_for_discussion` and `get_discussion`, so a caller that learned to read
 * one has learned all three — and the text half is the same value rendered for a
 * model that reads the text block first. It ends with the `hint`, which is the
 * line that says what to do next.
 */
function discussion(result: DiscussionResult): ToolOutcome {
  const lines = [`Discussion ${result.status} — round ${result.round}`, result.url]

  if (result.conclusion !== undefined) {
    lines.push('', `Conclusion by ${result.conclusion.agentName}:`, '', result.conclusion.markdown)
  }

  if (result.positions !== undefined && result.positions.length > 0) {
    lines.push('', 'Positions:')
    for (const position of result.positions) {
      lines.push(
        '',
        `**${position.agentName}**${position.truncated ? ' (truncated)' : ''}`,
        position.markdown
      )
    }
  }

  if (result.error !== undefined) lines.push('', `Error: ${result.error}`)

  if (result.usage !== undefined) {
    lines.push(
      '',
      `Tokens: ${result.usage.inputTokens} in, ${result.usage.outputTokens} out, ${result.usage.totalTokens} total.`
    )
  }

  lines.push('', result.hint)
  return { ok: true, structured: result, text: lines.join('\n') }
}
