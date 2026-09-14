/**
 * The provider preset table: the starting points "Add provider" offers.
 *
 * A preset is **static data, not a record**. It carries no id of a stored row, no
 * key and no user: it only prefills the form (`type`, `baseUrl`, a plausible
 * model list) so the user types a key and saves. Once saved, the provider row
 * remembers which preset it came from in `Provider.presetId`, which is how the UI
 * picks the right logo again and how `providers/registry.ts` learns that a
 * provider is a local server that needs no key.
 *
 * It lives in `src/shared/` rather than in the main process because both sides
 * need it and neither owns it: the renderer renders the preset grid directly from
 * `PROVIDER_PRESETS` (there is deliberately no `providers.presets` backend
 * method — a round trip for a frozen array would be ceremony), and the main
 * process reads `requiresApiKey` / `local` while validating and while building a
 * model client.
 *
 * Nothing here may import electron, node built-ins or renderer code.
 */
import type { ProviderAuth, ProviderType } from './types'

/**
 * One entry of the preset picker.
 *
 * `defaultModels` are **examples, not a contract**: model line-ups change every
 * few weeks, the list is only what the form starts with, and the real list is
 * refreshed with "Fetch from /models" (`providers.fetchModels`). A stale entry
 * here is a cosmetic bug, never a functional one.
 */
export interface ProviderPreset {
  /** Stable identifier stored in `Provider.presetId`. Never translated. */
  id: string
  /** Brand name, shown as-is. Not translated — `custom` is labelled by the UI. */
  name: string
  type: ProviderType
  /** Absent means "the adapter's own default endpoint". */
  baseUrl?: string
  /** Seed list for the form; refreshed via `providers.fetchModels`. */
  defaultModels: string[]
  /** False for a local server that accepts any key, or none at all. */
  requiresApiKey: boolean
  docsUrl?: string
  /** A server running on the user's own machine: no key, no network egress. */
  local?: boolean
}

/**
 * Every preset, in the order the picker shows them: the three first-party
 * adapters, then the OpenAI-compatible hosted endpoints, then the local servers,
 * then the empty "bring your own endpoint" entry.
 *
 * Model ids below are examples only — see `defaultModels` above.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    type: 'anthropic',
    defaultModels: ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
    requiresApiKey: true,
    docsUrl: 'https://docs.anthropic.com/en/api/getting-started'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai',
    defaultModels: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
    requiresApiKey: true,
    docsUrl: 'https://platform.openai.com/docs/api-reference'
  },
  {
    id: 'google',
    name: 'Google',
    type: 'google',
    defaultModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    requiresApiKey: true,
    docsUrl: 'https://ai.google.dev/gemini-api/docs'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModels: ['deepseek-chat', 'deepseek-reasoner'],
    requiresApiKey: true,
    docsUrl: 'https://api-docs.deepseek.com'
  },
  {
    id: 'qwen',
    name: 'Qwen',
    type: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModels: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
    requiresApiKey: true,
    docsUrl: 'https://help.aliyun.com/zh/model-studio/developer-reference/compatibility-of-openai-with-dashscope'
  },
  {
    id: 'zhipu',
    name: 'Zhipu GLM',
    type: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModels: ['glm-4.5', 'glm-4.5-air'],
    requiresApiKey: true,
    docsUrl: 'https://open.bigmodel.cn/dev/api'
  },
  {
    id: 'moonshot',
    name: 'Moonshot',
    type: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModels: ['kimi-k2-0711-preview', 'moonshot-v1-128k'],
    requiresApiKey: true,
    docsUrl: 'https://platform.moonshot.cn/docs'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    type: 'openai-compatible',
    baseUrl: 'https://api.minimax.chat/v1',
    defaultModels: ['MiniMax-M1'],
    requiresApiKey: true,
    docsUrl: 'https://platform.minimaxi.com/document'
  },
  {
    id: 'volcengine',
    name: 'Volcengine Ark',
    type: 'openai-compatible',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModels: ['doubao-seed-1-6-250615'],
    requiresApiKey: true,
    docsUrl: 'https://www.volcengine.com/docs/82379'
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    type: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModels: ['Qwen/Qwen3-235B-A22B', 'deepseek-ai/DeepSeek-V3'],
    requiresApiKey: true,
    docsUrl: 'https://docs.siliconflow.cn'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModels: ['anthropic/claude-sonnet-4', 'openai/gpt-4o'],
    requiresApiKey: true,
    docsUrl: 'https://openrouter.ai/docs'
  },
  {
    id: 'ollama',
    name: 'Ollama',
    type: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    // Whatever the user has pulled. `fetchModels` is the only sensible source.
    defaultModels: [],
    requiresApiKey: false,
    local: true,
    docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/openai.md'
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    type: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    defaultModels: [],
    requiresApiKey: false,
    local: true,
    docsUrl: 'https://lmstudio.ai/docs/app/api/endpoints/openai'
  },
  {
    id: 'custom',
    // The only preset whose name is a UI concept rather than a brand, so the
    // renderer labels it with `settings.providers.presetCustom` instead.
    name: 'Custom',
    type: 'openai-compatible',
    // Deliberately no baseUrl and no models: this is the "type it yourself" entry.
    defaultModels: [],
    requiresApiKey: false
  }
]

/** The preset with this id, or `undefined` for an unknown / cleared `presetId`. */
export function getPreset(id: string | undefined): ProviderPreset | undefined {
  if (!id) return undefined
  return PROVIDER_PRESETS.find((preset) => preset.id === id)
}

