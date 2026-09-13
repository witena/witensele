/**
 * `agents.list` only — the read half, landed early because the chat screen needs
 * it.
 *
 * S2.1 owns the `agents` feature: create, update, delete and the configuration
 * page. S1.7 needs none of that, but it does need to print a message's author
 * name, avatar and model badge, and the member panel needs the same three
 * fields — so the list method lands here now and the other four stay stubbed out
 * by `buildHandlers()` until S2.1 fills them in.
 */
import type { HandlerModule } from './types'

export const agentHandlers: HandlerModule = {
  'agents.list': async (ctx) => ctx.repos.agents.list(ctx.userId)
}
