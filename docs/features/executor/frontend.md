# executor — Frontend

S5.4 was the backend half — the tools, the folder confinement and the permission
gate. S5.5 is the visible half: the user can answer the prompt, and what the
executor changed is in the transcript.

## Pages and components

| File | Responsibility |
|---|---|
| `src/renderer/src/stores/permissions.ts` | The open prompts, keyed by `requestId`: `applyRequested` / `applyResolved` from the two events, `reply(requestId, decision)` through `permission.reply`, `clear(chatId)` for a deleted chat, and the `pendingForChat` / `usePendingPermissions` / `useIsReplying` selectors |
| `src/renderer/src/components/chat/permission-card.tsx` | One card per pending request: the agent and the tool, the rendered input, and Allow / Always allow in this chat / Deny. Owns the two keyboard shortcuts |
| `src/renderer/src/components/chat/permission-input.ts` | `describePermissionInput(toolName, input)`: the command line **verbatim**, a write's path plus a capped content preview, an edit's patch, or raw JSON. Pure and unit-tested |
| `src/renderer/src/components/chat/diff-block.tsx` | One `DiffPart`: a collapsed header with the path and `+n -n`, opening onto `CodeBlock` in the `diff` language |
| `src/renderer/src/components/chat/file-ref-chip.tsx` | One `FileRefPart` as a `path:line` chip; clicking copies the reference |
| `src/renderer/src/components/chat/transcript-rows.ts` | `collectDiffs`, `collectFileRefs`, `countDiffLines`, `formatFileRef` — the pure part-level transforms both components read |
| `src/renderer/src/components/chat/tool-call.ts` | `EXECUTOR_PREVIEW_ARG`: which single argument a built-in executor tool's card prints, so the line reads `write_file(src/a.ts)` rather than `write_file(path: "src/a.ts", content: "…")` |
| `src/renderer/src/pages/chats-page.tsx` | Stacks the cards between the transcript and the composer, oldest first, and gives the oldest `autoFocus` |
| `src/renderer/src/lib/event-bridge.ts` | Fans `permission.requested` / `permission.resolved` into the store, and `chat.deleted` into `clear` |
| `src/renderer/src/components/chat/message-item.tsx` | Renders the diff blocks and the chip row, under the tool cards and above the agent's own summary |

## State

| Store | Field | Type | Meaning |
|---|---|---|---|
| `permissions` | `pending` | `Record<string, PendingPermission>` | Backend-owned. One entry per open prompt: `requestId`, `chatId`, `agentId`, `toolName`, the raw `input`, and `seq` |
| `permissions` | `replyingById` | `Record<string, boolean>` | Local; true while that card's `permission.reply` is in flight, which disables its three buttons |
| `permissions` | `seq` | `number` | A monotonic arrival counter. Two prompts raised in the same millisecond still have to draw in the order they arrived |

Nothing here is persisted and nothing is optimistic: a card is added by
`permission.requested` and removed by `permission.resolved` (or by a rejected
reply), never by the click that answered it.

## Backend calls

| Call / subscription | Called from | Purpose |
|---|---|---|
| `invoke('permission.reply')` | The card's three buttons and its two shortcuts, through `permissions.reply` | Releases the suspended tool call with `allow`, `deny` or `allowAlways` |
| `subscribe` → `permission.requested` | `lib/event-bridge.ts` | Adds a card. `input` is the only description of what is about to happen |
| `subscribe` → `permission.resolved` | `lib/event-bridge.ts` | Removes it, for every `decision` including `aborted` |
| `subscribe` → `chat.deleted` | `lib/event-bridge.ts` | Drops that chat's cards; the gate has already aborted the prompts |

What the backend imposes, and the renderer honours:

| From the backend | The renderer must |
|---|---|
| `permission.requested` | Draw one card per `requestId`, oldest first. Several may be open at once — a parallel round, or two chats |
| `input` on that event | Render it readably, and for `run_command` **verbatim**: the shell is not sandboxed, so the prompt is the whole security boundary |
| `permission.resolved` | Dismiss the card, whatever the `decision` says. `aborted` is a stop closing a prompt nobody answered |
| `permission.reply` rejecting `not_found` | Treat the card as stale and drop it. It never means the executor is stuck |
| A turn suspended in a prompt | Keep showing the agent as `working`: it is, and its hard timeout is still counting |
| A `tool-result` with `isError: true` reading "The user declined…" | Nothing special. An ordinary failed tool card; the sentence is model-facing text |
| A `DiffPart` on the executor's message | One collapsed block per file, through `code-block.tsx` in the `diff` language |

