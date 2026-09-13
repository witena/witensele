# providers — Implementation

## Approach

Four layers, each of which knows less than the one above it.

**The preset table** (`src/shared/presets.ts`) is frozen data: id, brand name,
`ProviderType`, optional `baseUrl`, seed models, `requiresApiKey`, optional
`local`. It is shared because both sides consume it — the renderer renders the
picker from it, the main process asks it whether a key is mandatory — and it is
data rather than a method because it cannot change at runtime.

**The provider services** (`src/main/providers/`) are four small, electron-free
modules:

- `resolve.ts` turns a `ProviderRef` into a `ResolvedProvider` (the record plus a
  plaintext key). It is the only place a stored key is decrypted.
- `registry.ts` turns a `ResolvedProvider` plus a model id into an AI SDK
  `LanguageModel`. One `switch` over `ProviderType`, one factory each — plus
  (S5.3) `oauthFetch`, the `fetch` wrapper that swaps an API key header for an
  account token, and `createProviderFetch`, which decides whether a given
  provider needs it.
- `discovery.ts` answers the two network questions: `fetchModels` speaks the raw
  `/models` endpoints, `testConnection` runs `generateText` through the registry.
- `anthropic-cli.ts` (S5.3) wraps the `ant` binary: `status`, `login`, `logout`
  and `accessToken`, behind an `AnthropicCli` interface that everything else
  takes by injection. It is the only module here that spawns a process, and the
  only one that ever holds a token — which never leaves it except as an
  `Authorization` header.

**The handlers** (`src/main/handlers/providers.ts`) validate and delegate. They
hold no logic of their own beyond "is this input acceptable".

**The renderer** keeps a list and an **editor draft** (`stores/providers.ts`) and
renders them as the artboard's two columns. The draft exists because a provider is
not editable field by field: a preset rewrites three fields at once, a key must
not be sent before Save, and a model list must be fetchable for an endpoint that
has no row yet.

## Data flow

Adding a provider, end to end:

```
click "Add provider"        → startCreate(): draft = { type:'openai-compatible', name:'', models:[] }
click a preset tile         → applyPreset(id): type, name, baseUrl, models from PROVIDER_PRESETS
type a key                  → patchDraft({ apiKey })            (renderer memory only)
click "Fetch from /models"  → providers.fetchModels { draft }
                              → resolveProvider(ctx, { draft })  (uses the typed key)
                              → GET {baseUrl}/models
                              → draft.models = answer
click "Test connection"     → providers.testConnection { draft, modelId }
                              → createLanguageModel(...) → generateText(prompt:'Reply with OK',
                                                                       maxOutputTokens: 8)
                              → { ok, latencyMs, model } | { ok:false, error }
click "Save"                → providers.create { input: draft }
                              → validation → repository → secrets.encrypt(apiKey) → SQLite
                              → the editor re-binds to the saved row (key field resets to "stored")
```

Signing in instead of pasting a key (S5.3):

```
open the Anthropic provider     → the editor shows the Authentication control
click "Sign in with Anthropic"  → patchDraft({ auth: 'oauth' }); the key field is
                                  replaced by the panel, which asks once:
                                  providers.authStatus → ant auth print-credentials
                                  → { state, accountEmail, workspaceName, expiresAt }
click "Sign in"                 → providers.login → ant auth login (opens the
                                  system browser itself; resolves when it exits)
                                  → the resulting status replaces the old one
click "Save"                    → providers.create { input: { …, auth: 'oauth' } }
                                  → validation: anthropic only, no baseUrl, no key
                                    needed; and the CLI must actually be signed in
                                  → the row stores `auth = 'oauth'` and no key
```

and then, whenever that provider is used:

```
createLanguageModel(resolved, modelId, { anthropicCli })
  → createAnthropic({ apiKey: '', fetch: oauthFetch(() => cli.accessToken()) })
      per request: delete x-api-key
                   set Authorization: Bearer <token>
                   merge oauth-2025-04-20 into anthropic-beta
  → the token comes from the CLI's in-memory cache until 60 s before it expires
```

Using one afterwards (S1.7 preview):

```
AgentTurn needs a model
  → resolveProvider(ctx, { id: agent.providerId })   decrypts once, for this call
  → createLanguageModel(resolved, agent.modelId)
  → streamText({ model, ... })
```

The key's whole lifetime in plaintext is inside one handler call: it is decrypted
from `providers.api_key_encrypted`, handed to an SDK factory, and dropped. It is
never in a `Provider`, never in an event, never in the renderer.

## Key types and contracts

