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
| `settings.update` | `{ patch: { language } }` | `AppSettings` | `validation` when `patch` is not an object or carries a key other than `language` / `theme` / `timeouts` |

The handler does **not** validate the language value itself. The renderer only
ever sends one of the three, the type system enforces it on both sides, and an
unknown value would be corrected on read by `resolveLanguage`'s fallback rather
than corrupt anything. Add a runtime check here if a non-TypeScript client ever
appears.

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

The same principle covers failures: `BackendError.code` is the machine-readable
class the renderer maps to an `errors.<code>` key, and `BackendError.message` is
developer detail for logs that is never rendered.

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

## External dependencies

| Dependency | Used for | Pitfalls |
|---|---|---|
| — | The main process has no i18n dependency, and must not gain one | Pulling `i18next` into `src/main` would mean two copies of the copy and text frozen at write time. If you find yourself wanting it, you want a `system-notice` instead |
