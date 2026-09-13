# agent-turn — Frontend

This feature has **no UI of its own**. It runs entirely in the main process; what
the user sees of it is rendered by [`chats`](../chats/frontend.md) — the message
row, its streaming cursor, its reasoning block and its status hint.

What the backend half *imposes* on the renderer is worth stating here, because
every one of these is a contract the message list has to honour:

| From the turn | The renderer must |
|---|---|
| `message.created` with `parts: []` and `status: 'streaming'` | Render the row immediately, with a cursor and no body. A row that only appears once text arrives makes every reply look like a freeze |
| `message.delta { kind: 'text' \| 'reasoning' }` | **Append** to the last part of that kind, and start a new part when the kind differs. Never replace the message from a delta |
| `message.updated` | Replace the message wholesale. It is authoritative for `status`, `usage` and `error`, so a renderer that dropped deltas still converges |
| `status: 'passed'` | Dim the row and show the abstention label instead of the `[PASS]` text |
| `status: 'error'`, `error: 'aborted'` | Show "Stopped", not a failure — the user pressed the button themselves |
| `status: 'error'`, any other detail | Show "The reply failed". `Message.error` is operator-facing detail and is **not** rendered |
| `presence.changed` | Update the dot on that agent's avatars, everywhere. The dot shows the agent's *current* state, not its state when the message was sent |
| `usage` | Stored per message; nothing displays it yet. S4.1 adds the per-member and per-chat totals |

Reasoning parts are rendered collapsed behind a "Reasoning" toggle
(`chat.reasoning`) because they are long, low-signal and not what the group said.

The group briefing and the system prompt never reach the renderer at all: they
are model-facing text, which is exactly why `briefing.zh-CN.ts` is a `.ts` file
rather than a locale entry (see [`backend.md`](./backend.md)).
