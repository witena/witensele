# i18n — Context

## Problem

Witena is used in Chinese and in English, often by the same person on the same
day. Every label, placeholder, empty state and backend notice must be available
in both languages, switch the moment the user picks a language, come back the
same way after a restart, and start out matching the machine's own language so a
first launch never looks wrong. Nothing about that may depend on a developer
remembering to translate a string after the fact.

## Scope

S1.4 delivers the whole mechanism, not just the two files:

- `i18next` + `react-i18next` with bundled `zh-CN` and `en` resources, one
  namespace, keys addressed as `t('chat.send')`.
- `resolveLanguage(setting, navigatorLanguage)` — the single place that turns the
  stored setting (`'zh-CN' | 'en' | 'system'`) into an actual UI language.
- The language setting persisted through `settings.update`, so it survives a
  restart, and applied through `i18n.changeLanguage` with no reload.
- `translateNotice` — the renderer half of the "the backend sends keys, not
  sentences" contract for `SystemNoticePart`, and `i18n/errors.ts` — the same
  contract for a rejected call, by `BackendErrorCode` and, since S5.2, by the
  finer `ValidationReason`.
- Two guard tests that keep the rule true as the UI grows: the key trees must
  match, and no hard-coded string may reach JSX.
- The full key tree for the screens S1.5–S2.5 will build, written ahead of the
  components so those steps add UI rather than vocabulary.

## Out of scope

| Not done here | Owner |
|---|---|
| The Settings → Appearance & language screen; S1.4 shipped a three-button switcher on the smoke screen, and S1.5 turned it into the settings-nav quick toggle plus the Appearance select | `ui-shell` (S1.5) `[x]` |
| The **appearance** half of that screen — the System / Light / Dark control, the two palettes and `lib/theme.ts`. It shares the section and copies this feature's `'system'` pattern exactly, but a theme is not a language and none of it goes through i18next | `ui-shell` (S5.8) `[x]` |
| The bilingual **group briefing** injected into the models' system prompt — a prompt, not UI copy, and it needs the prompt assembly that does not exist yet | `agent-turn` (S1.7) |
| `zh-TW` or any third language. `resolveLanguage` folds every `zh*` tag into `zh-CN` for now | A later step; the mechanism already supports adding a resource |
| Date, number and plural formatting beyond i18next's defaults | Whichever feature first needs it |
| Lazy-loaded namespaces. Both files are bundled; the whole UI is a few kilobytes of JSON | Not planned |
| The **licence list** in Settings → About (S7.5): 244 `name@version · licence` rows, generated at build time. Identifiers, not sentences, so they never enter the locale files — only the labels around them do | `ui-shell` (S7.5) `[x]` |
| An agent **template's name** (S7.5). It is stored in `agents.name`, `@mentions` resolve against it and every model sees it, so it is an English literal in `@shared/agent-templates`; its description is a runtime key here | `agents` (S7.5) `[x]` |

## Dependencies

- [`backend-client`](../backend-client/context.md) — the language is read and
  written with `settings.get` / `settings.update` through `BackendClient`, and
  `SystemNoticePart` (`key` + `params`) is the contract this feature translates.
- [`database`](../database/context.md) — the settings row is where the choice
  lives; `DEFAULT_APP_SETTINGS.language` is `'system'`.

Depending on i18n in return: every feature with a user interface. `ui-shell`,
`chats`, `agents`, `providers`, `mcp`, `skills`, `memory` and `presence` all add
their copy to the two locale files rather than to their components, and
`orchestration` / `presence` emit `system-notice` parts whose keys live under
`notices.*`.

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| Resources bundled and imported statically | i18next-http-backend, dynamic `import()` per language | `init` then completes synchronously, so the bootstrap can render an already-translated tree — no loading state, no flash of raw keys. Two small JSON files do not justify a loader. |
| One i18next namespace; the plan's "namespaces" are the top level of the key tree | A real namespace per area (`common`, `chat`, …) | A key is always `t('chat.send')` with no `useTranslation('chat')` bookkeeping. Namespaces buy lazy loading, which bundled resources make pointless. |
| Settings are loaded **before** the first render, in `main.tsx` | Render, then switch language in an effect | The alternative shows one frame in the wrong language on every launch. The cost is an async bootstrap, which is a few lines. |
| `'system'` is stored as itself and resolved at use time | Resolve once at first launch and store the concrete language | A machine whose language changes should follow it. Storing `zh-CN` would silently freeze a user who picked "follow the system". S5.8's theme setting copies this decision verbatim, down to the name of the value. |
| Every `zh*` navigator tag resolves to `zh-CN` | Only exact `zh-CN`; treat `zh-TW` as English | Traditional Chinese is far better served by Simplified Chinese than by English until a `zh-TW` locale exists. |
| Hard-coded strings are caught by a **text-scanning guard test** | ESLint with `react/jsx-no-literals`, or trusting review | The project has no ESLint yet, and the guard also checks that every key actually resolves — something a lint rule does not do. It is a heuristic and says so in its own header. |
| A `validation` refusal may carry a `ValidationReason` identifier, translated as `errors.<reason>` (S5.2) | A new `BackendErrorCode` per case; a sentence in `BackendError.message` | The code list is a failure taxonomy and one entry per refusal would dilute it; a sentence from the backend would be frozen in the wrong language. A reason is the same "keys, not sentences" contract at a finer grain, and `i18n/errors.ts` switches over the union so the compiler proves the mapping is total. |
| A new `BackendErrorCode` is still right when the failure is about the **machine**, not the request (S5.3's `ant_missing`, `ant_not_logged_in`; S5.13's three `gcloud_*`; S7.6's `key_unreadable`) | Two more `ValidationReason`s | A reason narrows a refusal of *this request*, and it only ever reaches the screen through `code === 'validation'`. "The Anthropic CLI is not installed" is raised while building a model for a chat turn as well as while validating a form, so it has to travel as a class of its own. Both spellings were used in S5.3: the two `oauth_*` refusals are reasons, the two `ant_*` conditions are codes. S5.13 reused the same split for Google, and `gcloud_no_project` is the clearest case of all — the OAuth `fetch` wrapper raises it mid-request, where there is no request-shaped refusal to narrow. |
| The backend emits keys, the renderer translates | Backend renders sentences in the user's language | A message is stored forever and the language can change afterwards; a stored sentence would be frozen in the language that was active when it was written. It also keeps `src/main` free of UI copy. |
| Both language names are written in **English** inside `en.json` (`Chinese (Simplified)`) | The usual endonym convention, which would put the Chinese endonym in both files | CLAUDE.md rule #1: `zh-CN.json` is the only file that may contain Chinese, and `locales.test.ts` enforces it. `zh-CN.json` itself does use the endonyms. |

## Open questions

- Whether the language switcher deserves a quick toggle at the bottom of the
  settings navigation, as `PLAN.md` suggests, or only the Appearance & language
  section. Decided when that screen is built (S1.6).
- Whether agent *names* should be translatable. Currently they are user data and
  are shown verbatim, which seems right.