| Export | Where | Notes |
|---|---|---|
| `ProviderPreset`, `PROVIDER_PRESETS`, `getPreset`, `isLocalPreset`, `providerRequiresApiKey` | `@shared/presets` | The table, and the three questions asked of it |
| `ResolvedProvider` | `src/main/providers/registry.ts` | `Provider & { apiKey?: string }` — the only form the model layer accepts |
| `createLanguageModel(provider, modelId, options?)` | same | Throws `validation` for an empty model id, an `openai-compatible` provider with no base URL, or an `oauth` provider with no `AnthropicCli` in `options` |
| `ModelOptions`, `createProviderFetch`, `oauthFetch`, `mergeBeta` | same | The S5.3 injection point: the CLI and the outbound `fetch`, and the wrapper that rewrites the three headers |
| `AnthropicCli`, `createAnthropicCli`, `resolveAntBinary`, `antMissing`, `antNotLoggedIn` | `src/main/providers/anthropic-cli.ts` | The CLI seam. `createAnthropicCli` takes `spawn`, `env`, `fallbackDirs` and `now` so the tests drive the real implementation against a fake `ant` |
| `modelOptions(ctx)`, `providerFetch(ctx, provider)` | `src/main/app-context.ts` | Those capabilities read off the context, so no caller spells out "…unless it signs in" |
| `fetchModels(resolved, fetchImpl?)` | `src/main/providers/discovery.ts` | Rejects with `provider_error`; `details.status` carries the HTTP status |
| `testConnection(resolved, options?)` | same | **Never throws.** `options` carries `modelId`, `timeoutMs` and the two test seams (`createModel`, `generate`) |
| `resolveProvider(ctx, ref)` | `src/main/providers/resolve.ts` | The decryption seam |
| `useProvidersStore` | `src/renderer/src/stores/providers.ts` | See [frontend.md](./frontend.md) |
| `errorMessage` / `translateError` | `src/renderer/src/i18n/errors.ts` | `BackendErrorCode` → a sentence, by literal `switch` |

Shared-contract changes made by S5.3:

- `ProviderAuth` (`'apiKey' | 'oauth'`) with `Provider.auth` / `ProviderInput.auth`
  optional, and `AnthropicAuthStatus` — the token-free status the renderer sees.
- `BackendErrorCode` gained `ant_missing` and `ant_not_logged_in`; they describe
  the state of a tool on the user's machine rather than a malformed request, and
  they are raised by the model layer as well as by a handler.
- `VALIDATION_REASONS` gained `oauth_unsupported_provider` and
  `oauth_custom_base_url`, reusing S5.2's reason channel rather than adding
  codes for two refusals of one form.
- `providers.authStatus`, `providers.login` and `providers.logout` were added to
  `BackendApi`, `BACKEND_METHODS` and `shared/contracts.test.ts`.

Shared-contract changes made by S1.6:

- `ConnectionTestOk` gained an optional `model` field, so the result line can say
  *which* model answered. Optional because `McpConnectionTestResult` reuses the
  same shape and an MCP probe has no model.
- `providers.testConnection` gained an optional `modelId` on its input object —
  a non-breaking addition, exactly the kind the one-object-argument convention in
  `shared/backend.ts` exists to allow. No method was added or removed, so
  `BACKEND_METHODS` is unchanged.
- `AppContext` gained an optional `fetchImpl`, the injection point that keeps
  `npm test` from opening a socket.

## Tests

