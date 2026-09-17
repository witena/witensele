# chats — Frontend

## Pages and components

| File | Responsibility |
|---|---|
| `src/renderer/src/pages/chats-page.tsx` | The three-column page. Owns the three list loads (chats, agents, providers), the per-chat transcript load, the group-settings block (which writes straight through to `chats.update`) including the S5.2 "Working directory" row, the folder chip beside the header title, and — since S5.10 — the goal-status load and the two goal surfaces it hosts |
| `src/renderer/src/components/onboarding/onboarding-card.tsx` | **S7.5.** The first-run card, drawn in the conversation column in place of the "no chat selected" empty state. Five steps done in place, the first three of them the provider editor's own components (see [`providers`](../providers/frontend.md)), then the agent templates and the button that creates the first chat. Exports `useOnboarding()`, which the page calls to decide which of the two to render |
| `src/renderer/src/lib/onboarding.ts` | `onboardingState(input)` and `credentialReady(draft, authStatus)`: which step is current, and whether the card should be on screen at all. Pure and unit-tested, like `handoff.ts` and `goal.ts` |
| `src/renderer/src/components/chat/goal-settings.tsx` | The **Goal** block (S5.10) under the Working directory row: the kind `SegmentedControl` (Document and Codebase disabled without a folder, with the reason under them), the description, the deliverable and its "Choose…", and the materials list with "Add…". The one block in the panel that holds a **draft**, because a goal is one JSON column and two of its fields are free text; it writes on blur |
| `src/renderer/src/components/chat/grants-list.tsx` | The **Always allowed** block (S5.15), last in the group settings: one monospace row per standing permission grant, newest first, each with a revoke button that appears on hover, or an empty line saying how a row gets there. Owned by [`executor`](../executor/frontend.md); hosted here |
| `src/renderer/src/components/chat/goal-chip.tsx` | The goal chip in the header (S5.10). Four states, one of which is a button: a **delivered** document opens in the editor through S5.7's `openInEditor`, and a refused open paints the chip red for 2.5 s |
| `src/renderer/src/components/chat/goal.ts` | `goalChipState(goal, status)`: which of those four states to draw, and what to open. Pure and unit-tested; the component turns it into `t()` copy |
| `src/renderer/src/components/chat/chat-list.tsx` | The grouped chat list: selection, kebab / right-click menu, inline rename, two-step delete. Since S5.16 a row's subtitle is the chat's **conclusion** (`chat-item-conclusion`, the translated label plus its first line) when `conclusionPreviews` has one for it, and the member count otherwise |
| `src/renderer/src/components/chat/message-list.tsx` | The virtualized scroller (react-virtuoso): `followOutput` only while at the bottom, the "jump to latest" pill, the day separators, and (S5.16) `scrollTo`, which the header's Conclusion chip uses to bring one message back into view |
| `src/renderer/src/components/chat/transcript-rows.ts` | The transcript's pure transforms: `buildTranscriptRows` / `dayBucket` (`Message[]` → the flat row array the virtualizer renders, each message row carrying `conclusion` since S5.16) and, since S5.5, `collectDiffs`, `collectFileRefs`, `countDiffLines` and `formatFileRef` — the part-level cases a message row draws. Unit-tested |
| `src/renderer/src/components/chat/conclusion-card.tsx` | The conclusion card (S5.16): the "Conclusion" label, the accent edge, the body, the speaker underneath, **Copy** (the markdown source, through `navigator.clipboard`) and **Write to the deliverable** (`chat.handoff` with `intent: 'deliver'`) |
| `src/renderer/src/components/chat/conclusion.ts` | `latestConclusion`, `conclusionPreview`, `deliverableBlocker` and the `ConclusionPreviews` alias: the pure rules behind the card, the header chip and the chat-list preview. Unit-tested |
| `src/renderer/src/components/chat/message-item.tsx` | One message row: avatar + presence dot, header (name, model badge, round, "replying to @who", time), reasoning, tool cards, the S5.5 diff blocks and file-reference chips, body, streaming cursor, status hint. A `system` message takes the short branch: one centred dimmed line, no avatar and no name. A row the row model marked `conclusion` (S5.16) draws its body inside `ConclusionCard` — the header above it is unchanged, and `message-text` stays exactly where it was |
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
| `src/renderer/src/components/chat/actions-card.tsx` | The right column's Actions card: the summarise picker and the vote button, both sending an ordinary message — the vote with `VOTE_ROUNDS` (`1`, S5.14), so it runs one round whatever the chat's Max automatic rounds says — and, since S5.12, "Write the deliverable" (`chat-write-deliverable`), the one row that does **not**: it is `chat.handoff` with `intent: 'deliver'`, owned by [`orchestration`](../orchestration/frontend.md) and disabled by the same `handoffBlocker` as the button above the composer |
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
| `chats` | `goalStatusByChat` | `Record<string, ChatGoalStatus>` | Backend-owned (S5.10), from `chats.goalStatus`. A chat with no entry has simply not been asked about yet, which the chip draws as "not delivered" rather than as a third state |
| `chats` | `selectedId` | `string \| null` | Local UI state, not persisted |
| `settings` | `settings.onboardingDismissed` | `boolean` | Backend-owned (S7.5). Read by `useOnboarding`, written once by the card's Skip link through `dismissOnboarding()` |
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
`useIsRunning(chatId)`, `useAgentPresence(chatId, agentId)`, `useAgent(id)`, and
since S7.5 `useHasChatWithMembers()` — a boolean, because it is the single fact
that ends the first-run card and a derived array would re-render it on every
write. Each
returns a stable reference for the empty case, because a fresh array from a
selector re-renders on every store write.

