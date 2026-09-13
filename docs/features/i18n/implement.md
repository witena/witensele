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
| `chat` | Chat list, date groups, member panel, composer, run controls, `passed` / `skipped` |
| `agents` | Agent list and configuration form labels |
| `settings` | Section names, the language switcher's own copy, the placeholder copy of the sections not built yet, and the `developer.*` subtree that S1.5 moved out of `smoke` |
| `presence` | The four presence states |
| `errors` | One entry per `BackendErrorCode`, so a rejected `invoke` is rendered from `errors.<code>` — plus, since S5.2, one per `ValidationReason`, for the `validation` refusals that name which rule was broken (`errors.<reason>`). `errors.test.ts` asserts the namespace holds **exactly** the codes plus the reasons, in both directions, so a code added to the shared union without copy fails there rather than on screen (S5.3 added two of each) |
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
  keys, and `locales.test.ts` covers the third against the preset table.
- **No plural or gender rules** beyond i18next's defaults, because nothing needs
  them yet. Adding them is a locale-file change, not a code change.
- **`zh-TW` is folded into `zh-CN`.** Adding it means a third resource and one
  more branch in `resolveLanguage`.
- **The group briefing is still English-only** — it does not exist yet. S1.7 adds
  it in both languages, driven by the same resolved language (see
  `backend.md`).
