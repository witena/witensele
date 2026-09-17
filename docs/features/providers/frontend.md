# providers — Frontend

## Pages and components

| File | Responsibility |
|---|---|
| `src/renderer/src/pages/settings/providers-section.tsx` | The section: a 520px card list (with the header that carries `settings-section-title`) and the editor column beside it |
| `src/renderer/src/pages/settings-page.tsx` | Renders `ProvidersSection` **in place of** the generic content pane, because this section owns both of its columns |
| `src/renderer/src/components/settings/provider-card.tsx` | One card: monogram, name, endpoint, status pill, model chips — and, since S7.6, one line when the stored key cannot be decrypted. A `<button>`, because it is the selection control |
| `src/renderer/src/components/settings/provider-editor.tsx` | The add / edit form's layout and its Test / Save / Delete row. Since S7.5 the preset grid, the credential block and the model block are the three components below, not inline JSX |
| `src/renderer/src/components/settings/provider-credential.tsx` | **S7.5**, extracted from the editor: the Authentication control (S5.3) and, under it, either the write-only key field or the sign-in panel. Takes no props — it reads and writes the one draft in the store — so the first-run card renders *this component*, not a copy. **S7.6** added the unreadable-key notice above the field and the focus that goes with it |
| `src/renderer/src/components/settings/provider-models.tsx` | **S7.5**, extracted likewise: "Fetch models", the chips and the inline "add a model" field, with the documented rule that a fetch *replaces* what the form held |
| `src/renderer/src/components/settings/provider-sign-in.tsx` | **S5.3**, generalised in **S5.13** (it was `anthropic-sign-in.tsx`). The sign-in panel for whichever vendor its `type` prop names: the three states, that vendor's install command, the Sign in / Sign out buttons, and — for a Google login with no quota project — the project field |
| `src/renderer/src/components/settings/preset-grid.tsx` | The three-column preset picker, rendered straight from `PROVIDER_PRESETS` |
| `src/renderer/src/components/settings/provider-logo.ts` | Monogram initials and the colour derived from the preset id |
| `src/renderer/src/components/settings/provider-display.ts` | `providerHost`, `providerStatus`, `providerStatusTone`, (S5.3) `authControl`, `signedInName`, `formatExpiry` and (S7.6) `keyUnreadable` — the editor's decisions as pure functions, because the suite has no DOM |
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
| `mode` | `'idle' \| 'create' \| 'edit'` | `idle` renders the placeholder, the others render the form. It is the **settings editor's** state: the first-run card edits the same draft without touching it |
| `draft` | `ProviderInput \| null` | The editor's working copy. **Never carries a loaded key** — see below |
| `testResults` | `Record<string, ConnectionTestResult>` | Keyed by provider id, plus `'draft'` for an unsaved one. Runtime only, never persisted. A probe that was *rejected* rather than answered — S7.6's `key_unreadable`, or a transport failure — is stored in the same shape with its own code, so the line under the button never flattens to "something went wrong inside the app" |
| `testing` / `fetchingModels` / `saving` | `boolean` | Drive the three spinners |
| `authStatus` | `Record<OAuthProviderType, ProviderAuthStatus \| null>` | What each vendor CLI reports; `null` for one until its panel asks. One status **per vendor**, not one per provider — it is a fact about the machine, and two Anthropic providers share the one `ant` profile — but `ant` and `gcloud` are independent facts, which is why S5.13 made it a record |
| `authBusy` / `authErrorCode` | `boolean` / `BackendErrorCode?` | The sign-in spinner, and the class of the last attempt that was refused. One flag, not one per vendor: exactly one panel is on screen at a time, because it belongs to the one draft the editor holds |

Actions: `load`, `create`, `update`, `remove`, `fetchModels(ref)`,
`testConnection(ref, modelId?)`, plus the editor set `startCreate`,
`ensureDraft` (S7.5), `startEdit`, `closeEditor`, `patchDraft`, `applyPreset`,
`addModel`, `removeModel`, `saveDraft`, and the S5.3 set `loadAuthStatus(type)`,
`signIn(type)`, `signOut(type)` plus S5.13's `setQuotaProject(project)` — none of
which rejects: a sign-in that failed is a line in the panel, not a thrown error.

