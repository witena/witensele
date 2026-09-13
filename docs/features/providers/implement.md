# providers — Implementation

## Approach

Four layers, each of which knows less than the one above it.

**The preset table** (`src/shared/presets.ts`) is frozen data: id, brand name,
`ProviderType`, optional `baseUrl`, seed models, `requiresApiKey`, optional
`local`. It is shared because both sides consume it — the renderer renders the
picker from it, the main process asks it whether a key is mandatory — and it is
data rather than a method because it cannot change at runtime.

**The provider services** (`src/main/providers/`) are three small, electron-free
modules:

- `resolve.ts` turns a `ProviderRef` into a `ResolvedProvider` (the record plus a
  plaintext key). It is the only place a stored key is decrypted.
- `registry.ts` turns a `ResolvedProvider` plus a model id into an AI SDK
  `LanguageModel`. One `switch` over `ProviderType`, one factory each.
- `discovery.ts` answers the two network questions: `fetchModels` speaks the raw
  `/models` endpoints, `testConnection` runs `generateText` through the registry.

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
| `createLanguageModel(provider, modelId)` | same | Throws `validation` for an empty model id or an `openai-compatible` provider with no base URL |
| `fetchModels(resolved, fetchImpl?)` | `src/main/providers/discovery.ts` | Rejects with `provider_error`; `details.status` carries the HTTP status |
| `testConnection(resolved, options?)` | same | **Never throws.** `options` carries `modelId`, `timeoutMs` and the two test seams (`createModel`, `generate`) |
| `resolveProvider(ctx, ref)` | `src/main/providers/resolve.ts` | The decryption seam |
| `useProvidersStore` | `src/renderer/src/stores/providers.ts` | See [frontend.md](./frontend.md) |
| `errorMessage` / `translateError` | `src/renderer/src/i18n/errors.ts` | `BackendErrorCode` → a sentence, by literal `switch` |

Shared-contract changes made by this step:

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
| `src/main/providers/registry.test.ts` | A model is constructed for all four types and reports the right `provider` / `modelId`; the compatible name comes from the preset id and falls back to a slug; an empty model id and a base-URL-less compatible provider are rejected; a keyless local provider still builds |
| `src/main/providers/discovery.test.ts` | `fetchModels` for all four families with a fake `fetch` (URL, headers, id extraction, sorting, `/v1` not doubled); HTTP 401 and 404 → `provider_error` with the status; a 10 s timeout; an unreachable host. `testConnection` through the **real** `generateText` with `MockLanguageModelV4`, plus the failure, timeout, no-model and "keep the deliberate error code" paths |
| `src/main/handlers/handlers.test.ts` | The `providers.*` block against the temp database: create stores ciphertext and reports only `hasApiKey`; the five validation refusals; a local preset saves with no key; an absent `apiKey` keeps the stored one and `''` clears it; delete; user scoping; `fetchModels` for a draft *and* for a saved row (proving decryption) with an injected `fetchImpl` |
| `src/renderer/src/stores/providers.test.ts` | Load, the draft lifecycle (preset application, the name the user typed surviving it, models add/remove/dedupe), save-create vs save-update, failures becoming state, remove, and both probes including the draft/record result key |
| `src/renderer/src/i18n/errors.test.ts` | Every `BackendErrorCode` maps to distinct, real copy, and `translateError` never prints the developer message |
| `src/renderer/src/components/settings/provider-logo.test.ts` | The initials rules and the stability of the derived colour |
| `src/renderer/src/components/settings/provider-display.test.ts` | Host derivation including the unparseable case; the status rule, especially "a local provider is never `no-key`" and "untested is not connected" |
| `src/renderer/src/components/ui/status-pill.test.ts` | The tone → token mapping, and that the classes are literal rather than interpolated |
| `e2e/providers.spec.ts` | The Ollama flow against a real local server (skipped assertions are annotated when it is not running), survival across a restart, the write-only key contract, clearing a key, and the `providers.png` screenshot |

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
- **`e2e/providers.spec.ts` leaves the app in Chinese**, like `ui-shell.spec.ts`,
  because both take screenshots meant to be compared with the artboards.
