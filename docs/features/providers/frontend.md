# providers — Frontend

## Pages and components

| File | Responsibility |
|---|---|
| `src/renderer/src/pages/settings/providers-section.tsx` | The section: a 520px card list (with the header that carries `settings-section-title`) and the editor column beside it |
| `src/renderer/src/pages/settings-page.tsx` | Renders `ProvidersSection` **in place of** the generic content pane, because this section owns both of its columns |
| `src/renderer/src/components/settings/provider-card.tsx` | One card: monogram, name, endpoint, status pill, model chips. A `<button>`, because it is the selection control |
| `src/renderer/src/components/settings/provider-editor.tsx` | The add / edit form, including (S5.3) the Authentication control and the panel that replaces the key field |
| `src/renderer/src/components/settings/anthropic-sign-in.tsx` | **S5.3.** The sign-in panel: the three states, the install command, the Sign in / Sign out buttons |
| `src/renderer/src/components/settings/preset-grid.tsx` | The three-column preset picker, rendered straight from `PROVIDER_PRESETS` |
| `src/renderer/src/components/settings/provider-logo.ts` | Monogram initials and the colour derived from the preset id |
| `src/renderer/src/components/settings/provider-display.ts` | `providerHost`, `providerStatus`, `providerStatusTone`, and (S5.3) `authControl`, `signedInName`, `formatExpiry` — the editor's decisions as pure functions, because the suite has no DOM |
| `src/renderer/src/components/ui/chip.tsx` | New primitive: an item in an editable set, optionally removable or clickable |
| `src/renderer/src/components/ui/spinner.tsx` | New primitive: the indeterminate ring |
| `src/renderer/src/components/ui/status-pill.tsx` | New primitive: dot + label in three tones, with the exported tone → token mapping |
| `src/renderer/src/components/ui/input.tsx` | Gained a `ref` prop so the inline "add a model" field can focus itself |
| `src/renderer/src/i18n/errors.ts` | `BackendErrorCode` → a sentence, by literal `switch` |
| `src/renderer/src/index.css` | Six new tokens: `status-{ok,warn,idle}` and their `-surface` pairs |
| `src/renderer/src/stores/providers.ts` | The store below |

## State

| Field | Type | Meaning |
|---|---|---|
| `providers` | `Provider[]` | Backend-owned mirror of the table, oldest first |
| `status` | `'idle' \| 'loading' \| 'ready' \| 'error'` | Explicit, because "not loaded" and "load failed" need different UI |
| `error` / `errorCode` / `errorDetails` | `string?` / `BackendErrorCode?` / `unknown` | Developer detail, its failure class, and the failing call's `details`. The UI shows `translateFailure(t, errorCode, errorDetails)` as the sentence and `error` as a dimmed mono line; `details` is what lets a refusal name the rule it broke (S5.2's `ValidationReason`) instead of saying "rejected as invalid" |
| `selectedId` | `string \| null` | The record the editor is bound to; `null` while creating |
| `mode` | `'idle' \| 'create' \| 'edit'` | `idle` renders the placeholder, the others render the form |
| `draft` | `ProviderInput \| null` | The editor's working copy. **Never carries a loaded key** — see below |
| `testResults` | `Record<string, ConnectionTestResult>` | Keyed by provider id, plus `'draft'` for an unsaved one. Runtime only, never persisted |
| `testing` / `fetchingModels` / `saving` | `boolean` | Drive the three spinners |
| `authStatus` | `AnthropicAuthStatus \| null` | What the `ant` CLI reports; `null` until the panel asks. One status for the app, not one per provider — it is a fact about the machine, and two Anthropic providers share the one login |
| `authBusy` / `authErrorCode` | `boolean` / `BackendErrorCode?` | The sign-in spinner, and the class of the last attempt that was refused |

