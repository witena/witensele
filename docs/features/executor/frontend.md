# executor — Frontend

This feature has **no UI yet**. S5.4 is the backend half: the tools, the folder
confinement and the permission gate all run in the main process, and the only
renderer file it touched is a comment in `src/renderer/src/lib/event-bridge.ts`
saying who will own the two new events.

S5.5 builds the visible half — `stores/permissions.ts`, the `PermissionCard`
above the composer, the `DiffPart` block and the `FileRefPart` chip — and this
document is rewritten then. What the backend half already **imposes** on it is
worth stating now, because each one is a contract the card has to honour:

| From the backend | The renderer must |
|---|---|
| `permission.requested` | Draw one card per `requestId`, oldest first. Several may be open at once — a parallel round can have two executors of two chats waiting |
| `input` on that event | Render it readably: the path and a preview for `write_file`, the path and the `patch` for `edit_file`, the command line for `run_command`, raw JSON for an MCP tool. It is the **only** description of what is about to happen, and for `run_command` it is the whole security boundary — show the command verbatim, never summarised |
| `permission.resolved` | Dismiss the card, whatever the `decision` says. `aborted` means the run was stopped while it was open, and the user must not be left answering a prompt nobody is waiting on |
| `permission.reply` rejecting `not_found` | Treat the card as stale and drop it. It never means the executor is stuck |
| A turn suspended in a prompt | Keep showing the agent as `working`: it is, and the supervisor is still counting against its hard timeout |
| A `tool-result` whose `output` has a `patch` | That is a write. S5.5 renders the unified diff with the existing `code-block.tsx` in the `diff` language |
| A `tool-result` with `isError: true` reading "The user declined…" | Nothing special. It is an ordinary failed tool card; the sentence is model-facing text, like an MCP server's error |

## Copy and i18n

**This step adds no locale keys.** Two kinds of user-visible text are involved
and neither needs one:

- The **tool errors** ("The user declined to allow write_file…") are prompt
  content written for the model and shown in the tool card exactly as an MCP
  server's error text is. They are not backend-authored UI copy, so CLAUDE.md
  rule #4 does not turn them into `notices.*` keys.
- The **card's own copy** — the three buttons, the labels around the tool name —
  is S5.5's, and lands in both `en.json` and `zh-CN.json` with it.

The path printed in a prompt or a diff header is **data** and is never
translated, the same rule the working-directory chip follows (S5.2).