## Interaction states

| State | What the user sees |
|---|---|
| idle | No card. The composer is where it always is |
| prompt open | A card between the transcript and the composer: `Ada wants to run write_file`, the path, the content preview (or the patch, or the command line in mono), and three buttons. The oldest card is focused, so Enter and Escape work without a click |
| several prompts | One card per request, stacked oldest first. Only the oldest takes focus |
| answering | The three buttons are disabled while the reply is in flight; the card is still there, because the call it belongs to has not returned yet |
| answered, or the run stopped | The card disappears on `permission.resolved`. A denial leaves an errored tool card in the transcript, not a system notice |
| stale card | A reply the backend refuses (`not_found`) removes the card silently. There is nothing the user could do about it and nothing is broken |
| a file was changed | One collapsed `diff-block` per file: `path` on the left, `+n -n` on the right. Opening it renders the unified diff through the shared code block |
| a file is referenced | A `path:line` chip; clicking copies it and the icon becomes a tick for 1.5 s |
| loading / empty / error | n/a. There is nothing to fetch: the store is fed entirely by events, and an empty store is the normal state |

## Copy and i18n

New keys, all under `chat.*`:

| Key | Used by |
|---|---|
| `chat.permissionTitle` | The card's accessible name |
| `chat.permissionRequest` | `{{agent}} wants to run {{tool}}` |
| `chat.permissionAllow`, `chat.permissionAllowAlways`, `chat.permissionDeny` | The three buttons; the middle one is PLAN.md's "always allow in this chat" |
| `chat.permissionKeyHint` | The `Enter allows, Esc denies` line |
| `chat.permissionTruncated` | Shown when the previewed content is shorter than what will be written |
| `chat.permissionCommandHint` | The one line of context a command gets: it runs in this chat's folder, as the user, with their environment |
| `chat.diffExpand`, `chat.diffCollapse` | The diff block's toggle |
| `chat.fileRefTitle` | The chip's tooltip |

Three kinds of text on these surfaces are **not** translated, all for the same
reason — they are data, not copy:

- The **path**, the **command line** and the **patch**. Translating a command
  would be translating the thing the user is being asked to approve.
- The **tool name** (`write_file`), which is an identifier the transcript already
  prints.
- The **denial the model reads** ("The user declined to allow write_file…"),
  which is prompt content produced by `executor/tools.ts` and shown in the tool
  card exactly as an MCP server's error text is. It is deliberately not a
  `notices.*` key, and S5.5 adds no notice keys at all: a denial is already
  visible as the failed tool call it was, and a system notice repeating it would
  be the app narrating the user's own click back to them.

## Accessibility and keyboard

- **Enter allows, Escape denies**, on the card rather than on the document. A
  global listener would take Enter away from the composer, where Enter sends.
- The oldest card is focused when it appears — `tabIndex={-1}`, so it takes no
  Tab stop — and carries `aria-label` from `chat.permissionTitle`. The **card**
  is focused, not the Allow button: a focused default button is one stray Enter
  away from being pressed by someone who was typing, and allowing is meant to be
  a decision.
- `preventDefault` on Enter stops the keypress from also activating a focused
  button, and `reply` ignores a second answer while the first is in flight, so a
  double press cannot send two decisions.
- The diff toggle is a `button` with `aria-expanded`; the chip is a `button`
  with a translated `title`.
- Test hooks, so the end-to-end specs stay language-independent:
  `permission-stack`, `permission-card` (`data-request-id`, `data-tool`,
  `data-agent-id`), `permission-card-title`, `permission-card-path`,
  `permission-card-body` (`data-kind`), `permission-allow`,
  `permission-allow-always`, `permission-deny`, `diff-block` (`data-path`),
  `diff-block-toggle`, `diff-block-path`, `diff-block-stat`, `file-ref`
  (`data-path`, `data-line`), `message-file-refs`.
