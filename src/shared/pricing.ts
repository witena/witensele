/**
 * What a turn cost, and how much room the model had.
 *
 * Two numbers the product needs and no provider gives us in a usable form:
 *
 * - **Price.** Providers report token counts, never money. Turning one into the
 *   other needs a price list, and there is no API that serves one — every vendor
 *   publishes it as a web page. So it is a table, checked in, editable by hand.
 * - **Context window.** `S4.2`'s history budget has to know how much fits before
 *   the first request is made, and the model does not say until it refuses.
 *
 * ## The table is an estimate, and says so
 *
 * `MODEL_PRICING` holds **approximate USD list prices as of 2026-09**. They are
 * per million tokens, they ignore cache reads, batch discounts, long-context
 * surcharges and every promotional rate, and they go stale — vendors reprice
 * every few months. That is accepted on purpose: a figure that is roughly right
 * is what makes "$0.04" a useful signal about which agent is expensive, and the
 * alternative (no figure at all, or a network call per chat) is worse. **Edit the
 * table when a price changes**; nothing else in the app has to be touched, and
 * `estimateCost` returns `null` rather than a wrong number for a model it does
 * not recognise.
 *
 * ## Matching
 *
 * Entries are matched against the model id **in order, first match wins**, so the
 * specific rows come before the general ones (`gpt-4o-mini` before `gpt-4o`,
 * `glm-4.5-air` before `glm-4.5`). Matching is a case-insensitive regular
 * expression over the whole id rather than an equality test, because the same
 * model reaches us under several spellings: `claude-sonnet-4-5` from Anthropic,
 * `anthropic/claude-sonnet-4` through OpenRouter, `Qwen/Qwen3-235B-A22B` through
 * SiliconFlow. A `string` match is treated as a case-insensitive substring.
 *
 * ## Local models are free
 *
 * A provider created from the `ollama` or `lmstudio` preset runs on the user's
 * own machine, so its tokens cost nothing. That is why cost estimation takes the
 * provider's `presetId` alongside the model id: `qwen2.5:7b` on Ollama is free,
 * and the same weights behind a hosted endpoint are not.
 *
 * Nothing here imports electron, node built-ins or renderer code: the main
 * process prices a finished turn and the renderer prices what it already has in
 * its store, from this one table.
 */
import { isLocalPreset } from './presets'
import type { Usage } from './types'

/** One row of the price list. */
export interface ModelPricing {
  /**
   * How a model id is recognised. A `RegExp` is tested against the id; a string
   * matches when the id contains it, case-insensitively.
   */
  match: RegExp | string
  /** Approximate USD per million input tokens. */
  inputPerMTok: number
  /** Approximate USD per million output tokens. */
  outputPerMTok: number
  /** Total tokens the model accepts in one request, prompt plus completion. */
  contextWindow: number
}

/**
 * The price list. **Approximate USD list prices as of 2026-09**; see the header.
 *
 * Ordered specific → general, because the first match wins.
 */
export const MODEL_PRICING: ModelPricing[] = [
  /* -- Anthropic ---------------------------------------------------------- */
  { match: /claude.*opus/i, inputPerMTok: 15, outputPerMTok: 75, contextWindow: 200_000 },
  { match: /claude.*haiku/i, inputPerMTok: 1, outputPerMTok: 5, contextWindow: 200_000 },
  { match: /claude.*sonnet/i, inputPerMTok: 3, outputPerMTok: 15, contextWindow: 200_000 },

  /* -- OpenAI ------------------------------------------------------------- */
  { match: /gpt-5.*(mini|nano)/i, inputPerMTok: 0.25, outputPerMTok: 2, contextWindow: 400_000 },
  { match: /gpt-5/i, inputPerMTok: 1.25, outputPerMTok: 10, contextWindow: 400_000 },
  { match: /gpt-4\.1.*(mini|nano)/i, inputPerMTok: 0.4, outputPerMTok: 1.6, contextWindow: 1_000_000 },
  { match: /gpt-4\.1/i, inputPerMTok: 2, outputPerMTok: 8, contextWindow: 1_000_000 },
  { match: /gpt-4o-mini/i, inputPerMTok: 0.15, outputPerMTok: 0.6, contextWindow: 128_000 },
  { match: /gpt-4o/i, inputPerMTok: 2.5, outputPerMTok: 10, contextWindow: 128_000 },
  { match: /\bo3-mini\b/i, inputPerMTok: 1.1, outputPerMTok: 4.4, contextWindow: 200_000 },
  { match: /\bo3\b/i, inputPerMTok: 2, outputPerMTok: 8, contextWindow: 200_000 },

  /* -- Google ------------------------------------------------------------- */
  { match: /gemini-2\.5-flash/i, inputPerMTok: 0.3, outputPerMTok: 2.5, contextWindow: 1_048_576 },
  { match: /gemini-2\.5-pro/i, inputPerMTok: 1.25, outputPerMTok: 10, contextWindow: 1_048_576 },

  /* -- DeepSeek ----------------------------------------------------------- */
  { match: /deepseek.*(reasoner|r1)/i, inputPerMTok: 0.55, outputPerMTok: 2.19, contextWindow: 65_536 },
  { match: /deepseek/i, inputPerMTok: 0.27, outputPerMTok: 1.1, contextWindow: 65_536 },

  /* -- Qwen (DashScope) --------------------------------------------------- */
  { match: /qwen.*max/i, inputPerMTok: 1.6, outputPerMTok: 6.4, contextWindow: 32_768 },
  { match: /qwen.*plus/i, inputPerMTok: 0.4, outputPerMTok: 1.2, contextWindow: 131_072 },
  { match: /qwen.*turbo/i, inputPerMTok: 0.05, outputPerMTok: 0.2, contextWindow: 1_000_000 },

  /* -- Zhipu GLM ---------------------------------------------------------- */
  { match: /glm-4\.5-air/i, inputPerMTok: 0.2, outputPerMTok: 1.1, contextWindow: 128_000 },
  { match: /glm-4\.5/i, inputPerMTok: 0.6, outputPerMTok: 2.2, contextWindow: 128_000 },

  /* -- Moonshot ----------------------------------------------------------- */
  { match: /kimi-k2/i, inputPerMTok: 0.6, outputPerMTok: 2.5, contextWindow: 128_000 },

  /* -- MiniMax ------------------------------------------------------------ */
  { match: /minimax-m1/i, inputPerMTok: 0.4, outputPerMTok: 2.2, contextWindow: 1_000_000 },

  /* -- Volcengine Ark ----------------------------------------------------- */
  { match: /doubao-seed/i, inputPerMTok: 0.11, outputPerMTok: 0.28, contextWindow: 256_000 }
]

