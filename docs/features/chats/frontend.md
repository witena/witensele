# chats — Frontend

## Pages and components

| File | Responsibility |
|---|---|
| `src/renderer/src/pages/chats-page.tsx` | The three-column page. Owns the three list loads (chats, agents, providers), the per-chat transcript load, and the group-settings block, which now writes straight through to `chats.update` |
| `src/renderer/src/components/chat/chat-list.tsx` | The grouped chat list: selection, kebab / right-click menu, inline rename, two-step delete |
| `src/renderer/src/components/chat/message-list.tsx` | The virtualized scroller (react-virtuoso): `followOutput` only while at the bottom, the "jump to latest" pill, and the day separators |
| `src/renderer/src/components/chat/transcript-rows.ts` | `buildTranscriptRows` / `dayBucket`: `Message[]` → the flat row array the virtualizer renders. Pure and unit-tested |
| `src/renderer/src/components/chat/message-item.tsx` | One message row: avatar + presence dot, header (name, model badge, round, "replying to @who", time), reasoning, tool cards, body, streaming cursor, status hint. A `system` message takes the short branch: one centred dimmed line, no avatar and no name |
| `src/renderer/src/components/chat/markdown.tsx` | `react-markdown` + `remark-gfm` with the mockup's prose rules as descendant utilities; hands fenced blocks to `CodeBlock`, wraps tables in their own scroller and marks every link `target="_blank" rel="noreferrer"` |
| `src/renderer/src/components/chat/code-block.tsx` | A fenced block: language header, Copy button ("Copied" for 1.5 s), shiki markup when a grammar exists and plain monospace otherwise |
| `src/renderer/src/components/chat/code-language.ts` | `resolveCodeLanguage` / `codeLanguageLabel`: the fourteen highlighted languages, their aliases, and `null` for everything else. Pure and unit-tested |
| `src/renderer/src/lib/highlighter.ts` | The memoised shiki core highlighter: the JavaScript regex engine, `vitesse-dark`, and one lazy import per grammar |
| `src/renderer/src/components/chat/tool-card.tsx` | The mockup's one-line tool card, expandable to the pretty-printed input and output |
| `src/renderer/src/components/chat/tool-call.ts` | `describeToolCall` / `collectToolCalls`: pairing a `tool-call` with its `tool-result` and summarising both. Pure and unit-tested |
| `src/renderer/src/components/chat/composer.tsx` | Auto-growing textarea (Enter sends, Shift+Enter newline, IME-safe, up to 8 lines), the `@` autocomplete popover, the clickable mention chips plus `@all`, Send / Stop |
| `src/renderer/src/components/chat/mention-query.ts` | `extractMentionQuery` / `filterMentionCandidates` / `insertMention` / `appendMention`: everything the autocomplete could get wrong. Pure and unit-tested |
| `src/renderer/src/components/chat/actions-card.tsx` | The right column's Actions card: the summarise picker and the vote button, both sending an ordinary message |
| `src/renderer/src/components/chat/member-panel.tsx` | The right column: the add-member popover, the member rows (avatar with presence dot, name, `model · presence` — counting up as `away · Ns` — the usage placeholder or, while the member is offline, a Retry button, and remove on hover) and native HTML5 drag-and-drop reordering |
| `src/renderer/src/lib/reorder.ts` | `reorder(list, from, to)`: the index arithmetic behind the drag, pure and unit-tested |
| `src/renderer/src/components/agents/agent-display.ts` | `agentModelLabel`, shared with the Agents page so both screens name a model the same way |
| `src/renderer/src/lib/event-bridge.ts` | The single backend subscription; fans every event into the stores |
| `src/renderer/src/lib/message-view.ts` | `wasStopped`, `messageText` and the stored `'aborted'` detail |
| `src/renderer/src/main.tsx` | Starts the event bridge before the first render |

## State

| Store | Field | Type | Meaning |
|---|---|---|---|
| `chats` | `chats` | `Chat[]` | Backend-owned, newest `updatedAt` first. Replaced by `chats.list`, upserted by `chat.updated`, filtered by `chat.deleted` |
| `chats` | `membersByChat` | `Record<string, string[]>` | Backend-owned member agent ids, in speaking order. Written only by `setMembers`, which goes through the backend first |
| `chats` | `selectedId` | `string \| null` | Local UI state, not persisted |
| `chats` | `status` / `error` / `errorCode` | | Load state and the last failure |
| `messages` | `byChat` | `Record<string, Message[]>` | Backend-owned, **oldest first** |
| `messages` | `status` | `Record<string, MessagesStatus>` | Per chat, so one failed load does not blank the others |
| `run` | `activeByChat` | `Record<string, ActiveRun>` | Backend-owned; set by `run.started` / `run.round`, cleared by `run.finished`. Drives the Stop button |
| `run` | `sendingByChat` | `Record<string, boolean>` | Local; covers the `chat.send` round trip before `run.started` arrives |
| `run` | `error` / `errorCode` | | The last refused send, shown under the composer. Cleared on a new send, on a chat switch and when the membership changes |
| `presence` | `byChatAgent` | `Record<string, AgentPresence>` | Runtime only, keyed `chatId:agentId`, never persisted. Seeded from `presence.list` when a chat is opened; see [`presence`](../presence/frontend.md) |
| `agents` | `agents` | `Agent[]` | Backend-owned; the Agents page (S2.1) writes it, this page only reads |
| `providers` | `providers` | `Provider[]` | Backend-owned; the member picker prints the provider's name beside the model |

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
| `invoke('agents.list')` | `agents.load()` on mount and after a chat is created | Author name, avatar and model badge |
| `invoke('chat.send')` | Composer, Enter or the Send button — and the Actions card, through the composer's `submitText` handle | Stores the message and schedules a run |
| `invoke('chats.members.set')` | The picker, the row's "×", and a drop | Replaces the whole member list, order included |
| `invoke('chats.update')` | Every group-settings control | Persists one `ChatSettings` field immediately; no Save button and no debounce |
| `invoke('providers.list')` | `providers.load()` on mount | The provider name in the member picker |
| `invoke('chat.stop')` | The Stop button | Aborts the run |
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

## Interaction states

| State | What the user sees |
|---|---|
| idle | Composer enabled with a Send button; no Stop |
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
| `chat.memberUsage` | The per-member token placeholder (an em dash until S4.1) |
| `chat.jumpToLatest` | The pill that appears when a message arrives while the user is scrolled up |
| `chat.mentionAllHint` | The subtitle of the popover's `@all` row |
| `chat.copy`, `chat.copied`, `chat.copyCode` | The code block's Copy button, its confirmed state and its accessible name |
| `chat.toolRunning`, `chat.toolDone`, `chat.toolError`, `chat.toolResults`, `chat.toolExpand`, `chat.toolCollapse`, `chat.toolInput`, `chat.toolOutput` | The tool card |
| `chat.actions.title`, `.summarize`, `.vote` | The Actions card's heading and its two buttons (S2.5 nested what were three flat keys) |
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
