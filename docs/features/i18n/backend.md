# i18n — Backend

The main process holds **no copy and no translation machinery**. Its whole share
of this feature is storing one string and, where it must say something to the
user, saying it as a key. S1.4 changed no main-process file: `settings.update`
already accepted `'zh-CN' | 'en' | 'system'`, and `SystemNoticePart` was defined
in S1.1.

## Modules

| File | Responsibility |
|---|---|
| `src/main/handlers/settings.ts` | `settings.get` / `settings.update`; validates that the patch has only the documented keys |
| `src/main/db/repositories/settings.ts` | Reads merge over `DEFAULT_APP_SETTINGS`, writes shallow-merge — so a settings row written before a field existed still answers with that field's default |
| `src/shared/types.ts` | `Language`, `AppSettings.language`, `DEFAULT_APP_SETTINGS` (`language: 'system'`), `SystemNoticePart` |

## Database

| Table | Column | Type | Notes |
|---|---|---|---|
| `settings` | `userId` | text, primary key | `local` in the desktop build |
| `settings` | `data` | json (`AppSettings`) | `data.language` is `'zh-CN' \| 'en' \| 'system'` |
| `settings` | `updatedAt` | integer (epoch ms) | |

Migrations: `0000_outstanding_medusa.sql` created the table in S1.2; S1.4 added
no migration. A fresh install has no row at all, and the repository answers with
`DEFAULT_APP_SETTINGS`, whose language is `'system'` — which is exactly what
"follows the system language on first launch" means in storage terms.

**`'system'` is stored as itself, never resolved before writing.** The main
process must not resolve it: it does not know the renderer's locale, and a
machine whose language changes should keep following it.

## IPC handlers

| Channel | Input | Output | Errors |
|---|---|---|---|
| `settings.get` | — | `AppSettings` | None; an absent row is the defaults |
| `settings.update` | `{ patch: { language } }` | `AppSettings` | `validation` when `patch` is not an object or carries a key other than `language` / `theme` / `editor` / `timeouts` / `onboardingDismissed` |

The handler does **not** validate the language value itself. The renderer only
ever sends one of the three, the type system enforces it on both sides, and an
unknown value would be corrected on read by `resolveLanguage`'s fallback rather
than corrupt anything. Add a runtime check here if a non-TypeScript client ever
appears.

S7.5 added the fifth key, `onboardingDismissed` — the first-run card's Skip flag
([`../chats/backend.md`](../chats/backend.md)). It is validated like `theme` and
`editor` rather than trusted like the language: it is read back as a boolean by
code with no other branch, and a stored `'no'` is truthy, which would hide the
first-run card on a machine where nothing is set up. No migration was needed —
reads merge the stored object over `DEFAULT_APP_SETTINGS`, so a row written
before it existed answers `false`.

S7.4 added no settings key at all, which is worth one line because it looks as
though it should have. Whether the app may update itself is a fact about the
*bundle* — signed or not, packaged or not — read fresh at every launch by
`src/main/index.ts`, not a preference; and the notice bar's "Not now" is a fact
about this window (see [`../ui-shell/context.md`](../ui-shell/context.md)). The
one piece of backend-authored text S7.4 produces is the updater's own error
message, and it travels as **data** inside a resolved `UpdateStatus` rather than
as a `SystemNoticePart` key: it is not a sentence the product wrote.

S5.8 made `theme` the exception: `assertPatch` checks it against
`THEME_SETTINGS` and refuses anything else with `validation`. The asymmetry is
deliberate and is about the *consequence*, not the source — an unknown language
falls back to English, which is visible and recoverable, while an unknown theme
resolves to light and leaves the user looking at an appearance no control in
the app accounts for.

## Events emitted

None. A settings change has one origin — the single window that made it — so
there is nothing to broadcast. A second window or the server version would need a
`settings.updated` event on the bus; the renderer store is written so that
applying such an event is a one-line addition.

## Filesystem

Nothing outside the database.

## User-visible text produced by the main process

The rule, which every later backend feature has to follow:

> The main process never produces a sentence for the user. It emits a
> `SystemNoticePart` — `{ type: 'system-notice', key, params? }` — whose `key` is
> a name under `notices.*` in the locale files.

Two reasons, both load-bearing:

1. **The backend does not know the UI language.** It would have to be told on
   every call, and would then need its own copy of both locale files.
2. **Messages are stored forever; the language is not.** A sentence persisted in
   `messages.parts` would still be Chinese after the user switched to English.
   A key is re-rendered in whatever language is active when it is read.

Keys reserved for the features that will emit them:

