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
 * - **`chats.create` gives a new chat a member.** `ChatInput` carries no member
 *   list (it is `Omit<Chat, keyof EntityBase>`: title, workdir, settings), and
 *   S2.1 has not built the agents page yet, so a chat created from the "+" button
 *   would have nobody to answer in it. The handler therefore calls
 *   `ensureDefaultAgent` and sets it as the only member. When S2.2 adds the
 *   member picker this becomes the empty-library fallback and
 *   `chats.members.set` takes over.
 * - **`chats.delete` stops the run first.** Deleting a chat cascades to its
 *   messages, so a turn still streaming into one of them would write to rows that
 *   no longer exist and emit events for a chat the renderer has dropped.
 */
import type { ChatInput, ChatSettings } from '@shared/types'
import { ensureDefaultAgent } from '../agents/default-agent'
import { validation } from '../errors'
import type { HandlerModule } from './types'

function assertId(input: unknown, what: string): asserts input is { id: string } {
  const id = (input as { id?: unknown })?.id
  if (typeof id !== 'string' || id.length === 0) throw validation(`A ${what} id is required`)
}

/** Only the fields `ChatInput` declares, and only when present. */
function assertChatPatch(patch: unknown): asserts patch is Partial<ChatInput> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw validation('A chat patch object is required')
  }
  const candidate = patch as Partial<ChatInput>
  if (candidate.title !== undefined) {
    if (typeof candidate.title !== 'string' || candidate.title.trim().length === 0) {
      throw validation('A chat title cannot be empty')
    }
  }
  if (candidate.settings !== undefined) {
    const settings = candidate.settings as Partial<ChatSettings>
    if (typeof settings !== 'object' || settings === null) {
      throw validation('chat settings must be an object')
    }
    if (settings.maxAutoRounds !== undefined && !(settings.maxAutoRounds >= 1)) {
      throw validation('maxAutoRounds must be at least 1')
    }
  }
}

function assertAgentIds(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw validation('agentIds must be an array of agent ids')
  }
}

export const chatHandlers: HandlerModule = {
  'chats.list': async (ctx) => ctx.repos.chats.list(ctx.userId),

  'chats.get': async (ctx, input) => {
    assertId(input, 'chat')
    return ctx.repos.chats.get(input.id, ctx.userId)
  },

  'chats.create': async (ctx, input) => {
    const patch = input?.input ?? {}
    assertChatPatch(patch)

    // Rejects with `validation` when no provider has a model, which is the only
    // way a first-run user can end up here — the copy points them at Settings.
    const agent = await ensureDefaultAgent(ctx)
    const chat = ctx.repos.chats.create(patch, ctx.userId)
    ctx.repos.chats.setMembers(ctx.userId, chat.id, [agent.id])

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

  'chats.members.list': async (ctx, input) => {
    const chatId = (input as { chatId?: unknown })?.chatId
    if (typeof chatId !== 'string' || chatId.length === 0) throw validation('A chat id is required')
    return ctx.repos.chats.listMembers(chatId, ctx.userId)
  },

  'chats.members.set': async (ctx, input) => {
    const chatId = (input as { chatId?: unknown })?.chatId
    if (typeof chatId !== 'string' || chatId.length === 0) throw validation('A chat id is required')
    assertAgentIds(input.agentIds)

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
