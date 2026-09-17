# providers — Backend

## Modules

| File | Responsibility |
|---|---|
| `src/shared/presets.ts` | The preset table and the three questions asked of it. Shared, not main-only: the renderer imports it directly |
| `src/shared/pricing.ts` | The **model price table** plus `estimateCost`, `contextWindowFor`, `formatTokens` and `formatCost` (S4.1, S4.2). Shared for the same reason as the presets, and edited by hand — see "Editing the price table" below |
| `src/main/providers/resolve.ts` | `ProviderRef` → `ResolvedProvider`. The **only** place a stored key is decrypted, and (S7.6) the place a failed decrypt becomes `key_unreadable` |
| `src/main/providers/migrate-secrets.ts` | **S7.6.** The startup pass that moves every pre-S7.6 key onto the file-held key, and records the ones it could not read |
| `src/main/secrets.ts` | **S7.6.** `createFileKeySecretStore` — AES-256-GCM under `userData/secrets.key` — plus the prefix rules (`fk1:`, `djEw…`, `plain:`). Electron-free: `node:crypto` and `node:fs` |
| `src/main/ipc/secret-store.ts` | **S7.6.** `createSafeStorageStore()` returns the `safeStorage` store **or `null`**: the legacy reader for old rows, and the key file's wrapper on a signed build |
| `src/main/providers/registry.ts` | `ResolvedProvider` + model id → an AI SDK `LanguageModel` |
| `src/main/providers/discovery.ts` | `fetchModels` (raw `/models`) and `testConnection` (`generateText`) |
| `src/main/providers/cli-process.ts` | **S5.13.** Binary resolution (`PATH`, then the vendor's install locations, then the override variable) and one child process per command, shared by both CLI wrappers |
| `src/main/providers/anthropic-cli.ts` | **S5.3.** The `ant` wrapper: `status`, `login`, `logout`, `accessToken` and the token cache |
| `src/main/providers/google-cli.ts` | **S5.13.** The `gcloud` wrapper: the same four plus `project` and `setQuotaProject`, and the credential cache |
| `src/main/handlers/providers.ts` | The eleven `providers.*` methods; validation lives here and nowhere else |
| `src/main/app-context.ts` | Gained an optional `fetchImpl` so a test can inject HTTP, and (S5.3, S5.13) `anthropicCli` / `googleCli` plus the `modelOptions` / `providerFetch` / `authCli` readers |

Those two wrappers are the only modules in the app that ever hold an access
token, and each holds one for as long as its CLI says it is valid, minus sixty
seconds.

None of them imports electron (CLAUDE.md rule #5). `resolve.ts` takes an
`AppContext` by type only; the secret store arrives through it as an interface.
`cli-process.ts` imports `node:child_process`, `node:fs` and `node:path`, which
the rule says nothing about — it is about electron, and the main process already
spawns stdio MCP servers.

**S7.6 changed how the key is protected, not where it is stored.** The column,
the write-only contract and `getApiKeyCiphertext` are untouched; what changed is
which store produces the ciphertext, plus one new runtime field on `Provider`
(`keyState`) and one new error code (`key_unreadable`). See "The secret store"
at the end of this file.

**S7.5 added nothing here.** The first-run card is a second *renderer* of the
same draft and the same seven methods: it calls `providers.fetchModels` and
`providers.create` exactly as the settings editor does, and a provider it saves
is indistinguishable from one added in Settings. No handler, no column, no
validation rule changed — which is the point of having put the rules in the
handler rather than in the form.

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
| `auth` | text null | `apiKey \| oauth` (S5.3). Null means `apiKey`; read it through `providerAuth()`. An `oauth` row stores **no credential at all**. S5.13 widened which types may hold `oauth` and needed **no migration**: the column already existed and its meaning did not change |
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
| `providers.create` | `{ input: ProviderInput }` | `Provider` | name non-empty; known `type`; `models` an array of strings; `openai-compatible` needs `baseUrl`; a key is required when `providerRequiresApiKey` says so; and (S5.3) `auth` must be one of the two modes, `oauth` only on `anthropic` or `google` (`oauth_unsupported_provider`) with no `baseUrl` (`oauth_custom_base_url`), with **that type's** CLI actually signed in (`ant_missing` / `ant_not_logged_in`, `gcloud_missing` / `gcloud_not_logged_in`). A Google provider with no quota project is **accepted**: the user is signed in and the panel offers the field |
| `providers.update` | `{ id, patch }` | `Provider` | the same checks, applied only to the fields present. The key requirement is **not** re-checked: clearing a key is a deliberate operation. The `auth` rules *are* checked against the **stored row merged with the patch**, because `{ auth: 'oauth' }` alone says nothing about the type it lands on |
| `providers.delete` | `{ id }` | `void` | non-empty id |
| `providers.fetchModels` | `{ provider: ProviderRef }` | `string[]` | the ref must be `{ id }` or `{ draft }`; rejects `provider_error` with `details.status` |
| `providers.testConnection` | `{ provider: ProviderRef, modelId? }` | `ConnectionTestResult` | never rejects; a failed probe is a value |
| `providers.authStatus` | `{ type }` | `ProviderAuthStatus` | `type` must be `anthropic` or `google` (`oauth_unsupported_provider`); otherwise never rejects, because `not-installed` and `signed-out` are states |
| `providers.login` | `{ type }` | `ProviderAuthStatus` | rejects `*_missing` with no binary, `*_not_logged_in` for a flow the user abandoned |
| `providers.logout` | `{ type }` | `ProviderAuthStatus` | rejects `*_missing` only; "there was nothing to log out of" is the state the caller asked for |
| `providers.setQuotaProject` | `{ project }` | `ProviderAuthStatus` | **S5.13**, Google only. Non-empty id; rejects `gcloud_no_project` when the CLI refuses it, usually for want of `serviceusage.services.use` on that project |

Every method that returns a record passes it through `withKeyState(ctx, …)`
(S7.6), which fills `Provider.keyState` from `ctx.unreadableSecrets`: `none` for
a provider that stores no key, `unreadable` for one whose ciphertext this
installation could not decrypt, `ok` otherwise. `providers.update` **clears** the
mark when the patch touched `apiKey` — that is what makes "paste it again"
actually fix the card — and `providers.delete` drops it with the row.

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
| `google` | `GET {base}/models?key=<key>`, or `GET {base}/models` with no parameter when the provider signs in | `models[].name`, minus the `models/` prefix |

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
  main process; it is never logged. A provider in sign-in mode has no key and the
  parameter is **omitted entirely** (S5.13) rather than sent empty: its credential
  arrives as the `Authorization` and `x-goog-user-project` headers that
  `createProviderFetch` puts on the request, and an empty `key=` alongside them is
  refused.

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

### The two vendor CLIs

Both are wrapped the same way and share `cli-process.ts`, which owns the search
(`PATH`, then the vendor's macOS install locations, then the override variable)
and the child process (one per command, a timeout, ENOENT told apart from a
non-zero exit). What stays per vendor is the binary's name, its install
locations, its error codes and the shape of what it prints.

| | Anthropic (S5.3) | Google (S5.13) |
|---|---|---|
| Binary | `ant` | `gcloud` |
| Override | `WITENA_ANT_BIN` | `WITENA_GCLOUD_BIN` |
| Fallback dirs | `/opt/homebrew/bin`, `/usr/local/bin`, `$HOME/go/bin` | `/opt/homebrew/bin`, `/usr/local/bin`, `$HOME/google-cloud-sdk/bin` |
| Read timeout | 30 s | 60 s — with no ADC, `gcloud` probes the Compute Engine metadata server three times first, ~10 s on a laptop |
| Missing | `ant_missing` | `gcloud_missing` |
| Signed out | `ant_not_logged_in` | `gcloud_not_logged_in` |
| Third code | — | `gcloud_no_project` |

#### The Anthropic CLI (`ant`), S5.3

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
`expires_at` become a `ProviderAuthStatus`; the two token fields never leave the
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

#### The Google Cloud SDK (`gcloud`), S5.13

Verified against Google Cloud SDK 553.0.0 on macOS. Install:
`brew install --cask google-cloud-sdk`.

| Command | What it does |
|---|---|
| `gcloud auth application-default print-access-token --format=json` | The status *and* the token *and* the quota project, in one JSON **object**; refreshes the token when it is near expiry; exits 1 with no ADC |
| `gcloud config list --format=json` | The fallback account and project, read only when the ADC carries neither |
| `gcloud auth application-default login` | Opens the system browser itself |
| `gcloud auth application-default revoke --quiet` | Deletes `~/.config/gcloud/application_default_credentials.json` |
| `gcloud auth application-default set-quota-project <id>` | Writes `quota_project_id` into that same file |

The `--format=json` object's keys, as printed on 553.0.0: `account`,
`client_id`, `client_secret`, `default_scopes`, `expired`, `expiry`,
`granted_scopes`, `id_token`, `id_tokenb64`, `quota_project_id`, `rapt_token`,
`refresh_handler`, `refresh_token`, `requires_scopes`, `scopes`, `token`,
`token_state`, `token_uri`, `universe_domain`, `valid`.

Things that will bite anyone changing this file:

- **The token field is `token`, not `access_token`.** This is the SDK's own
  credential object, not an OAuth response body. Reading `access_token` gets
  `undefined` and the module reports "credentials without an access token".
- **`expiry.datetime` is a naive **UTC** timestamp** (`2026-09-14 05:14:51.579879`
  while `date -u` read 04:14:51). `parseExpiry` appends the `Z`; letting the
  platform apply the local zone would be wrong by the offset on every machine
  outside UTC — and wrong in the *unsafe* direction east of it.
- **`gcloud config get-value` is not parsed.** Its unset answer is the word
  `(unset)` on **stderr** with an empty stdout and exit code **0**, which is
  prose pretending to be a value. `config list --format=json` simply omits the
  key, and answers both questions in one spawn.
- **An ADC written by `application-default login` alone carries no account.**
  `account` is `""` and `quota_project_id` is `null` until someone sets them, so
  the labels fall back to `core.account` / `core.project` from `config list` —
  and a machine that has neither is still `signed-in`, just without a name to
  print.
- **A missing quota project is not an error state.** It is `signed-in` with no
  `project`; `gcloud_no_project` is raised by `cli.project()`, which the fetch
  wrapper calls *before* asking for a token, so a request that could not succeed
  is never sent.
- **`stdout` is a credential** — an access token, a refresh token and an id
  token. It is parsed and dropped; only `stderr` is ever quoted, trimmed to 200
  characters. A test asserts that a command which prints one *and* fails leaks
  nothing.
- **`createGoogleGenerativeAI({ apiKey: '' })` is deliberate**, exactly as on the
  Anthropic side: omitting `apiKey` makes the adapter look for
  `GOOGLE_GENERATIVE_AI_API_KEY` and throw, and the empty `x-goog-api-key` it
  produces is deleted by the wrapper before the request leaves.
- **Token lifetime falls back to 55 minutes** when `gcloud` printed no expiry;
  Google issues one-hour tokens, and the shared 60 s margin applies on top.

**Not used, deliberately:** the Gemini CLI / Antigravity OAuth client and the
`cloudcode-pa.googleapis.com` Code Assist endpoint. A first-party client id
belonging to a vendor's own tools is not ours to reuse.

### The shared OAuth `fetch` wrapper

One `oauthFetch` for both vendors (S5.13, generalised from S5.3's
Anthropic-only one), because the risk being managed is *forgetting an edit* and
the way to manage that is to have one place that applies them. The vendor's
edits arrive as data:

| | `remove` | `Authorization` | `set` | `merge` |
|---|---|---|---|---|
| Anthropic | `x-api-key` | `Bearer <ant token>` | — | `anthropic-beta: oauth-2025-04-20` |
| Google | `x-goog-api-key` | `Bearer <ADC token>` | `x-goog-user-project: <project>` | — |

`merge` exists only for `anthropic-beta`: the SDK sets that header itself for
features like extended output, so assigning it would silently turn them off.
`remove` exists because both APIs refuse a request that carries a key *and* a
token. The preparer is called **per request** rather than captured, so a model
instance built once and used for an hour keeps working — each CLI refreshes its
credential and caches it until just before it expires.

### The secret store

**Untouched by S5.3**: a provider that signs in stores no secret, so the sign-in
path never reaches this store at all.

Note for anyone writing a handler test, and the oldest trap here: the
repository's `encrypt` and the context's `secrets.decrypt` must come from the
*same* store, or nothing round-trips — `createTestAppContext` builds its
repositories for that reason, and takes a `secrets` option so a suite about
encryption can swap the store without unbinding them.

#### Why it is a file and not the Keychain (S7.6)

The store the app writes provider keys with is `createFileKeySecretStore`:

| | |
|---|---|
| Key | 32 random bytes in `userData/secrets.key`, mode `0600`, created on first use |
| Cipher | AES-256-GCM, a fresh 12-byte IV per value |
| Stored form | `fk1:` + base64(iv ‖ tag ‖ ciphertext), one string for a `text` column |
| Failure | `BackendFailure('key_unreadable')` on a wrong key, a failed tag, a truncated value or a value that is not `fk1:` at all |
| Key file form | `fkkey1:` + base64(key), or `fkkey1w:` + `safeStorage` ciphertext on a signed build (S7.3) |

`safeStorage` was the store until S7.6 and is the reason this changed. Its
Keychain item ("Witena Safe Storage") is granted **per application identity**,
and an unsigned build has a new identity every time it is packaged — so when the
S7.1 dmg replaced the S4.4 one, the DeepSeek and Moonshot ciphertexts already in
the database (`v10…`, genuine `safeStorage` output) could no longer be
decrypted. Nothing was lost except the key to the data. A file under `userData`
belongs to the user's data rather than to the bundle, so an update leaves it
exactly where it was.

What that costs, stated plainly so nobody has to rediscover it: **on an unsigned
build, anyone who can read the user's files can read `secrets.key`, and
therefore every stored API key.** That was already true of an unsigned app's
Keychain item — it is granted to an identity nothing vouches for — and the file
buys something the Keychain item does not, which is surviving the next rebuild.
The stronger form arrives with signing: on a **signed** build (S7.3) the key file
is stored **wrapped** by `safeStorage`, so the Keychain protects the key and the
identity it is granted to has stopped changing. Wrapping stays off otherwise on
purpose — wrapping on an unsigned build would reintroduce the very bug this
fixes.

Three things worth knowing before changing `src/main/secrets.ts`:

- **The key file records how it is stored.** `fkkey1:` versus `fkkey1w:`, rather
  than inferring it from the build at read time: the build's signed-ness
  describes the running process, not the file it found, and a mismatch would hand
  the wrong 32 bytes to AES.
- **`djEw` is not a magic string.** It is base64 of `v10`, Chromium's `OSCrypt`
  version prefix, and base64 maps three bytes to four characters with no padding
  in between — so the prefix survives the encoding. `djEx` is `v11`, which Linux
  writes when there is no keyring.
- **Nothing in this module may import electron**, which is what lets the whole
  store move to a Node server and what makes `wrapper` an injected `SecretStore`
  rather than a `safeStorage` import. The same rule is why `isSignedBuild` takes
  a **parsed manifest** rather than finding one: locating the bundle is
  `src/main/index.ts`'s job, and the store is handed a boolean.

#### How the build tells the app it was signed (S7.3)

S7.6 read the environment variable `WITENA_SIGNED_BUILD` and recorded in the same
breath that this could not work: the variable is read by the **running** process,
and one exported while the dmg is being built is not in the environment of the
app a user launches days later. It was therefore false in exactly the situation
it existed for.

The answer now travels inside the bundle:

```
electron-builder  -c.extraMetadata.witenaSignedBuild=true
                    ↓  written into the package.json inside the .app
src/main/index.ts   signedBuild()  →  app.getAppPath()/package.json
                    ↓  a boolean
src/main/secrets.ts createFileKeySecretStore({ wrap }) and rewrapKeyFile({ wrap })
```

`isSignedBuild(manifest)` accepts `true` and `'true'` — a command-line value may
arrive as either depending on how it is coerced, and a flag that is quietly false
because it was a string is the failure this field replaced. Everything else,
including a manifest with no such field and any failure to read one, is **not
signed**: a checkout and the end-to-end harness both land there (the repository's
own `package.json` has no such field), and the cost of guessing wrong the other
way is a key file wrapped by a Keychain item nothing vouches for.

#### Re-wrapping an existing key file (S7.3)

`rewrapKeyFile({ keyPath, wrapper, wrap })`, called from `src/main/index.ts`
**before** the store is constructed, because the store reads the file on first
use. S7.6 left this undone and listed it as a gap: wrapping was only ever applied
to a file the build *created*, so a machine that had been running unsigned dmgs
kept a plain `secrets.key` forever and never gained what signing paid for.

It rewrites the **container, not the contents**. The same 32 bytes go back in
under `fkkey1w:` instead of `fkkey1:`, so every `fk1:` ciphertext in the database
stays readable and no provider key is re-encrypted or touched. That is what makes
doing it without asking defensible where re-encrypting the keys themselves would
not be — and it is why there is no screen and no confirmation for it.

| Case | Outcome | Effect |
|---|---|---|
| `wrap` is false | `unsigned` | Nothing. Wrapping on an unsigned build is the original bug |
| No file yet | `absent` | Nothing; the store creates one already wrapped |
| Already `fkkey1w:` | `already-wrapped` | Nothing — every launch after the first |
| `fkkey1:`, wrapper succeeds | `wrapped` | Rewritten atomically, mode `0600` |
| Wrapper throws, no wrapper, or the file is not ours | `failed` | The plain file stands, one warning, no temp file left |

Two properties are load-bearing:

- **Atomic.** A temp file in the same directory, `fsync`, then `rename`. The
  interruption this has to survive is the catastrophic one: a half-written key
  file is every API key the user has, gone. The `rename` is the only moment
  anything observable changes, and POSIX makes it indivisible within a
  filesystem.
- **Fails soft.** `safeStorage` can refuse — a locked keychain, a user who
  clicked Deny — and the answer there is to keep the plain file, which still
  works, and log once. Never to leave the user with a key nobody can read. The
  base64 is also decoded and length-checked before anything is written, because
  rewriting a key that could not be decoded would turn "a key we can read" into
  "a key nobody can".

**Unit-tested with a fake wrapper; never observed on a real signed build.** No
Developer ID certificate exists yet, so the real `safeStorage` has never been
asked to wrap a real key file. STEPS.md S7.3 carries that.

#### The startup migration

`migrateProviderSecrets(ctx, { legacy })` runs once per launch, from
`src/main/index.ts`, after the context exists:

- Rows already holding `fk1:`, and rows with no key, are skipped — so every
  launch after the first writes nothing.
- A `plain:` row is read by the insecure store (no platform support needed) and a
  `djEw…` row by the injected `safeStorage` store; both are re-encrypted through
  `ProviderRepository.update({ apiKey })`, which uses the same injected `encrypt`
  as every other write.
- A row that **cannot** be read is left byte-for-byte as it is and its id is added
  to `ctx.unreadableSecrets`. Never overwrite a ciphertext you could not read:
  the key is unreachable from this installation, not gone from the world, and the
  user may still restore the Keychain item or open the database where it was
  written.
- It never throws. The app has to start, and the ids it collected are what the UI
  turns into a sentence.
