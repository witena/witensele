# chats — Context

## Problem

A conversation needs somewhere to live. This feature is the container: the list of
chats in the left column, the create / rename / delete actions on it, and the
persistence of every message that is ever sent — the transcript that
`orchestration` schedules against and `agent-turn` reads to rebuild an agent's
view.

It is the feature the user meets first. Before S1.7 the left column was an empty
state and the composer was disabled; after it, pressing "+" produces a chat that
can hold a real conversation and still holds it after a restart.

## Scope

- `chats.*` handlers: list, get, create, update (rename and settings), delete,
  and the two membership methods.
- `messages.list`: the transcript page the chat view opens on, newest first with
  a message-id cursor.
- The left column: grouping by Today / Yesterday / Earlier, selection, inline
  rename, two-step delete.
- The middle column's message list: avatars with presence dots, author name,
  model badge, markdown body, collapsible reasoning, streaming cursor, dimmed
  `passed`, red hint on `error`.
- The renderer stores behind all of it (`chats`, `messages`, `run`, `presence`,
  `agents`, `providers`) and the single event subscription that feeds them.
- The right column (S2.2): the member picker, removing a member, drag-to-reorder
  the speaking order, and the group-settings block bound to `ChatSettings`. Since
  S5.15 that block ends with **Always allowed**, the list of standing permission
  grants this chat has been given, one revoke button per row.
- The message row's labels fed by the run (S2.3): `Round n`,
  `Replying to @x` from `Message.inReplyTo`, and `@Name` highlighted in the body.
- `ensureDefaultAgent`: the bootstrap agent a chat is given **only** while the
  agent library is empty, so a fresh install can hold a conversation before
  anyone opens the Agents page.
- The **first-run card** (S7.5): the conversation column draws it in place of
  its empty state until the installation has a chat with a member, or until
  Skip. The state machine (`lib/onboarding.ts`) and the card
  (`components/onboarding/onboarding-card.tsx`) are this feature's; the controls
  inside its first three steps are [`providers`](../providers/context.md)'s own
  components, and the templates behind step four are
  [`agents`](../agents/context.md)'s.
- The chat's **working directory** (S5.2): `ChatPatch.workdir`, the handler's
  filesystem check, the "Working directory" row in the group settings with
  "Choose…" and "Clear", and the folder chip in the header.
- The chat's **goal** (S5.10): `Chat.goal`, its column and migration, the whole
  validation table behind `ChatPatch.goal`, `chats.goalStatus`, the **Goal**
  block under the Working directory row, and the goal chip beside the folder
  chip — including the "delivered" state and the click that opens the file. What
  the goal *says to a model* is [`agent-turn`](../agent-turn/context.md)'s.
- The **one executor per chat** rule (S5.2): refused by `chats.members.set`, and
  explained in advance by the member picker, which greys a second executor out.
  The executor badge on member rows and message headers is here too.
- **"Hand to executor"** (S5.6): the button above the composer, its three
  disabled states and the sentence each of them shows. The action it starts —
  the executor's round and the review round after it — is
  [`orchestration`](../orchestration/context.md)'s; this feature owns the place
  it sits and the chat facts it reads (`workdir`, the member list, whether a run
  is going).
- **The conclusion** (S5.16): the card a message carrying a `ConclusionPart` is
  drawn as — the label, the accent edge, the speaker underneath, **Copy** and
  **Write to the deliverable** — plus the header's "Conclusion" chip, the
  chat-list preview line and the "Closing speaker" select in the group settings.
  What *produces* a conclusion is [`orchestration`](../orchestration/context.md)'s
  closing turn; this feature owns everything the user does with one.
- The three renderer surfaces the executor needs (S5.5): the **permission card**
  above the composer (`stores/permissions.ts` plus `permission-card.tsx`), the
  **diff block** a `DiffPart` renders as, and the `path:line` chip a
  `FileRefPart` renders as. The transcript is where the user watches an agent
  change their files, so it is this feature that draws it; what the executor may
  do, and when it asks, is [`executor`](../executor/context.md)'s.

## Out of scope

