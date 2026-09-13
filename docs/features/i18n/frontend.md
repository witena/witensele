# i18n — Frontend

This feature is almost entirely frontend: the backend only stores a string (see
[backend.md](./backend.md)).

## Pages and components

| File | Responsibility |
|---|---|
| `src/renderer/src/locales/en.json` | Every English string. The reference tree the guards check against |
| `src/renderer/src/locales/zh-CN.json` | Every Chinese string. The **only** file in the repository allowed to contain Chinese |
| `src/renderer/src/i18n/index.ts` | `initI18n`, `resolveLanguage`, `getNavigatorLanguage`, `SUPPORTED_LANGUAGES`, `FALLBACK_LANGUAGE`, the shared `i18n` instance |
| `src/renderer/src/i18n/notices.ts` | `translateNotice(t, part)` for `system-notice` message parts |
| `src/renderer/src/stores/settings.ts` | The settings store and the `useLanguage()` selector |
| `src/renderer/src/lib/backend-provider.ts` | `getBackend()` / `setBackend()` — the injection point that keeps stores testable in plain Node |
| `src/renderer/src/main.tsx` | Bootstrap: load settings → resolve → `initI18n` → set `<html lang>` → render inside `I18nextProvider` |
| `src/renderer/src/App.tsx` | The smoke screen, now fully translated, plus the three-button language switcher |
| `src/renderer/index.html` | `lang="en"` as the pre-bootstrap default; the bootstrap overwrites it |

## State

| Store | Field | Type | Meaning |
|---|---|---|---|
| `settings` | `settings` | `AppSettings \| null` | Backend-owned mirror of the settings row; `null` until the first load |
| `settings` | `status` | `'idle' \| 'loading' \| 'ready' \| 'error'` | Explicit rather than derived: "not loaded yet" and "load failed" need different UI |
| `settings` | `error` | `string \| undefined` | Developer-facing detail of a failed load. The UI renders `common.error`, never this |

Actions:

- `load()` — calls `settings.get`. **Never rejects**: a failure sets `status:
  'error'` and leaves `settings` null, because the bootstrap awaits it and a
  broken settings row must not produce a blank window.
- `setLanguage(language)` — optimistic local write, then `settings.update`, then
  replace with the authoritative answer, then `i18n.changeLanguage(resolve(…))`.
  It *does* reject if the write fails, so the caller can surface it.
- `useLanguage()` — the stored **setting** (`'system'` included), which is what
  the switcher highlights. The *active* language is `i18n.language` from
  `useTranslation()`; the two are different things.

The i18next instance is state too, owned by i18next and read through
`useTranslation()`. Nothing mirrors the active language into zustand — that would
be two sources of truth for one fact.

## Backend calls

| Call / subscription | Called from | Purpose |
|---|---|---|
| `invoke('settings.get')` | `useSettingsStore.load()`, from the bootstrap in `main.tsx` | The stored language, before the first render |
| `invoke('settings.update', { patch: { language } })` | `useSettingsStore.setLanguage()` | Persist the choice |

No subscriptions. A settings change has exactly one origin — this window — so
there is nothing to reconcile. (A second window, or the server version, would
need a `settings.updated` event; the store would then replace `settings` from it.)

Components never call `invoke` for settings; they call store actions. The store
reaches the backend through `getBackend()`, never `window.witena` (CLAUDE.md
rule #6).

## Interaction states

| State | What the user sees |
|---|---|
| idle | The UI in the active language; the current choice highlighted with `aria-pressed` |
| loading | Nothing — the dark page background. The bootstrap resolves the language before creating the React root, so there is no frame of raw keys and no language flicker |
| streaming | n/a |
| empty | n/a |
| error | `settings.get` failing leaves the language at the system default and shows the failure under `data-testid="error"`; the app still starts. `settings.update` failing surfaces the same way and the optimistic highlight is corrected by the next successful read |

## Copy and i18n

This feature *is* the copy. The namespaces are `common`, `nav`, `chat`, `agents`,
`settings`, `presence`, `errors`, `notices` and `smoke` — see the key-tree table
in [implement.md](./implement.md).

**Adding a string:**

1. Add the key to **both** `en.json` and `zh-CN.json`, in the same place in the
   tree. `locales.test.ts` fails if only one file has it.
2. Render it with `t('namespace.key')`. Never a literal —
   `used-keys.test.ts` fails on any JSX text node with three or more letters.
3. Interpolate with `{{name}}` and pass `t('chat.round', { round })`. The
   placeholder names must match across both files; that is asserted too.
4. Text the main process produces is not a string: emit a `SystemNoticePart` with
   a key under `notices.*` and render it with `translateNotice`. A rejected
   `invoke` is rendered from `errors.<BackendError.code>`; `BackendError.message`
   is log detail and is never shown.

Things the guards will refuse: an English sentence in `zh-CN.json`, any CJK in
`en.json`, an empty value, a key that exists in one file only, a key that no
locale file defines, and a literal in JSX.

## Accessibility and keyboard

- `<html lang>` is set during bootstrap and updated on every `languageChanged`,
  so screen readers, hyphenation and spell-checking follow the UI language.
- The language switcher is three real `<button>`s in tab order, each carrying
  `aria-pressed` for the active choice.
- Because all copy comes from keys, assistive technology never reads a stale
  sentence after a switch — including backend notices stored months earlier.
- Chinese and English differ in length by up to a factor of two. Layouts must not
  be sized to one language's text; the mockup's fixed column widths are the
  constraint to check against when S1.5 lands.
