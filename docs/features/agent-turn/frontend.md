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
| `usage` | Stored per message. Since S4.1 it is the source of the chat header's `12.4k tokens · $0.04`, each member row's share, and the tooltip on that message's model badge — see [`chats`](../chats/frontend.md) |
| `status: 'done'` on text that **ends** with `[PASS]`, `[AGREED]` or `[CONTINUE]` | Strip the trailing marker when rendering (`messageText` → `stripTrailingMarkers`), keep the status. A model that answered and then signed off with a protocol token has not abstained (S4.3) and has not said anything the reader needs to see (S5.14). A reply that is *nothing but* a marker is left alone, so a bare `[AGREED]` shows as itself rather than as an empty row |
| `message.delta { kind: 'part' }` carrying a `tool-call` with no `serverId` | Draw the tool card with the bare tool name and no server prefix. That is what a built-in tool looks like: `read_skill`, `read_skill_file`, `memory_save`, `memory_search` (S3.2, S3.3) and the seven executor tools (S5.4) |
| A turn that has gone quiet because a `permission.requested` is open (S5.4) | Keep the agent `working` — it is, and its hard timeout is still counting. The card that unblocks it is [`executor`](../executor/frontend.md)'s (S5.5) |
| `message.delta { kind: 'part' }` carrying a `diff` (S5.5) | Draw one collapsed block per file, headed by the path, through the shared code block in the `diff` language. They arrive **after** the tool results and the text, once the stream has ended, and the final `message.updated` carries them too |

S5.11 is the same shape once more, with one visible consequence: the workspace
briefing and the materials only lengthen the system prompt, but a **participant**
can now produce a `tool-call` part for `read_file`, `list_dir`, `search_files` or
`git_diff`, which the message list draws as the same built-in tool card an
executor's call produces — and, since those four never ask, with no permission
card in front of it. The one new user-visible string is
`notices.materialsTruncated`, stored by the runner
([`orchestration`](../orchestration/frontend.md)) and rendered like every other
notice.

Since S5.6 one more option reaches the turn and **nothing** of it reaches the
renderer: `handoff` only lengthens the system prompt, so a handed-over turn
streams, fails, is stopped and is rendered exactly like any other. S5.10's goal
is the same again — it changes what every member is told and nothing about how a
reply is drawn — and so is S5.12's `reviewing`, which is one more block of one
round's prompts. What the *user* sees of the goal is the panel and the header
chip, both owned by [`chats`](../chats/frontend.md).

S5.12's one visible addition is a **part**, not an option: an executor turn that
brought the chat's deliverable into existence carries a `FileRefPart` for it,
after its diff blocks. It arrives as a `message.delta` of kind `part` like any
other and is drawn by the `FileRefChip` that already existed — the only thing new
is that this chip's path was reported by the backend rather than found in prose
by [`editor`](../editor/frontend.md)'s detector.

Reasoning parts are rendered collapsed behind a "Reasoning" toggle
(`chat.reasoning`) because they are long, low-signal and not what the group said.
Since S5.14 most transcripts have none at all: an agent on the open-model route
does not show its thinking unless the user turns "Show thinking" on in the agent
editor, and the turn then **never emits the delta**, so the renderer needs no
rule for it — a message with no `reasoning` part simply has no toggle. Nothing
about the collapsed block changed; there is just far less of it. The toggle
itself is [`agents`](../agents/frontend.md)'s.

S5.14's other renderer-visible change is two notice keys, `notices.consensus` and
`notices.voteClosed`, both stored by the runner and drawn like every other
notice, and the closing turn itself — which was, until S5.16, an ordinary agent
message with an ordinary round number.

S5.16 gives that message one more **part**, and it is the first part in the
product that carries no content at all:

| From the turn | The renderer must |
|---|---|
| `message.updated` whose parts start with `{ type: 'conclusion' }` (S5.16) | Draw the message as the conclusion card — the label, the accent edge, the speaker underneath, Copy and (for a document goal) Write to the deliverable. The flag is **never** rendered as text: `messageText` already ignores anything that is not a `text` part, so it is invisible unless something looks for it |

It arrives on the terminal `message.updated` rather than as a delta, because the
turn writes it once it knows the turn finished `done`: a conclusion that was
stopped or failed is not one. Everything else about that row — the avatar, the
round label, the presence dot — is unchanged, and the card wraps the body rather
than replacing it. The card itself is [`chats`](../chats/frontend.md)'s.

S5.18 changes nothing the renderer draws from a turn; what it changes is the
**text** of that conclusion in a `document` chat — the file's content rather
than a summary with a request attached — and the rows that follow it, which
[`orchestration`](../orchestration/frontend.md) now stores without a click: the
`handoffDeliver` line, the executor's turn and the review. The executor's reply
to an automatic delivery carries no `ConclusionPart`: only the `closing` turn is
flagged, whatever comes after it.

The group briefing and the system prompt never reach the renderer at all: they
are model-facing text, which is exactly why `briefing.zh-CN.ts` is a `.ts` file
rather than a locale entry (see [`backend.md`](./backend.md)). Neither do the
skills and memory sections, nor the contents of a `MEMORY.md`: what the user sees
of those is Settings → Skills ([`../skills/frontend.md`](../skills/frontend.md))
and the agent form's memory panel
([`../memory/frontend.md`](../memory/frontend.md)).
