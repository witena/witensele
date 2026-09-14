# providers — Context

## Problem

Nothing in Witena can talk to a model until the user has told it *which* model,
*where* it lives and *with whose key*. S1.6 is that: a preset-driven settings
screen where a provider is added in three clicks, its key is encrypted into the
local database, its model list is read from the endpoint itself, and the whole
thing can be probed before anything depends on it.

It is also the last piece of infrastructure before the product exists. S1.7 turns
`(providerId, modelId)` into a streaming reply; this step is what makes that pair
mean something.

## Scope

- `src/shared/presets.ts`: the 14-entry preset table and the rules derived from it
  (`getPreset`, `isLocalPreset`, `providerRequiresApiKey`, and since S5.3
  `providerAuth`, `supportsOAuth`, `ANT_INSTALL_COMMAND` — plus S5.13's
  `OAuthProviderType`, `isOAuthProviderType`, `cliInstallCommand` and
  `GCLOUD_INSTALL_COMMAND`).
- `src/main/providers/`: `registry.ts` (record → AI SDK `LanguageModel`, plus the
  shared OAuth `fetch` wrapper and the two vendors' header sets), `discovery.ts`
  (`/models` and the connection probe), `resolve.ts` (`ProviderRef` → record with
  a decrypted key), `cli-process.ts` (S5.13: binary resolution and child-process
  handling, shared by both CLI wrappers), `anthropic-cli.ts` (S5.3: the `ant`
  wrapper behind "Sign in with Anthropic") and `google-cli.ts` (S5.13: the
  `gcloud` wrapper behind "Sign in with Google").
- `src/main/handlers/providers.ts`: the eleven `providers.*` methods and all input
  validation.
- Settings → Providers: the 520px card list and the add/edit panel, plus the
  three primitives it needed (`Chip`, `Spinner`, `StatusPill`). Since S7.5 the
  panel's preset grid, credential block and model block are three components
  (`preset-grid.tsx`, `provider-credential.tsx`, `provider-models.tsx`) that the
  first-run card renders as well — **the same components, not copies**.
- `src/renderer/src/stores/providers.ts`: the list, the editor draft, both probes
  and (S5.3, S5.13) one login status per vendor CLI.
- `src/renderer/src/i18n/errors.ts`: `BackendErrorCode` → a sentence, which every
  later feature that surfaces a failure will reuse.
- `src/shared/pricing.ts` (S4.1): the model price table and the context-window
  lookup derived from it. It lives with the provider layer because it is the same
  kind of thing as `presets.ts` — vendor facts that both processes need and that
  are maintained by editing a checked-in list, not by calling an API.

## Out of scope

| Deliberately absent | Owned by |
|---|---|
| Choosing a provider and model *for an agent* | S2.1 (`agents`) |
| Signing in to OpenAI | "Provider authentication beyond Anthropic" in `docs/STEPS.md`'s Phase 6 backlog. "Sign in with ChatGPT" is a gated program for third-party apps, so the control stays visible and disabled with a hint |
| Creating a Google Cloud project, or enabling an API on one | The user's own console. The panel names the project it needs and sets it on the credentials; it does not provision anything |
| Cloud-platform credentials (Vertex AI, Bedrock, Azure) | The same backlog section |
| Actually generating text with one | S1.7 (`agent-turn`) |
| Periodic health probing that keeps a provider's dot green | S2.4 (`presence`) — the probe here is manual and its result is not persisted |
| Per-provider rate limits, retries, proxies, custom headers | Not planned for the MVP; the AI SDK's own retry is left at its default |
| Editing a provider's `type` after creation | Possible through the patch contract, not offered in the UI: the preset grid rewrites the type, which is the only sensible way to change it |
| A provider "test all" or import/export | S4.x (data & backup) |
| Reading a live price list from a vendor | Nobody serves one. `pricing.ts` is edited by hand, and says so |

## Dependencies

| Depends on | For what |
|---|---|
| [`../database/context.md`](../database/context.md) | The `providers` table and `ProviderRepository`, including `getApiKeyCiphertext` — written in S1.2 with exactly this step in mind |
| [`../backend-client/context.md`](../backend-client/context.md) | `ProviderRef`, the eleven declared methods, `BackendError`, and the handler/transport split |
| [`../ui-shell/context.md`](../ui-shell/context.md) | `Column`, `PageHeader`, `Avatar`, `Field`, `Input`, `Select`, `Button`, `EmptyState` and the design tokens |
| [`../i18n/context.md`](../i18n/context.md) | Every string, and the "backend sends codes, renderer picks words" contract |
| `SecretStore` (`src/main/secrets.ts`) | Encrypting the key on write, decrypting it for one call at a time |
| `ai`, `@ai-sdk/{anthropic,openai,google,openai-compatible}` | Building the model client and running the probe |

Depending on it in return: `agents` (S2.1) reads `providers.list` to populate its
model dropdown, and `agent-turn` (S1.7) calls `createLanguageModel` for every turn.

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| Presets are static shared data, imported by the renderer directly | A `providers.presets` backend method | The table is frozen at build time. A round trip would add a loading state to a list that cannot change, and a third place to keep in sync |
| One `ProviderRef` = `{ id } \| { draft }` for both probes | Save first, then probe; or a separate "probe these settings" method | The user must be able to test a key *before* committing it, and fetch a model list for an endpoint that has no row yet. One union keeps that to one method each |
| **S7.5: the first-run card reuses these components rather than its own form** | A dedicated, simpler onboarding form; a wizard with its own state | The rules that matter here are subtle — an empty key field *clears* a stored key, a fetch *replaces* the list, sign-in *replaces* the field — and a second implementation would eventually disagree with one of them, in the screen a brand-new user sees first. One draft, one set of controls, two places they are laid out |
| The API key is write-only end to end | Return a masked key; return the key to a "reveal" button | `Provider` has no key field at all, so no accident at any layer can leak one. The cost is the "a key is stored" hint, which is a smaller price than a key in a renderer heap snapshot |
| `''` clears the key, absent keeps it | A separate `clearApiKey` flag | The repository already had these semantics from S1.2. A second mechanism for the same thing is worse than one documented rule |
| The probe runs `generateText`, not a `/models` ping | Reuse `fetchModels` as the health check | `/models` answers for a key that cannot generate, a model id that does not exist, and an endpoint that only proxies listings. "Can this exact model answer?" is the question the user is actually asking |
| The probe target is selectable when there is more than one model | Always probe the first model | Found while writing the end-to-end test: an Ollama install commonly holds a 70B model whose id sorts first, which turned "Test connection" into a multi-minute wait. `providers.testConnection` takes an optional `modelId` |
| Probe results live in the store, never in the database | Persist `lastTestOk` on the row | A probe is a fact about *now*. A green dot restored from disk after three days is a lie, and the honest fourth state (`untested`) costs one locale key |
| Four card states, not the three in the artboard | Paint an untested provider green, or hide the pill | See above: `untested` is the state a restored card is actually in |
| `Chip` is a new primitive rather than a `Badge` variant | Extend `Badge` with `onRemove` | A badge is a label and is never interactive; a chip is an item in an editable set. Merging them gives a primitive whose props contradict each other |
| Delete confirms with a second click on the same button | A modal dialog | The shell has no dialog layer, and a modal needs focus trapping and an escape route that S1.6 would have to invent. The latch is honest, reversible and disarms itself after 4 s |
| Provider logos are derived from the preset id, not stored | A `logoColor` column; let the user pick | Derived means the same provider looks identical in the list, the preset grid and (from S2.1) the agent form, with nothing to keep in sync |
| `providerRequiresApiKey` lives in `@shared/presets` | One copy in the handler, one in the renderer | Two copies of a rule disagree the first time a preset changes; the backend enforces it and the card renders it, and both must mean the same thing |
| **S5.3: signing in delegates to the official `ant` CLI** | Registering our own OAuth client with a loopback redirect; embedding a browser view | The CLI already owns a registered client, a redirect the vendor accepts and a refresh token that survives a restart. Reusing it means Witena stores **no credential of its own**: `SecretStore` is untouched, no column holds a token, and `ant auth logout` signs Witena out too, because there was never a second copy |
| **S5.13: Google signs in through `gcloud` application-default credentials** | The Gemini CLI / Antigravity OAuth client and the `cloudcode-pa.googleapis.com` Code Assist endpoint; our own OAuth client with a loopback redirect | The same argument as S5.3, and one more: a first-party client id belonging to Google's own tools is not ours to reuse — that is the shape of credential Anthropic now refuses, and it would be no better here. ADC is the credential the user's own SDK holds for exactly this purpose, and Witena speaks only the public Gemini API with it |
| The quota project is a **field on the panel**, not something Witena guesses | Read `gcloud config get-value project` and use it silently; omit the header | `x-goog-user-project` decides who is billed. Guessing that from an unrelated `gcloud` setting spends somebody's money on a project they did not name here. It is read from the ADC when it is there and asked for when it is not |
| A missing quota project is **`signed-in` with no project**, not a fourth state | A `no-project` auth state; refusing Save | The user is signed in — that part worked — and the gap is one field away from fixed. `gcloud_no_project` is raised only where a request actually has to be made |
| One `ProviderSignIn` component for both vendors | A `GoogleSignIn` beside `AnthropicSignIn` | The three states, the busy flag, the error line, the two buttons and the "Sign in doubles as look again" rule are the whole component and are identical. What differs is three strings, an install command and one extra control — a prop and two branches, not a second copy of a state machine |
| One `oauthFetch` taking the vendor's edits as data | A wrapper per vendor | The risk being managed is *forgetting an edit*, and the way to manage it is to have one place that applies them. The vendors' differences are then data (`remove` / `set` / `merge`) that a test can read |
| `cli-process.ts` is shared by both CLI wrappers | Copy the spawn, timeout and `PATH` search into `google-cli.ts` | Sixty lines of ENOENT-versus-exit-code handling is exactly the kind of thing that gets fixed in one copy and not the other. What stays per-vendor is what is genuinely per-vendor: the binary's name, its install locations, its error codes and the shape of what it prints |
| `auth` is a field on the provider, not a new `ProviderType` | `type: 'anthropic-oauth'`; a separate preset | The endpoint, the model list and the adapter are identical either way — only the header differs. A new type would fork `registry.ts`, `discovery.ts`, the preset table and the logo rules to express one boolean |
| Status is derived from `print-credentials`, never from `ant auth status` | Parse the status command's text | Its output is prose and its `--format json` flag does not apply to that subcommand (verified on `ant` 1.32.0). `print-credentials` is JSON, is the one call that also refreshes a near-expired token, and fails cleanly when no profile is logged in |
| `not-installed` / `signed-out` are **states**, not rejections | Reject `ant_missing` from `providers.authStatus` | They are the ordinary condition of a machine that has never used the CLI, and the panel exists precisely to render them. The two codes are reserved for calls that had to *do* something and could not |
| Save is refused when the CLI cannot authenticate | Save the row and let the first chat turn fail | A saved provider is a promise that an agent can speak through it. The refusal happens while the editor — and the sign-in panel — are still on screen |
| An `oauth` provider may not carry a custom base URL | Allow it and trust the user | The account token is issued for Anthropic's own API; sending it to a proxy would hand a credential to somewhere the user never authorised |
| The "signed in" badge is neutral, not green | Paint it like a successful probe | The record says this provider signs in. That is not a claim that the login is still valid — only a probe can make that claim, and it then shows "Connected" |
| The token is cached in memory until 60 s before it expires | Ask the CLI per request; keep it for a fixed interval | Every request would otherwise spawn a process. The CLI refreshes the credential itself, so honouring its own `expires_at` is both correct and free |

## Open questions

- **The S5.3 acceptance criterion is only two-thirds verified on this machine.**
  With `ant` installed and logged in, an `oauth` provider's status reads back,
  and `providers.fetchModels` returns the real list (11 models) through the
  wrapper. A generation is refused by the API with `Your credit balance is too
  low…` (HTTP 400, `invalid_request_error`) — an account-balance answer, not an
  authentication one, and the same refusal comes back for a bare `curl` with the
  same headers. The header path is therefore proven; "a chat turn completes" needs
  an account with API credit. Recorded in the Phase 6 backlog.
- **`fetchModels` is a hand-written fetch per provider family.** The AI SDK has
  no listing API, so this is unavoidable, but it is also the part most likely to
  break when a provider changes its response shape. It fails loudly
  (`provider_error` with the HTTP status) rather than silently returning `[]`.
- **Google's list endpoint authenticates with a query parameter.** That is the
  documented REST form; the key therefore appears in a URL inside the main
  process. It is never logged and never leaves the machine except to Google, but
  the `x-goog-api-key` header is the better shape if this is ever revisited.
- **`createOpenAICompatible` needs a non-empty key on some servers.** Ollama does
  not care, LM Studio can. A `'ollama'` placeholder is sent for a local preset
  with no stored key, which is a small lie that removes a class of "works in
  curl, fails in the app" reports.
- **A second provider of the same type shares the one login.** Each CLI has a
  single active profile, so two `oauth` Anthropic providers are the same account
  and the panel's status is a fact about the machine rather than about the row.
  The two *vendors* are independent — the store keys the status by provider type
  — but multiple profiles of one vendor would need a profile picker and a
  per-provider selection.
- **S5.13's acceptance criterion is unverified, and it may not be reachable with
  the default ADC scopes.** On the development machine `gcloud` 553.0.0 is
  installed and application-default credentials are present; `GoogleCli` finds
  the binary from a `launchd`-shaped `PATH`, reports `signed-in`, parses the
  expiry (one hour out) and returns a live `ya29.` token, and rejects
  `gcloud_no_project` because no quota project is set. But a bare `curl` to
  `GET https://generativelanguage.googleapis.com/v1beta/models` with
  `Authorization: Bearer <ADC token>` answers **HTTP 403
  `ACCESS_TOKEN_SCOPE_INSUFFICIENT`**, with and without `x-goog-user-project`.
  The token's scopes are the ADC defaults (`openid`, `userinfo.email`, `email`,
  `cloud-platform`, `sqlservice.login`), so the endpoint wants a scope
  `cloud-platform` does not imply — probably
  `https://www.googleapis.com/auth/generative-language.retriever`, which
  `gcloud auth application-default login --scopes=…` can request. That flag was
  **not** added speculatively: it changes a login that is known to complete into
  one that might be refused at the consent screen, and proving it needs a browser
  and the user's own account. Recorded in the Phase 6 backlog.
- **No provider is validated against its own model list.** A user can type a
  model id that does not exist and only find out when they press Test (or, from
  S1.7, when an agent speaks). Validating on save would need a network call on a
  screen that must work offline.
