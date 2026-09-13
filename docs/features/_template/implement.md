# <feature> — Implementation

## Approach

> The shape of the solution in a few paragraphs: which modules exist, what each
> owns, and what the main abstraction is. Enough that a reader can predict where
> a given piece of behaviour lives before opening any file.

## Data flow

> Trace the primary path end to end. Keep it concrete about which layer does what:
>
> user action → renderer component → store → BackendClient → IPC → main handler →
> service → storage / model call → event → store → re-render
>
> Add a second trace for each significantly different path (for example a
> streaming response, or an error path).

## Key types and contracts

> The types other features rely on, and where they live (normally
> `src/shared/types.ts`). List the IPC channels or `BackendClient` methods this
> feature adds, with request and response shapes, and the typed events it emits.

| Channel / method | Request | Response | Notes |
|---|---|---|---|
| | | | |

| Event | Payload | Emitted when |
|---|---|---|
| | | |

## Tests

> The test files that cover this feature and what each asserts. Every feature
> needs at least one. `npm test` must pass before the feature is considered done.

| File | Covers |
|---|---|
| | |

## Known limitations and TODOs

> Shortcuts taken on purpose, and what would have to change to remove them.