/** True when the provider was created from a preset that runs on this machine. */
export function isLocalPreset(id: string | undefined): boolean {
  return getPreset(id)?.local === true
}

/**
 * How a provider authenticates, with the default applied.
 *
 * `Provider.auth` is nullable in the database and optional in the shared type —
 * every row written before S5.3 has none — so "absent means `apiKey`" is a rule
 * that would otherwise be spelled out at every call site. It lives here beside
 * `providerRequiresApiKey` because that function is its first caller and the two
 * answers have to agree.
 */
export function providerAuth(provider: { auth?: ProviderAuth | undefined }): ProviderAuth {
  return provider.auth ?? 'apiKey'
}

/**
 * How each vendor's CLI is installed on macOS, shown to a user who has none.
 *
 * Shared data rather than copy: both are typed verbatim into a terminal and are
 * the same sentence in every language, so the sign-in panel renders them as
 * monospace values the way the chat header renders a folder path.
 */
export const ANT_INSTALL_COMMAND = 'brew install anthropics/tap/ant'

/** The Google Cloud SDK, which owns the application-default credentials (S5.13). */
export const GCLOUD_INSTALL_COMMAND = 'brew install --cask google-cloud-sdk'

/** The provider types that can be signed into rather than given a key. */
export const OAUTH_PROVIDER_TYPES = ['anthropic', 'google'] as const satisfies readonly ProviderType[]

/** A provider type Witena can actually sign in to: `anthropic` or `google`. */
export type OAuthProviderType = (typeof OAUTH_PROVIDER_TYPES)[number]

/**
 * Whether this provider type has a sign-in flow Witena can actually run.
 *
 * OpenAI is shown the control and told it is not available yet rather than
 * having it hidden, because "Witena cannot do this *yet*" is a different
 * statement from "this provider has no such thing", and the editor says which.
 * See "Provider authentication beyond Anthropic" in `docs/STEPS.md`.
 */
export function supportsOAuth(type: ProviderType): type is OAuthProviderType {
  return (OAUTH_PROVIDER_TYPES as readonly ProviderType[]).includes(type)
}

/** The same question asked of an unknown value, for validating an IPC input. */
export function isOAuthProviderType(value: unknown): value is OAuthProviderType {
  return typeof value === 'string' && (OAUTH_PROVIDER_TYPES as readonly string[]).includes(value)
}

/**
 * Which vendor's install command a sign-in panel prints. Total over the union,
 * so a third vendor cannot be added without answering this.
 */
export function cliInstallCommand(type: OAuthProviderType): string {
  return type === 'anthropic' ? ANT_INSTALL_COMMAND : GCLOUD_INSTALL_COMMAND
}

/**
 * Whether this provider must carry an API key.
 *
 * Shared rather than duplicated because both sides need the same answer for
 * different jobs: the main process refuses to create a provider without a key it
 * requires, and the renderer shows a "no key" pill on the card. Two copies of
 * this rule would disagree the first time a preset changed.
 *
 * A provider that signs in has no key at all, which is the point of S5.3, so
 * that answer comes first. Otherwise the preset is the authority when there is
 * one — that is what makes Ollama and LM Studio saveable with an empty key
 * field. Without a preset, the three first-party adapters always need one, while
 * a bare `openai-compatible` endpoint might be another local server and so does
 * not.
 */
export function providerRequiresApiKey(provider: {
  type: ProviderType
  presetId?: string | undefined
  auth?: ProviderAuth | undefined
}): boolean {
  if (providerAuth(provider) === 'oauth') return false
  const preset = getPreset(provider.presetId)
  if (preset) return preset.requiresApiKey
  return provider.type !== 'openai-compatible'
}

/**
 * Whether an agent on this provider shows its **thinking** in the transcript by
 * default (S5.14).
 *
 * `Agent.params.reasoning` means "show thinking", and this is the answer applied
 * when the agent has no explicit choice — at creation, so the agent editor's
 * toggle starts where it should, and again at turn time, so an agent written
 * before the field existed behaves the same way.
 *
 * The split is between the two **routes**, not between good and bad models. The
 * first-party adapters (`anthropic`, `openai`, `google`) emit reasoning only
 * when the model was asked for an extended thinking mode, and a user who picked
 * such a model picked it to watch it think. The open-model route — every local
 * server and every `openai-compatible` endpoint, which is Ollama, DeepSeek,
 * Moonshot, vLLM and the rest — streams a long chain of thought from an `r1`-
 * style model whether or not anybody wanted one, and in a group chat of four
 * members that buries the discussion under thinking nobody reads. So it starts
 * hidden there and the toggle turns it back on.
 *
 * `local` is tested as well as the type even though every local preset is
 * `openai-compatible` today: the rule the product means is "an open model the
 * user is running themselves", and a future local preset with a type of its own
 * must not silently change sides.
 */
export function showsThinkingByDefault(provider: {
  type: ProviderType
  presetId?: string | undefined
}): boolean {
  if (isLocalPreset(provider.presetId)) return false
  return provider.type !== 'openai-compatible'
}
