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
  (`getPreset`, `isLocalPreset`, `providerRequiresApiKey`).
- `src/main/providers/`: `registry.ts` (record → AI SDK `LanguageModel`),
  `discovery.ts` (`/models` and the connection probe), `resolve.ts`
  (`ProviderRef` → record with a decrypted key).
- `src/main/handlers/providers.ts`: the seven `providers.*` methods and all input
  validation.
- Settings → Providers: the 520px card list and the add/edit panel, plus the
  three primitives it needed (`Chip`, `Spinner`, `StatusPill`).
- `src/renderer/src/stores/providers.ts`: the list, the editor draft and both
  probes.
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
| [`../backend-client/context.md`](../backend-client/context.md) | `ProviderRef`, the seven declared methods, `BackendError`, and the handler/transport split |
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

## Open questions

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
- **No provider is validated against its own model list.** A user can type a
  model id that does not exist and only find out when they press Test (or, from
  S1.7, when an agent speaks). Validating on save would need a network call on a
  screen that must work offline.