Actions: `load`, `create`, `update`, `remove`, `fetchModels(ref)`,
`testConnection(ref, modelId?)`, plus the editor set `startCreate`, `startEdit`,
`closeEditor`, `patchDraft`, `applyPreset`, `addModel`, `removeModel`,
`saveDraft`, and the S5.3 set `loadAuthStatus`, `signIn`, `signOut` — none of
which rejects: a sign-in that failed is a line in the panel, not a thrown error.

**Why a draft.** A provider is not editable field by field: choosing a preset
rewrites three fields at once, a typed key must not be sent until Save, and the
model list has to be fetchable for an endpoint that has no row yet. `saveDraft` is
the only action that touches a record.

**Why the draft has no key.** `Provider` carries `hasApiKey`, never a value, so
`startEdit` leaves `draft.apiKey` **undefined** — which the update contract reads
as "keep the stored key". The field renders empty with a hint saying one is
stored; typing replaces it, and emptying a field that was typed into sends `''`,
which clears it.

Component-local state, deliberately not in the store: the half-typed model id and
whether the inline input is open, the delete latch, and which model the probe
should target (empty means "the first one", which is the backend's own default).

## Backend calls

| Call | From | Purpose |
|---|---|---|
| `providers.list` | `ProvidersSection` on mount | Fill the card list. Not loaded at startup: nothing needs providers until this section (or, from S2.1, the agent form) is open |
| `providers.create` / `providers.update` | `saveDraft` | The only writes |
| `providers.delete` | the delete latch's second click | |
| `providers.fetchModels` | the "Fetch from /models" link | Replaces `draft.models` with the endpoint's answer |
| `providers.testConnection` | the "Test connection" button | Always with `{ draft }`, so a key typed a second ago is what gets tested |
| `providers.authStatus` | `AnthropicSignIn` on mount, once | Only when the panel is actually shown: a user who never opens sign-in mode never spawns a process |
| `providers.login` / `providers.logout` | the panel's two buttons | The CLI opens the browser itself; the call resolves when it exits |

No subscription: this feature emits no events.

## Interaction states

| State | What the user sees |
|---|---|
| idle | Cards on the left with their status pill; the editor column shows "select or add a provider" |
| loading | The list is briefly empty; the empty state is suppressed while `status === 'loading'` so it cannot flash |
| fetching models | A spinner in the "Fetch from /models" link, which is disabled meanwhile (and whenever an `openai-compatible` draft has no base URL) |
| testing | A spinner in the Test button and its label switches to "Testing…"; the result replaces it as one line — latency and model on success, the translated error class plus the raw provider message on failure |
| saving | A spinner in Save; the button is also disabled while the name is empty |
| error | A failed save or fetch leaves the form open with a red line under it: translated sentence, then the developer detail in dimmed mono. A failed list shows the same under the cards |
| empty | An `EmptyState` with its own "Add provider" button (the header's copy keeps the `data-testid`, so the locator stays unique) |
| confirm delete | The Delete button relabels to "Click again to confirm" and disarms itself after 4 s |
| sign-in mode | The key field is **replaced** by the panel, not hidden beside it. `data-auth-state` on the panel is the state the e2e spec asserts on |
| signed in | Who (account email, falling back to workspace then organisation), the organisation and workspace as a dimmed mono line, when the credential expires, and a Sign out button |
| signed out | One sentence saying Witena signs in through the CLI and keeps no token, and a Sign in button |
| `ant` not installed | The same shape plus the install command in monospace. The Sign in button stays clickable on purpose: it doubles as "look again" for a user who installs the CLI in another window |
| sign-in refused | A red line under the panel with the translated `ant_missing` / `ant_not_logged_in` sentence; Save then refuses too, and the editor's error line carries `data-error-code` |

Card status is derived, never stored: `no-key` when a key is required and missing,
otherwise `connected` / `probe failed` from this session's probe, otherwise
`signed-in` for a provider that authenticates with an account (S5.3), otherwise
`untested`. A restored card is therefore `untested` rather than a stale green, and
a signed-in one wears a **neutral** badge — the record says it signs in, which is
not a claim that the login still works.

## Copy and i18n

S5.3 added thirteen keys under `settings.providers.*` (`auth`, `authApiKey`,
`authSignIn`, `authUnavailable`, `signedIn`, `signedInDetail`, `signedOut`,
`antMissing`, `signIn`, `signOut`, `signingIn`, `authExpires`, `statusSignedIn`)
and four under `errors.*` (`ant_missing`, `ant_not_logged_in`,
`oauth_unsupported_provider`, `oauth_custom_base_url`). Two conventions it had to
respect: the **install command is data, not copy** — `ANT_INSTALL_COMMAND` from
`@shared/presets`, rendered in a `<code>` exactly like a working directory path —
and the expiry is formatted **in the renderer** with the active language, because
the backend does not know which one that is.

All the S1.6 keys live under the same namespace (36 of them: `add`, `addTitle`,
`editTitle`, `editorIdleTitle`, the two empty states, the two placeholders for the
editor column, `preset`, `presetCustom`, `name`, `namePlaceholder`, `baseUrl`,
`baseUrlOptional`, `baseUrlPlaceholder`, `apiKey`, `apiKeyHint`,
`apiKeyPlaceholder`, `apiKeyNotNeeded`, `apiKeyStored`, `models`, `noModels`,
`moreModels`, `fetchModels`, `addModel`, `addModelPlaceholder`, `removeModel`,
`test`, `testing`, `probeModel`, `testOk`, `deleteConfirm` and the four
`status*`). `errors.*` was already complete and is now actually rendered, through
`i18n/errors.ts`.

Conventions this feature had to respect, and one it added:

- **Status labels and editor titles go through a `switch` of literal `t()` calls**
  (`statusLabel`, `editorTitle`), like `sectionLabel` in the shell: `t(KEYS[x])`
  is invisible to `used-keys.test.ts`, and the switch also makes the compiler
  prove the mapping is total.
- **Error codes get the same treatment**, which is what `i18n/errors.ts` is:
  `t('errors.' + code)` would have shipped unnoticed.
- **Brand names are not translated.** Preset names render as data. The one
  exception is `custom`, whose "name" is a UI concept, so `PresetGrid` takes its
  label as a prop.
- **`{{extra}}`, `{{latency}}`, `{{model}}`** are the new placeholders — never
  `count`, which i18next treats as the plural trigger.

## Accessibility and keyboard

- Cards are real buttons with `aria-current` on the selected one; preset tiles are
  buttons with `aria-pressed`.
- The Authentication control is a `SegmentedControl`: real buttons with
  `aria-pressed`, and `disabled` plus a hint sentence for the two provider types
  whose sign-in does not exist yet.
- Every input has a `<label>` through `Field` + `htmlFor`; the probe-model
  `<select>` has an `aria-label` because its meaning comes from the button beside
  it.
- The chip's remove control is a button with a translated `aria-label`, and it
  stops propagation so removing a model never also selects the chip.
- `Spinner` is `aria-hidden` unless given a label, because it always sits inside a
  control that already says what is happening.
- The API key field is `type="password"` with `autoComplete="off"`.
- The inline "add a model" input focuses itself, commits on Enter or blur and
  abandons on Escape.

## Layout notes

The section is the artboard's two columns: a 520px list with a 52px header
(title, count, accent "Add provider") and the editor filling the rest. Neither
gets `TRAFFIC_LIGHT_INSET` — the settings nav is the leftmost column, so the
macOS traffic lights are nowhere near these two.

Known differences from the artboard:

- The card subtitle is the host only; the artboard appends an "OpenAI-compatible"
  suffix to compatible providers. Dropped as noise once the monogram already distinguishes
  them.
- A fourth status (`untested`) exists that the artboard does not draw; see
  [context.md](./context.md).
- The editor has a result line and a probe-model select the artboard does not
  show, both of which the feature needs to be honest about what it did.
