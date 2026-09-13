/**
 * The bootstrap agent, so a fresh install can hold a conversation before S2.1
 * gives the user an agent configuration page.
 *
 * S1.7's acceptance is "create a chat, send a message, watch a reply stream in".
 * Nothing in the UI can create an agent yet, so `chats.create` calls this: if the
 * agents table is empty it writes one general-purpose assistant bound to the
 * first provider that actually has a model, and every later chat reuses it.
 *
 * **S2.1 replaces this with user-managed agents.** When the agents page lands,
 * agents are created by the user and `chats.create` takes an explicit member
 * list; this function then survives only as the "you have no agents yet" fallback,
 * or disappears. Nothing else may depend on there being exactly one agent.
 */
import type { Agent, AgentInput, Provider } from '@shared/types'
import type { AppContext } from '../app-context'
import { validation } from '../errors'

/** Name the bootstrap agent is listed under. Stored content, not UI copy. */
export const DEFAULT_AGENT_NAME = 'Assistant'

/** Its one-line description, which the group briefing prints. */
export const DEFAULT_AGENT_DESCRIPTION = 'General assistant'

/**
 * Avatar colour, taken from the mockup's warm monogram tile rather than invented,
 * so the first message looks like the design instead of like a placeholder.
 */
export const DEFAULT_AGENT_AVATAR_COLOR = '#4a3a2f'

/**
 * Its system prompt. Deliberately short: the group briefing appended by
 * `agent-turn.ts` already explains the protocol, and a long default prompt would
 * be the hardest thing to notice when an answer goes wrong.
 */
export const DEFAULT_AGENT_SYSTEM_PROMPT =
  'You are a helpful assistant in a group chat. Answer clearly and concisely, and say when you are unsure.'

/** The first provider that has at least one model to talk to. */
function firstUsableProvider(providers: Provider[]): Provider | undefined {
  return providers.find((provider) => provider.models.length > 0)
}

/** The record `ensureDefaultAgent` writes, exported so the tests can compare against it. */
export function defaultAgentInput(provider: Provider): AgentInput {
  return {
    name: DEFAULT_AGENT_NAME,
    avatar: { kind: 'initial', text: 'A', color: DEFAULT_AGENT_AVATAR_COLOR },
    description: DEFAULT_AGENT_DESCRIPTION,
    systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
    providerId: provider.id,
    // `models[0]`: the provider's own order, which is the preset's order or the
    // `/models` answer. S2.1 lets the user pick.
    modelId: provider.models[0] as string,
    params: {},
    skillNames: [],
    mcpServerIds: [],
    memoryEnabled: false,
    role: 'participant'
  }
}

/**
 * Returns an agent to put in a new chat, creating one if the table is empty.
 *
 * Throws `validation` when no provider has a model: that is a state the user can
 * fix (Settings → Providers) and the renderer turns the code into copy, so it is
 * a rejection rather than a silently empty chat.
 */
export async function ensureDefaultAgent(ctx: AppContext): Promise<Agent> {
  const existing = ctx.repos.agents.list(ctx.userId)
  const first = existing[0]
  if (first) return first

  const provider = firstUsableProvider(ctx.repos.providers.list(ctx.userId))
  if (!provider) throw validation('no provider with models')

  return ctx.repos.agents.create(defaultAgentInput(provider), ctx.userId)
}