| Not here | Owned by |
|---|---|
| Who speaks, in which order, and for how many rounds — including the hand-off's two rounds and the `chat.handoff` method behind the button | [`orchestration`](../orchestration/context.md) |
| What one agent does during its turn | `agent-turn` |
| Creating and editing agents | [`agents`](../agents/context.md) (S2.1) |
| The presence state machine, the heartbeat, the two timeouts and the Retry button | [`presence`](../presence/context.md). This feature owns the `ChatSettings` fields that override the budgets, and the rows the dots are drawn on |
| Generating the title itself | [`orchestration`](../orchestration/context.md) — `ChatRunner` writes it after the first run (S4.3); this feature owns the field, the rename and the list row |
| The `executor` **role** itself — the control, the badge's copy, what the role means | [`agents`](../agents/context.md). This feature owns the *membership* rule and the surfaces that draw the badge |
| The executor's file, shell and git tools, the permission **gate** and the `DiffPart`s the backend appends | [`executor`](../executor/context.md) and [`agent-turn`](../agent-turn/context.md). This feature owns the folder they are confined to and the three surfaces that draw their results — not what they may do |
| The command policy, the write sandbox, the prompt timeout, and what a grant *means* | [`executor`](../executor/context.md), S5.15. This feature hosts the **Always allowed** list in the group settings, exactly as it hosts the Goal block: the panel is this feature's, the rules behind the rows are not |
| The wording of the goal in a system prompt, in either language, and the hand-off line that names the deliverable | [`agent-turn`](../agent-turn/context.md) and [`executor`](../executor/context.md), S5.10. This feature owns the goal as **data** and as a **control**; they own what a model is told about it |
| Placing a goal's `materials` in every member's context, the workspace briefing, and the read-only tools every member now gets | [`agent-turn`](../agent-turn/context.md) and [`executor`](../executor/context.md), S5.11 `[x]`. This feature records the materials, validates that they exist inside `workdir`, and lists them in the panel; what a model is shown of them, and in what order, is theirs |
| Appending a `FileRefPart` when an executor turn produces the deliverable, and what the executor is told to write | [`executor`](../executor/context.md) and [`agent-turn`](../agent-turn/context.md), S5.12. This feature owns the query the chip reads and the moments the renderer asks it |
| Scheduling the hand-off either control starts, and the four rules that refuse it | [`orchestration`](../orchestration/context.md), S5.6 / S5.12. Both controls are drawn on this feature's page and neither is this feature's: they start a run |
| Opening a `file-ref` chip, a path in the body text, a diff header or a file tool card in the editor | [`editor`](../editor/context.md), S5.7 `[x]`. It adds behaviour to components this feature owns; the rules it follows — the path detector, the confinement, the `AppSettings.editor` choice — are written up there |
| Syntax highlighting, tool cards, `@` autocomplete | S2.5 |
| Virtualized message list, upward paging | S2.5 |

## Dependencies

| Feature | What this one needs from it |
|---|---|
| [`database`](../database/context.md) | `ChatRepository` (list ordered by `updatedAt`, membership in one transaction) and `MessageRepository` (the `seq` ordering and the `before` cursor) |
| [`backend-client`](../backend-client/context.md) | `BackendClient`, the `BackendApi` contract and the typed event union |
| [`providers`](../providers/context.md) | A provider with at least one model, or `chats.create` has nothing to bind the bootstrap agent to |
| [`ui-shell`](../ui-shell/context.md) | `Column`, `PageHeader`, `Avatar`, `PresenceDot`, `Badge`, `EmptyState` and the design tokens |
| [`i18n`](../i18n/context.md) | Every string under `chat.*` and `common.you`; `translateNotice` for stored system notices |

