# <feature> — Frontend

## Pages and components

> Every renderer file this feature touches, with one line each on its
> responsibility. Use paths relative to the repository root.

| File | Responsibility |
|---|---|
| | |

## State

> The zustand store(s) involved: which fields this feature reads and writes, what
> the actions do, and which state is server-owned (mirrors the main process) as
> opposed to purely local UI state.

| Store | Field | Type | Meaning |
|---|---|---|---|
| | | | |

## Backend calls

> Which `BackendClient` methods the UI calls and from where, plus which events it
> subscribes to and what it does when one arrives. The renderer must never reach
> for `window.witena` or Electron directly — only the BackendClient abstraction.

| Call / subscription | Called from | Purpose |
|---|---|---|
| | | |

## Interaction states

> How the UI behaves in each state, including the ones that are easy to forget.

| State | What the user sees |
|---|---|
| idle | |
| loading | |
| streaming | |
| empty | |
| error | |

## Copy and i18n

> The translation keys this feature adds, under which namespace. All user-facing
> copy goes through `t()`; no hardcoded strings in components.

## Accessibility and keyboard

> Focus order, shortcuts, anything that needs a label rather than an icon alone.
