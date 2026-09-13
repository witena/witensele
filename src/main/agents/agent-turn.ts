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
 * ## Tools (S3.1)
 *
 * `collectAgentTools` turns the agent's MCP servers into one `ToolSet` and
 * `streamText({ tools, stopWhen: stepCountIs(MAX_TOOL_STEPS) })` runs the loop:
 * call → result → call, until a step asks for no tool or the cap is reached. Each
 * `tool-call` and `tool-result` becomes a whole message part rather than a text
 * delta (`MessageDelta`'s `part` kind), so the transcript can draw a tool card,
 * and text that arrives after a tool starts a new `text` part on its own — the
 * append rule already says a delta of a different kind opens a new part.
 *
 * The side-effects rule lives in `collectAgentTools`: a server flagged
 * `sideEffects` is attached only to an `executor` agent. See its doc comment.
 *
 * ## The executor and its permission prompt (S5.4)
 *
 * `collectAgentTools` also attaches the seven built-in executor tools
 * (`executor/tools.ts`) — but only to **the** executor of a chat that has a
 * `workdir`. `write_file`, `edit_file`, `run_command` and every tool of a
 * `sideEffects` MCP server suspend inside `PermissionGate.ask` until the user
 * answers `permission.reply`; a denial or a stop comes back as a `tool-error`
 * part the model reads and can talk about. The whole feature is written up in
 * `docs/features/executor/`.
 *
 * When the stream is over, `diffPartsFrom` turns the patches those writes
 * returned into one `DiffPart` per file and appends them to the same message
 * (S5.5), so what an executor changed is a block in the transcript rather than a
 * field inside a tool result nobody expands.
 *
 * ## Skills and memory (S3.2, S3.3)
 *
 * The same function also attaches the built-in tools. `read_skill` and
 * `read_skill_file` appear when the agent has at least one skill that still
 * exists on disk, `memory_save` and `memory_search` when `agent.memoryEnabled`.
 * The system prompt carries their counterpart: one `name — description` line per
 * enabled skill (progressive disclosure — never a body), and the whole
 * `MEMORY.md` index capped at `MEMORY_PROMPT_MAX_BYTES`.
 *
 * ## Context budget (S4.2)
 *
 * The transcript is run through `fitHistory` before it is sent: the oldest
 * messages are dropped until the estimated prompt fits
 * `contextWindowFor(agent.modelId)` minus the agent's own output reserve
 * (`params.maxTokens`, or `DEFAULT_OUTPUT_RESERVE`). Both history paths go
 * through it — the sequential turn's fresh read and the snapshot a parallel round
 * shares — and the number dropped is returned as `droppedMessages` so
 * `ChatRunner` can announce it once per run rather than once per round. The
 * algorithm, and why the estimate is a character count rather than a tokenizer,
 * is in `context-budget.ts`.
 *
 * ## AI SDK v7 names used here
 *
 * Verified against `node_modules/ai/dist/index.d.ts` (ai 7.0.99); the full table
 * with the pitfalls is in `docs/features/agent-turn/backend.md`.
 * `streamText({ model, system, messages, abortSignal, tools, stopWhen,
 * maxOutputTokens, temperature, onError })`, iterated through
 * `result.fullStream`, whose parts are `text-delta` / `reasoning-delta` (both
 * carry `text`), `tool-call` (`toolCallId`, `toolName`, `input`), `tool-result`
 * (`toolCallId`, `output`), `tool-error` (`toolCallId`, `error`), `finish`
 * (carries `finishReason` and `totalUsage`, summed over every step), `abort` and
 * `error`. `stepCountIs` is exported by `ai` as an alias of `isStepCount`.
 */
import { stepCountIs, streamText, type LanguageModel, type LanguageModelUsage, type ToolSet } from 'ai'
import type { BackendEvent } from '@shared/events'
import { parseMentions } from '@shared/mentions'
import { isPassOnly } from '@shared/pass'
import { contextWindowFor } from '@shared/pricing'
import type {
  Agent,
  Chat,
  DiffPart,
  Message,
  MessagePart,
  MessageStatus,
  ReasoningPart,
  SkillMeta,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  Usage
} from '@shared/types'
import type { AppContext } from '../app-context'
import { skillsDir } from '../app-context'
import {
  buildExecutorSection,
  buildExecutorTools,
  EDIT_FILE_TOOL,
  PermissionDeniedError,
  WRITE_FILE_TOOL
} from '../executor/tools'
import { toAiTools, type AgentTools, type ToolOrigin } from '../mcp/tools'
import { buildMemorySection, buildMemoryTools } from '../memory/tools'
import { scanSkills } from '../skills/loader'
import { buildSkillsSection, buildSkillTools } from '../skills/tools'
import { isTimeoutAbort, TIMEOUT_ERROR } from '../presence/abort-reasons'
import type { TurnOutcome } from '../presence/supervisor'
import { modelOptions } from '../app-context'
import { createLanguageModel } from '../providers/registry'
import { resolveProvider } from '../providers/resolve'
import { buildGroupBriefing, resolveMainLanguage, toBriefingMember } from './briefing'
import { DEFAULT_OUTPUT_RESERVE, fitHistory } from './context-budget'
import { toModelMessages } from './history'

/** Partial text is written to the database at least this often, in milliseconds. */
export const FLUSH_INTERVAL_MS = 500

/** …and at least this often in deltas, for a model that streams faster than that. */
export const FLUSH_EVERY_DELTAS = 40

/** Detail stored in `Message.error` when the user pressed Stop. */
export const ABORTED_ERROR = 'aborted'

/** Notice inserted when the supervisor's hard timeout skipped an agent's turn. */
export const NOTICE_AGENT_SKIPPED = 'agentSkipped'

/** Notice inserted once per chat when a model turned out not to accept tools. */
export const NOTICE_TOOLS_UNSUPPORTED = 'toolsUnsupported'

/**
 * How many model calls one turn may take when tools are in play.
 *
 * `streamText` loops call → result → call until a step produces no tool call, so
 * without a cap a model that keeps asking for the same tool never returns and
 * only the hard timeout ends the turn. Eight leaves room for a real chain (look
 * something up, look the next thing up, answer) while keeping the worst case to a
 * number of requests a user can afford to have been billed for.
 */
export const MAX_TOOL_STEPS = 8

/** The terminal status a turn ends in, mapped to what the supervisor is told. */
function outcomeOf(status: MessageStatus, aborted: boolean): TurnOutcome {
  if (status === 'skipped') return 'skipped'
  if (status === 'passed') return 'passed'
  if (status === 'done') return 'done'
  return aborted ? 'aborted' : 'error'
}

/** Builds the model client for an agent. Injected by tests; defaults to the registry. */
export type CreateModel = (ctx: AppContext, agent: Agent) => LanguageModel

/**
 * The default: resolve the provider (decrypting its key) and build the adapter.
 *
 * `modelOptions(ctx)` carries the Anthropic CLI, which is what a provider in
 * sign-in mode needs to mint a token for this turn (S5.3). A provider on an API
 * key never touches it.
 */
export const createModelFromRegistry: CreateModel = (ctx, agent) =>
  createLanguageModel(
    resolveProvider(ctx, { id: agent.providerId }),
    agent.modelId,
    modelOptions(ctx)
  )

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
  /**
   * How many of the oldest history messages `fitHistory` had to leave out of
   * this turn's prompt. `0` in every chat short enough to fit.
   *
   * Reported rather than announced here: the user-visible `contextTruncated`
   * notice belongs to the **run**, and `ChatRunner` is the only object that
   * knows a run is under way, so it is the one that stores the notice — once per
   * run per agent rather than once per round.
   */
  droppedMessages: number
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
 * One `DiffPart` per file this turn wrote (S5.5).
 *
 * The write tools return `{ path, patch }` and the patch reaches the transcript
 * only as a field buried inside the `tool-result` JSON, which nobody reads. This
 * turns it into the block the user actually looks at, and it is computed from
 * the parts rather than collected during the stream so that it has exactly one
 * source of truth: what was stored.
 *
 * Three rules, each of them a case that occurs:
 *
 * - **Per file, not per call.** An executor that writes a file and then edits it
 *   twice produced one changed file, so the patches are concatenated in the
 *   order they happened. First-write order decides where the file's block sits.
 * - **Only successful calls.** A denied or refused write has `isError`, no
 *   patch, and nothing to show.
 * - **Only the write tools.** `git_diff` also returns a `patch`, and it is a
 *   *report* about the folder rather than a change this turn made; posting it as
 *   the turn's diff would claim the executor wrote something it did not.
 */
export function diffPartsFrom(parts: readonly MessagePart[]): DiffPart[] {
  /** The write calls, in the order the model made them. */
  const writes = parts
    .filter(
      (part): part is ToolCallPart =>
        part.type === 'tool-call' &&
        (part.toolName === WRITE_FILE_TOOL || part.toolName === EDIT_FILE_TOOL)
    )
    .map((part) => part.toolCallId)
  if (writes.length === 0) return []

  const results = new Map<string, ToolResultPart>()
  for (const part of parts) {
    if (part.type === 'tool-result') results.set(part.toolCallId, part)
  }

  // Walked in **call** order rather than in the order the results came back: two
  // writes issued in one step finish in whichever order the filesystem answers,
  // and a transcript whose blocks reshuffle between two identical turns is one
  // nobody can compare against anything.
  //
  // Insertion-ordered, so a file keeps the position of its first write.
  const byPath = new Map<string, string[]>()
  for (const toolCallId of writes) {
    const result = results.get(toolCallId)
    if (!result || result.isError === true) continue

    const output = result.output as { path?: unknown; patch?: unknown } | null
    if (!output || typeof output !== 'object') continue
    const { path, patch } = output
    if (typeof path !== 'string' || path.length === 0) continue
    if (typeof patch !== 'string' || patch.trim().length === 0) continue

    const collected = byPath.get(path)
    if (collected) collected.push(patch)
    else byPath.set(path, [patch])
  }

  return [...byPath.entries()].map(([path, patches]) => ({
    type: 'diff' as const,
    path,
    // A patch from `createPatch` ends with a newline, but a hand-made one may
    // not, and two headers running into each other would break the block.
    patch: patches.map((patch) => (patch.endsWith('\n') ? patch : `${patch}\n`)).join('')
  }))
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

/**
 * The skills this agent has enabled **and** that still exist on disk.
 *
 * Matched on the skill's `name` first and its folder second, both
 * case-insensitively, in the order the agent lists them. A name that no longer
 * resolves is skipped silently here — the agent editor is where a missing skill
 * is reported, because that is where it can be fixed; a turn that failed because
 * a folder was moved would be a worse answer than one given without it.
 */
export function enabledSkills(ctx: AppContext, agent: Agent): SkillMeta[] {
  if (agent.skillNames.length === 0) return []
  const available = scanSkills(skillsDir(ctx))
  const found: SkillMeta[] = []
  for (const wanted of agent.skillNames) {
    const key = wanted.trim().toLowerCase()
    const skill =
      available.find((candidate) => candidate.name.toLowerCase() === key) ??
      available.find((candidate) => candidate.folder.toLowerCase() === key)
    if (skill && !found.includes(skill)) found.push(skill)
  }
  return found
}

/**
 * The system prompt, in the order `docs/PLAN.md` ("One agent turn") fixes: the
 * agent's own instructions, the group briefing, the executor's folder and tools
 * when it is one, the enabled skills' names and descriptions, then the whole
 * memory index.
 *
 * Skills and memory come **after** the briefing because they are data the agent
 * may reach for, while the briefing is how it must behave; a model that runs out
 * of attention should lose the reference material first, not the protocol. The
 * executor section sits between the two for the same reason: it is protocol —
 * which folder, which tools, what to do when it is finished — and is only
 * present when the tools it describes are actually attached, because a prompt
 * that promises a tool the model was not given is how a model starts describing
 * tool calls in prose.
 */
export function buildSystemPrompt(
  ctx: AppContext,
  chat: Chat,
  agent: Agent,
  members: Agent[]
): string {
  const language = resolveMainLanguage(ctx.repos.settings.get(ctx.userId).language)
  const briefing = buildGroupBriefing({
    language,
    self: toBriefingMember(agent),
    members: members.map(toBriefingMember),
    memoryEnabled: agent.memoryEnabled
  })

  const sections = [agent.systemPrompt.trim(), briefing]

  if (executorWorkdir(chat, agent, members)) {
    sections.push(buildExecutorSection(chat.workdir as string))
  }

  const skills = buildSkillsSection(enabledSkills(ctx, agent))
  if (skills.length > 0) sections.push(skills)

  if (agent.memoryEnabled) sections.push(buildMemorySection(ctx.memory.readIndex(agent.id)))

  return sections.filter((section) => section.length > 0).join('\n\n')
}

/**
 * The folder this agent may act on, or `null` — the single rule behind both the
 * executor tools and the executor section of the prompt.
 *
 * Three conditions, all necessary:
 *
 * 1. **The agent's role is `executor`.** A participant never gets these tools,
 *    whatever the chat says (PLAN.md: discussion agents are read-only).
 * 2. **The chat has a `workdir`.** There is no default folder and no fallback to
 *    the process's working directory: an executor in a chat nobody bound to a
 *    folder simply has no file tools, which S5.2 chose over refusing the member.
 * 3. **It is *the* executor of this chat** — the first `executor` in the member
 *    list, which the runner passes in `position` order.
 *
 * The third condition exists because `chats.members.set` is not the only way to
 * end up with two executors in one chat: `agents.update` can still *promote* a
 * participant that is already a member, which S5.2 recorded as a known gap. Two
 * agents writing into one folder is exactly what PLAN.md's one-writer decision
 * exists to prevent, so the tie is broken deterministically here rather than
 * left to whichever turn runs first.
 */
export function executorWorkdir(chat: Chat, agent: Agent, members: readonly Agent[]): string | null {
  if (agent.role !== 'executor') return null
  if (typeof chat.workdir !== 'string' || chat.workdir.trim().length === 0) return null
  const first = members.find((member) => member.role === 'executor')
  // `first` is undefined only when the caller passed a member list this agent is
  // not in, which the runner never does; trusting the agent's own role then is
  // the safer of the two answers, because the alternative silently disarms an
  // executor the user is watching.
  if (first && first.id !== agent.id) return null
  return chat.workdir
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                       */
/* -------------------------------------------------------------------------- */

/** What `collectAgentTools` needs from the turn: its signal, its budget, its chat. */
export interface CollectToolsOptions {
  signal: AbortSignal
  toolTimeoutMs: number
  /**
   * Everyone in the chat, in `position` order.
   *
   * Needed only to pick the chat's executor deterministically when the member
   * list somehow holds two; see `executorWorkdir`.
   */
  members: readonly Agent[]
}

/**
 * Every tool this agent may call, from every MCP server it is bound to.
 *
 * Three filters apply, in this order:
 *
 * 1. **The record still exists.** A server deleted while it was still listed on
 *    an agent is skipped, not an error: `mcp.delete` unbinds it from every agent,
 *    but a turn already in flight may hold a stale copy.
 * 2. **The server is enabled.** A disabled server is off for every agent.
 * 3. **The side-effects rule** (PLAN, "Future extension"; STEPS S3.1): a server
 *    flagged `sideEffects` is attached **only** to an `executor` agent.
 *    Participants discuss, and discussion must not write files, send mail or push
 *    commits — several models writing to one directory overwrite each other and
 *    nothing is reviewable. This is the enforcement point named in the plan, so
 *    it lives here rather than in the UI, which only explains it.
 *
 * A server that cannot be reached is skipped with a log line rather than failing
 * the turn: one broken tool server must not silence an agent that could still
 * answer from what it knows.
 *
 * On top of those, the **built-in** tools: `read_skill` / `read_skill_file` when
 * the agent has at least one skill that still exists (S3.2), `memory_save` /
 * `memory_search` when its memory is on (S3.3), and the seven **executor** tools
 * when `executorWorkdir` says this agent is the chat's executor and the chat has
 * a folder (S5.4). See the end of the function for why the side-effects rule
 * does not reach the first two families.
 *
 * ## Where the permission prompt is attached
 *
 * Here, not inside the tools: `mcp/tools.ts` is pure and knows nothing about a
 * chat, and the executor tools ask through the gate they are handed. So the
 * `call` closure this function builds for an MCP server checks `sideEffects` and
 * asks first — which means the flag that decides *whether an agent may have a
 * tool at all* and the flag that decides *whether a call is confirmed* are read
 * in one place, from one record.
 */
export async function collectAgentTools(
  ctx: AppContext,
  chat: Chat,
  agent: Agent,
  options: CollectToolsOptions
): Promise<AgentTools> {
  const tools: ToolSet = {}
  const origins: Record<string, ToolOrigin> = {}

  for (const serverId of agent.mcpServerIds) {
    let server
    try {
      server = ctx.repos.mcpServers.get(serverId, ctx.userId)
    } catch {
      continue
    }
    if (!server.enabled) continue

    if (server.sideEffects && agent.role !== 'executor') {
      console.debug(
        `[witena] tools from "${server.name}" withheld from ${agent.name}: ` +
          'the server has side effects and the agent is not an executor'
      )
      continue
    }

    try {
      const discovered = await ctx.mcp.listTools(serverId)
      const wrapped = toAiTools(serverId, server.name, discovered, async (toolName, args) => {
        // Every tool of a side-effecting server is confirmed, not only the ones
        // whose name sounds dangerous: the server declared that its tools change
        // the outside world and this layer cannot tell which of them do.
        if (server.sideEffects) {
          const outcome = await ctx.permissions.ask({
            chatId: chat.id,
            agentId: agent.id,
            toolName,
            input: args,
            signal: options.signal
          })
          if (!outcome.allowed) throw new PermissionDeniedError(toolName, outcome.reason)
        }
        return await ctx.mcp.callTool(serverId, toolName, args, {
          signal: options.signal,
          timeoutMs: options.toolTimeoutMs
        })
      })
      for (const [key, definition] of Object.entries(wrapped.tools)) {
        // Two servers whose names sanitize to the same slug would collide; the
        // first one keeps the key, which is at least stable across turns.
        if (key in tools) continue
        tools[key] = definition
        origins[key] = wrapped.origins[key] as ToolOrigin
      }
    } catch (error) {
      console.warn(`[witena] MCP server "${server.name}" is unavailable: ${describe(error)}`)
    }
  }

  // The built-in tools, which have no server behind them and therefore no
  // `origins` entry: the transcript shows them by their own name.
  //
  // They are attached **after** the MCP loop and are not subject to the
  // side-effects rule above, for the reasons written out in `skills/tools.ts`
  // and `memory/tools.ts`: reading a skill is read-only, and the only thing
  // `memory_save` can write is this agent's own notes folder. Neither can reach
  // a file the user is working on, which is what the rule protects.
  const skills = enabledSkills(ctx, agent)
  if (skills.length > 0) {
    Object.assign(tools, buildSkillTools(skillsDir(ctx), skills))
  }
  if (agent.memoryEnabled) {
    Object.assign(tools, buildMemoryTools(ctx.memory, agent.id))
  }

  // The executor's own file, search, shell and git tools (S5.4). Unlike the two
  // families above, these *are* the side-effects rule rather than an exception
  // to it: three of the seven go through `ctx.permissions` before they run, and
  // all seven are confined to the chat's folder.
  const workdir = executorWorkdir(chat, agent, options.members)
  if (workdir) {
    Object.assign(
      tools,
      buildExecutorTools({
        workdir,
        chatId: chat.id,
        agentId: agent.id,
        signal: options.signal,
        timeoutMs: options.toolTimeoutMs,
        permissions: ctx.permissions
      })
    )
  }

  return { tools, origins }
}

/**
 * Whether a provider failure looks like "this model cannot do tools".
 *
 * A heuristic, and deliberately a narrow one: providers disagree completely on
 * how they say it (Ollama answers "does not support tools", an OpenAI-compatible
 * gateway a 400 about an unknown field), and there is no error class to switch
 * on. Both halves must match, so a tool that merely *failed* is not mistaken for
 * a model that cannot be given tools at all.
 */
export function looksLikeToolRejection(detail: string): boolean {
  return (
    /tools?\b|function[_ -]?call/i.test(detail) &&
    /unsupported|not supported|does ?n[o']?t support|unknown (field|parameter)|unrecognized|invalid[_ ]request/i.test(
      detail
    )
  )
}

/** True when this chat has already been told that this agent's model has no tools. */
function noticedToolsUnsupported(ctx: AppContext, chatId: string, agentName: string): boolean {
  return ctx.repos.messages.listForContext(chatId, ctx.userId).some((message) =>
    message.parts.some(
      (part) =>
        part.type === 'system-notice' &&
        part.key === NOTICE_TOOLS_UNSUPPORTED &&
        part.params?.['agent'] === agentName
    )
  )
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
  /** Set when the turn had to drop its tools; drives the notice below. */
  let toolsUnsupported = false
  /** How many history messages the context budget removed; reported to the runner. */
  let droppedMessages = 0

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

  /** Appends a whole part and pushes it as one `part` delta. */
  const onPart = (part: MessagePart): void => {
    parts.push(part)
    emit({ type: 'message.delta', chatId: chat.id, messageId: created.id, delta: { kind: 'part', part } })
    // A tool call can be followed by a long wait for the tool; flushing here
    // means a crash during that wait still leaves the call visible.
    flush()
  }

  /**
   * One `streamText` run, consumed to the end.
   *
   * Factored out because it may have to happen **twice**: a model whose provider
   * rejects tools outright gets a second, tool-free attempt (see the call site).
   * It reports the failure rather than throwing, so the caller can decide whether
   * that failure is worth retrying.
   */
  const consume = async (attached: AgentTools | null): Promise<string | undefined> => {
    const model = options.model ?? (options.createModel ?? createModelFromRegistry)(ctx, agent)
    const agentsById = Object.fromEntries(members.map((member) => [member.id, member]))
    const origins = attached?.origins ?? {}

    const system = buildSystemPrompt(ctx, chat, agent, members)
    // Both history paths go through the budget: the sequential turn's fresh read
    // and the snapshot the runner took once for a parallel round. A long chat
    // overflows every speaker at the same moment, so exempting either one would
    // mean half the round failing where the other half was trimmed.
    const budgeted = fitHistory({
      system,
      messages: toModelMessages({
        self: agent,
        agentsById,
        messages: options.history ?? ctx.repos.messages.listForContext(chat.id, ctx.userId)
      }),
      contextWindow: contextWindowFor(agent.modelId),
      reserveForOutput: agent.params.maxTokens ?? DEFAULT_OUTPUT_RESERVE
    })
    if (budgeted.droppedCount > 0) {
      // Reported once per attempt; the retry-without-tools path re-runs this and
      // would otherwise double the count the runner announces.
      droppedMessages = budgeted.droppedCount
      console.info(
        `[witena] ${agent.name}: dropped ${budgeted.droppedCount} history messages to fit ` +
          `${agent.modelId} (~${budgeted.estimatedTokens} tokens of ${contextWindowFor(agent.modelId)})`
      )
    }

    const result = streamText({
      model,
      system,
      messages: budgeted.messages,
      abortSignal: turnSignal,
      ...(attached && Object.keys(attached.tools).length > 0
        ? { tools: attached.tools, stopWhen: stepCountIs(MAX_TOOL_STEPS) }
        : {}),
      ...(agent.params.maxTokens ? { maxOutputTokens: agent.params.maxTokens } : {}),
      ...(agent.params.temperature !== undefined ? { temperature: agent.params.temperature } : {}),
      // The SDK's default handler logs the error itself; the `error` part below
      // is the one that decides what the user sees, so silence the duplicate.
      onError: () => {}
    })

    let detail: string | undefined

    for await (const part of result.fullStream) {
      // Every part is a heartbeat, not only the ones that carry text: a model
      // that streams nothing but reasoning, or that is waiting on a tool, is
      // working, and the stall timeout must not fire underneath it.
      ctx.supervisor.activity(chat.id, agent.id)

      switch (part.type) {
        case 'text-delta':
          onDelta('text', part.text)
          break
        case 'reasoning-delta':
          onDelta('reasoning', part.text)
          break
        case 'tool-call': {
          // `part.toolName` is the prefixed key the model was shown; the
          // transcript stores the tool's own name plus where it came from.
          const origin = origins[part.toolName]
          const call: ToolCallPart = {
            type: 'tool-call',
            toolCallId: part.toolCallId,
            toolName: origin?.toolName ?? part.toolName,
            input: part.input,
            ...(origin ? { serverId: origin.serverId, serverName: origin.serverName } : {})
          }
          onPart(call)
          break
        }
        case 'tool-result': {
          const done: ToolResultPart = {
            type: 'tool-result',
            toolCallId: part.toolCallId,
            output: part.output
          }
          onPart(done)
          break
        }
        case 'tool-error': {
          // A tool that threw — including the `isError: true` an MCP server
          // reports — is stored as a result the card can mark red, not as a
          // turn-ending failure: the model gets the error back and may recover.
          const failed: ToolResultPart = {
            type: 'tool-result',
            toolCallId: part.toolCallId,
            output: describe(part.error),
            isError: true
          }
          onPart(failed)
          break
        }
        case 'finish':
          // `totalUsage` is the sum over every step of the tool loop, so no
          // accumulation is needed here even for a multi-step turn.
          usage = toUsage(part.totalUsage)
          break
        case 'abort':
          aborted = true
          break
        case 'error':
          detail = describe(part.error)
          break
        default:
          break
      }
    }

    return detail
  }

  try {
    // Stopped before the first request: nothing to stream, and `streamText`
    // would reject with a provider-shaped error for what is a user action.
    if (turnSignal.aborted) throw new TurnAborted()

    const toolTimeoutMs = ctx.repos.settings.get(ctx.userId).timeouts.toolTimeoutMs
    const attached = await collectAgentTools(ctx, chat, agent, {
      signal: turnSignal,
      toolTimeoutMs,
      members
    })
    const hasTools = Object.keys(attached.tools).length > 0

    failure = await consume(hasTools ? attached : null)

    // A provider that refuses tools outright fails before a single token is
    // streamed. Answering without tools is far better than answering nothing, so
    // the turn is retried once and the chat is told — once — what happened.
    if (hasTools && failure && parts.length === 0 && !turnSignal.aborted && looksLikeToolRejection(failure)) {
      console.warn(`[witena] ${agent.modelId} rejected tools; retrying without them: ${failure}`)
      const shouldNotice = !noticedToolsUnsupported(ctx, chat.id, agent.name)
      failure = await consume(null)
      if (!failure && shouldNotice) toolsUnsupported = true
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

  // What the turn changed on disk, as one block per file (S5.5). Appended after
  // the stream rather than as each write returns, so a file written three times
  // is one block instead of three — and appended even when the turn was stopped
  // or failed afterwards, because the writes really happened and hiding them is
  // the one thing the transcript must never do.
  for (const diff of diffPartsFrom(parts)) onPart(diff)

  // The supervisor's hard timeout and the user's Stop both arrive as an abort;
  // only the reason tells them apart, and they end in different statuses.
  const timedOut = isTimeoutAbort(turnSignal.reason)

  const text = textOf(parts).trim()
  const status: MessageStatus = timedOut
    ? 'skipped'
    : aborted || failure
      ? 'error'
      : // Only a reply that is *nothing but* the token abstains. A model that
        // answered and then signed the answer off with `[PASS]` stays `done`;
        // the trailing marker is stripped where the text is read, never from
        // the stored parts (see `@shared/pass`).
        isPassOnly(text)
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

    // "X's model cannot use tools" — once per chat per agent, because the model
    // will keep refusing on every round and a notice per round would bury the
    // discussion under the same sentence.
    if (toolsUnsupported) {
      const notice = ctx.repos.messages.create(
        {
          chatId: chat.id,
          senderType: 'system',
          senderId: 'system',
          parts: [
            { type: 'system-notice', key: NOTICE_TOOLS_UNSUPPORTED, params: { agent: agent.name } }
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
    return { message, status, aborted: aborted && !timedOut, droppedMessages }
  } finally {
    ctx.supervisor.endTurn({
      chatId: chat.id,
      agentId: agent.id,
      outcome: outcomeOf(status, aborted)
    })
  }
}