Depending on it in return: `orchestration` persists through the same message
repository, emits the events these stores reduce, and reads `chat_members` — in
`position` order — once **per run**, so a membership or settings change lands at
the next round boundary rather than mid-turn.

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| `workdir` is checked against the **real filesystem**, not merely parsed | Store whatever string arrives and fail at the first tool call | The path is a boundary, not a label: S5.4 resolves every executor path inside it. A folder that is not there confines nothing, and "the write failed" three screens later is a far worse answer than "that folder does not exist" at the moment it is picked |
| A chat with an `executor` member and **no** `workdir` is allowed | Refuse the member until a folder is bound | Configuration order is the user's. S5.4 simply attaches no executor tools, which is the same outcome with none of the ordering rules |
| The second-executor refusal lives in `chats.members.set` | Refuse it in `agents.update`; enforce it when tools are attached | `members.set` replaces the whole list and is the only place that sees the resulting set, so it is the only place the rule can be *checked* rather than guessed. The cost is the promotion gap recorded in `backend.md` |
| **S7.5: the card is gone once a chat has a member**, not once a provider exists | Hide it as soon as the first provider is saved, which is what the step's first sentence says | Both sentences in the step are true of the same journey — it *appears* because no provider exists and *disappears* once a chat has a member. Hiding it at the provider would drop the user back onto an empty screen three steps from a working chat |
| The card's "Start chat" names its member explicitly | Let `chats.create` decide, as the "+" button does | The backend only adds the bootstrap agent while the agents table is **empty**, and by that step it holds the template agent. Saying nothing would produce a chat with no members and a first send refused |
| Skip is a settings row, not `localStorage` | `localStorage`; a `dismissed` column on something | It is a fact about the installation, it has to survive cleared web storage, and the server version (Phase 8) will want it per account. It also costs no migration: settings reads merge over the defaults |
| A refused `workdir` or member carries a `ValidationReason` in `details` | One more `BackendErrorCode` each; a generic `validation` line | The seven codes are a failure *taxonomy*, not a message catalogue, and four new ones would dilute it. A reason is an identifier the renderer translates, which is the same contract `SystemNoticePart` already uses for stored text |
| The hand-off button sits **above the composer**, not in the Actions card | A third row in the Actions card; a header button | The Actions card's two actions are ordinary messages and say so in their own header comment — nothing there bypasses `chat.send`. A hand-off is a backend path of its own that schedules rounds the chat's `mode` does not describe, so it belongs beside Send, where the user already is when they decide the talking is over |
| It is **disabled, never hidden**, and the tooltip names the missing rule | Hide it until the chat qualifies | A control that vanishes teaches nothing: "where is hand to executor?" has no answer on screen. The disabled button plus "choose a working directory first" is the answer |
| The workdir failure is shown in the left column's `chats-error` line, like every other chats-store failure | A dedicated error line under the Working directory row | One store, one error field, one place it is rendered. A second surface for one field would be the first exception in a screen that has had none, and the reason sentence is now specific enough to be read anywhere |
| `chats.create` takes `memberAgentIds`, and only falls back to the bootstrap agent while the agents table is empty | Always add the first agent; never add anyone | Once the user owns agents, deciding who is in a chat is theirs. The fallback is kept because it is the only thing that makes the *first* chat of a fresh install answerable |
| `ChatCreateInput` carries `memberAgentIds` rather than `Chat` carrying members | Put a member list on `Chat`; save the chat and then its members | Membership is a separate table and not a property of the chat row, but a chat created from the picker must be born with its members rather than saved twice |
| `chat.send` rejects with `validation('chat has no members')`, and the composer stays enabled | Disable the composer; run with nobody and finish silently | A disabled composer does not say *why*. The rejection prints one line under the box and the member panel prints the fix |
| `ChatPatch.settings` is a partial that the backend merges | Send the whole `ChatSettings` from every control | Two controls changed quickly would otherwise overwrite each other, and the caller would have to hold a copy of the stored object |
| The goal is **one JSON field replaced whole**, not four patchable ones (S5.10) | A field patch per control, like `ChatSettings` | `materials` is a list the user removes from, and a merge has no spelling for "this list is now empty". The cost is that the Goal block has to hold a draft and send the whole object, which it does |
| **Always allowed** goes in the group settings, last (S5.15) | A Settings page section; a row on the permission card; its own dialog | A grant is per **chat**, so the place it belongs is the panel that already holds everything else that is per chat. Last in the block because it is the only row there that is a *record of something the user did* rather than a setting they are making, and because a chat that has granted nothing should not push the folder and the goal down the column |
| A goal's paths are **relative to `workdir`**; the folder itself is absolute (S5.10) | Store absolute paths, as the dialogs return them | The folder is a machine-local binding; the goal describes the project and has to survive the folder being moved, cloned or restored. That makes the conversion — and the "you picked something outside this folder" refusal — the **renderer's** job, because no native dialog can be confined to a directory |
| "Delivered" is a **query** (`chats.goalStatus`), not a column on `Chat` (S5.10) | A boolean the backend writes when it notices; a field filled in on `chats.get` / `chats.list` | It is a fact about the filesystem, so a stored value is wrong the moment anything creates, moves or deletes the file — including something that is not this app. A derived field on the domain type is the same mistake this table already refused for the member count. The renderer asks when a chat is opened and whenever that chat changes |
| A goal **is** its description: blank means no goal (S5.10) | Allow an empty description; add a "Clear goal" button | A kind on its own says nothing a model can act on, so an empty description is not a goal that is merely unfinished — it is no goal. That gives the block its way back out for free, through the same box that created it, instead of a second control that exists only to undo the first |
| Document and Codebase are **disabled** without a folder, with the reason under them (S5.10) | Hide them; bind a folder automatically when one is picked | The same rule as the hand-off button: a control that vanishes teaches nothing, and "choose a working directory to write a document" is the answer to the question the user is about to ask |
| Every group-settings control persists on change, with no Save button | A Save button; a debounce | Each control is one field of one row. A select the user changed and then closed the app on must not quietly have been forgotten |
| Reordering uses the native HTML5 drag events | A drag-and-drop library | A handful of rows in a window that is always Chromium. The library would add a package, a provider component and its own keyboard model; the only part that can silently be wrong is the index arithmetic, which lives in `lib/reorder.ts` and is unit-tested |
| Add / remove / reorder all end in one `chats.members.set` with the whole array | Narrower add / remove / move methods | The array index *is* `position`. Three narrower calls would each have to read the current order first, and would race the `chat.updated` that follows |
| `chats.members.list` was added to `BackendApi` | Put a member count on `Chat`; show every agent as a member | The contract had `members.set` but no getter, and both columns need the membership. A derived field on the domain type would be a lie the moment S2.2 lets membership change |
| The chat list groups by **calendar day** | "within 24 hours" | A message sent at 23:50 has to read as *yesterday* the next morning. The rule is in `groupChats`, with the 23:50 case as its own test |
| Delete confirms in place ("click again"), rename edits in place | A modal dialog | Both are one-click-recoverable actions on a list row; the pattern already exists in Settings → Providers |
| Rename cancels on blur rather than committing | Commit on blur | A click elsewhere is far more often "never mind" than "save this" |
| Chats are loaded with one `chats.members.list` call each | A batched method; a count column | N+1 over local IPC costs nothing at desktop list sizes, and it keeps the contract honest. S2.2 revisits it if a list ever grows enough to notice |
| `selectedId` is not persisted | Remember the last open chat | A restart opening on "no chat selected" is predictable; restoring a chat that was mid-run when the app died is not |
| Syntax highlighting covers fourteen languages, loaded lazily; anything else renders plain | Bundle every shiki grammar; guess from the content | Every grammar is megabytes in a renderer whose job is a chat window. Guessing is worse than not colouring: a Haskell block painted with Python's rules reads as wrong code |
| `shiki` runs on the JavaScript regex engine, not Oniguruma/wasm | Ship `onig.wasm` beside the renderer | An Electron renderer loaded from `file://` would have to fetch the asset. The JS engine handles all fourteen grammars and costs one fewer moving part |
| The code block renders plain text first and swaps in the highlighted markup | Wait for the grammar before showing anything | A block arrives **while a reply streams** and changes a dozen times a second. Waiting would make it blink for the whole answer |
| Both Actions-card buttons send an ordinary `chat.send` | A dedicated backend "summarise" path | The transcript then records exactly what was asked, the orchestrator schedules the reply the usual way, and the user can edit the sentence next time. A second way to start a run is a second thing to keep correct |
| **"Start a vote" is still an ordinary message — with `rounds: 1`** (S5.14) | A `chat.vote` method; set `maxAutoRounds` to 1 before the send and put it back after | A vote is one question and one answer per member; a chat set to three automatic rounds otherwise spends the other two voting on the votes. The cap travels **on the send**, so the transcript still records exactly the sentence that was asked and the card keeps its one rule: nothing here bypasses `chat.send`. Writing the chat's setting instead would be a change the user never made, visible in the member panel, and wrong for ever if the app closed in between |
| The action prompts are locale keys, not English constants | One English sentence for both languages | An agent answers in the language it is addressed in; a Chinese UI asking in English gets an English summary |
| The autocomplete's query may contain spaces, bounded at 40 characters | Stop the query at the first space | A member can be called `Ann Lee`, and a completion that stopped at the space could never reach her. The bound plus "closes when nothing matches" keeps a stray `@` from leaving a popover open behind a paragraph |
| The autocomplete writes the textarea's value and caret **synchronously** | Restore the caret in `requestAnimationFrame` | The deferred version looks right by hand and races anything that reads or replaces the box in between — which is how it first showed up, as a flaky end-to-end assertion |
| **The conclusion is a card around the message, not a panel above the chat** (S5.16) | Pin a copy of the conclusion to the top of the transcript; a side panel listing every conclusion | The transcript is the record, in the order things happened; a floating duplicate is a second thing to keep in step with it and pushes the conversation down the screen for ever. The header chip is how it is found from the top of a long chat, and it *scrolls to* the card rather than repeating it |
| **Copy goes through the browser clipboard, not through `BackendClient`** (S5.16) | A `system.copyToClipboard` method beside `system.openInEditor` | Rule #6 is that the renderer reaches the **backend** only through that client; the clipboard is not the backend, it belongs to the window the user is in. A method would also put a desktop capability into a contract the server build has to implement |
| **"Write to the deliverable" is hidden when the goal is not a document, and disabled otherwise** (S5.16) | Always show it; never show it outside a document chat | A permanently dead control on a card in a discussion chat explains a feature that chat is not using. The other three refusals — no folder, no executor, a run in flight — are states the user can act on, so there the button stays with its reason, exactly like the hand-off button |
| **Who closes is a chat setting, not a per-run choice** (S5.16) | Ask at the moment the group agrees; derive it from the discussion | The run has already ended by then and a modal in the middle of the answer is worse than a default. `closingAgentId` is one field of the settings column, the select offers the chat's own members, and a stale value costs the preference and never the conclusion |
| **The chat-list preview replaces the member count rather than joining it** (S5.16) | A second line under the title; show both separated by a dot | The row is one line high and the count is on screen the moment the chat is opened. What a discussion concluded is the better answer to "which one was this" |

