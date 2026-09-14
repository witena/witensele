/**
 * `agents.*`: the agent library the configuration page edits.
 *
 * Thin like the other namespace files — persistence is `repos.agents`' job — so
 * what lives here is **validation and the events the rest of the app needs**.
 *
 * Three rules are worth reading before changing anything:
 *
 * - **A name is an identity, not a label.** S2.3 resolves `@name` against this
 *   table, so a name is rejected when it trims to nothing, when it contains `@`
 *   (which would make the mention unparseable) and when another agent already
 *   holds it case-insensitively. Spaces inside a name are *allowed*: "Architect
 *   copy" has to be a legal duplicate, and S2.3 resolves the longest matching
 *   name rather than splitting on whitespace.
 * - **The provider must exist and the model must be named.** An agent whose
 *   `providerId` points at a deleted row fails at the first turn with a provider
 *   error the user cannot act on; rejecting it here fails at the moment the
 *   mistake is made instead.
 * - **"Show thinking" is decided at creation, not at render time** (S5.14).
 *   `agents.create` writes `params.reasoning` from the agent's provider when the
 *   caller left it out, so a new agent on an open model starts with its thinking
 *   hidden and one on Claude, GPT or Gemini starts with it shown. See
 *   `withThinkingDefault`.
 * - **Deleting an agent is not only a row delete.** `chat_members.agent_id`
 *   cascades, so the agent silently leaves every chat. Any of those chats may be
 *   mid-run with that very agent streaming, so the run is stopped first, and
 *   every affected chat gets a `chat.updated` so the member panel and the
 *   "N members" line stop showing somebody who is gone.
 *
 * `role` is accepted so the reserved executor role can be written by a future
 * caller, but only `participant` and `executor` are legal values and the UI
 * offers only the first (see "Future extension" in `docs/PLAN.md`).
 */
import { showsThinkingByDefault } from '@shared/presets'
import type { AgentInput, AgentParams, AgentRole } from '@shared/types'
import { validation } from '../errors'
import type { AppContext } from '../app-context'
import type { HandlerModule } from './types'

/** The two roles `Agent.role` may hold. `executor` is reserved, not implemented. */
const ROLES: readonly AgentRole[] = ['participant', 'executor']

/** Temperature range every supported provider accepts. */
const TEMPERATURE_MIN = 0
const TEMPERATURE_MAX = 2

function assertId(input: unknown, what: string): asserts input is { id: string } {
  const id = (input as { id?: unknown })?.id
  if (typeof id !== 'string' || id.length === 0) throw validation(`A ${what} id is required`)
}

/**
 * Name rules, shared by create and update.
 *
 * `excludeId` is the record being updated: an agent must be allowed to keep its
 * own name, so it is excluded from the uniqueness scan.
 */
function assertName(ctx: AppContext, name: unknown, excludeId?: string): void {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw validation('An agent name cannot be empty')
  }
  if (name.includes('@')) throw validation('An agent name cannot contain @')

  const wanted = name.trim().toLowerCase()
  const clash = ctx.repos.agents
    .list(ctx.userId)
    .some((agent) => agent.id !== excludeId && agent.name.trim().toLowerCase() === wanted)
  if (clash) throw validation('An agent with that name already exists', { name })
}

function assertProvider(ctx: AppContext, providerId: unknown): void {
  if (typeof providerId !== 'string' || providerId.length === 0) {
    throw validation('An agent needs a provider')
  }
  // Throws `not_found` for an id that is gone or belongs to another user.
  ctx.repos.providers.get(providerId, ctx.userId)
}

function assertModelId(modelId: unknown): void {
  if (typeof modelId !== 'string' || modelId.trim().length === 0) {
    throw validation('An agent needs a model id')
  }
}

function assertParams(params: unknown): asserts params is AgentParams {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw validation('agent params must be an object')
  }
  const { temperature, maxTokens, reasoning } = params as AgentParams
  if (reasoning !== undefined && typeof reasoning !== 'boolean') {
    throw validation('reasoning must be a boolean')
  }
  if (temperature !== undefined) {
    if (
      typeof temperature !== 'number' ||
      !Number.isFinite(temperature) ||
      temperature < TEMPERATURE_MIN ||
      temperature > TEMPERATURE_MAX
    ) {
      throw validation(`temperature must be between ${TEMPERATURE_MIN} and ${TEMPERATURE_MAX}`)
    }
  }
  if (maxTokens !== undefined) {
    if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0) {
      throw validation('maxTokens must be a positive integer')
    }
  }
}

function assertRole(role: unknown): void {
  if (!ROLES.includes(role as AgentRole)) throw validation('unknown agent role')
}

function assertStringArray(value: unknown, what: string): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw validation(`${what} must be an array of strings`)
  }
}