/**
 * The window assumed for a model the table does not know.
 *
 * Deliberately small. Guessing low costs a few dropped messages at the top of a
 * long history; guessing high costs a request the provider rejects outright, and
 * the user sees a failed turn instead of a slightly shorter one.
 */
export const DEFAULT_CONTEXT_WINDOW = 32_768

/** Tokens per pricing unit: every figure in the table is per million tokens. */
const TOKENS_PER_PRICE_UNIT = 1_000_000

/** Identifies a model well enough to price it: its id plus where it runs. */
export interface PricedModel {
  modelId: string
  /** `Provider.presetId`; `ollama` / `lmstudio` mean the tokens are free. */
  presetId?: string | undefined
}

/** The first row whose `match` recognises this model id, or `undefined`. */
export function findPricing(modelId: string): ModelPricing | undefined {
  if (typeof modelId !== 'string' || modelId.length === 0) return undefined
  return MODEL_PRICING.find((entry) =>
    typeof entry.match === 'string'
      ? modelId.toLowerCase().includes(entry.match.toLowerCase())
      : entry.match.test(modelId)
  )
}

/**
 * What one turn cost, in USD, or `null` when the model is not in the table.
 *
 * `null` means "no claim", and every surface renders it by printing the token
 * count alone rather than `$0.00` — a zero would be a claim, and a wrong one for
 * a hosted model we simply have no price for.
 *
 * A **local** provider returns `0`, not `null`: its tokens genuinely cost
 * nothing, and returning `null` would poison the total of a chat that mixes a
 * local model with a hosted one. The display layer omits a zero cost, so an
 * Ollama-only chat still shows tokens and no price.
 */
export function estimateCost(model: PricedModel, usage: Usage): number | null {
  if (isLocalPreset(model.presetId)) return 0
  const pricing = findPricing(model.modelId)
  if (!pricing) return null
  const input = (usage.inputTokens * pricing.inputPerMTok) / TOKENS_PER_PRICE_UNIT
  const output = (usage.outputTokens * pricing.outputPerMTok) / TOKENS_PER_PRICE_UNIT
  return input + output
}

/** The model's context window, or `DEFAULT_CONTEXT_WINDOW` when unknown. */
export function contextWindowFor(modelId: string): number {
  return findPricing(modelId)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
}

/**
 * `842`, `12.4k`, `1.2M` — a token count at the width a chat header can spare.
 *
 * Not `Intl.NumberFormat`'s compact notation: that localises the suffix, and the
 * suffix here sits inside a monospaced column beside a model id, where a
 * localised suffix would be wider than the space the mockup gives it and would
 * not line up with the row above.
 */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0'
  if (count < 1_000) return String(Math.round(count))
  if (count < 1_000_000) return `${trimZero((count / 1_000).toFixed(1))}k`
  return `${trimZero((count / 1_000_000).toFixed(1))}M`
}

/** `12.0` → `12`, so a round number does not carry a pointless decimal. */
function trimZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value
}

/**
 * `$0.04`, and `<$0.01` for an amount that would round to nothing.
 *
 * The `<` form exists because most turns of a cheap model cost a fraction of a
 * cent, and a column of `$0.00` reads as "this is free" rather than as "this is
 * small".
 */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00'
  if (usd < 0.01) return '<$0.01'
  if (usd < 1_000) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd)}`
}
