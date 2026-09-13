# chats — Frontend

## Pages and components

| File | Responsibility |
|---|---|
| `src/renderer/src/pages/chats-page.tsx` | The three-column page. Owns the two list loads, the per-chat transcript load, and the group-settings block that is still local state |
| `src/renderer/src/components/chat/chat-list.tsx` | The grouped chat list: selection, kebab / right-click menu, inline rename, two-step delete |
| `src/renderer/src/components/chat/message-list.tsx` | The scroller and the auto-scroll rule (follow the bottom only while already at the bottom) |
| `src/renderer/src/components/chat/message-item.tsx` | One message row: avatar + presence dot, name, model badge, round, time, body, reasoning toggle, streaming cursor, status hint |
| `src/renderer/src/components/chat/markdown.tsx` | `react-markdown` + `remark-gfm` with the mockup's prose rules as descendant utilities |
| `src/renderer/src/components/chat/composer.tsx` | Textarea (Enter sends, Shift+Enter newline, IME-safe), mention hint, Send / Stop |
| `src/renderer/src/components/chat/member-panel.tsx` | The right column's member rows: name, model, live presence dot |
| `src/renderer/src/lib/event-bridge.ts` | The single backend subscription; fans every event into the stores |
| `src/renderer/src/lib/message-view.ts` | `wasStopped`, `messageText` and the stored `'aborted'` detail |
| `src/renderer/src/main.tsx` | Starts the event bridge before the first render |

## State

| Store | Field | Type | Meaning |
|---|---|---|---|
| `chats` | `chats` | `Chat[]` | Backend-owned, newest `updatedAt` first. Replaced by `chats.list`, upserted by `chat.updated`, filtered by `chat.deleted` |
| `chats` | `membersByChat` | `Record<string, string[]>` | Backend-owned member agent ids, in speaking order |
| `chats` | `selectedId` | `string \| null` | Local UI state, not persisted |
| `chats` | `status` / `error` / `errorCode` | | Load state and the last failure |
| `messages` | `byChat` | `Record<string, Message[]>` | Backend-owned, **oldest first** |
| `messages` | `status` | `Record<string, MessagesStatus>` | Per chat, so one failed load does not blank the others |
| `run` | `activeByChat` | `Record<string, ActiveRun>` | Backend-owned; set by `run.started` / `run.round`, cleared by `run.finished`. Drives the Stop button |
| `run` | `sendingByChat` | `Record<string, boolean>` | Local; covers the `chat.send` round trip before `run.started` arrives |
| `presence` | `byChatAgent` | `Record<string, AgentPresence>` | Runtime only, keyed `chatId:agentId`, never persisted |
| `agents` | `agents` | `Agent[]` | Backend-owned, read-only until S2.1 |

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
| `invoke('chat.send')` | Composer, Enter or the Send button | Stores the message and schedules a run |
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
| loading | The list and the transcript are simply empty while the first call resolves; a skeleton is S2.5 |
| streaming | The agent's row grows token by token with a blinking accent cursor, its presence dot is red, and Send is replaced by Stop |
| empty | "No chats yet" in the left column, "Nothing here yet" with no chat selected, "No messages yet" in a new chat, "No members yet" if a chat somehow has none |
| error (call) | The left column shows the translated `BackendError.code` under the list — the first-run "no provider with models" path lands here |
| error (message) | The row keeps whatever text arrived and adds a red hint: "Stopped" when `error === 'aborted'`, otherwise "The reply failed" |
| passed / skipped | The whole row is dimmed and the body is replaced by the "Passed" / "Skipped" label |

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
- Presence dots on message avatars carry a translated `role="img"` name; the dot
  in the member panel is decorative, because the name and model are already read
  out beside it.
- Each message is an `<article>` carrying `data-sender` and `data-status`, which
  is also what the end-to-end spec asserts on so it stays language-independent.
