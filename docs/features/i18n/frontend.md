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
| `src/renderer/src/pages/settings-page.tsx` | S1.5: the language quick toggle at the bottom of the settings nav (`lang-system` / `lang-zh-CN` / `lang-en`) |
| `src/renderer/src/pages/settings/appearance-section.tsx` | S1.5: the same setting again as a `Select`, under Settings -> Appearance & language. S5.8 put the appearance `SegmentedControl` above it, built the same way: a handler module, a stored `'system'`, no local state |
| `src/renderer/src/pages/settings/language.ts` | S1.5: `applyLanguageSetting` — the single handler both controls call; it puts a failed write into the store's `error` field |
| `src/renderer/src/App.tsx` | S1.5: a composition root only. The smoke screen it used to hold is now Settings -> Developer |
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
- `dismissOnboarding()` (S7.5) — the same shape as `setTheme`: an optimistic
  local write so the card disappears under the cursor, then `settings.update`
  with `{ onboardingDismissed: true }`, then the authoritative row. One-way by
  design; nothing writes `false` back.
- `useLanguage()` — the stored **setting** (`'system'` included), which is what
  the switcher highlights. The *active* language is `i18n.language` from
  `useTranslation()`; the two are different things.
- `applyLanguageSetting(setting)` (S1.5, `pages/settings/language.ts`) — what the
  two controls actually call. It awaits `setLanguage` and writes a rejection into
  the store's `error` field, so a failed write still has one visible surface now
  that the switcher is no longer next to the error line.

The i18next instance is state too, owned by i18next and read through
`useTranslation()`. Nothing mirrors the active language into zustand — that would
be two sources of truth for one fact.

## Backend calls

| Call / subscription | Called from | Purpose |
|---|---|---|
| `invoke('settings.get')` | `useSettingsStore.load()`, from the bootstrap in `main.tsx` | The stored language, before the first render |
| `invoke('settings.update', { patch: { language } })` | `useSettingsStore.setLanguage()`, called from `applyLanguageSetting` by either control | Persist the choice |

No subscriptions. A settings change has exactly one origin — this window — so
there is nothing to reconcile. (A second window, or the server version, would
need a `settings.updated` event; the store would then replace `settings` from it.)

Components never call `invoke` for settings; they call store actions. The store
reaches the backend through `getBackend()`, never `window.witena` (CLAUDE.md
rule #6).

## Interaction states

| State | What the user sees |
|---|---|
| idle | The UI in the active language; in the settings nav the current choice is highlighted with `aria-pressed`, and the Appearance select shows the same value. The appearance control above it highlights the stored *setting* (S5.8) — `System` stays pressed while the machine decides what is painted, exactly as the language toggle does |
| loading | Nothing — the dark page background. The bootstrap resolves the language before creating the React root, so there is no frame of raw keys and no language flicker |
| streaming | n/a |
| empty | n/a |
| error | `settings.get` failing leaves the language at the system default and shows the failure under `data-testid="error"` — which lives in Settings -> Developer since S1.5; the app still starts. `settings.update` failing surfaces the same way (via `applyLanguageSetting`) and the optimistic highlight is corrected by the next successful read |

## Copy and i18n

This feature *is* the copy. The namespaces are `common`, `nav`, `chat`, `agents`,
`settings`, `presence`, `errors` and `notices` — see the key-tree table in
[implement.md](./implement.md). S1.5 removed the ninth, `smoke`: the screen it
belonged to became Settings -> Developer and its strings moved under
`settings.developer.*`, with `EXPECTED_NAMESPACES` in `locales.test.ts` updated to
match.

One trap S1.5 found the hard way: **do not name an interpolation placeholder
`count`.** i18next treats `count` as the plural trigger and resolves `key_one` /
`key_other` instead of the key itself, so the string renders with the placeholder
still in it. Use any other name (`{{rounds}}`, `{{seconds}}`) unless plurals are
actually wanted.

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
   is log detail and is never shown. When the rejection carries a
   `ValidationReason` in `details`, `translateFailure` prefers `errors.<reason>`
   over the generic `errors.validation` — the narrower half of the same contract.
   A code may also have a *second*, longer piece of copy in the feature that owns
   the screen: S7.6's `errors.key_unreadable` is the one-line failure class, and
   `settings.providers.keyUnreadable` is the sentence the provider card and the
   editor show, which says what to do about it.
   Since S5.10 a store may fill those same three fields **itself**, with a reason
   and no rejection behind it: a path picked outside the chat's folder is refused
   by the renderer, because no native dialog can be confined to a directory, and
   it is reported through exactly this path so the user cannot tell — and does
   not need to — which side noticed
   (S5.2).

Things the guards will refuse: an English sentence in `zh-CN.json`, any CJK in
`en.json`, an empty value, a key that exists in one file only, a key that no
locale file defines, and a literal in JSX.

One thing they are *not* meant to refuse: a value that is genuinely the same in
both languages. A shell command (S5.3's `brew install anthropics/tap/ant`,
S5.13's `brew install --cask google-cloud-sdk`) is
data, so it is a constant in `@shared/presets` rendered inside `{…}` — braces are
invisible to the JSX scan — rather than a key that would have to be duplicated
identically in both files and then drift. The same rule already covers a working
directory path and a model id, and S7.5 added three more: the version string and
the repository URL in Settings → About, every `name@version · licence` row of
its generated licence list, and an agent template's **name**, which is stored in
`agents.name` and resolved against by `@mentions`.

Two runtime keys now exist, and both are checked in `locales.test.ts` rather
than by the usage guard, which cannot see a key that is assembled:
`settings.mcp.presets.<id>` (S5.1) and `agents.templates.<id>` (S7.5). Each is
asserted **in both directions** — no entry without copy, no copy left behind by
an entry that was renamed.

S5.15's `chat.commandRisk.*` is a third family of the same shape and takes the
*other* route on purpose. The sixteen `CommandRiskReason` codes could have been
resolved as `chat.commandRisk.${reason}` and checked the same way; instead
`components/chat/command-risk.ts` is a `switch` of sixteen **literal** `t()`
calls, so the ordinary usage guard sees every one of them and a renamed key
fails at the usual place. Its own test then asserts both directions over the two
locale files as well, which is what a computed key would have needed anyway —
the difference is that the literals cost nothing to check twice.

## Accessibility and keyboard

- `<html lang>` is set during bootstrap and updated on every `languageChanged`,
  so screen readers, hyphenation and spell-checking follow the UI language.
- The language switcher is three real `<button>`s in tab order, each carrying
  `aria-pressed` for the active choice. Since S1.5 it is a `SegmentedControl` at
  the bottom of the settings nav, visible from every settings section — a user who
  cannot read the current UI language must not have to navigate to find it.
- Because all copy comes from keys, assistive technology never reads a stale
  sentence after a switch — including backend notices stored months earlier.
- Chinese and English differ in length by up to a factor of two. Layouts must not
  be sized to one language's text; the mockup's fixed column widths are the
  constraint. S1.5 checked this: `e2e/ui-shell.spec.ts` pins the UI to Chinese —
  the denser of the two — before taking its screenshots, so a layout that survives
  the shots survives English.
