# providers — Implementation

## Approach

Four layers, each of which knows less than the one above it.

**The preset table** (`src/shared/presets.ts`) is frozen data: id, brand name,
`ProviderType`, optional `baseUrl`, seed models, `requiresApiKey`, optional
`local`. It is shared because both sides consume it — the renderer renders the
picker from it, the main process asks it whether a key is mandatory — and it is
data rather than a method because it cannot change at runtime.

**The provider services** (`src/main/providers/`) are seven small, electron-free
modules:

- `resolve.ts` turns a `ProviderRef` into a `ResolvedProvider` (the record plus a
  plaintext key). It is the only place a stored key is decrypted.
- `registry.ts` turns a `ResolvedProvider` plus a model id into an AI SDK
  `LanguageModel`. One `switch` over `ProviderType`, one factory each — plus
  (S5.3, generalised in S5.13) `oauthFetch`, the `fetch` wrapper that swaps an
  API key header for an account token; `anthropicOAuthHeaders` /
  `googleOAuthHeaders`, the two vendors' edits *as data*; and
  `createProviderFetch`, which decides whether a given provider needs any of it.
- `discovery.ts` answers the two network questions: `fetchModels` speaks the raw
  `/models` endpoints, `testConnection` runs `generateText` through the registry.
- `cli-process.ts` (S5.13) finds a vendor binary and runs one command against it.
  Shared by both wrappers below, because sixty lines of `PATH` search and
  ENOENT-versus-exit-code handling is exactly the kind of thing that gets fixed
  in one copy and not the other.
- `anthropic-cli.ts` (S5.3) wraps the `ant` binary: `status`, `login`, `logout`
  and `accessToken`, behind an `AnthropicCli` interface that everything else
  takes by injection.
- `google-cli.ts` (S5.13) wraps `gcloud` the same way, plus `project` and
  `setQuotaProject`, behind a `GoogleCli` interface. Those two and the Anthropic
  one are the only modules here that spawn a process, and the only ones that ever
  hold a token — which never leaves them except as an `Authorization` header.
- `migrate-secrets.ts` (S7.6) runs once per launch and moves every key still
  stored in the pre-S7.6 format onto the file-held key. It reads each row with
  the store that wrote it, re-encrypts through the repository's own `encrypt`,
  and leaves a row it could not read exactly as it is — collecting those ids in
  `ctx.unreadableSecrets` instead, which is what the handlers report as
  `keyState`.

**The handlers** (`src/main/handlers/providers.ts`) validate and delegate. They
hold no logic of their own beyond "is this input acceptable".

**The renderer** keeps a list and an **editor draft** (`stores/providers.ts`) and
renders them as the artboard's two columns. The draft exists because a provider is
not editable field by field: a preset rewrites three fields at once, a key must
not be sent before Save, and a model list must be fetchable for an endpoint that
has no row yet.

Since S7.5 that draft has a **second editor**: the first-run card on the chat
page. It is not a second form — the three blocks that matter (`PresetGrid`,
`ProviderCredential`, `ProviderModels`) were extracted from
`provider-editor.tsx` and are rendered by both screens, reading and writing the
one draft in the store. That is what keeps the write-only key rule, the "a fetch
replaces the list" rule and the sign-in panel from existing twice. The one thing
the card must not touch is `mode`, which is the settings editor's own state,
hence `ensureDraft` (see [frontend.md](./frontend.md)).

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

Signing in instead of pasting a key (S5.3, and S5.13 for Google):

```
open the Anthropic provider     → the editor shows the Authentication control
click "Sign in with Anthropic"  → patchDraft({ auth: 'oauth' }); the key field is
                                  replaced by the panel, which asks once:
                                  providers.authStatus { type: 'anthropic' }
                                  → ant auth print-credentials
                                  → { state, account, workspaceName, expiresAt }
click "Sign in"                 → providers.login { type } → ant auth login (opens
                                  the system browser itself; resolves when it exits)
                                  → the resulting status replaces the old one
click "Save"                    → providers.create { input: { …, auth: 'oauth' } }
                                  → validation: a sign-in type only, no baseUrl, no
                                    key needed; and that type's CLI must be signed in
                                  → the row stores `auth = 'oauth'` and no key
```

