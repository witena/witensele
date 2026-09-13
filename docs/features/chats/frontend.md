# chats — Frontend

## Pages and components

| File | Responsibility |
|---|---|
| `src/renderer/src/pages/chats-page.tsx` | The three-column page. Owns the three list loads (chats, agents, providers), the per-chat transcript load, the group-settings block (which writes straight through to `chats.update`) including the S5.2 "Working directory" row, and the folder chip beside the header title |
| `src/renderer/src/components/chat/chat-list.tsx` | The grouped chat list: selection, kebab / right-click menu, inline rename, two-step delete |
| `src/renderer/src/components/chat/message-list.tsx` | The virtualized scroller (react-virtuoso): `followOutput` only while at the bottom, the "jump to latest" pill, and the day separators |
| `src/renderer/src/components/chat/transcript-rows.ts` | The transcript's pure transforms: `buildTranscriptRows` / `dayBucket` (`Message[]` → the flat row array the virtualizer renders) and, since S5.5, `collectDiffs`, `collectFileRefs`, `countDiffLines` and `formatFileRef` — the part-level cases a message row draws. Unit-tested |
| `src/renderer/src/components/chat/message-item.tsx` | One message row: avatar + presence dot, header (name, model badge, round, "replying to @who", time), reasoning, tool cards, the S5.5 diff blocks and file-reference chips, body, streaming cursor, status hint. A `system` message takes the short branch: one centred dimmed line, no avatar and no name |
| `src/renderer/src/components/chat/handoff-button.tsx` | "Hand to executor" (S5.6), between the permission stack and the composer: enabled only for an idle chat with a folder and an executor, and otherwise disabled with the reason in its `title` and in `data-blocked` |
| `src/renderer/src/components/chat/handoff.ts` | `handoffBlocker({ workdir, members, running })` → the `ValidationReason` that disables the button, or `null`. The same three rules the backend applies, in the same order. Pure and unit-tested |
| `src/renderer/src/components/chat/permission-card.tsx` | The executor's permission prompt (S5.5): one card per pending request, above the composer, with Allow / Always allow in this chat / Deny. Enter allows and Escape denies, handled on the card so the composer keeps Enter |
| `src/renderer/src/components/chat/permission-input.ts` | `describePermissionInput`: what the card shows about a call — a command line **verbatim**, a path plus a capped content preview, the patch of an edit, or raw JSON. Pure and unit-tested |
| `src/renderer/src/components/chat/diff-block.tsx` | One `DiffPart`: a collapsed header with the path and the `+`/`-` counts, opening onto `CodeBlock` in the `diff` language. Since S5.7 the header is a row of two buttons and the path opens the file |
| `src/renderer/src/components/chat/file-ref-chip.tsx` | One `FileRefPart` as a `path:line` chip. Since S5.7 clicking it opens the file in the editor (it used to copy the reference); see [`editor`](../editor/frontend.md) |
| `src/renderer/src/components/chat/file-refs.ts` | S5.7's pure path detector, owned by [`editor`](../editor/frontend.md) and listed here because it is what `markdown.tsx` calls |
| `src/renderer/src/components/chat/markdown.tsx` | `react-markdown` + `remark-gfm` with the mockup's prose rules as descendant utilities; hands fenced blocks to `CodeBlock`, wraps tables in their own scroller and marks every link `target="_blank" rel="noreferrer"`. Since S5.7 it also turns the file paths in a body into chips |
| `src/renderer/src/components/chat/code-block.tsx` | A fenced block: language header, Copy button ("Copied" for 1.5 s), shiki markup when a grammar exists and plain monospace otherwise |
| `src/renderer/src/components/chat/code-language.ts` | `resolveCodeLanguage` / `codeLanguageLabel`: the fourteen highlighted languages, their aliases, and `null` for everything else. Pure and unit-tested |
| `src/renderer/src/lib/highlighter.ts` | The memoised shiki core highlighter: the JavaScript regex engine, `vitesse-dark`, and one lazy import per grammar |
| `src/renderer/src/components/chat/tool-card.tsx` | The mockup's one-line tool card, expandable to the pretty-printed input and output. A `read_file` / `write_file` / `edit_file` card carries an "open" icon since S5.7 |
| `src/renderer/src/components/chat/tool-call.ts` | `describeToolCall` / `collectToolCalls`: pairing a `tool-call` with its `tool-result` and summarising both. Pure and unit-tested |
| `src/renderer/src/components/chat/composer.tsx` | Auto-growing textarea (Enter sends, Shift+Enter newline, IME-safe, up to 8 lines), the `@` autocomplete popover, the clickable mention chips plus `@all`, Send / Stop |
| `src/renderer/src/components/chat/mention-query.ts` | `extractMentionQuery` / `filterMentionCandidates` / `insertMention` / `appendMention`: everything the autocomplete could get wrong. Pure and unit-tested |
| `src/renderer/src/components/chat/actions-card.tsx` | The right column's Actions card: the summarise picker and the vote button, both sending an ordinary message |
| `src/renderer/src/components/chat/member-panel.tsx` | The right column: the add-member popover (which since S5.2 greys out a second executor and says why in its sub-line), the member rows (avatar with presence dot, name, the executor badge, `model · presence` — counting up as `away · Ns` — the usage placeholder or, while the member is offline, a Retry button, and remove on hover) and native HTML5 drag-and-drop reordering |
| `src/renderer/src/lib/reorder.ts` | `reorder(list, from, to)`: the index arithmetic behind the drag, pure and unit-tested |
| `src/renderer/src/lib/workdir.ts` | `folderName(path)`: the last segment of a path, for the header chip and the settings row. Hand-written rather than `node:path`, because the renderer has no Node types. Pure and unit-tested |
| `src/renderer/src/i18n/errors.ts` | `translateFailure(t, code, details)`: the one place a store's `errorCode` + `errorDetails` becomes a sentence, and where a `ValidationReason` overrides the generic `validation` copy |
| `src/renderer/src/components/agents/agent-display.ts` | `agentModelLabel`, plus `isExecutor` / `hasExecutor` (S5.2) — shared with the Agents page so all four surfaces that draw the badge read one rule |
| `src/renderer/src/lib/event-bridge.ts` | The single backend subscription; fans every event into the stores |
| `src/renderer/src/lib/message-view.ts` | `wasStopped`, `messageText` (which also strips a trailing `[PASS]`, S4.3) and the stored `'aborted'` detail |
| `src/renderer/src/stores/usage.ts` | The per-chat token and cost summary: seeded from `messages.usageSummary` when a chat is opened, recomputed locally on every `message.updated` |
| `src/renderer/src/main.tsx` | Starts the event bridge before the first render |