## Backend calls

| Call / subscription | Called from | Purpose |
|---|---|---|
| `invoke('chats.list')` + `invoke('chats.members.list')` | `chats.load()`, from the page's mount effect | The left column and its "N members" subtitles |
| `invoke('chats.create')` | The "+" button, and (S7.5) the first-run card's "Start chat" | Creates and selects a chat; also reloads `agents` because the bootstrap agent may have just been created. The card passes `memberAgentIds`: once the agent library is non-empty the backend creates an **empty** chat, so the card names the agent it has just made rather than producing a chat nobody can speak in |
| `invoke('agents.create')` | The card's template tiles (S7.5), through `agents.createFromTemplate` | The first agent, from `@shared/agent-templates` |
| `invoke('settings.update', { patch: { onboardingDismissed: true } })` | The card's Skip link (S7.5) | Hides the card for this installation |
| `invoke('chats.update')` | Inline rename | Title change; the row floats to the top |
| `invoke('chats.delete')` | The menu's second Delete click | Removes the chat and its transcript |
| `invoke('messages.list')` | The page's `selectedId` effect, once per chat | The first (and for now only) page of the transcript |
| `invoke('messages.usageSummary')` | The page's `selectedId` effect, on **every** visit | Seeds the header and member-row token counts over the whole transcript, not just the loaded page |
| `invoke('chats.search')` | The search box, debounced 200 ms | The ids the left column keeps while a query is active |
| `invoke('agents.list')` | `agents.load()` on mount and after a chat is created | Author name, avatar and model badge |
| `invoke('chat.send')` | Composer, Enter or the Send button — and the Actions card, through the composer's `submitText` handle, which since S5.14 also carries an optional `rounds` | Stores the message and schedules a run |
| `invoke('chats.members.set')` | The picker, the row's "×", and a drop | Replaces the whole member list, order included |
| `invoke('chats.update')` | Every group-settings control | Persists one `ChatSettings` field immediately; no Save button and no debounce |
| `invoke('system.pickFolder')` + `invoke('chats.update')` | "Choose…" in the Working directory row, through `chooseWorkdir` | The native modal, then the binding. A cancelled dialog writes nothing and leaves no error |
| `invoke('chats.update')` | "Clear" in the Working directory row, through `setWorkdir(id, null)` | Unbinds the folder; the one path that needs no dialog |
| `invoke('chats.update')` | Every control in the Goal block, through `setGoal(id, goal)` | Persists the **whole** goal; `null` removes it, which is what emptying the description does |
| `invoke('chats.goalStatus')` | The page's `selectedId` / `updatedAt` / `running` / round effect, and after every `setGoal` | Whether the deliverable is on disk. Re-asked whenever the chat changes, at every round boundary and at the end of a run (S5.12), because a column nobody refreshed would be wrong the moment anything wrote the file. An answer identical to the one already held writes nothing, so the extra asks cost no re-render |
| `invoke('system.pickSavePath')` | "Choose…" in the Goal block, through `pickDeliverable(workdir)` | The native save dialog. Its absolute answer becomes a relative path, or the pick is refused with `goal_deliverable_outside_workdir` |
| `invoke('system.pickPaths')` | "Add…" in the Materials list, through `pickMaterials(workdir)` | Files and folders, multi-select. The picks inside the folder are kept and the ones outside are reported: six files with one stray among them meant the six |
| `invoke('providers.list')` | `providers.load()` on mount | The provider name in the member picker |
| `invoke('chat.handoff')` | The "Hand to executor" button, through `run.handoff(chatId)`; the Actions card's "Write the deliverable", through `run.handoff(chatId, 'deliver')` (S5.12); and the same call from the conclusion card's own "Write to the deliverable" (S5.16) | Stores the hand-off message and runs implement + review ([`orchestration`](../orchestration/frontend.md)). Refused with the same four reasons the controls are disabled for, which the composer's error line then prints |
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
  answered, and S5.15's `timeout` is one nobody answered in time). An
  `allowAlways` resolution additionally reloads that chat's grants, so the
  **Always allowed** block gains its row without the panel being reopened.

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
| first run (S7.5) | With no chat selected and nothing set up yet, the conversation column shows the **onboarding card** instead of "Nothing here yet": five numbered steps, the current one expanded with its controls, the finished ones ticked, Skip in the footer. `data-step` on the card names the current step and each row carries `data-state` (`done` / `current` / `todo`). It disappears the moment a chat has a member, and for good once Skip is pressed |
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
| chat with no folder | The Goal block's Document and Codebase segments are disabled and a hint under them says to choose a working directory. Discussion stays available: a chat can be about something without owning a folder |
| chat with no grants | **Always allowed** shows one line: nothing yet, and that "Always allow" on a prompt is what adds a row (S5.15) |
| chat with grants | One row per tool, newest first, with a revoke button on hover. Revoking removes the row — redrawn from what the backend answers, never optimistically — and the tool asks again from its next call |
| goal set | A chip beside the folder chip. `discussion` / `codebase` show the kind; `document` shows the deliverable's **file name**, with the whole relative path in the tooltip |
| deliverable written | The same chip reads `name · Delivered`, turns accent and becomes a button that opens the file (S5.7). A refused open paints it red for 2.5 s, exactly as a file-reference chip does. Since S5.12 it flips without the user touching anything: the query is re-asked at every round boundary and at the end of a run, so the executor turn that wrote the file is what changes the header |
| the deliverable can be written | The Actions card's third row, "Write the deliverable", is enabled: the chat has a folder, an executor and a `document` goal naming a file, and no run is going. Otherwise it is disabled with the reason in its tooltip and in `data-blocked`, exactly like "Hand to executor" |
| an executor turn delivered the file | That message carries a `path:line` chip for the deliverable, under its diff blocks — the one file-reference chip in the product the **backend** authored rather than the text detector (S5.12) |
| goal refused | The `chats-error` line names the field: a description that is blank or too long, a missing deliverable, a path that is not relative, one that leaves the folder, or a material that is not there |
| material picked outside the folder | The same line, from the **renderer** rather than from a rejection — the dialogs cannot be confined, so the conversion is where it is noticed. The picks that were inside are still added |
| permission prompt open | A card between the transcript and the composer: the agent and the tool, the call itself (a command line verbatim in mono, a path plus a content preview, or a patch), and Allow / Always allow in this chat / Deny. The oldest card takes focus, so Enter and Escape work without a click. The agent stays `working` — its turn is suspended inside the tool call, not stalled |
| permission answered, or the run stopped | The card disappears on `permission.resolved`. A denial is not a system notice: it comes back as an errored tool card carrying the sentence the **model** read |
| a file was changed | One collapsed `diff-block` per file under the tool cards, headed by the path with `+n -n`; opening it renders the unified diff through the same `code-block` a fenced diff uses. The path itself opens the file (S5.7) |
| a file is referenced | A `path:line` chip. Clicking opens the file in the editor (S5.7); a refused open turns the chip red for 2.5 s. A reference with no absolute path to open is plain text, not a button |
| the group reached a conclusion (S5.16) | The closing turn's message is drawn as a card: an accent left edge, the word "Conclusion" above the body, the speaker named underneath, and **Copy**. In a chat with a `document` goal the card also offers **Write to the deliverable**, disabled with its reason when the hand-off rules say so and absent entirely when the goal is not a document |
| a conclusion has been copied | The Copy button reads "Copied" and turns accent for two seconds (`data-copied="true"`). What is on the clipboard is the **markdown source**, not the rendered text |
| a chat holds a conclusion | An accent "Conclusion" chip in the header beside the goal chip, carrying `data-message-id`. Clicking scrolls the transcript to that card, centred, and clicking it again scrolls back to it |
| the chat list has read a chat's transcript | That row's subtitle is the conclusion's first line behind the translated label, instead of "N members". A chat that has never been opened keeps the count |

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
| `chat.goal`, `chat.goalHint`, `chat.goalKindDiscussion`, `chat.goalKindDocument`, `chat.goalKindCodebase`, `chat.goalNeedsWorkdirHint` | The Goal block's heading, its three segments and the hint under the two that need a folder |
| `chat.grantsTitle`, `chat.grantsEmpty`, `chat.grantsHint`, `chat.grantRevoke` | The Always allowed block (S5.15). The **tool name itself is never translated** — it is an identifier, printed as the transcript prints it, the same rule the working directory follows |
| `chat.goalDescription`, `chat.goalDescriptionPlaceholder`, `chat.goalDeliverable`, `chat.goalDeliverablePlaceholder`, `chat.goalDeliverableChoose` | The description box, the deliverable field and its picker button. The paths are data and are never translated |
| `chat.goalMaterials`, `chat.goalMaterialsAdd`, `chat.goalMaterialsNone`, `chat.goalMaterialRemove` | The materials list, its "Add…" and each row's remove button. Since S5.11 the rows are what every member is shown before the first round; the panel says nothing about how much of them fits, and `notices.materialsTruncated` is what reports that after the fact |
| `chat.goalDelivered`, `chat.goalChipTitleDiscussion`, `chat.goalChipTitleCodebase`, `chat.goalChipTitleDocument`, `chat.goalChipTitleDelivered` | The header chip's label and its four tooltips (`{{path}}` in the last two) |
| `errors.goal_description_empty`, `errors.goal_description_too_long`, `errors.goal_deliverable_required`, `errors.goal_deliverable_not_relative`, `errors.goal_deliverable_outside_workdir`, `errors.goal_material_not_relative`, `errors.goal_material_outside_workdir`, `errors.goal_material_missing`, `errors.goal_needs_workdir` | S5.10's nine `ValidationReason` sentences, resolved by `translateFailure` — whether the refusal came from the backend or, for the two `outside_workdir` ones, from the renderer's own conversion |
| `chat.executorTaken` | The picker's sub-line on a second executor |
| `agents.executorBadge`, `agents.executorBadgeTitle` | The chip and its tooltip, shared with the Agents page — the copy belongs to the role, which `agents` owns |
| `chat.handoff`, `chat.handoffTitle` | The "Hand to executor" button and its tooltip while it is enabled (S5.6) |
| `errors.workdir_not_absolute`, `errors.workdir_missing`, `errors.workdir_not_directory`, `errors.second_executor`, `errors.handoff_no_workdir`, `errors.handoff_no_executor`, `errors.handoff_run_active` | The `ValidationReason` sentences, resolved by `translateFailure`. The last three are also the **disabled** hand-off button's tooltip: one set of words whether the rule is applied before the click or after it |
| `chat.mentionAllHint` | The subtitle of the popover's `@all` row |
| `chat.copy`, `chat.copied`, `chat.copyCode` | The code block's Copy button, its confirmed state and its accessible name |
| `chat.toolRunning`, `chat.toolDone`, `chat.toolError`, `chat.toolResults`, `chat.toolExpand`, `chat.toolCollapse`, `chat.toolInput`, `chat.toolOutput` | The tool card — which since S5.11 also appears on a **participant's** message, for `read_file`, `list_dir`, `search_files` or `git_diff`, with no permission card in front of it because those four never ask |
| `notices.materialsTruncated` | Written once per chat by `ChatRunner` when a member could not fit the goal's materials (S5.11); rendered like every other notice by `translateNotice` |
| `chat.actions.title`, `.summarize`, `.vote` | The Actions card's heading and its two buttons (S2.5 nested what were three flat keys) |
| `chat.permissionTitle`, `chat.permissionRequest`, `chat.permissionAllow`, `chat.permissionAllowAlways`, `chat.permissionDeny`, `chat.permissionKeyHint`, `chat.permissionTruncated`, `chat.permissionCommandHint` | The permission card (S5.5). The **call itself is never translated**: a path, a command line and a patch are data |
| `chat.diffExpand`, `chat.diffCollapse` | The diff block's toggle |
| `chat.fileRefTitle`, `chat.fileRefFailed`, `chat.openInEditor` | The file-reference chip's two tooltips, and the one on the diff header and the tool card's "open" icon (S5.7, [`editor`](../editor/frontend.md)) |
| `chat.onboarding.*` (S7.5) | The first-run card: `title`, `description`, the five `step*` labels, `saveProvider`, `startChat`, `skip`, `skipHint`. The agent templates' **names** are not here — they are stored content (`@shared/agent-templates`), like a chat's title; only their descriptions are copy, under `agents.templates.<id>` |
| `chat.conclusion`, `chat.conclusionBy`, `chat.conclusionCopy`, `chat.conclusionCopied`, `chat.conclusionDeliver`, `chat.conclusionDeliverTitle`, `chat.conclusionChipTitle`, `chat.conclusionPreview` | S5.16: the card's label and speaker line (`{{name}}`), its two buttons and the copied state, the header chip's tooltip, and the chat-list preview (`{{text}}` — the label is translated, the sentence inside it is the group's own words) |
| `chat.closingSpeaker`, `chat.closingSpeakerFirst` | The "Closing speaker" select in the group settings and its default row (S5.16). The other rows are **member names**, which are data |
| `chat.actions.summarizePrompt`, `chat.actions.votePrompt` | The **message text** each action sends, after the `@mention`. A locale key rather than a constant, because an agent answers in the language it is addressed in |
| `notices.consensus`, `notices.voteClosed` | The two dimmed lines S5.14 added to the transcript, written by the runner and translated like every other notice — see [`orchestration`](../orchestration/frontend.md) |
| `agents.reasoning`, `agents.reasoningHint` | Renamed by S5.14 to "Show thinking" and its hint; the control is [`agents`](../agents/frontend.md)'s, and what the transcript then holds is [`agent-turn`](../agent-turn/frontend.md)'s |

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
  `settings-editor-command`. S5.10 added `chat-goal`, `goal-discussion` /
  `goal-document` / `goal-codebase`, `goal-needs-workdir`, `goal-description`,
  `goal-deliverable`, `goal-deliverable-pick`, `goal-materials`, `goal-material`
  (with `data-path`), `goal-material-remove`, `goal-materials-add`, and
  `chat-goal-chip` — the last inside a wrapper carrying `data-kind` and
  `data-delivered`, which is where the end-to-end spec reads the state without
  touching copy.
- **The permission card owns Enter and Escape only while it is focused.** The
  shortcuts are on the card element, not on the document: a global listener would
  take Enter away from the composer, where it sends. The oldest card is focused
  when it appears (`tabIndex={-1}`, so it takes no Tab stop) and the buttons keep
  their own focus ring; the card carries `aria-label` from
  `chat.permissionTitle`.
- The goal chip is a `button` **only when it is openable**, and a plain chip
  otherwise — a control whose click can only fail is worse than text. Both
  branches carry the same `data-*`, so a test reads one place.
- The Goal block's kind control is the shared `SegmentedControl`, which gained a
  per-option `disabled` in S5.10; each segment stays a real `button` with
  `aria-pressed`, and a disabled one keeps its place in the row.
- Since S5.7 the diff header is **two** buttons rather than one containing
  another (invalid, and unreachable by keyboard): the toggle, and the path that
  opens the file, with the expand/collapse word as a third.
- The diff block's toggle is a `button` with `aria-expanded`; the file-reference
  chip is a `button` with a translated `title`.
