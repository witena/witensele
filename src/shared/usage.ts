/**
 * Rolling a chat's per-message token counts up into the three numbers the UI
 * shows: the chat total, the cost that total implies, and the same pair per
 * agent.
 *
 * It lives in `src/shared/` because **both sides compute it**, and they must
 * agree to the token:
 *
 * - The main process answers `messages.usageSummary` from the database, which is
 *   what the renderer asks for when a chat is opened and the transcript in the
 *   store may only be the last page.
 * - The renderer recomputes it from the messages it already holds every time a
 *   `message.updated` arrives, because a run of three agents over three rounds
 *   would otherwise be nine extra IPC round trips to learn a number that is
 *   already sitting in the store.
 *
 * Two copies of the arithmetic would drift the first time one of them was
 * edited, and the drift would show as a header that disagrees with itself mid
 * run — so there is one copy, and it is a pure function.
 *
 * ## What counts
 *
 * Only messages that carry a `usage` object: the provider reports it once, at
 * the end of a turn, so a streaming message contributes nothing until it
 * finishes. Every terminal status counts, `error` included — a turn the user
 * stopped halfway still billed for the tokens it had generated, and hiding that
 * would make the number a lie in exactly the case where a user is most likely to
 * check it.
 *
 * `turns` counts those messages, not rounds: an agent that spoke twice in one
 * round (it cannot today, but the scheduler is free to change) is two turns.
 */
import { estimateCost, type PricedModel } from './pricing'
import type { Message, Usage } from './types'

/** One agent's contribution to a chat. */
export interface AgentUsage {
  usage: Usage
  /** `null` when no message of this agent could be priced; see `estimateCost`. */
  cost: number | null
  /** How many finished turns this agent reported usage for. */
  turns: number
}

/** What `messages.usageSummary` returns, and what the renderer recomputes. */
export interface ChatUsageSummary {
  total: Usage
  /** `null` when nothing in the chat could be priced. */
  cost: number | null
  perAgent: Record<string, AgentUsage>
}

/** A summary with nothing in it, which is what an empty chat reports. */
export function emptyUsageSummary(): ChatUsageSummary {
  return { total: zeroUsage(), cost: null, perAgent: {} }
}

function zeroUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
}

function addUsage(into: Usage, more: Usage): void {
  into.inputTokens += more.inputTokens
  into.outputTokens += more.outputTokens
  into.totalTokens += more.totalTokens
}

/**
 * How a message's sender is priced.
 *
 * A function rather than a map because the two callers look it up differently —
 * the backend reads the agent and its provider from the repositories, the
 * renderer from its agent and provider stores — and because an agent the user
 * has since deleted still has messages in the transcript. Returning `undefined`
 * for one of those keeps its tokens in the total and leaves its cost unknown.
 */
export type ResolvePricedModel = (agentId: string) => PricedModel | undefined

/**
 * Sums every priced message of a chat.
 *
 * The cost of a group is `null` only when **nothing** in it could be priced; a
 * chat that mixes a known model with an unknown one reports the part it knows,
 * which is the more useful of the two possible lies. Messages from the user and
 * from the system are ignored: neither has a model behind it.
 */
export function summarizeUsage(
  messages: readonly Message[],
  resolve: ResolvePricedModel
): ChatUsageSummary {
  const total = zeroUsage()
  const perAgent: Record<string, AgentUsage> = {}
  let costTotal = 0
  let anyPriced = false

  for (const message of messages) {
    if (message.senderType !== 'agent' || !message.usage) continue

    const usage = message.usage
    addUsage(total, usage)

    const entry = (perAgent[message.senderId] ??= { usage: zeroUsage(), cost: null, turns: 0 })
    addUsage(entry.usage, usage)
    entry.turns += 1

    const model = resolve(message.senderId)
    if (!model) continue
    const cost = estimateCost(model, usage)
    if (cost === null) continue

    anyPriced = true
    costTotal += cost
    entry.cost = (entry.cost ?? 0) + cost
  }

  return { total, cost: anyPriced ? costTotal : null, perAgent }
}
