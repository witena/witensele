/**
 * `presence.*` — reading live presence and asking an offline agent to try again.
 *
 * Two methods only, because presence is **pushed**, not polled: the renderer
 * seeds its store with `presence.list` when it opens a chat and is kept current
 * by `presence.changed` events from there on. Anything else would either miss a
 * transition or poll a value that changes once a minute.
 *
 * Neither method touches storage beyond proving the chat exists — `ctx.supervisor`
 * owns every state machine involved (`src/main/presence/supervisor.ts`).
 */
import { validation } from '../errors'
import type { HandlerModule } from './types'

function assertChatId(input: unknown): asserts input is { chatId: string } {
  const chatId = (input as { chatId?: unknown })?.chatId
  if (typeof chatId !== 'string' || chatId.length === 0) throw validation('A chat id is required')
}

export const presenceHandlers: HandlerModule = {
  'presence.list': async (ctx, input) => {
    assertChatId(input)
    // `not_found` for a chat that is gone, rather than an empty list that looks
    // like a chat with no members.
    ctx.repos.chats.get(input.chatId, ctx.userId)
    return ctx.supervisor.list(input.chatId)
  },

  'presence.retry': async (ctx, input) => {
    assertChatId(input)
    const agentId = (input as { agentId?: unknown }).agentId
    if (typeof agentId !== 'string' || agentId.length === 0) {
      throw validation('An agent id is required')
    }
    // Both must exist: the probe reads the agent's provider, and the answer is
    // scoped to one chat.
    ctx.repos.chats.get(input.chatId, ctx.userId)
    ctx.repos.agents.get(agentId, ctx.userId)

    // Resolves with the presence the probe produced — available on success, still
    // offline on failure. It never rejects for a dead provider: that is an
    // outcome the member panel renders, not an error.
    return ctx.supervisor.retry(input.chatId, agentId)
  }
}