| File | Covers |
|---|---|
| `src/shared/pricing.test.ts` | The price table's shape (positive prices and windows), the specific-before-general match order, matching a vendor-prefixed id, `estimateCost` (linear, `null` for an unknown model, `0` for a local preset), `contextWindowFor`'s fallback, and both formatters |
| `src/shared/presets.test.ts` | Unique ids; every OpenAI-compatible preset except `custom` has a base URL; local presets require no key, ship no models and point at localhost; hosted presets are https and seeded; `getPreset` / `isLocalPreset` edge cases |
| `src/main/providers/registry.test.ts` | A model is constructed for all four types and reports the right `provider` / `modelId`; the compatible name comes from the preset id and falls back to a slug; an empty model id and a base-URL-less compatible provider are rejected; a keyless local provider still builds. S5.3: `mergeBeta`'s three cases; `oauthFetch` deleting `x-api-key`, setting the bearer token, merging the beta flag, keeping every other header and asking for a token **per request**; an `oauth` model whose first real `doGenerate` is inspected for those headers; the refusal to build one with no CLI; and every other provider keeping the plain `fetch` |
| `src/main/providers/anthropic-cli.test.ts` | The real implementation against a **fake `ant`** — an executable script first on the given `PATH`. Binary resolution (`PATH`, the fallback directories, `WITENA_ANT_BIN`, nothing at all); `status` for all three states; the status carrying no token and exactly five fields; that `print-credentials` is what is called; the token cache expiring 60 s early, not caching a credential with no expiry, and being dropped on logout; `ant_not_logged_in` on a non-zero exit; `internal` on output that is not JSON; a failing command quoting `stderr` and **never** `stdout`; login, a cancelled login, and logout being forgiving of "nothing to log out of" but not of a missing binary |
| `src/main/providers/discovery.test.ts` | `fetchModels` for all four families with a fake `fetch` (URL, headers, id extraction, sorting, `/v1` not doubled); HTTP 401 and 404 → `provider_error` with the status; a 10 s timeout; an unreachable host. `testConnection` through the **real** `generateText` with `MockLanguageModelV4`, plus the failure, timeout, no-model and "keep the deliberate error code" paths |
| `src/main/handlers/handlers.test.ts` | The `providers.*` block against the temp database: create stores ciphertext and reports only `hasApiKey`; the five validation refusals; a local preset saves with no key; an absent `apiKey` keeps the stored one and `''` clears it; delete; user scoping; `fetchModels` for a draft *and* for a saved row (proving decryption) with an injected `fetchImpl`. S5.3: an `oauth` provider saves with no key at all; the two reasoned refusals; an unknown mode; Save refused with `ant_missing` / `ant_not_logged_in`; the **merged** check on update (a patch of `{ auth: 'oauth' }` refused on an OpenAI row, accepted on an Anthropic one); `fetchModels` sending a bearer token, no `x-api-key` and the beta flag; and the three auth methods answering straight from the CLI |
| `src/renderer/src/stores/providers.test.ts` | Load, the draft lifecycle (preset application, the name the user typed surviving it, models add/remove/dedupe), save-create vs save-update, failures becoming state, remove, and both probes including the draft/record result key. S5.3: `loadAuthStatus` / `signIn` / `signOut` keeping the latest status and never leaving `authBusy` on, a refused sign-in being recorded and followed by a re-read, and the draft carrying `auth` both ways |
| `src/renderer/src/i18n/errors.test.ts` | Every `BackendErrorCode` maps to distinct, real copy, and `translateError` never prints the developer message |
| `src/renderer/src/components/settings/provider-logo.test.ts` | The initials rules and the stability of the derived colour |
| `src/renderer/src/components/settings/provider-display.test.ts` | Host derivation including the unparseable case; the status rule, especially "a local provider is never `no-key`" and "untested is not connected". S5.3: `signed-in` replacing the key indicator and a probe outranking it; `authControl`'s three outcomes, which is how the editor's mode switch is tested without a DOM; `signedInName`'s fallbacks and `formatExpiry` |
| `src/renderer/src/components/ui/status-pill.test.ts` | The tone → token mapping, and that the classes are literal rather than interpolated |
| `e2e/providers.spec.ts` | The Ollama flow against a real local server (skipped assertions are annotated when it is not running), survival across a restart, the write-only key contract, clearing a key, and the `providers.png` screenshot. S5.3 adds a case that relaunches the app with `WITENA_ANT_BIN` pointing at nothing: the panel reports `not-installed`, the key field is gone, the install command is printed verbatim, Save is refused with a translated `ant_missing` and stores nothing, and switching back to the key field restores the form |

`MockLanguageModelV4` is the right mock, not `MockLanguageModelV3`: the installed
provider packages implement `LanguageModelV4`, whose `finishReason` and `usage`
are structured objects rather than a string and three numbers.

## Known limitations and TODOs

- **The price table goes stale.** It is a hand-maintained estimate (see
  [backend.md](./backend.md), "Editing the price table"); a vendor that reprices
  is a one-line edit here and nothing else. A model the table does not know
  reports tokens and no price, which is the honest failure mode.
- **The probe result is lost on restart** by design (see
  [context.md](./context.md)), so every card starts as `untested`. S2.4's periodic
  provider probe is what will keep those dots meaningful.
- **`fetchModels` replaces the list rather than merging it.** A model added by
  hand disappears when the list is refetched. Merging felt worse: the endpoint is
  the authority on what it serves.
- **No base-URL validation on save.** A malformed URL is accepted and fails at the
  first probe with the provider's own error. `providerHost` falls back to echoing
  the raw string so the card still says something useful.
- **The editor has no dirty-state guard.** Selecting another card discards an
  unsaved draft silently. A confirm prompt needs the dialog layer this step
  deliberately did not build.
- **The sign-in click is never driven by a test.** It opens a real browser and
  needs an account, so `providers.login` is exercised only against the fake `ant`
  in the unit suite and by hand.
- **A generation through an `oauth` provider is unverified end to end.** The
  headers reach the real API and the model list comes back; the account used for
  verification has no API credit, so `generateText` is refused for billing rather
  than for authentication. See `context.md`.
- **`e2e/providers.spec.ts` leaves the app in Chinese**, like `ui-shell.spec.ts`,
  because both take screenshots meant to be compared with the artboards.