**Why `ensureDraft` exists beside `startCreate` (S7.5).** The first-run card on
the chat page edits this same draft, but `startCreate` also sets `mode`, and a
user who then opened Settings → Providers would find the Add form open on a
screen they had never visited — which `e2e/providers.spec.ts` noticed
immediately. `ensureDraft` creates the draft when there is none and leaves
`mode` alone, so "is the settings editor open" stays the settings editor's own
answer.

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
whether the inline input is open (now inside `ProviderModels`), the delete latch,
and which model the probe should target (empty means "the first one", which is
the backend's own default).

## Backend calls

| Call | From | Purpose |
|---|---|---|
| `providers.list` | `ProvidersSection` on mount | Fill the card list. Not loaded at startup: nothing needs providers until this section (or, from S2.1, the agent form) is open |
| `providers.create` / `providers.update` | `saveDraft` | The only writes |
| `providers.delete` | the delete latch's second click | |
| `providers.fetchModels` | the "Fetch from /models" link | Replaces `draft.models` with the endpoint's answer |
| `providers.testConnection` | the "Test connection" button | Always with `{ draft }`, so a key typed a second ago is what gets tested |
| `providers.authStatus` | `ProviderSignIn` on mount, once per vendor | Only when the panel is actually shown: a user who never opens sign-in mode never spawns a process |
| `providers.login` / `providers.logout` | the panel's two buttons | The CLI opens the browser itself; the call resolves when it exits |
| `providers.setQuotaProject` | the Google panel's project field | **S5.13**, and only while a Google login names no project |

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
| signed in | Who (account email, falling back to workspace, then organisation, then the Google project), the second line — organisation and workspace for Anthropic, the quota project for Google — when the credential expires, and a Sign out button |
| signed out | One sentence saying Witena signs in through that vendor's CLI and keeps no token (Google's adds what the account needs: a project with the Generative Language API enabled and billing attached), and a Sign in button |
| CLI not installed | The same shape plus **that vendor's** install command in monospace. The Sign in button stays clickable on purpose: it doubles as "look again" for a user who installs the CLI in another window |
| signed in to Google with no project | A warning line and a project-id field with its own button, which calls `providers.setQuotaProject`. It is not an error state — the login worked — but the Gemini API refuses an end-user credential that names no project, so the fix is offered where the gap is noticed (S5.13) |
| sign-in refused | A red line under the panel with the translated `ant_*` / `gcloud_*` sentence; Save then refuses too, and the editor's error line carries `data-error-code` |
| key unreadable (S7.6) | One warning-toned line on the card (`provider-card-key-unreadable`) and another above the key field in the editor (`provider-key-unreadable`), both saying the key was saved by a previous version and has to be pasted again. The field takes the focus when such a provider is opened, and the "a key is stored" hint is **replaced** rather than shown beside it — it would be true and reassuring, which is exactly wrong. Saving a new key clears all of it, because the backend drops the id the moment a patch touches `apiKey` |
| first run (S7.5) | The same three controls, on the chat page instead. `PresetGrid`, `ProviderCredential` and `ProviderModels` are rendered by `components/onboarding/onboarding-card.tsx` one step at a time, against the same draft, and the card's own Save calls `saveDraft`. Only one of the two screens is ever mounted — the shell renders a single page at a time — so every `data-testid` here stays unique |

The unreadable-key notice is deliberately **not** a sixth status: the pill
answers "can this provider be used", and a provider whose key cannot be read is
in exactly the state the four existing answers describe — it has a key
(`hasApiKey` is true, so not `no-key`) and nobody has probed it (`untested`).
What the user needs is a sentence saying what to do, which a coloured dot cannot
be.

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

S7.6 added two keys: `settings.providers.keyUnreadable`, the sentence on the
card and in the editor, and `errors.key_unreadable`, the failure class a probe or
a model fetch reports. Two rather than one because they are said in different
places for different reasons — the first is advice on a screen where the fix is
one field away, the second is the translation of a `BackendErrorCode` that can
reach the user from the middle of a chat turn.

**S7.3 added none, deliberately.** Signing decides whether the Keychain wraps
`secrets.key`, and the key file being wrapped or plain changes nothing the user
can see: the same providers, the same keys, the same "a key is stored" hint. The
re-wrap on the first signed launch is silent for the same reason it is safe to do
unasked — it rewrites the container, not the contents, so there is no outcome to
report. A string for it would be a notice about a storage format, which is not a
thing a user should have to hold an opinion about. The one case that *is* worth
saying — a key this build cannot decrypt — already has its line, above, and is
reached the same way whatever wrapped the file.

S5.13 split `authSignIn` into `authSignInAnthropic` / `authSignInGoogle` — the
user is about to hand an account to a named company and the control should say
which — and added `gcloudMissing`, `signedOutGoogle` and the five
`quotaProject*` keys, plus `errors.gcloud_missing`,
`errors.gcloud_not_logged_in` and `errors.gcloud_no_project`. The vendor branch
is a ternary over **two literal `t()` calls**, never `t(KEYS[type])`, because
`used-keys.test.ts` reads literals and a computed key would ship a typo.
`GCLOUD_INSTALL_COMMAND` follows the same data-not-copy rule as its Anthropic
counterpart, selected by `cliInstallCommand(type)`.

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