The Google path is the same three calls with `{ type: 'google' }` behind them,
and one extra branch: a signed-in ADC that names no quota project.

```
providers.authStatus { type: 'google' }
  → gcloud auth application-default print-access-token --format=json
  → { state: 'signed-in', account?, project?, expiresAt }
  → no project? the panel shows a project-id field
type an id, click the button    → providers.setQuotaProject { project }
                                  → gcloud auth application-default
                                    set-quota-project <id>
                                  → the new status replaces the old one
```

and then, whenever such a provider is used:

```
createLanguageModel(resolved, modelId, { anthropicCli, googleCli })
  anthropic → createAnthropic({ apiKey: '', fetch: oauthFetch(anthropicOAuthHeaders(cli)) })
                per request: delete x-api-key
                             set Authorization: Bearer <token>
                             merge oauth-2025-04-20 into anthropic-beta
  google    → createGoogleGenerativeAI({ apiKey: '', fetch: oauthFetch(googleOAuthHeaders(cli)) })
                per request: delete x-goog-api-key
                             set Authorization: Bearer <token>
                             set x-goog-user-project: <quota project>
                             (no project → gcloud_no_project, and nothing is sent)
  → the token comes from that CLI's in-memory cache until 60 s before it expires
```

Starting the app, since S7.6:

```
app.whenReady()
  → createSafeStorageStore()            null when the platform has no key store
  → createFileKeySecretStore({ keyPath: userData/secrets.key, wrapper })
      first use only: 32 random bytes, written 0600, wrapped only if
      WITENA_SIGNED_BUILD is set (S7.3)
  → createAppContext({ secrets })       every provider key is written with it
  → migrateProviderSecrets(ctx, { legacy: safeStorage })
      per row, by the ciphertext's own prefix:
        fk1:      → skip
        plain:    → the insecure store reads it   → re-encrypt → update
        djEw/djEx → safeStorage reads it          → re-encrypt → update
                    …or throws → leave the row, remember the id
  → ctx.unreadableSecrets                providers.* report keyState: 'unreadable'
```

and when such a provider is used anyway:

