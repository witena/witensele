# i18n — Implementation

## Approach

Five small modules, each with one job.

| Module | Owns |
|---|---|
| `src/renderer/src/locales/{en,zh-CN}.json` | Every user-visible string in the app |
| `src/renderer/src/i18n/index.ts` | `initI18n`, `resolveLanguage`, `getNavigatorLanguage`, `SUPPORTED_LANGUAGES`, the shared instance |
| `src/renderer/src/i18n/notices.ts` | `translateNotice` — rendering a backend `system-notice` part |
| `src/renderer/src/stores/settings.ts` | The settings store: `load`, `setLanguage`, `useLanguage` |
| `src/renderer/src/lib/backend-provider.ts` | `getBackend()` / `setBackend()` so stores never import a transport |

Two ideas carry most of the design.

**The resources are bundled.** Both JSON files are imported statically, so
`i18next.init` finishes synchronously — i18next only defers when a backend
connector has to fetch a namespace. That is what allows `main.tsx` to read the
settings row, resolve the language, initialise i18next and render an
already-translated tree, instead of rendering first and correcting afterwards.

**A setting is not a language.** `AppSettings.language` may be `'system'`, which
i18next cannot be set to. `resolveLanguage(setting, navigatorLanguage)` is the
one function that maps the stored setting onto `SUPPORTED_LANGUAGES`: anything
starting with `zh` becomes `zh-CN`, everything else `en`. The store keeps the
setting, i18next keeps the resolved language, and Settings -> Developer shows
both (`data-testid="language"` and `resolved-language`) precisely because
confusing them is the easy mistake.

## Data flow

**First launch, and every launch.**

```
main.tsx bootstrap
  → useSettingsStore.load()
      → getBackend().invoke('settings.get')
          → IPC → settings handler → SettingsRepository.get()
          → AppSettings (language: 'system' on a fresh install)
  → resolveLanguage(setting, getNavigatorLanguage())      // 'zh-CN' | 'en'
  → initI18n(language)                                    // synchronous
  → document.documentElement.lang = language
  → createRoot(...).render(<I18nextProvider i18n={i18n}><App/></I18nextProvider>)
```

Nothing renders before that chain completes; the window shows the dark page
background from `index.css` for those few milliseconds.

**Switching the language.**

```
click → useSettingsStore.setLanguage('zh-CN')
  → set({ settings: { ...previous, language } })           // optimistic
  → getBackend().invoke('settings.update', { patch: { language } })
      → IPC → settings handler → SettingsRepository.update() → SQLite
  → set({ settings })                                      // authoritative answer
  → i18n.changeLanguage(resolveLanguage(settings.language, getNavigatorLanguage()))
      → react-i18next re-renders every component using useTranslation
      → 'languageChanged' → document.documentElement.lang
```

The optimistic write is only there so the pressed button highlights instantly;
the authoritative settings object replaces it a moment later. `changeLanguage`
runs *after* the round trip, which is why `resolved-language` flipping in the
end-to-end test also proves the write reached SQLite.

**A backend notice.**

```
main process → SystemNoticePart { key: 'agentSkipped', params: { agent: 'Kai' } }
  → stored in messages.parts, pushed as a message event
  → renderer: translateNotice(t, part) → t('notices.agentSkipped', { agent: 'Kai' })
```

The backend never produces a sentence, so a message written in Chinese renders in
English the instant the user switches — nothing stored is frozen in a language.

## Key types and contracts

| Type | Where | Role |
|---|---|---|
| `Language` (`'zh-CN' \| 'en'`) | `src/shared/types.ts` | The resolved UI languages |
| `AppSettings['language']` (`Language \| 'system'`) | `src/shared/types.ts` | The stored setting; re-exported by the store as `LanguageSetting` |
| `SystemNoticePart` (`{ key, params? }`) | `src/shared/types.ts` | Backend-authored text, translated under `notices.*` |
| `TranslateFn` | `i18n/notices.ts` | The two-argument subset of i18next's `t` that `translateNotice` needs |

No new `BackendClient` method and no new event: the feature rides on
`settings.get` / `settings.update`, which S1.3 already shipped.

| Channel / method | Request | Response | Notes |
|---|---|---|---|
| `settings.get` | — | `AppSettings` | Read once during bootstrap |
| `settings.update` | `{ patch: { language } }` | `AppSettings` | The handler already accepts `'zh-CN' \| 'en' \| 'system'`; no main-process change was needed |