## State

| Store | Field | Type | Meaning |
|---|---|---|---|
| `chats` | `chats` | `Chat[]` | Backend-owned, newest `updatedAt` first. Replaced by `chats.list`, upserted by `chat.updated`, filtered by `chat.deleted` |
| `chats` | `membersByChat` | `Record<string, string[]>` | Backend-owned member agent ids, in speaking order. Written only by `setMembers`, which goes through the backend first |
| `chats` | `selectedId` | `string \| null` | Local UI state, not persisted |
| `chats` | `status` / `error` / `errorCode` / `errorDetails` | | Load state and the last failure. `errorDetails` is the rejection's own `details`, which may carry a `ValidationReason` — that is what turns "the request was rejected as invalid" into "that folder no longer exists" |
| `messages` | `byChat` | `Record<string, Message[]>` | Backend-owned, **oldest first** |
| `messages` | `status` | `Record<string, MessagesStatus>` | Per chat, so one failed load does not blank the others |
| `run` | `activeByChat` | `Record<string, ActiveRun>` | Backend-owned; set by `run.started` / `run.round`, cleared by `run.finished`. Drives the Stop button |
| `run` | `sendingByChat` | `Record<string, boolean>` | Local; covers the `chat.send` round trip before `run.started` arrives |
| `run` | `error` / `errorCode` | | The last refused send, shown under the composer. Cleared on a new send, on a chat switch and when the membership changes |
| `presence` | `byChatAgent` | `Record<string, AgentPresence>` | Runtime only, keyed `chatId:agentId`, never persisted. Seeded from `presence.list` when a chat is opened; see [`presence`](../presence/frontend.md) |
| `agents` | `agents` | `Agent[]` | Backend-owned; the Agents page (S2.1) writes it, this page only reads |
| `providers` | `providers` | `Provider[]` | Backend-owned; the member picker prints the provider's name beside the model, and the usage store reads each provider's `presetId` to know whether its tokens are free |
| `chats` | `searchQuery` / `matchIds` | `string` / `string[] \| null` | The debounced query and what it matched. `null` means "no filter", which is how the column tells that apart from "filtered and nothing matched" |
| `usage` | `byChat` | `Record<string, ChatUsageSummary>` | Total and per-agent tokens plus an estimated cost. Seeded by `messages.usageSummary`, then recomputed from the messages store |
| `permissions` | `pending` | `Record<string, PendingPermission>` | Backend-owned, keyed by `requestId`. Filled by `permission.requested`, emptied by `permission.resolved` — the only two writers. `seq` orders the cards oldest first |
| `permissions` | `replyingById` | `Record<string, boolean>` | Local; covers the `permission.reply` round trip and disables that card's three buttons. Nothing is optimistic: a card disappears when the backend says the prompt ended |
| `messages` | `complete` | `Record<string, boolean>` | True when the store holds the **whole** transcript rather than a page. The usage store recomputes locally only when it does |