## Open questions

- Reordering is mouse-only. `ChatRunner` reads `position` every round, so the
  order matters more since S2.3 and a keyboard path for it is still missing.
- Whether a conclusion should be **exportable** beyond the clipboard — a file, a
  share sheet, an entry in a "decisions" list across chats. S5.16 deliberately
  shipped the two destinations that need no new concept: the clipboard, and the
  deliverable this chat already names.
- Whether the chat-list preview should cover chats whose transcript has never
  been loaded, which would need a backend query of its own rather than the
  messages store.
- Whether the member count belongs on `Chat` after all: membership is now
  mutable and the left column re-reads `chats.members.list` per chat to follow it.
- Upward paging: the transcript is virtualized but still loads one page of 100,
  so reaching the top of a long chat fetches nothing older.
- Whether `messages.list` should return oldest-first for the first page, given
  that every caller reverses it. Changing it would change a contract that already
  has a cursor semantics written around "newest first".
- Whether the "one executor" rule should also be enforced when an agent is
  *promoted* to `executor` (`agents.update`). Today it is not; see the known gap
  in `backend.md`.
- Whether the chat should offer to bind the folder when an executor joins a chat
  that has none. Today the two are independent and the user does both by hand.
- Whether `chats.goalStatus` should be pushed rather than polled. Today the
  renderer re-asks when the chat is opened, on every `chat.updated`, at every
  round boundary and at the end of a run (S5.12 added the last two, which is what
  makes an executor turn flip the chip), so a file written by something that is
  not this app is noticed only at the next such moment. A filesystem watcher
  would make it immediate and is deliberately not in Phase 5. Because the query
  is now asked far more often, `loadGoalStatus` writes **nothing** when the
  answer is unchanged: a fresh object for an unchanged fact re-rendered the whole
  chat page in the middle of a streaming reply.
- Whether a `discussion` goal should be allowed to carry materials at all. It
  may, as long as the chat has a folder, and since S5.11 that is a useful
  combination rather than an inert one: a discussion grounded in three documents
  needs no deliverable.
- Whether the **materials list should say what it will cost**. The panel lists
  the paths the user picked; how much of them fits in a given member's context is
  decided per turn, per model, by `agents/materials.ts`, and the only feedback
  the user gets is the `materialsTruncated` notice after the fact. A size hint
  next to each row would be honest but is a guess until a model is chosen.