### The key tree

Top-level keys are the plan's namespaces and are asserted by `locales.test.ts`:

| Namespace | Holds |
|---|---|
| `common` | App name, OK / Cancel / Save / Delete / Add / Search, loading, generic error |
| `nav` | The three navigation rail entries |
| `chat` | Chat list, date groups, member panel, composer, run controls, `passed` / `skipped`, since S5.5 the executor's permission card, the diff block and the file-reference chip, and since S5.15 the `commandRisk.*` subtree (one line per `CommandRiskReason`) and the Always allowed block's four keys |
| `agents` | Agent list and configuration form labels, plus the `templates.*` subtree (S7.5): one description per entry of `@shared/agent-templates`, looked up by a **runtime** key, so `locales.test.ts` checks the subtree against the table in both directions the way it already does for the MCP presets |
| `settings` | Section names (S10.4 added `sections.integrations`), the language switcher's own copy, the appearance switcher's (S5.8: `theme`, `themeSystem`, `themeLight`, `themeDark`, `themeHint`), the placeholder copy of the sections not built yet, and the `developer.*` subtree that S1.5 moved out of `smoke` S5.7 extended with the Editor block's seven `editor*` keys and S5.15 with the Sandbox block's four — plus, under `timeouts`, S5.15's `permission` / `permissionHint` ; S10.4 added the `integrations.*` subtree, twenty-eight keys for Settings → Integrations |
| `presence` | The four presence states |
| `errors` | One entry per `BackendErrorCode`, so a rejected `invoke` is rendered from `errors.<code>` — plus, since S5.2, one per `ValidationReason`, for the `validation` refusals that name which rule was broken (`errors.<reason>`). `errors.test.ts` asserts the namespace holds **exactly** the codes plus the reasons, in both directions, so a code added to the shared union without copy fails there rather than on screen (S5.3 added two of each; S5.13 three more codes, one per way the Google Cloud SDK can be unready; S5.6 three more reasons, for the hand-off's three refusals; S5.7 two more, for the two ways a path can be refused by `system.openInEditor`; S5.10 nine more, one per field of a chat goal that can be wrong — two of which the **renderer** raises itself, because a native dialog cannot be confined to a folder and the conversion is where that is noticed; S7.6 one more code, `key_unreadable`, for an API key encrypted by a previous installation) |
| `notices` | Backend-authored notices — the keys `SystemNoticePart.key` may take |

S1.5 was the first step to render most of `nav`, `chat`, `agents` and `settings`,
and it added the copy the shell needed (empty states, orchestration labels,
section placeholders) rather than only consuming what was here. It also removed
the ninth namespace, `smoke`: its screen became Settings -> Developer and its
strings are the `settings.developer.*` subtree now.

S1.7 filled in the rest of `chat`: `memberCount` (whose placeholder is
`{{members}}`, **not** `count` — see the trap in
[frontend.md](./frontend.md)), the row menu's `chatOptions` / `rename` /
`renameChat` / `deleteChat` / `deleteConfirm`, `emptyMessagesTitle` /
`emptyMessagesDescription`, `reasoning`, and the two `error` hints `stopped` and
`failed`; plus `common.you`, which is both the user's name in the transcript and
the source of their avatar monogram. `presence.*` and the `notices.*` renderer are
now actually rendered rather than only defined. `agents` still waits for S2.1.

One thing S1.7 deliberately did **not** put in the locale files: the group
briefing sent to models. It exists in both languages as
`src/main/agents/briefing.en.ts` and `briefing.zh-CN.ts`, because it is a prompt
rather than UI copy — it never reaches the renderer, so it has no key and is
translated at authoring time, not at display time. That makes `briefing.zh-CN.ts`
the one `.ts` file allowed to contain Chinese; see
[`../agent-turn/backend.md`](../agent-turn/backend.md).

S5.7's keys are seven under `settings.developer.editor*` and three under
`chat.*` (`fileRefTitle`, reworded from "Copy this path" when the chip stopped
copying, `fileRefFailed` and `openInEditor`). Two of the seven — `editorVscode`
and `editorCursor` — are **brand marks** and are byte-identical in both files,
which is precisely the shape `locales.test.ts` allows: a `zh-CN` value with no
CJK in it must *equal* its English counterpart, so a brand name passes and an
untranslated sentence does not. And
`editorCommandHint` writes its placeholders as single-brace `{path}` / `{line}`
rather than i18next's `{{…}}`: they are literal text the user types into a
command template, not interpolation, and the double-brace spelling would have
been substituted away to nothing.

S5.12 added four: `chat.writeDeliverable` and `chat.writeDeliverableTitle` for
the Actions card's third row, `errors.handoff_no_deliverable` for the rule that
disables it, and `notices.handoffDeliver` for the message the click stores. The
notice is a **second key** rather than a parameter on `notices.handoff`, which is
the rule this feature keeps coming back to: a parameter is for a value inside a
sentence, and these are two different sentences — one says "implement what the
group decided", the other names a file. The error key follows the S5.2 shape
exactly, so the disabled tooltip and the backend's rejection are one string.

S5.16 added ten `chat.*` keys and no notice key at all, which is the interesting
part. Eight of them are the conclusion — `conclusion`, `conclusionBy`,
`conclusionCopy` / `conclusionCopied`, `conclusionDeliver` /
`conclusionDeliverTitle`, `conclusionChipTitle` and `conclusionPreview` — and two
are the "Closing speaker" select (`closingSpeaker`, `closingSpeakerFirst`). The
`conclusionPreview` key is the one worth reading: the chat list shows a label in
front of the group's own sentence, and the label is interpolated **around** the
sentence (`"Conclusion: {{text}}"`) rather than concatenated as two nodes, so a
language that puts the label last can. What is *not* here: the thing that marks a
conclusion is a `ConclusionPart`, a flag with no text, so it needs no key and no
notice — the backend says "this message is the answer" and the renderer chooses
every word around it.

S7.5 added three groups and one rule worth repeating. `chat.onboarding.*` is the
first-run card; `agents.templates.*` is described above; `settings.about.*` plus
`settings.sections.about` is the About screen, whose only interpolation is
`licensesHint`'s `{{packages}}`. The rule: **the things About prints are not
copy**. `Witena 0.1.0`, `react@19.3.0`, `MIT` and the repository URL are
identifiers — the same in both languages — so they are rendered as data with
translated labels around them, exactly as the `ant` install command and a
working-directory path are. The same goes for a template's **name**: it is
stored in `agents.name`, `@mentions` resolve against it and every model sees it,
so it lives in `@shared/agent-templates` as an English literal and only its
description is a key.

S7.4 added the `settings.about.updates.*` subtree — sixteen keys under the About
screen's own namespace, because the Updates block lives there and the notice bar
is the same two sentences seen from the bottom of the window. Three of them are
worth naming. The eight **state** sentences are reached by a `switch` of literal
`t()` calls in `lib/updates.ts` rather than by `t('settings.about.updates.' + state)`,
which is the rule S1.5's two traps established; `lib/updates.test.ts` walks every
state and asserts the key it lands on exists in `en.json`, so the compiler, the
usage guard and that test between them make an unwritten sentence impossible.
`error`'s `{{message}}` is the **updater's own words** — a 404 from GitHub, a
DNS failure — and is interpolated as data rather than translated, because there
is no fixed set of network failures to write copy for; it is the same call
`notices.providerError` already makes. And `unsignedBuild` / `developmentBuild`
are two sentences rather than one with a parameter, for the reason S5.12 gives:
a parameter is for a value inside a sentence, and these say different things.

S10.4 added exactly one key, `chat.viaClient` — `via {{client}}` in `en.json`,
with its translation beside it — and it is the shortest illustration this feature
has of its own rule about what is copy and what is data. The chip on a message an
IDE sent is two things: the word "via", which is a sentence the user reads and is
therefore a key, and the **client's own name** — `claude-code`, `codex`, whatever
the IDE called itself in `initialize.clientInfo.name` — which is an identifier
the backend stores, and is therefore interpolated as data and never translated.
It is the same division the working directory, the tool names in the Always
allowed block and About's package versions are already on.

Two things about it that are not obvious. It is a **key with a parameter rather
than two nodes**, so a language that puts the client first can. And the backend
sends no notice and no sentence: the message carries an `OriginPart`, a flag whose
only content is that name, exactly as `ConclusionPart` carries none at all — the
backend says *what the message is*, and the renderer chooses every word around it
in the language that is on screen now.

S10.4's second half added the `settings.integrations.*` subtree — twenty-eight
keys for the Integrations section — and it is the clearest case this feature has
of the **data / copy** line, because the screen prints four different things and
only two of them are keys:

| On the screen | What it is | How it is rendered |
|---|---|---|
| "Coding agents", "Not connected", "Repair", every hint | Copy | `settings.integrations.*` |
| `Claude Code`, `Codex` | Copy that is *identical* in both languages | `settings.integrations.clientClaudeCode` / `clientCodex`, the same string in both files — which `locales.test.ts` explicitly allows |
| The registered command, `/Applications/Witena.app/…/bin/witena-mcp` | Data | Printed verbatim, in mono, like About's version string |
| The JSON and TOML snippets | Data | Built by `components/settings/integration-display.ts`; a translated `mcpServers` key would be wrong in both languages |

Two mechanics are worth naming. The state and action labels are reached by a
`switch` of **literal** `t()` calls in `integration-display.ts` — the rule
`lib/updates.ts` set, so `used-keys.test.ts` resolves every one of them and a
typo cannot ship. And `snippetDevNote` interpolates `{{placeholder}}` with the
`<witena-repo>` constant rather than spelling it inside the sentence, so the note
and the snippet above it cannot drift apart; `escapeValue: false` is what lets an
angle bracket through unmangled.

S5.8 added five `settings.theme*` keys next to the language ones, and nothing
else: the theme is an attribute on `<html>`, so the only translated text it
owns is the three segment labels and one hint. `themeSystem` is worded
identically to `languageSystem` in both files on purpose — it is the same
promise about the same machine — which is also why `locales.test.ts`'s rule
that a `zh-CN` value must differ from its English one has an exception list it
did not need here (both Chinese values are real translations).

## Tests

| File | Covers |
|---|---|
| `src/renderer/src/i18n/locales.test.ts` | Identical key trees; the expected top-level namespaces; no empty values; no CJK in `en.json`; every `zh-CN` value either contains CJK or is deliberately identical to English; identical `{{placeholders}}` on both sides; and, since S5.1, that the `settings.mcp.presets.*` keys are exactly the ids in `@shared/mcp-presets` — a runtime key `used-keys.test.ts` cannot resolve |
| `src/renderer/src/i18n/used-keys.test.ts` | Every literal `t('…')` / `i18nKey="…"` resolves in `en.json`; no JSX text node is a hard-coded string |
| `src/renderer/src/i18n/notices.test.ts` | `translateNotice` prefixes, interpolates, follows the active language, and falls back to the raw key |
| `src/renderer/src/stores/settings.test.ts` | `load` populates and records failure instead of throwing; `setLanguage` sends the right patch, stores the answer, switches i18next, resolves `'system'` through the navigator, and updates optimistically |
| `e2e/i18n.spec.ts` | Switching re-renders immediately; the quick toggle and the Appearance select are the same setting; the choice survives a restart, including `<html lang>` |

`used-keys.test.ts` is a heuristic and documents itself as one — read its header
before trusting or extending it. Both guards were verified to fail on purpose: a
bogus `t('smoke.nonexistentKey')` and a literal `<p>Backend status below</p>`
temporarily added to `App.tsx` each produced exactly one failure. It caught two
more for free during S1.5: a `switch` whose arms returned adjacent JSX elements
(read as a text node between two tags) and, indirectly, the `count` placeholder
trap described in [frontend.md](./frontend.md).

## Known limitations and TODOs

- **The guard only reads `.tsx` for literals.** A string assembled in a `.ts`
  helper and rendered elsewhere is invisible to it.
- **Runtime keys are unchecked.** `t(option.labelKey)`,
  `t('notices.' + part.key)` and the gallery's `settings.mcp.presets.<id>` cannot
  be resolved statically; `notices.test.ts` covers the second by exercising real
  keys, and `locales.test.ts` covers the third against the preset table. S5.15's
  sixteen `chat.commandRisk.*` lines avoid the problem instead of covering it:
  `command-risk.ts` is a `switch` of sixteen literal `t()` calls, which the
  ordinary guard resolves, and its own test then checks both locale files in
  both directions anyway.
- **No plural or gender rules** beyond i18next's defaults, because nothing needs
  them yet. Adding them is a locale-file change, not a code change.
- **`zh-TW` is folded into `zh-CN`.** Adding it means a third resource and one
  more branch in `resolveLanguage`.
- **The group briefing is still English-only** — it does not exist yet. S1.7 adds
  it in both languages, driven by the same resolved language (see
  `backend.md`).
