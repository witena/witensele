/**
 * The agent templates the first-run card offers (S7.5).
 *
 * Shaped like `src/shared/presets.ts` and `src/shared/mcp-presets.ts`: static
 * data compiled into the bundle, no electron, no node, imported by the renderer
 * directly. A backend method would add a loading state to a list that cannot
 * change at runtime.
 *
 * ## What is data and what is copy
 *
 * `name` and `systemPrompt` are **stored content**, not UI copy, and are
 * therefore English literals here rather than i18n keys — exactly like
 * `DEFAULT_AGENT_NAME` in `src/main/agents/default-agent.ts`. The name ends up
 * in `agents.name`, which `@mentions` resolve against and which every model
 * sees in the group briefing; a name that changed when the user switched the UI
 * language would break both. The one-line **description** is UI copy and lives
 * in both locale files under `agents.templates.<id>`, which
 * `i18n/locales.test.ts` checks in both directions.
 *
 * ## `modelHints` is a hint, not a requirement
 *
 * A template cannot name a model id: the user's provider may be Ollama, Zhipu
 * or Anthropic and none of them share ids. So each template lists lowercase
 * substrings, in preference order, that suit the kind of work it does, and
 * `suggestedModel` picks the first model whose id contains one — falling back
 * to the provider's first model, which is what `default-agent.ts` does too.
 * Nothing breaks when no hint matches; the user changes the model on the agent
 * page in one click.
 */

/** One entry of the first-run template list. */
export interface AgentTemplate {
  /** Stable id. The description key is `agents.templates.<id>` in both locales. */
  id: string
  /** Stored agent name. Data, never translated: `@mentions` resolve against it. */
  name: string
  /** Stored one-line description the group briefing prints. Data, not copy. */
  description: string
  /** Stored system prompt. Data, not copy; deliberately short. */
  systemPrompt: string
  /**
   * Lowercase substrings of a model id that suit this template, best first.
   * See the header: a hint, not a requirement.
   */
  modelHints: readonly string[]
  /** Index into the renderer's `AGENT_AVATAR_COLORS`, so the three tiles differ. */
  paletteIndex: number
}

/**
 * Three templates, not ten.
 *
 * The card exists to get a first chat running, and a first-run screen offering
 * a catalogue is a screen the user has to read. One generalist, one challenger
 * and one organiser is the smallest set that still demonstrates what the
 * product is *for* — several models disagreeing in one room.
 */
export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  {
    id: 'assistant',
    name: 'Assistant',
    description: 'General assistant',
    systemPrompt:
      'You are a helpful assistant in a group chat. Answer clearly and concisely, and say when you are unsure.',
    // A fast instruction-tuned model is the right default for the generalist.
    modelHints: ['instruct', 'flash', 'haiku', '4o-mini', 'turbo'],
    paletteIndex: 0
  },
  {
    id: 'critic',
    name: 'Critic',
    description: 'Challenges the group and looks for what is wrong',
    systemPrompt:
      'You are the critic in a group chat. Read what the others said, name the weakest assumption and the most likely failure, and propose a concrete correction. Be specific and brief; do not repeat points that already hold.',
    // The one seat where a reasoning model earns its latency.
    modelHints: ['reason', 'think', 'r1', 'o3', 'o1', 'opus', 'sonnet'],
    paletteIndex: 5
  },
  {
    id: 'planner',
    name: 'Planner',
    description: 'Turns the discussion into ordered, checkable steps',
    systemPrompt:
      'You are the planner in a group chat. Turn what the group has agreed on into a short ordered list of steps that can each be checked off, name what is still undecided, and ask the member who can settle it by name.',
    modelHints: ['sonnet', 'pro', '4o', 'plus', 'instruct'],
    paletteIndex: 1
  }
]

/** The template with this id, or `undefined`. */
export function getAgentTemplate(id: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((template) => template.id === id)
}

/**
 * The model this template should start on, given what a provider offers.
 *
 * The first model matching the earliest hint wins; with no match at all the
 * provider's own first model is used, which is the order the preset or the
 * `/models` answer established.
 */
export function suggestedModel(
  template: AgentTemplate,
  models: readonly string[]
): string | undefined {
  for (const hint of template.modelHints) {
    const match = models.find((model) => model.toLowerCase().includes(hint))
    if (match) return match
  }
  return models[0]
}
