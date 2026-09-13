/**
 * `memory.*` — one agent's markdown memory, as the agent editor's panel sees it.
 *
 * Thin like the rest: the files belong to `memory/store.ts` (`ctx.memory`), and
 * what lives here is validation plus the one rule the store cannot know — the
 * **agent must exist**. `ctx.repos.agents.get` is called first on every method,
 * so an id that was never real, or that belongs to another user, is a `not_found`
 * rather than a directory quietly created under a made-up name.
 *
 * Paths are relative to the agent's own directory and are resolved inside it by
 * the store; `MEMORY.md` is the index and `notes/<file>.md` is one entry.
 */
import { validation } from '../errors'
import type { AppContext } from '../app-context'
import type { HandlerModule } from './types'

function assertAgent(ctx: AppContext, input: unknown): string {
  const agentId = (input as { agentId?: unknown })?.agentId
  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw validation('An agent id is required')
  }
  // Throws `not_found` for an id that is gone or belongs to another user.
  ctx.repos.agents.get(agentId, ctx.userId)
  return agentId
}

function assertPath(input: unknown): string {
  const path = (input as { path?: unknown })?.path
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw validation('A memory path is required')
  }
  return path
}

export const memoryHandlers: HandlerModule = {
  'memory.list': async (ctx, input) => ctx.memory.listEntries(assertAgent(ctx, input)),

  'memory.read': async (ctx, input) => {
    const agentId = assertAgent(ctx, input)
    const path = assertPath(input)
    return { path, content: ctx.memory.readNote(agentId, path) }
  },

  'memory.write': async (ctx, input) => {
    const agentId = assertAgent(ctx, input)
    const path = assertPath(input)
    const content = (input as { content?: unknown })?.content
    if (typeof content !== 'string') throw validation('Memory content must be a string')
    return ctx.memory.writeFile(agentId, path, content)
  },

  'memory.delete': async (ctx, input) => {
    const agentId = assertAgent(ctx, input)
    ctx.memory.deleteNote(agentId, assertPath(input))
  },

  'memory.search': async (ctx, input) => {
    const agentId = assertAgent(ctx, input)
    const query = (input as { query?: unknown })?.query
    if (typeof query !== 'string') throw validation('A search query is required')
    return ctx.memory.search(agentId, query)
  }
}
