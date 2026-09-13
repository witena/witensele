# providers — Backend

## Modules

| File | Responsibility |
|---|---|
| `src/shared/presets.ts` | The preset table and the three questions asked of it. Shared, not main-only: the renderer imports it directly |
| `src/shared/pricing.ts` | The **model price table** plus `estimateCost`, `contextWindowFor`, `formatTokens` and `formatCost` (S4.1, S4.2). Shared for the same reason as the presets, and edited by hand — see "Editing the price table" below |
| `src/main/providers/resolve.ts` | `ProviderRef` → `ResolvedProvider`. The **only** place a stored key is decrypted |
| `src/main/providers/registry.ts` | `ResolvedProvider` + model id → an AI SDK `LanguageModel` |
| `src/main/providers/discovery.ts` | `fetchModels` (raw `/models`) and `testConnection` (`generateText`) |
| `src/main/providers/anthropic-cli.ts` | **S5.3.** The `ant` wrapper: binary resolution, `status`, `login`, `logout`, `accessToken` and the token cache. The only module in the app that holds an access token |
| `src/main/handlers/providers.ts` | The seven `providers.*` methods; validation lives here and nowhere else |
| `src/main/app-context.ts` | Gained an optional `fetchImpl` so a test can inject HTTP, and (S5.3) `anthropicCli` plus the `modelOptions` / `providerFetch` readers |