Selectors worth knowing: `useChatMessages(chatId)`, `useChatMemberIds(chatId)`,
`useIsRunning(chatId)`, `useAgentPresence(chatId, agentId)`, `useAgent(id)`. Each
returns a stable reference for the empty case, because a fresh array from a
selector re-renders on every store write.

## Backend calls

| Call / subscription | Called from | Purpose |
|---|---|---|
| `invoke('chats.list')` + `invoke('chats.members.list')` | `chats.load()`, from the page's mount effect | The left column and its "N members" subtitles |
| `invoke('chats.create')` | The "+" button | Creates and selects a chat; also reloads `agents` because the bootstrap agent may have just been created |
| `invoke('chats.update')` | Inline rename | Title change; the row floats to the top |
| `invoke('chats.delete')` | The menu's second Delete click | Removes the chat and its transcript |
| `invoke('messages.list')` | The page's `selectedId` effect, once per chat | The first (and for now only) page of the transcript |
| `invoke('messages.usageSummary')` | The page's `selectedId` effect, on **every** visit | Seeds the header and member-row token counts over the whole transcript, not just the loaded page |
| `invoke('chats.search')` | The search box, debounced 200 ms | The ids the left column keeps while a query is active |
| `invoke('agents.list')` | `agents.load()` on mount and after a chat is created | Author name, avatar and model badge |
| `invoke('chat.send')` | Composer, Enter or the Send button — and the Actions card, through the composer's `submitText` handle | Stores the message and schedules a run |
| `invoke('chats.members.set')` | The picker, the row's "×", and a drop | Replaces the whole member list, order included |
| `invoke('chats.update')` | Every group-settings control | Persists one `ChatSettings` field immediately; no Save button and no debounce |
| `invoke('system.pickFolder')` + `invoke('chats.update')` | "Choose…" in the Working directory row, through `chooseWorkdir` | The native modal, then the binding. A cancelled dialog writes nothing and leaves no error |
| `invoke('chats.update')` | "Clear" in the Working directory row, through `setWorkdir(id, null)` | Unbinds the folder; the one path that needs no dialog |
| `invoke('providers.list')` | `providers.load()` on mount | The provider name in the member picker |
| `invoke('chat.handoff')` | The "Hand to executor" button, through `run.handoff(chatId)` | Stores the hand-off message and runs implement + review ([`orchestration`](../orchestration/frontend.md)). Refused with the same three reasons the button is disabled for, which the composer's error line then prints |
| `invoke('chat.stop')` | The Stop button | Aborts the run — which also closes every open permission prompt as `aborted` |
| `invoke('permission.reply')` | The permission card's three buttons, through `permissions.reply` | Releases the suspended tool call. A rejection (`not_found`) drops the card: the prompt is stale, not broken |
| `subscribe(...)` | `startEventBridge()` in `main.tsx`, once at bootstrap | Fans `message.*`, `chat.*`, `run.*` and `presence.changed` into the stores |

