/**
 * `chats.*`, `messages.list` and the two run methods — everything the chat screen
 * calls.
 *
 * Thin, like `providers.ts`: persistence is the repositories' job, scheduling is
 * `ChatRunner`'s, and what is left here is **validation plus the events the rest
 * of the app needs to hear about**.
 *
 * Two decisions worth reading before changing anything:
 *
 * - **`chats.create` seeds members in exactly two ways.** `ChatCreateInput`
 *   carries `memberAgentIds`, and when it is given those agents become the chat's
 *   members in that order. When it is not, the chat is created **empty** — unless
 *   the agent library is still empty too, in which case `ensureDefaultAgent`
 *   writes the bootstrap agent and puts it in, so a fresh installation can still
 *   hold a conversation before anyone visits the Agents page. Once the user owns
 *   agents, picking who is in a chat is theirs to decide, not the handler's.
 * - **A chat with no members refuses `chat.send`.** The composer stays enabled —
 *   the fix is one click away in the member panel — but the run is rejected with
 *   `validation` rather than silently producing no answer.
 * - **`chats.delete` stops the run first.** Deleting a chat cascades to its
 *   messages, so a turn still streaming into one of them would write to rows that
 *   no longer exist and emit events for a chat the renderer has dropped.
 */
import type { ChatCreateInput, ChatMode, ChatPatch, ChatSettings, SpeakingMode } from '@shared/types'
import { MAX_AUTO_ROUNDS, MIN_AUTO_ROUNDS } from '@shared/types'
import { summarizeUsage, type ChatUsageSummary } from '@shared/usage'
import { ensureDefaultAgent } from '../agents/default-agent'
import { validation } from '../errors'
import type { AppContext } from '../app-context'
import type { HandlerModule } from './types'

/** The two orchestration modes `ChatSettings.mode` may hold. */
const CHAT_MODES: readonly ChatMode[] = ['roundrobin', 'mention-only']

/** The two speaking modes `ChatSettings.speaking` may hold. */
const SPEAKING_MODES: readonly SpeakingMode[] = ['sequential', 'parallel']

function assertId(input: unknown, what: string): asserts input is { id: string } {
  const id = (input as { id?: unknown })?.id
  if (typeof id !== 'string' || id.length === 0) throw validation(`A ${what} id is required`)
}

/** Only the fields `ChatPatch` declares, and only when present. */
function assertChatPatch(patch: unknown): asserts patch is ChatPatch {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw validation('A chat patch object is required')
  }
  const candidate = patch as ChatPatch
  if (candidate.title !== undefined) {
    if (typeof candidate.title !== 'string' || candidate.title.trim().length === 0) {
      throw validation('A chat title cannot be empty')
    }
  }
  if (candidate.settings !== undefined) assertChatSettings(candidate.settings)
}

/**
 * The orchestration settings, field by field.
 *
 * The patch is merged into the stored object by the repository, so every field is
 * optional here and only the ones present are checked. The bounds are the ones
 * the member panel offers; validating them in the backend as well means a future
 * caller (the server build, a script) cannot store a chat that `ChatRunner`
 * would then have to defend itself against every round.
 */
function assertChatSettings(value: unknown): asserts value is Partial<ChatSettings> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw validation('chat settings must be an object')
  }
  const settings = value as Partial<ChatSettings>

  if (settings.mode !== undefined && !CHAT_MODES.includes(settings.mode)) {
    throw validation('unknown chat mode')
  }
  if (settings.speaking !== undefined && !SPEAKING_MODES.includes(settings.speaking)) {
    throw validation('unknown speaking mode')
  }
  if (settings.maxAutoRounds !== undefined) {
    const rounds = settings.maxAutoRounds
    if (
      typeof rounds !== 'number' ||
      !Number.isInteger(rounds) ||
      rounds < MIN_AUTO_ROUNDS ||
      rounds > MAX_AUTO_ROUNDS
    ) {
      throw validation(`maxAutoRounds must be an integer between ${MIN_AUTO_ROUNDS} and ${MAX_AUTO_ROUNDS}`)
    }
  }
  for (const field of ['stallTimeoutMs', 'hardTimeoutMs'] as const) {
    const timeout = settings[field]
    if (timeout === undefined) continue
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      throw validation(`${field} must be a positive number of milliseconds`)
    }
  }
}

function assertAgentIds(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw validation('agentIds must be an array of agent ids')
  }
}

/**
 * The member list a new chat is born with.
 *
 * An explicit list wins. Without one the chat is empty, *except* on an
 * installation whose agent library has never been used: there `ensureDefaultAgent`
 * writes the bootstrap agent so the very first chat of a fresh install can still
 * be talked to. That fallback rejects with `validation` when no provider has a
 * model, which is the only way a first-run user can reach it — the renderer turns
 * the code into copy that points at Settings.
 */
async function initialMembers(
  ctx: AppContext,
  memberAgentIds: string[] | undefined
): Promise<string[]> {
  if (memberAgentIds) return memberAgentIds
  if (ctx.repos.agents.list(ctx.userId).length > 0) return []
  return [(await ensureDefaultAgent(ctx)).id]
}

/**
 * Usage over a whole chat, priced with each agent's own provider.
 *
 * The arithmetic itself is `summarizeUsage` in `@shared/usage`, which the
 * renderer runs on the same messages: this function only supplies the "which
 * model, on which provider" lookup, from the repositories. An agent or provider
 * the user has since deleted resolves to `undefined`, which keeps its tokens in
 * the total and leaves its cost unknown — the honest answer, and the reason the
 * lookup is a function rather than a prebuilt map.
 */