```
resolveProvider(ctx, { id })
  → secrets.decrypt(cipher) throws
  → ctx.unreadableSecrets.add(id)
  → BackendError('key_unreadable')
  → the probe's result line, the model fetch and the chat turn all say the same
    thing, and the card and the editor explain it without probing at all
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
| `createLanguageModel(provider, modelId, options?)` | same | Throws `validation` for an empty model id, an `openai-compatible` provider with no base URL, or an `oauth` provider whose vendor CLI is not in `options` |
| `ModelOptions`, `createProviderFetch`, `oauthFetch`, `OAuthRequestHeaders`, `anthropicOAuthHeaders`, `googleOAuthHeaders`, `mergeBeta` | same | The injection point: the two CLIs and the outbound `fetch`, the one wrapper, and the two vendors' header edits as data |
| `AnthropicCli`, `createAnthropicCli`, `resolveAntBinary`, `antMissing`, `antNotLoggedIn` | `src/main/providers/anthropic-cli.ts` | The CLI seam. `createAnthropicCli` takes `spawn`, `env`, `fallbackDirs` and `now` so the tests drive the real implementation against a fake `ant` |
| `GoogleCli`, `createGoogleCli`, `resolveGcloudBinary`, `parseExpiry`, `gcloudMissing`, `gcloudNotLoggedIn`, `gcloudNoProject` | `src/main/providers/google-cli.ts` | The same seam for `gcloud`, with the same four options |
| `CliProcess`, `resolveCliBinary`, `runCliCommand`, `TOKEN_EXPIRY_MARGIN_MS` | `src/main/providers/cli-process.ts` | What the two wrappers share |
| `modelOptions(ctx)`, `providerFetch(ctx, provider)`, `authCli(ctx, type)` | `src/main/app-context.ts` | Those capabilities read off the context, so no caller spells out "…unless it signs in", and `authCli` is total over `OAuthProviderType` |
| `fetchModels(resolved, fetchImpl?)` | `src/main/providers/discovery.ts` | Rejects with `provider_error`; `details.status` carries the HTTP status |
| `testConnection(resolved, options?)` | same | **Never throws.** `options` carries `modelId`, `timeoutMs` and the two test seams (`createModel`, `generate`) |
| `resolveProvider(ctx, ref)` | `src/main/providers/resolve.ts` | The decryption seam. Since S7.6 a failed decrypt is `key_unreadable` rather than a raw throw, and the provider's id is remembered on the context |
| `migrateProviderSecrets(ctx, { legacy })`, `SecretMigrationResult` | `src/main/providers/migrate-secrets.ts` | **S7.6.** Idempotent, never throws for a row it cannot read, returns what it did |
| `createFileKeySecretStore`, `isFileKeySecret`, `isSafeStorageSecret`, `isLegacySecret`, `isSignedBuild`, `FILE_KEY_PREFIX`, `SECRETS_KEY_FILE` | `src/main/secrets.ts` | **S7.6.** The store and the prefix rules. Electron-free: `node:crypto` and `node:fs` |
| `createSafeStorageStore()` | `src/main/ipc/secret-store.ts` | **S7.6.** `safeStorage` or `null` — the legacy reader, and the wrapper on a signed build |
| `useProvidersStore` | `src/renderer/src/stores/providers.ts` | See [frontend.md](./frontend.md) |
| `errorMessage` / `translateError` | `src/renderer/src/i18n/errors.ts` | `BackendErrorCode` → a sentence, by literal `switch` |

Shared-contract changes made by S5.3:

- `ProviderAuth` (`'apiKey' | 'oauth'`) with `Provider.auth` / `ProviderInput.auth`
  optional, and the token-free status the renderer sees — named
  `AnthropicAuthStatus` then, `ProviderAuthStatus` since S5.13.
- `BackendErrorCode` gained `ant_missing` and `ant_not_logged_in`; they describe
  the state of a tool on the user's machine rather than a malformed request, and
  they are raised by the model layer as well as by a handler.
- `VALIDATION_REASONS` gained `oauth_unsupported_provider` and
  `oauth_custom_base_url`, reusing S5.2's reason channel rather than adding
  codes for two refusals of one form.
- `providers.authStatus`, `providers.login` and `providers.logout` were added to
  `BackendApi`, `BACKEND_METHODS` and `shared/contracts.test.ts`.

Shared-contract changes made by S5.13:

- `AnthropicAuthStatus` became `ProviderAuthStatus` (and `AnthropicAuthState`
  `ProviderAuthState`), with `accountEmail` renamed `account` and `project`
  added. One interface for both vendors rather than one each: every consumer
  treats it as "the machine's login state plus a few labels", and which labels
  are filled is a fact about the vendor, not about the shape.
- `OAUTH_PROVIDER_TYPES` gained `google`, so `supportsOAuth` — which is also a
  type guard now — answers true for it, `providerRequiresApiKey` answers false,
  and the editor's Authentication control is live. **No migration**: the `auth`
  column already existed and its meaning did not change.
- The three auth methods take `{ type: OAuthProviderType }` instead of nothing,
  and `providers.setQuotaProject` was added beside them. The three are
  `{ type }`-shaped because they ask the same question of a different machine
  fact; the fourth is not, because a quota project is a Google concept with no
  Anthropic counterpart, and a method meaningless for half its own argument's
  values is worse than one named after what it does.
- `BackendErrorCode` gained `gcloud_missing`, `gcloud_not_logged_in` and
  `gcloud_no_project`, all on the "state of a tool on the machine" side of the
  code-versus-reason line — the third most clearly of all, since the fetch
  wrapper raises it mid-request, which is nobody's form.

Shared-contract changes made by S7.6:

- `BackendErrorCode` gained `key_unreadable`, on the "state of something on this
  machine" side of the code-versus-reason line, beside `ant_missing` and the
  `gcloud_*` three: it is raised while building a model for a chat turn as much
  as while validating a form.
- `Provider` gained an **optional, runtime** `keyState: ProviderKeyState`
  (`'ok' | 'unreadable' | 'none'`), filled by the `providers.*` handlers from
  `AppContext.unreadableSecrets`. Optional because a `Provider` built anywhere
  else — a repository row, `resolve.ts`'s draft — has not been asked, and absent
  must read as "not determined" rather than as "fine".
- `AppContext` gained `unreadableSecrets: Set<string>`, on the context for the
  same reason the runners and the supervisor are: two contexts must never share
  one. **No column, no migration**: see `docs/features/database/context.md`.

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
| `src/shared/presets.test.ts` | Unique ids; every OpenAI-compatible preset except `custom` has a base URL; local presets require no key, ship no models and point at localhost; hosted presets are https and seeded; `getPreset` / `isLocalPreset` edge cases. S5.3, S5.13: `providerAuth`'s default, the two types `supportsOAuth` answers true for, `isOAuthProviderType` against an unknown value, and both install commands including which `cliInstallCommand` picks |
| `src/main/providers/registry.test.ts` | A model is constructed for all four types and reports the right `provider` / `modelId`; the compatible name comes from the preset id and falls back to a slug; an empty model id and a base-URL-less compatible provider are rejected; a keyless local provider still builds. S5.3: `mergeBeta`'s three cases; `oauthFetch` deleting `x-api-key`, setting the bearer token, merging the beta flag, keeping every other header and asking for a token **per request**; an `oauth` model whose first real `doGenerate` is inspected for those headers; the refusal to build one with no CLI; and every other provider keeping the plain `fetch`. S5.13 adds the **Google header set** through the same wrapper — `x-goog-api-key` gone, the bearer token and `x-goog-user-project` set, no `anthropic-beta` anywhere near it — a Google `oauth` model whose `doGenerate` is inspected likewise, the refusal to build one with no `GoogleCli`, and the rule that a project-less credential makes **no request at all** |
| `src/main/providers/google-cli.test.ts` | **S5.13**, the same discipline against a **fake `gcloud`**: binary resolution (`PATH`, the fallback directories, `WITENA_GCLOUD_BIN`, nothing at all); `parseExpiry` reading the naive timestamp as UTC; `status` for all three states plus signed-in-with-no-project; the `config list` fallback for an ADC that carries no account or project, and the proof that it is **not** spawned when the ADC does carry them; the status carrying no credential and only three keys; that every read asks for `--format=json`; the cache expiring 60 s early, the 55-minute assumption when no expiry was printed, and the cache being dropped on logout and on `set-quota-project`; `gcloud_no_project` from `project()`; `gcloud_not_logged_in` on a non-zero exit; `internal` on output that is not JSON; a failing command quoting `stderr` and **never** `stdout`; login, a cancelled login, a forgiving revoke, and a refused project id |
| `src/main/providers/anthropic-cli.test.ts` | The real implementation against a **fake `ant`** — an executable script first on the given `PATH`. Binary resolution (`PATH`, the fallback directories, `WITENA_ANT_BIN`, nothing at all); `status` for all three states; the status carrying no token and exactly five fields; that `print-credentials` is what is called; the token cache expiring 60 s early, not caching a credential with no expiry, and being dropped on logout; `ant_not_logged_in` on a non-zero exit; `internal` on output that is not JSON; a failing command quoting `stderr` and **never** `stdout`; login, a cancelled login, and logout being forgiving of "nothing to log out of" but not of a missing binary |
| `src/main/providers/discovery.test.ts` | `fetchModels` for all four families with a fake `fetch` (URL, headers, id extraction, sorting, `/v1` not doubled); HTTP 401 and 404 → `provider_error` with the status; a 10 s timeout; an unreachable host. `testConnection` through the **real** `generateText` with `MockLanguageModelV4`, plus the failure, timeout, no-model and "keep the deliberate error code" paths |
| `src/main/handlers/handlers.test.ts` | The `providers.*` block against the temp database: create stores ciphertext and reports only `hasApiKey`; the five validation refusals; a local preset saves with no key; an absent `apiKey` keeps the stored one and `''` clears it; delete; user scoping; `fetchModels` for a draft *and* for a saved row (proving decryption) with an injected `fetchImpl`. S5.3: an `oauth` provider saves with no key at all; the two reasoned refusals; an unknown mode; Save refused with `ant_missing` / `ant_not_logged_in`; the **merged** check on update (a patch of `{ auth: 'oauth' }` refused on an OpenAI row, accepted on an Anthropic one); `fetchModels` sending a bearer token, no `x-api-key` and the beta flag; and the three auth methods answering straight from the CLI. S5.13: the same three routed to the CLI the `{ type }` names, a sign-in type with no flow refused by reason, a Google provider saving with no key, Save refused with the **Google** codes, a signed-in Google provider with no quota project saving anyway, `setQuotaProject` passing the id through and refusing an empty one, and `fetchModels` for Google carrying the bearer token and the project header with **no `key=` in the URL** |
| `src/main/secrets.test.ts` | **S7.6**: the round trip and its `fk1:` marker; non-ASCII, empty and 8 KB values; a fresh IV per value; a second instance reading what the first wrote from the same key file; the file created on **first use** rather than at construction, with mode `0600`; a flipped bit and a truncated value refused with `key_unreadable`; a value written under another key file refused; a `v10…` or `plain:` value refused as "not mine"; the key file stored plain when the build is unsigned and wrapped when it is signed, through a fake `safeStorage`; a wrapped file the current wrapper cannot unwrap (and one with no wrapper at all) reported rather than guessed at; a file that is not a key file refused; and `WITENA_SIGNED_BUILD` making that decision when the caller does not |
| `src/main/providers/migrate-secrets.test.ts` | **S7.6**, against the real temporary database with the file-key store on the context: a `safeStorage` row re-encrypted and still decrypting to the same plaintext; a `plain:` row migrated with no key store at all; a row written by **another identity** left byte-for-byte untouched and its id reported; the same when there is no key store; `fk1:` and keyless rows skipped without a write; a second pass doing nothing; and one pass that migrates what it can while reporting what it cannot |
| `src/main/providers/resolve.test.ts` | **S7.6**: the decrypted key on the resolved provider; a key this build cannot read surfacing `key_unreadable` **and** marking the provider; the mark cleared by a successful decrypt; and a keyless provider marking nothing |
| `src/renderer/src/stores/providers.test.ts` | Load, the draft lifecycle (preset application, the name the user typed surviving it, models add/remove/dedupe), save-create vs save-update, failures becoming state, remove, and both probes including the draft/record result key. S5.3: `loadAuthStatus` / `signIn` / `signOut` keeping the latest status and never leaving `authBusy` on, a refused sign-in being recorded and followed by a re-read, and the draft carrying `auth` both ways. S5.13: each of those taking a vendor and filing the answer under it, the two vendors' logins staying apart, and `setQuotaProject` storing the status that came back or recording a refusal without rejecting. S7.6: a rejected probe keeping its failure class instead of flattening to `internal`, and `keyState` mirrored from the backend and cleared by saving a pasted key |
| `src/renderer/src/i18n/errors.test.ts` | Every `BackendErrorCode` maps to distinct, real copy, and `translateError` never prints the developer message |
| `src/renderer/src/components/settings/provider-logo.test.ts` | The initials rules and the stability of the derived colour |
| `src/renderer/src/components/settings/provider-display.test.ts` | Host derivation including the unparseable case; the status rule, especially "a local provider is never `no-key`" and "untested is not connected". S5.3: `signed-in` replacing the key indicator and a probe outranking it; `authControl`'s three outcomes, which is how the editor's mode switch is tested without a DOM; `signedInName`'s fallbacks and `formatExpiry`. S5.13 moves Google from the disabled outcome to the live one and adds the project as `signedInName`'s last fallback. S7.6 adds `keyUnreadable`, including the rule that an **absent** `keyState` renders nothing — a draft has not been asked |
| `src/renderer/src/components/ui/status-pill.test.ts` | The tone → token mapping, and that the classes are literal rather than interpolated |
| `e2e/onboarding.spec.ts` | S7.5: the same three controls driven from the **chat page** — the Ollama tile, the local preset satisfying the credential step on its own, the model typed into `provider-add-model-input`, and the card's Save producing a stored provider |
| `e2e/providers.spec.ts` | The Ollama flow against a real local server (skipped assertions are annotated when it is not running), survival across a restart, the write-only key contract, clearing a key, and the `providers.png` screenshot. S5.3 adds a case that relaunches the app with `WITENA_ANT_BIN` pointing at nothing: the panel reports `not-installed`, the key field is gone, the install command is printed verbatim, Save is refused with a translated `ant_missing` and stores nothing, and switching back to the key field restores the form. S5.13 sets `WITENA_GCLOUD_BIN` on the same relaunch and adds the Google case on it: the Authentication control is **live** rather than disabled, the panel it opens is `data-auth-type="google"`, the install command is the cask one, no project field is offered to a signed-out panel, and Save is refused with `gcloud_missing` — the Google code, which is what a single shared status would have got wrong. **S7.6** adds the two key-survival cases: a provider saved *with* a key against Ollama's endpoint through the `custom` preset, relaunched on the same `userData`, still holding its key and still probing green; and a row seeded by hand with the `sqlite3` CLI as base64 of `v10…` while the app is closed, which comes back explained on the card and in the editor with the key field focused, and goes quiet the moment a new key is saved |

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
- **The first-run card and the settings editor share one draft.** Filling half
  the card, then opening Settings → Providers and pressing "Add provider",
  discards what the card held — `startCreate` replaces the draft, exactly as it
  does between two cards. It is the same silent discard as the row below and has
  the same answer, whenever that answer is built.
- **The editor has no dirty-state guard.** Selecting another card discards an
  unsaved draft silently. A confirm prompt needs the dialog layer this step
  deliberately did not build.
- **The sign-in click is never driven by a test.** It opens a real browser and
  needs an account, so `providers.login` is exercised only against the fake `ant`
  / fake `gcloud` in the unit suite and by hand.
- **A generation through an `oauth` Anthropic provider is unverified end to
  end.** The headers reach the real API and the model list comes back; the
  account used for verification has no API credit, so `generateText` is refused
  for billing rather than for authentication. See `context.md`.
- **The Google path is unverified against the real API, and may need a scope
  S5.13 did not ask for.** `GoogleCli` itself was driven against the installed
  `gcloud` 553.0.0 and works; the endpoint answers 403
  `ACCESS_TOKEN_SCOPE_INSUFFICIENT` to a default ADC token. See `context.md` and
  the Phase 6 backlog.
- **`e2e/providers.spec.ts` leaves the app in Chinese**, like `ui-shell.spec.ts`,
  because both take screenshots meant to be compared with the artboards.
- **S7.6's e2e proves a relaunch, not a reinstall.** A genuine reinstall needs
  two differently packaged unsigned dmgs and a Gatekeeper prompt, which no
  automated spec on this machine can produce. What it does instead is prove both
  halves separately: a key written by one launch is read by the next from the
  same `userData` (which is what the key file buys), and a row holding real
  `safeStorage`-shaped ciphertext that nothing can decrypt is left untouched and
  explained. The reinstall itself is checked by hand, once, when a dmg is built.
- **Nothing re-wraps an existing key file when the build becomes signed**, and
  the key is never rotated. See `context.md` and the Phase 6 backlog.