Event handling is written once, in `lib/event-bridge.ts`:

- `message.created` → upsert (not push: `chat.send` resolves with the same
  message and the two can arrive in either order).
- `message.delta` → `text` / `reasoning` append to the **last part of that
  kind**, starting a new part when the kind differs; `part` pushes a whole part.
- `message.updated` → replace the message; authoritative for status, usage and
  error.
- `chat.updated` → upsert and re-sort. `chat.deleted` → drop the chat, its
  transcript, its presences and its run state.
- `run.started` / `run.round` → set the active run. `run.finished` → clear it.
- `presence.changed` → update the dot, both in the member panel and on that
  agent's message avatars.
- `permission.requested` → add a card. `permission.resolved` → remove it,
  whatever the `decision` says (`aborted` is a Stop closing a prompt nobody
  answered).

## Interaction states

| State | What the user sees |
|---|---|
| idle | Composer enabled with a Send button; no Stop. "Hand to executor" above it is enabled when the chat has a folder and an executor, and disabled — with the missing rule in its tooltip — when it does not |
| loading | The list and the transcript are simply empty while the first call resolves |
| streaming | The agent's row grows token by token with a blinking accent cursor, its presence dot is red, and Send is replaced by Stop. While *reasoning* is arriving and the text has not started, the reasoning block is auto-expanded and pulsing; it collapses again on the first text token, unless the user has toggled it by hand |
| scrolled up | New messages no longer move the viewport; a floating "Jump to latest" pill appears and scrolls to the end |
| autocomplete open | A popover above the composer lists the matching members (avatar, `@name`, model) plus `@all`. ↑/↓ move, Enter and Tab insert `@Name `, Escape closes, a click does what Enter does |
| tool call | A one-line card — wrench, `serverName · toolName(argsPreview)`, and "running…" / "n results · expand" / "error" — which expands to the pretty-printed input and output. Real from S3.1; `data-tool` is the tool's own name and `data-server` the MCP server it came from |
| system notice | A centred dimmed line across the column, with no avatar, no name and no timestamp. It keeps `data-notice-key` |
| empty | "No chats yet" in the left column, "Nothing here yet" with no chat selected, "No messages yet" in a new chat, "No members yet" if a chat somehow has none |
| error (call) | The left column shows the translated `BackendError.code` under the list — the first-run "no provider with models" path lands here |
| error (message) | The row keeps whatever text arrived and adds a red hint: "Stopped" when `error === 'aborted'`, otherwise "The reply failed" |
| passed / skipped | The whole row is dimmed and the body is replaced by the "Passed" / "Skipped" label |
| no members | The member panel shows its empty state plus an accent hint ("Add at least one agent"), and a send is refused with a red line under the composer. The composer itself stays enabled |
| picker open | A popover under "+ Add" listing the agents that are not members yet (avatar, name, `model · provider`); it closes on a pick, on an outside click, and when the chat changes |
| dragging a member | The dragged row is at 50% opacity; dropping on another row writes the new order through `chats.members.set` |
| executor member | An accent `executor` chip next to the name, in the member row and on every message that agent sends. The agent list on the Agents page carries the same chip |
| second executor offered | The picker's row is disabled and at 55% opacity, and its mono model line is replaced by `chat.executorTaken`. The click is not merely ignored — there is nothing to click |
| folder bound | An accent chip beside the chat title holding the folder's **name**, with the whole path in its `title`; the settings row prints the same name in mono and enables "Clear" |
| folder refused | The left column's `chats-error` line names the reason: not absolute, no longer there, or a file rather than a folder |
| permission prompt open | A card between the transcript and the composer: the agent and the tool, the call itself (a command line verbatim in mono, a path plus a content preview, or a patch), and Allow / Always allow in this chat / Deny. The oldest card takes focus, so Enter and Escape work without a click. The agent stays `working` — its turn is suspended inside the tool call, not stalled |
| permission answered, or the run stopped | The card disappears on `permission.resolved`. A denial is not a system notice: it comes back as an errored tool card carrying the sentence the **model** read |
| a file was changed | One collapsed `diff-block` per file under the tool cards, headed by the path with `+n -n`; opening it renders the unified diff through the same `code-block` a fenced diff uses. The path itself opens the file (S5.7) |
| a file is referenced | A `path:line` chip. Clicking opens the file in the editor (S5.7); a refused open turns the chip red for 2.5 s. A reference with no absolute path to open is plain text, not a button |