None of them imports electron (CLAUDE.md rule #5). `resolve.ts` takes an
`AppContext` by type only; the secret store arrives through it as an interface.
`anthropic-cli.ts` imports `node:child_process`, `node:fs`, `node:os` and
`node:path`, which the rule says nothing about — it is about electron, and the
main process already spawns stdio MCP servers.

## Database

S1.2 created the table; S5.3 added one column
(`0002_mysterious_madelyne_pryor.sql`, `ALTER TABLE providers ADD auth text`).

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | UUID from the repository |
| `user_id` | text | Every query is scoped by it; a foreign row reads as `not_found` |
| `type` | text enum | `anthropic \| openai \| google \| openai-compatible` |
| `name` | text | Display name; may be renamed freely |
| `base_url` | text null | Null means "the adapter's default endpoint" |
| `preset_id` | text null | Which `PROVIDER_PRESETS` entry it came from; drives the logo, the key requirement and the local-server placeholder |
| `models` | json | `string[]`, preset seed or `/models` answer |
| `api_key_encrypted` | text null | **Ciphertext only.** Mapped to `Provider.hasApiKey`, never to a value |
| `auth` | text null | `apiKey \| oauth` (S5.3). Null means `apiKey`; read it through `providerAuth()`. An `oauth` row stores **no credential at all** |
| `created_at` / `updated_at` | integer | Epoch milliseconds |

Key handling is split on purpose: `ProviderRepository` takes an injected
`encrypt(plain)` and writes ciphertext, and the *only* way a key comes back out is
`getApiKeyCiphertext(id, userId)`, which `resolve.ts` pairs with
`ctx.secrets.decrypt`. Patch semantics, unchanged from S1.2: an absent `apiKey`
keeps the stored key, `''` clears it, any other string replaces it.

## IPC handlers

| Method | Input | Result | Validation |
|---|---|---|---|
| `providers.list` | — | `Provider[]`, oldest first | — |
| `providers.get` | `{ id }` | `Provider` | non-empty id; `not_found` otherwise |
| `providers.create` | `{ input: ProviderInput }` | `Provider` | name non-empty; known `type`; `models` an array of strings; `openai-compatible` needs `baseUrl`; a key is required when `providerRequiresApiKey` says so; and (S5.3) `auth` must be one of the two modes, `oauth` only on `anthropic` (`oauth_unsupported_provider`) with no `baseUrl` (`oauth_custom_base_url`), with the CLI actually signed in (`ant_missing` / `ant_not_logged_in`) |
| `providers.update` | `{ id, patch }` | `Provider` | the same checks, applied only to the fields present. The key requirement is **not** re-checked: clearing a key is a deliberate operation. The `auth` rules *are* checked against the **stored row merged with the patch**, because `{ auth: 'oauth' }` alone says nothing about the type it lands on |
| `providers.delete` | `{ id }` | `void` | non-empty id |
| `providers.fetchModels` | `{ provider: ProviderRef }` | `string[]` | the ref must be `{ id }` or `{ draft }`; rejects `provider_error` with `details.status` |
| `providers.testConnection` | `{ provider: ProviderRef, modelId? }` | `ConnectionTestResult` | never rejects; a failed probe is a value |
| `providers.authStatus` | — | `AnthropicAuthStatus` | never rejects: `not-installed` and `signed-out` are states |
| `providers.login` | — | `AnthropicAuthStatus` | rejects `ant_missing` with no binary, `ant_not_logged_in` for a flow the user abandoned |
| `providers.logout` | — | `AnthropicAuthStatus` | rejects `ant_missing` only; "there was nothing to log out of" is the state the caller asked for |

No event is emitted. Provider changes are the answer to the call that made them,
and the store updates from that answer; nothing else in the app is watching.

## External dependencies

### AI SDK v7 — the exact option names used

Verified against the installed type definitions
(`node_modules/<pkg>/dist/index.d.ts`), not from memory:

| Factory | Package | Version | Options passed |
|---|---|---|---|
| `createAnthropic` | `@ai-sdk/anthropic` | 4.0.53 | `apiKey`, `baseURL` |
| `createOpenAI` | `@ai-sdk/openai` | 4.0.66 | `apiKey`, `baseURL` |
| `createGoogleGenerativeAI` | `@ai-sdk/google` | 4.0.69 | `apiKey`, `baseURL` (exported as an alias of `createGoogle`) |
| `createOpenAICompatible` | `@ai-sdk/openai-compatible` | 3.0.48 | `name` (**required**), `baseURL` (**required**), `apiKey`, `includeUsage` |
| `generateText` | `ai` | 7.0.99 | `model`, `prompt`, `maxOutputTokens`, `abortSignal`; the result's `text` is read |
| `MockLanguageModelV4` | `ai/test` | 7.0.99 | `provider`, `modelId`, `doGenerate` |

Each provider object is callable *and* exposes `languageModel(modelId)`; this code
uses the method, because a bare call expression hides which kind of model is being
asked for. All four return a `LanguageModelV4`.

Pitfalls, every one of them hit while writing this step:

- **`baseURL`, not `baseUrl`.** The SDK capitalises URL; the stored column does
  not. They sit one line apart in `registry.ts`.
- **`createOpenAICompatible` requires `name`**, and that name becomes
  `model.provider` (`deepseek.chat`, not `openai-compatible.chat`). An empty name
  produces a provider string of `.chat`. It is the preset id, or a slug of the
  display name.
- **`createOpenAICompatible` has four type parameters and no defaults.** Call it
  as `createOpenAICompatible<string, string, string, string>({…})` or inference
  fails against the `extends string` constraints.
- **`LanguageModel` is a union that includes `string`.** Code that reads
  `model.modelId` must narrow first; the registry test does.
- **V4 result shapes are structured.** `finishReason` is
  `{ unified, raw }` and `usage` is `{ inputTokens: {…}, outputTokens: {…} }` —
  not the bare string and three numbers of earlier specification versions. A mock
  written from memory of V2/V3 will not type-check.
- **`openai.languageModel(id)` is the Responses API** (`openai.responses`), while
  `.chat(id)` is Chat Completions. The default is deliberate; a provider that only
  speaks Chat Completions belongs behind `openai-compatible` anyway.
- **The SDK has no "list models" call.** `/models` is spoken by hand in
  `discovery.ts`.
- **`includeUsage: true` is not optional if you want token counts.** Without it
  the compatible adapter omits `stream_options: { include_usage: true }` and an
  OpenAI-compatible endpoint streams **no usage at all**: the `finish` part
  arrives with zeroes. That is most of the preset list — every Chinese provider,
  OpenRouter, Ollama and LM Studio — so S4.1's token counts were empty for all of
  them until the flag went in. The first-party Anthropic / OpenAI / Google
  adapters report usage without being asked, and a server that does not
  understand the field ignores it.

The *streaming* half of the SDK — `streamText`, `fullStream`, the `text-delta` /
`reasoning-delta` / `finish` / `abort` / `error` part shapes, `LanguageModelUsage`
and `MockLanguageModelV4.doStream` — is used by `agent-turn` and documented with
its own pitfalls in [`../agent-turn/backend.md`](../agent-turn/backend.md). The
one that bites hardest: a `text-delta` carries `text` at the `ai` level and
`delta` at the provider level, so a mock written from the `fullStream` shape
streams nothing.

### Editing the price table (S4.1)

`MODEL_PRICING` in `src/shared/pricing.ts` is a checked-in list of **approximate
USD list prices as of 2026-09**, per million tokens, plus each model's context
window. There is no API that serves a price list — every vendor publishes one as
a web page — so this is a table, and keeping it current is a hand edit:

```ts
{ match: /claude.*sonnet/i, inputPerMTok: 3, outputPerMTok: 15, contextWindow: 200_000 }
```

Rules to keep in mind when editing it:

- **Order matters.** Rows are matched first-hit-wins, so a specific row must come
  before the general one it shares a prefix with (`gpt-4o-mini` before `gpt-4o`,
  `glm-4.5-air` before `glm-4.5`). `pricing.test.ts` asserts exactly that for the
  pairs that exist today; add a case when you add a pair.
- **`match` is a regular expression over the whole model id**, case-insensitively,
  because the same model reaches us under several spellings
  (`claude-sonnet-4-5`, `anthropic/claude-sonnet-4` through OpenRouter,
  `Qwen/Qwen3-235B-A22B` through SiliconFlow). A plain string matches as a
  case-insensitive substring.
- **A model that is not in the table is not a bug.** `estimateCost` returns
  `null`, `contextWindowFor` falls back to a deliberately small
  `DEFAULT_CONTEXT_WINDOW` (32 768), and every surface prints the token count
  without a price rather than inventing one.
- **Nothing else has to change.** The table is read by `estimateCost` (the chat
  header, the member rows, the per-message tooltip) and by `contextWindowFor`
  (S4.2's history budget). Prices are ignored entirely for a provider created
  from a `local` preset — Ollama and LM Studio cost nothing, whatever the model
  is called — which is why cost estimation takes `{ modelId, presetId }` rather
  than a model id alone.

The figures deliberately ignore cache reads, batch discounts, long-context
surcharges and promotional rates. A figure that is roughly right is what makes
`$0.04` a useful signal about which agent is expensive; the alternative is no
figure at all.

### The `/models` endpoints

| Type | Request | Ids from |
|---|---|---|
| `anthropic` | `GET {base}/v1/models`, headers `x-api-key` and `anthropic-version: 2023-06-01` | `data[].id` |
| `openai`, `openai-compatible` | `GET {base}/models`, `Authorization: Bearer <key>` (omitted when there is no key) | `data[].id` |
| `google` | `GET {base}/models?key=<key>` | `models[].name`, minus the `models/` prefix |

Defaults when the record stores no `baseUrl`: `https://api.anthropic.com`,
`https://api.openai.com/v1`,
`https://generativelanguage.googleapis.com/v1beta`. `openai-compatible` has none —
a missing base URL is a `validation` failure, not a guess.

Details that matter:

- A trailing slash on a stored base URL is trimmed, and an Anthropic base URL that
  already ends in `/v1` does not get a second one — the Anthropic adapter's own
  default `baseURL` ends in `/v1`, so users paste that value.
- Ids are de-duplicated and sorted with `localeCompare`, because the list is a
  picker.
- 10 s timeout via `AbortController`; the abort is distinguished from a network
  error so the message can say which happened.
- Every HTTP failure becomes `BackendFailure('provider_error', …)` with
  `details.status`, so the renderer can tell 401 (wrong key) from 404 (wrong URL)
  without parsing prose.
- Google authenticates the listing endpoint with a **query parameter**, which is
  its documented REST form. The key therefore appears in a URL string inside the
  main process; it is never logged.

### The connection probe

`generateText` against the real model client, `prompt: 'Reply with OK'`,
`maxOutputTokens: 8`, 20 s `AbortController`. It answers
`{ ok: true, latencyMs, model }` or `{ ok: false, error }` and **never throws** —
a failed probe is the ordinary outcome of pressing the button.

A thrown `BackendFailure` keeps its code; anything the AI SDK throws is re-coded
to `provider_error`, because the renderer's copy for that path has to be about the
provider rather than "something went wrong inside the app".

`options.createModel` and `options.generate` are the test seams: the unit tests
inject a `MockLanguageModelV4` and let the **real** `generateText` run, so the
option names above are proven by the suite rather than by review.

### The Anthropic CLI (`ant`), S5.3

Verified against `ant` 1.32.0 on macOS. Install:
`brew install anthropics/tap/ant`, then
`xattr -d com.apple.quarantine "$(brew --prefix)/bin/ant"`.

| Command | What it does |
|---|---|
| `ant auth print-credentials` | Prints JSON and **refreshes the token when it is near expiry**; exits non-zero when no profile is logged in |
| `ant auth print-credentials --access-token` | The bare token, no JSON |
| `ant auth login` | Opens the system browser itself and exits when the flow finishes |
| `ant auth logout` | Removes the active profile |

`print-credentials` prints exactly these keys: `version`, `type`
(`oauth_token`), `access_token`, `expires_at` (**unix seconds**),
`refresh_token`, `scope`, `organization_uuid`, `organization_name`,
`account_email`, `workspace_id`, `workspace_name`. Four of them plus a converted
`expires_at` become `AnthropicAuthStatus`; the two token fields never leave the
module.

Things that will bite anyone changing this file:

- **`ant auth status` is prose.** The global `--format json` flag does not change
  that subcommand's output, so nothing parses it. `print-credentials` is the
  status *and* the token, in one call whose failure already means "not logged in".
- **A packaged app does not inherit the shell `PATH`.** `launchd` gives it a
  minimal one, so `spawn('ant')` cannot find a Homebrew install.
  `resolveAntBinary` walks `PATH` and then `/opt/homebrew/bin`, `/usr/local/bin`
  and `$HOME/go/bin`. `WITENA_ANT_BIN` replaces the whole search with one
  absolute path — an escape hatch for an unusual install, and what the
  end-to-end spec uses to produce a machine where `ant` is definitively absent.
- **`stdout` is a credential.** It is parsed and dropped; only `stderr` is ever
  quoted into an error message, trimmed to 200 characters. A test asserts that a
  command which prints a token *and* fails leaks nothing.
- **The request headers are not optional.** An account token needs
  `Authorization: Bearer <token>` **and** `anthropic-beta: oauth-2025-04-20`, and
  must not carry `x-api-key` at all. `oauthFetch` deletes the key header, sets the
  bearer and *merges* the beta flag into whatever the SDK already asked for
  (comma-separated) rather than overwriting it.
- **`createAnthropic({ apiKey: '' })` is deliberate.** Omitting `apiKey` makes the
  adapter look for `ANTHROPIC_API_KEY` in the environment and throw; the empty
  value it puts in `x-api-key` is deleted by the wrapper before the request
  leaves.
- **The token cache honours the CLI's own `expires_at`**, minus 60 seconds. A
  credential printed without one is not cached at all.

Deviation from the S5.3 text worth knowing: the step says to fetch the token
with `--access-token`. This module uses the JSON form for both the status and the
token, because it is the call that carries `expires_at` — which the cache rule
needs — and using the bare flag as well would mean two child processes per cache
miss for one fact. The bare flag is still what a human should use at a prompt.

### `SecretStore`

**Untouched by S5.3**: a provider that signs in stores no secret, so the sign-in
path never reaches this store at all.

`safeStorage` in the app (`src/main/ipc/secret-store.ts`), the base64
`plain:` fallback in tests and on a machine with no OS key storage. The fallback
logs once, loudly. Note for anyone writing a handler test: the repository's
`encrypt` and the context's `secrets.decrypt` must come from the *same* store, or
nothing round-trips — `handlers.test.ts` builds its repositories for that reason.