/** The whole record, for `agents.create`. */
function assertAgentInput(ctx: AppContext, input: unknown): asserts input is AgentInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw validation('An agent input object is required')
  }
  const candidate = input as AgentInput
  assertName(ctx, candidate.name)
  assertProvider(ctx, candidate.providerId)
  assertModelId(candidate.modelId)
  assertParams(candidate.params)
  assertRole(candidate.role)
  assertStringArray(candidate.skillNames, 'skillNames')
  assertStringArray(candidate.mcpServerIds, 'mcpServerIds')
  if (typeof candidate.description !== 'string') throw validation('description must be a string')
  if (typeof candidate.systemPrompt !== 'string') throw validation('systemPrompt must be a string')
  if (typeof candidate.memoryEnabled !== 'boolean') {
    throw validation('memoryEnabled must be a boolean')
  }
  if (typeof candidate.avatar !== 'object' || candidate.avatar === null) {
    throw validation('An agent needs an avatar')
  }
}

/** Only the fields the patch actually carries, and only when present. */
function assertAgentPatch(
  ctx: AppContext,
  id: string,
  patch: unknown
): asserts patch is Partial<AgentInput> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw validation('An agent patch object is required')
  }
  const candidate = patch as Partial<AgentInput>
  if (candidate.name !== undefined) assertName(ctx, candidate.name, id)
  if (candidate.providerId !== undefined) assertProvider(ctx, candidate.providerId)
  if (candidate.modelId !== undefined) assertModelId(candidate.modelId)
  if (candidate.params !== undefined) assertParams(candidate.params)
  if (candidate.role !== undefined) assertRole(candidate.role)
  if (candidate.skillNames !== undefined) assertStringArray(candidate.skillNames, 'skillNames')
  if (candidate.mcpServerIds !== undefined) {
    assertStringArray(candidate.mcpServerIds, 'mcpServerIds')
  }
}

/**
 * The agent's `params` with `reasoning` — "show thinking" (S5.14) — filled in
 * from its provider when the caller did not choose.
 *
 * Read `agents.create`'s comment for why this happens here. The provider has
 * already been proved to exist by `assertProvider`, so the read cannot throw.
 */
function withThinkingDefault(ctx: AppContext, input: AgentInput): AgentParams {
  if (input.params.reasoning !== undefined) return input.params
  const provider = ctx.repos.providers.get(input.providerId, ctx.userId)
  return { ...input.params, reasoning: showsThinkingByDefault(provider) }
}

export const agentHandlers: HandlerModule = {
  'agents.list': async (ctx) => ctx.repos.agents.list(ctx.userId),

  'agents.get': async (ctx, input) => {
    assertId(input, 'agent')
    return ctx.repos.agents.get(input.id, ctx.userId)
  },

  'agents.create': async (ctx, input) => {
    const candidate = (input as { input?: unknown })?.input
    assertAgentInput(ctx, candidate)
    return ctx.repos.agents.create(
      {
        ...candidate,
        name: candidate.name.trim(),
        // S5.14: "show thinking" gets its answer the moment the agent is made,
        // from the provider it was pointed at, so the stored record carries a
        // choice rather than a gap. A caller that *did* choose is left alone —
        // including the agent editor, whose toggle always sends a boolean. Every
        // creation path in the product comes through here (the editor, Duplicate
        // and the first-run templates' `createFromTemplate`), which is why the
        // default lives in the handler and not in three renderer call sites.
        params: withThinkingDefault(ctx, candidate)
      },
      ctx.userId
    )
  },

  'agents.update': async (ctx, input) => {
    assertId(input, 'agent')
    // Proves the row exists before the patch is measured against it, so a patch
    // for a deleted agent fails as `not_found` rather than as a name clash.
    ctx.repos.agents.get(input.id, ctx.userId)
    assertAgentPatch(ctx, input.id, input.patch)

    const patch = input.patch as Partial<AgentInput>
    const updated = ctx.repos.agents.update(
      input.id,
      { ...patch, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}) },
      ctx.userId
    )

    // A renamed or re-modelled agent changes how every chat it sits in reads, and
    // the renderer's member panel is keyed on the chat. One event per chat keeps
    // the stores' single update path rather than adding an `agent.updated`.
    for (const chatId of ctx.repos.chats.listChatIdsForAgent(input.id, ctx.userId)) {
      ctx.events.emit({ type: 'chat.updated', chat: ctx.repos.chats.get(chatId, ctx.userId) })
    }
    return updated
  },

  'agents.delete': async (ctx, input) => {
    assertId(input, 'agent')
    ctx.repos.agents.get(input.id, ctx.userId)

    const affected = ctx.repos.chats.listChatIdsForAgent(input.id, ctx.userId)
    // Stop first: a turn still streaming for this agent would keep writing into a
    // chat whose membership is about to change under it. `stop` is idempotent, so
    // stopping an idle chat costs nothing.
    for (const chatId of affected) ctx.runners.stop(chatId)

    ctx.repos.agents.delete(input.id, ctx.userId)

    for (const chatId of affected) {
      ctx.events.emit({ type: 'chat.updated', chat: ctx.repos.chats.get(chatId, ctx.userId) })
    }
  }
}