Sending during a run is deliberately allowed: the message appears immediately and
is answered after the current run (see `../orchestration/context.md`).

## Copy and i18n

New keys, all under the existing namespaces:

| Key | Used by |
|---|---|
| `common.you` | The user's name and monogram in the message list |
| `chat.memberCount` | The "N members" subtitle (`{{members}}`, not `count`, so i18next does not switch to plural resolution) |
| `chat.chatOptions`, `chat.rename`, `chat.renameChat`, `chat.deleteChat`, `chat.deleteConfirm` | The row menu and the inline rename field |
| `chat.emptyMessagesTitle`, `chat.emptyMessagesDescription` | A chat with no messages yet |
| `chat.reasoning` | The collapsible reasoning toggle |
| `chat.stopped`, `chat.failed` | The two `error` hints |
| `chat.addMember`, `chat.addMemberAll`, `chat.addMemberEmpty` | The picker's button and its two "nothing to add" cases |
| `chat.removeMember`, `chat.reorderMember` | The row's "×" and the drag tooltip |
| `chat.noMembersHint` | The accent hint under the empty member list |
| `chat.memberUsage`, `chat.memberUsageTitle` | The per-member column: an em dash for a member that has not spoken, otherwise the formatted token count, with the tooltip explaining what it counts |
| `chat.usage`, `chat.usageWithCost`, `chat.usageTitle` | The header's `12.4k tokens` / `12.4k tokens · $0.04` and its tooltip |
| `chat.messageUsage`, `chat.messageUsageWithCost` | The model badge's tooltip on one message: `In … · out …`, plus the cost when there is one |
| `chat.searchEmptyTitle`, `chat.searchEmptyDescription` | The empty state when a query matches no chat (distinct from "no chats yet") |
| `chat.jumpToLatest` | The pill that appears when a message arrives while the user is scrolled up |
| `chat.workdir`, `chat.workdirHint`, `chat.workdirNone`, `chat.workdirChoose`, `chat.workdirClear` | The Working directory row. The **path itself is never translated** — it is data, printed as it is stored |
| `chat.executorTaken` | The picker's sub-line on a second executor |
| `agents.executorBadge`, `agents.executorBadgeTitle` | The chip and its tooltip, shared with the Agents page — the copy belongs to the role, which `agents` owns |
| `chat.handoff`, `chat.handoffTitle` | The "Hand to executor" button and its tooltip while it is enabled (S5.6) |
| `errors.workdir_not_absolute`, `errors.workdir_missing`, `errors.workdir_not_directory`, `errors.second_executor`, `errors.handoff_no_workdir`, `errors.handoff_no_executor`, `errors.handoff_run_active` | The `ValidationReason` sentences, resolved by `translateFailure`. The last three are also the **disabled** hand-off button's tooltip: one set of words whether the rule is applied before the click or after it |
| `chat.mentionAllHint` | The subtitle of the popover's `@all` row |
| `chat.copy`, `chat.copied`, `chat.copyCode` | The code block's Copy button, its confirmed state and its accessible name |
| `chat.toolRunning`, `chat.toolDone`, `chat.toolError`, `chat.toolResults`, `chat.toolExpand`, `chat.toolCollapse`, `chat.toolInput`, `chat.toolOutput` | The tool card |
| `chat.actions.title`, `.summarize`, `.vote` | The Actions card's heading and its two buttons (S2.5 nested what were three flat keys) |
| `chat.permissionTitle`, `chat.permissionRequest`, `chat.permissionAllow`, `chat.permissionAllowAlways`, `chat.permissionDeny`, `chat.permissionKeyHint`, `chat.permissionTruncated`, `chat.permissionCommandHint` | The permission card (S5.5). The **call itself is never translated**: a path, a command line and a patch are data |
| `chat.diffExpand`, `chat.diffCollapse` | The diff block's toggle |
| `chat.fileRefTitle`, `chat.fileRefFailed`, `chat.openInEditor` | The file-reference chip's two tooltips, and the one on the diff header and the tool card's "open" icon (S5.7, [`editor`](../editor/frontend.md)) |
| `chat.actions.summarizePrompt`, `chat.actions.votePrompt` | The **message text** each action sends, after the `@mention`. A locale key rather than a constant, because an agent answers in the language it is addressed in |