function summarizeChatUsage(ctx: AppContext, chatId: string): ChatUsageSummary {
  const models = new Map<string, { modelId: string; presetId?: string | undefined } | undefined>()
  return summarizeUsage(ctx.repos.messages.listForContext(chatId, ctx.userId), (agentId) => {
    if (models.has(agentId)) return models.get(agentId)
    let resolved: { modelId: string; presetId?: string | undefined } | undefined
    try {
      const agent = ctx.repos.agents.get(agentId, ctx.userId)
      const provider = ctx.repos.providers.get(agent.providerId, ctx.userId)
      resolved = { modelId: agent.modelId, presetId: provider.presetId }
    } catch {
      resolved = undefined
    }
    models.set(agentId, resolved)
    return resolved
  })
}

export const chatHandlers: HandlerModule = {
  'chats.list': async (ctx) => ctx.repos.chats.list(ctx.userId),

  'chats.get': async (ctx, input) => {
    assertId(input, 'chat')
    return ctx.repos.chats.get(input.id, ctx.userId)
  },

  'chats.create': async (ctx, input) => {
    const create: ChatCreateInput = input?.input ?? {}
    const { memberAgentIds, ...patch } = create
    assertChatPatch(patch)
    if (memberAgentIds !== undefined) assertAgentIds(memberAgentIds)

    const members = await initialMembers(ctx, memberAgentIds)
    const chat = ctx.repos.chats.create(patch, ctx.userId)
    // `setMembers` validates that every agent exists and rejects duplicates.
    ctx.repos.chats.setMembers(ctx.userId, chat.id, members)

    // Re-read: `setMembers` bumps `updatedAt`, and the list is ordered by it.
    const created = ctx.repos.chats.get(chat.id, ctx.userId)
    ctx.events.emit({ type: 'chat.updated', chat: created })
    return created
  },

  'chats.update': async (ctx, input) => {
    assertId(input, 'chat')
    assertChatPatch(input.patch)
    // The repository always bumps `updatedAt`, so a rename floats the chat to the
    // top of the list exactly like a new message does.
    const chat = ctx.repos.chats.update(input.id, input.patch, ctx.userId)
    ctx.events.emit({ type: 'chat.updated', chat })
    return chat
  },

  'chats.delete': async (ctx, input) => {
    assertId(input, 'chat')
    ctx.runners.remove(input.id)
    ctx.repos.chats.delete(input.id, ctx.userId)
    ctx.events.emit({ type: 'chat.deleted', chatId: input.id })
  },

  'chats.search': async (ctx, input) => {
    const query = (input as { query?: unknown })?.query
    if (typeof query !== 'string') throw validation('A search query is required')
    // A blank query is "no filter" by contract, not an error: the renderer calls
    // this on every keystroke and the last keystroke is often a deletion.
    return ctx.repos.chats.search(query, ctx.userId)
  },

  'chats.members.list': async (ctx, input) => {
    const chatId = (input as { chatId?: unknown })?.chatId
    if (typeof chatId !== 'string' || chatId.length === 0) throw validation('A chat id is required')
    return ctx.repos.chats.listMembers(chatId, ctx.userId)
  },

  'chats.members.set': async (ctx, input) => {
    const chatId = (input as { chatId?: unknown })?.chatId
    if (typeof chatId !== 'string' || chatId.length === 0) throw validation('A chat id is required')
    assertAgentIds(input.agentIds)
    // `not_found` for an id that names no agent of this user, before anything is
    // written: an empty member list is a valid state, a bogus one is not.
    for (const agentId of input.agentIds) ctx.repos.agents.get(agentId, ctx.userId)

    const members = ctx.repos.chats.setMembers(ctx.userId, chatId, input.agentIds)
    ctx.events.emit({ type: 'chat.updated', chat: ctx.repos.chats.get(chatId, ctx.userId) })
    return members
  },

  'messages.list': async (ctx, input) => {
    const chatId = (input as { chatId?: unknown })?.chatId
    if (typeof chatId !== 'string' || chatId.length === 0) throw validation('A chat id is required')
    if (input.limit !== undefined && !(input.limit > 0)) {
      throw validation('limit must be a positive number')
    }
    // Newest first, per the `BackendApi` contract; the renderer reverses it.
    return ctx.repos.messages.list(
      {
        chatId,
        ...(input.before ? { before: input.before } : {}),
        ...(input.limit ? { limit: input.limit } : {})
      },
      ctx.userId
    )
  },

  'messages.usageSummary': async (ctx, input) => {
    const chatId = (input as { chatId?: unknown })?.chatId
    if (typeof chatId !== 'string' || chatId.length === 0) throw validation('A chat id is required')
    // `not_found` for a chat that is gone, rather than an empty summary that
    // would look like a chat which simply has not spoken yet.
    ctx.repos.chats.get(chatId, ctx.userId)
    return summarizeChatUsage(ctx, chatId)
  },

  'chat.send': async (ctx, input) => {
    const chatId = (input as { chatId?: unknown })?.chatId
    if (typeof chatId !== 'string' || chatId.length === 0) throw validation('A chat id is required')
    if (typeof input.text !== 'string') throw validation('A message text is required')
    if (input.mentions !== undefined) assertAgentIds(input.mentions)

    return ctx.runners.send({
      chatId,
      text: input.text,
      ...(input.mentions ? { mentions: input.mentions } : {})
    })
  },

  'chat.stop': async (ctx, input) => {
    const chatId = (input as { chatId?: unknown })?.chatId
    if (typeof chatId !== 'string' || chatId.length === 0) throw validation('A chat id is required')
    // Idempotent by contract: stopping an idle chat is not an error.
    ctx.runners.stop(chatId)
  }
}