| Key | Params | Emitted by |
|---|---|---|
| `notices.agentSkipped` | `agent` | `presence` (S2.4), after the hard timeout aborts a turn |
| `notices.runStopped` | — | `orchestration` (S2.3), when the Stop button cancels a chain |
| `notices.maxRoundsReached` | `max` | `orchestration` (S2.3), when the automatic round cap is hit |
| `notices.providerError` | `message` | `agent-turn` (S1.7) / `providers` (S1.6) |
| `notices.materialsTruncated` | `agent`, `omitted` | `orchestration` (S5.11), once per chat when a member could not fit the goal's materials. The only notice deduped against the **transcript** rather than against a per-run set, which is what makes "once per chat" survive a relaunch |
| `notices.handoff` | `agent` | `orchestration` (S5.6), on the **user** message "Hand to executor" stores. The only notice that is a request rather than a report, and the only one carried by a message the user is the sender of |
| `notices.handoffDeliver` | `agent`, `path` | `orchestration` (S5.12), the same for the "Write the deliverable" action. A key of its own rather than a parameter on `handoff`, because the sentence the user reads is a different sentence; `path` is the goal's **relative** path, never the absolute one |
| `notices.consensus` | — | `orchestration` (S5.14), when every participant of a round wrote `[AGREED]`. Deliberately **parameterless**: it is stored before the closing speaker is picked, and every member being offline would leave it naming an agent that never wrote anything |
| `notices.voteClosed` | — | `orchestration` (S5.14), when a chain that carried its own `rounds` cap has run them. A key of its own rather than `maxRoundsReached` with a different `max`: that sentence says "this chat hit its automatic limit, send a message to continue", and this run ended exactly where the user asked it to |

The same principle covers failures: `BackendError.code` is the machine-readable
class the renderer maps to an `errors.<code>` key, and `BackendError.message` is
developer detail for logs that is never rendered.

S5.2 added a narrower identifier for the same reason. The codes are a
failure *taxonomy*, and "the request was rejected as invalid" is the right
sentence almost everywhere because the control that sent the request is on
screen saying what it wanted — but not when the user picked a folder that is not
a folder, or added a member the chat cannot hold. Those refusals carry a
`ValidationReason` (`src/shared/types.ts`) in `BackendError.details`, which the
renderer maps to an `errors.<reason>` key exactly as it maps a code. It is still
an identifier, never a sentence: the backend does not know the UI language.

S5.3 used the *other* half of the same choice, and the line between them is worth
keeping: a `ValidationReason` narrows the refusal of one request and is only read
when the code is `validation`, so the two `oauth_*` refusals of the provider form
are reasons — while "the Anthropic CLI is not installed" is also raised while
building a model for a chat turn, which is nobody's form, so `ant_missing` and
`ant_not_logged_in` are codes — and so are S5.13's `gcloud_missing`,
`gcloud_not_logged_in` and `gcloud_no_project`, the last of them most clearly of
all: it is raised by the OAuth `fetch` wrapper in the middle of a request, where
there is no request-shaped refusal to narrow. S7.6's `key_unreadable` is on the
same side: a stored key encrypted by a previous installation is a fact about this
machine's data, and it is raised while resolving a provider for a chat turn as
much as while probing one from a form. The same rule applies to the next one: if only the
sender of this request can be wrong, it is a reason; if the *machine* is in that
state, it is a code.

One more thing the backend deliberately does not send: a **formatted date**. The
sign-in panel's "valid until" line is built in the renderer from the epoch
milliseconds in `ProviderAuthStatus`, for the same reason as everything above —
the main process does not know the active language.

## Prompts are not UI copy — and are still bilingual (S1.7)

One piece of backend text is *not* a `system-notice`: the **group briefing**
injected into every agent's system prompt (member list, the `[name]:` prefix
convention, how to `@mention`, when to reply `[PASS]`). It goes to a model, not
to a screen, so it cannot be a key the renderer resolves.

The plan for S1.7, recorded here so it is not rediscovered:

- The briefing exists in Chinese and English as two templates under
  `src/main/agents/` — main-process assets, **not** entries in the renderer's
  locale files, which stay purely UI copy.
- Which one is used follows the resolved UI language. The main process reads
  `settings.language` and resolves it the same way `resolveLanguage` does; a
  stored `'system'` therefore needs the renderer's locale, so `AgentTurn` will
  receive the resolved language as a parameter rather than reading the setting
  itself.
- Rationale: English-first models follow an English briefing more reliably, and a
  Chinese-speaking user wants replies in Chinese. The briefing language is the
  cheapest lever on both.
- The agent's own `systemPrompt` is user data and is never translated.
- Since **S5.10** the same line runs through the chat's **goal**: the briefing's
  sentences about it are written in both `briefing.en.ts` and `briefing.zh-CN.ts`
  and follow the same setting, while the user's own `description` and the
  deliverable's path are **data** and are placed verbatim in whichever language
  the briefing is being written in. The `Goal` block's *labels* are ordinary
  locale keys under `chat.*`, and its nine refusals are `errors.<reason>` keys
  like every other `ValidationReason`.

## External dependencies

| Dependency | Used for | Pitfalls |
|---|---|---|
| — | The main process has no i18n dependency, and must not gain one | Pulling `i18next` into `src/main` would mean two copies of the copy and text frozen at write time. If you find yourself wanting it, you want a `system-notice` instead |