Already present and now actually used: `chat.today` / `yesterday` / `earlier`,
`chat.round`, `chat.passed`, `chat.skipped`, `chat.send`, `chat.stop`,
`chat.composerPlaceholder`, `chat.mentionHint`, `presence.*`.

Stored `system-notice` parts are rendered with `translateNotice(t, part)`; the
backend never sends a sentence. Message text itself is user and model content and
is never translated.

## Accessibility and keyboard

- **Enter** sends, **Shift+Enter** inserts a newline, and an Enter that ends an
  IME composition (`event.nativeEvent.isComposing`) does neither — it commits the
  candidate.
- The rename field is focused and selected on open; **Enter** commits, **Escape**
  and blur cancel.
- Every icon-only control has a translated `aria-label` (`IconButton` requires
  one): the "+" button, the row kebab, Send.
- The reasoning toggle is a `button` with `aria-expanded`.
- Presence dots on message avatars and on member avatars carry a translated
  `role="img"` name; the member row also prints the state in words next to the
  model.
- Reordering is mouse-only for now. That is a known gap: it is the one control on
  this screen with no keyboard path, and since S2.3 reads `position` every round
  it decides the speaking order of every discussion.
- The autocomplete is a `role="listbox"` of `role="option"` buttons with
  `aria-selected` on the highlighted row, driven entirely from the textarea: the
  focus never leaves the box, which is what lets Escape and Enter keep their
  normal meanings the moment the popover closes.
- The reasoning toggle, the tool card's toggle and the code block's Copy button
  are all `button`s; the first two carry `aria-expanded` and Copy carries a
  translated `aria-label` because its own text changes to "Copied".
- Each message is an `<article>` carrying `data-sender`, `data-status`,
  `data-round` and `data-author` (and `data-notice-key` on a system notice),
  which is what the end-to-end specs assert on so they stay
  language-independent. S2.5 added `data-testid="day-separator"` with
  `data-bucket`, `code-block` with `data-language`, `tool-card` with `data-tool`
  and `data-state`, `mention-popover` / `mention-option` with `data-name`, and
  `mention-chip` / `mention-chip-all`; every existing attribute was kept.
  S5.2 added `chat-workdir` (with `data-path`, empty when unbound),
  `chat-workdir-chip`, `chat-workdir-choose`, `chat-workdir-clear`,
  `member-executor`, `member-candidate-executor`, `message-executor` and
  `data-blocked` on `member-candidate`. S5.5 added `permission-stack`,
  `permission-card` (with `data-request-id`, `data-tool` and `data-agent-id`),
  `permission-card-title`, `permission-card-path`, `permission-card-body` (with
  `data-kind`), `permission-allow`, `permission-allow-always`,
  `permission-deny`, `diff-block` (with `data-path`), `diff-block-toggle`,
  `diff-block-path`, `diff-block-stat`, `file-ref` (with `data-path` and
  `data-line`) and `message-file-refs`. S5.7 added `diff-block-more`,
  `tool-card-open` (with `data-path`), `data-openable` on `file-ref`, and
  `settings-editor` with `editor-vscode` / `editor-cursor` / `editor-custom` and
  `settings-editor-command`.
- **The permission card owns Enter and Escape only while it is focused.** The
  shortcuts are on the card element, not on the document: a global listener would
  take Enter away from the composer, where it sends. The oldest card is focused
  when it appears (`tabIndex={-1}`, so it takes no Tab stop) and the buttons keep
  their own focus ring; the card carries `aria-label` from
  `chat.permissionTitle`.
- Since S5.7 the diff header is **two** buttons rather than one containing
  another (invalid, and unreachable by keyboard): the toggle, and the path that
  opens the file, with the expand/collapse word as a third.
- The diff block's toggle is a `button` with `aria-expanded`; the file-reference
  chip is a `button` with a translated `title`.
