# mcp-endpoint — Frontend

> One handler so far (WP-8), and no component of its own. The visible surfaces —
> the Settings section and the provenance chip — are still to come.

Surface, by work package (`tasks.md`):

| Surface | Package |
|---|---|
| Settings → Integrations: the endpoint switch, status, Claude Code and Codex cards, the generic snippet | WP-12 |
| The "via {{client}}" chip on a message sent through the endpoint | WP-13 |
| Selecting a chat on the `ui.open-chat` event (`witena://chat/<id>`) | WP-8 `[x]` (2026-09-20) |
| "Create a Claude Code agent for each committee" | WP-14 |

Every string goes through `t()` under `settings.integrations.*` and
`chat.viaClient`; no component reaches past `BackendClient`.

One boundary worth stating, because `src/shared/mcp-tools.ts` is importable from
the renderer and its strings are English: the tool `title` and `description`
fields are **not** UI copy and must never be rendered. Their reader is the
calling model, they are deliberately outside i18n (CLAUDE.md rule 4 is about
what the user sees), and a component that showed one would be showing the user
an untranslated prompt. If Settings → Integrations ever wants to list the tools,
it names them with its own `settings.integrations.*` keys.

## Opening a chat from a link (WP-8)

Two edits, no component: `lib/event-bridge.ts` gains one `case`, and
`stores/chats.ts` gains the method it calls.

```
open-url / second-instance argv           src/main/index.ts
  → ui.open-chat { chatId }               the bus, then BackendClient.subscribe
    → useChatsStore.applyOpenRequest(id)  did this window select it?
      → yes: useUiStore.setPage('chats')
```

`applyOpenRequest` returns a boolean, and the bridge navigates only when it is
`true`. A link to a chat this window does not have must not take the user off
the page they were on and show them nothing.

**An id the loaded list does not contain is ignored, with no error.** The link
came from outside the app — a tool result pasted into a terminal, a note, a
message — so "no such chat" is not a failure the user has to be told about, and
it must not clear a chat that *is* open either. The main process deliberately
does not check first; see [backend.md](./backend.md).

**The one exception is a list that has not loaded yet**, and it is the cold
launch, which is the case this whole feature exists for: the app was not
running, the shim started it, the main process created the window and emitted as
soon as it had loaded — while `chats.load()` is still in flight. The id is then
held in `pendingOpenId` and answered by the first `load` that finishes, which
either selects it or drops it. Nothing else clears it: an id still absent after
a full read is not going to appear later.

Navigation is not re-sent in that path, because a window created for a link is a
fresh one and the shell already opens on Chats (`stores/ui.ts`).

`stores/ui.ts` is unchanged. Its header calls the shell "deliberately not a
router" and says a deep link would become "the thing that writes these two
fields" — this is that, one `setPage` call from the event bridge, with the
routing decision staying in the bridge rather than in a router.

### Tests

`src/renderer/src/stores/chats.test.ts`, `describe('ui.open-chat')`, driven
through `applyBackendEvent` so the wiring is tested with the store: a known id
selects and navigates; an unknown one selects nothing, navigates nowhere, leaves
`error` unset and does not clear the current selection; an id that arrives
before `load` is honoured when the list lands, and dropped when the list turns
out not to contain it.
