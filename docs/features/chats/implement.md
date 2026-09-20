# chats — Implementation

## Approach

Three layers, each ignorant of the one above it:

1. **Storage.** `ChatRepository` and `MessageRepository` (S1.2) already hold
   everything: chats ordered by `updatedAt`, membership replaced in one
   transaction, messages ordered by a per-chat `seq`.
2. **Handlers.** `src/main/handlers/chats.ts` is validation plus events. It owns
   three behaviours that are not CRUD: `chats.create` decides who a new chat
   starts with, `chats.delete` stops the chat's run before the rows go away, and
   `chat.send` refuses a chat with no members.
3. **Renderer.** Six zustand stores mirror the backend and one module
   (`lib/event-bridge.ts`) subscribes to the backend once and fans every event
   into them. Components read stores and call store actions; none of them calls
   `BackendClient` directly.

The rule that shapes the renderer half: **backend-owned state is never edited
optimistically.** An action calls `invoke` and the store applies either the
returned value or the event that follows — which is why a message sent during a
run still appears instantly (the backend stores it and emits `message.created`
before deciding what to do with it) without the store having to guess.

## Data flow

### Creating a chat

```
"+" button
  → useChatsStore.create()
  → invoke('chats.create', { input: {} })
  → handler: initialMembers(ctx, undefined)
               agents table empty → ensureDefaultAgent(ctx), that agent
               otherwise        → []          // the user picks in the panel
             chats.create() + chats.setMembers()
             emit chat.updated
  → store: applyUpdated(chat), select(chat.id), loadMembers(), agents.load()
  → the row appears under "Today"; the composer is usable, but a send is
    refused until the chat has a member
```

### The first run, which is the same flow with the steps drawn (S7.5)

```
empty installation, chat page, no chat selected
  → useOnboarding()  =  onboardingState({ dismissed, providerCount, draft,
                                          authStatus, agentCount,
                                          hasChatWithMembers })
  → visible → <OnboardingCard /> instead of the "Nothing here yet" EmptyState

step 1-3  the provider editor's own components against the one draft
          (PresetGrid → ProviderCredential → ProviderModels + Save)
            → providers.saveDraft() → providers.create
step 4    a template tile
            → agents.createFromTemplate(template, providerId, provider.models)
            → agents.create                    // the editor is NOT opened
step 5    "Start chat"
            → chats.create([agent.id])
            → invoke('chats.create', { input: { memberAgentIds: [id] } })
  → the chat has a member → hasChatWithMembers → the card returns null
```

The member list is the part worth remembering: **the backend only adds the
bootstrap agent when the agents table is empty**, and by step 5 it is not, so a
card that called `create()` with no argument would produce a chat with nobody in
it — and then a send refused with "this chat has no members" on the very first
try. `ChatsState.create` therefore takes an optional `memberAgentIds`; the "+"
button still passes nothing and still lets the backend decide.

### Changing the members

```
"+ Add" → pick an agent      |  row "×"                |  drag a row onto another
  memberIds + [agentId]      |  memberIds − agentId    |  reorder(memberIds, from, to)
  → useChatsStore.setMembers(chatId, agentIds)
  → invoke('chats.members.set', { chatId, agentIds })   // index becomes position
  → handler: every agent must exist, then one transaction; emit chat.updated
  → store: membersByChat[chatId] = the returned order
  → ChatRunner picks the new list up on its next run
```

### Changing a group setting

```
a select / the segmented control changes
  → useChatsStore.updateSettings(chatId, { speaking: 'parallel' })
  → invoke('chats.update', { id, patch: { settings: { speaking: 'parallel' } } })
  → handler validates the field, repository merges it into the stored object
  → store applies the returned chat; the header badge re-renders from it
```

### Choosing who closes a discussion (S5.16)

```
the Closing speaker select changes
  → patchSettings({ closingAgentId: agentId })          // or null for the default
  → chats.update { patch: { settings: { closingAgentId } } }
  → mergeChatSettings drops a null, so "first in speaking order" is an ABSENT field
  → the select re-renders from the stored chat, falling back to the default row
    whenever the stored id is not a member of this chat any more
```

The select offers the chat's own members plus one default row whose value is the
empty string; the empty string is what the handler turns into `null`. A stale id
therefore shows as the default *and behaves* as the default, because
`closingSpeaker` in the runner applies the same fallback.

### Drawing a conclusion (S5.16)

```
message.updated arrives with parts [{ type: 'conclusion' }, { type: 'text', … }]
  → messages store replaces the row
  → buildTranscriptRows marks that row `conclusion: true`   (transcript-rows.ts)
  → MessageItem draws its body inside <ConclusionCard>
        Copy   → navigator.clipboard.writeText(messageText(message))
        Write  → run.handoff(chatId, 'deliver')   // deliverableBlocker decides
  → the page's latestConclusion(messages) puts the "Conclusion" chip in the header
        click → setScrollTo({ messageId, nonce: Date.now() })
              → MessageList scrolls that index into view, centred
  → conclusionPreview(messages) per loaded chat → the chat list's subtitle
```

Three things worth keeping in mind here. The card **wraps** the existing body
rather than replacing it, so `message-text` and everything written against it are
untouched. The header chip carries a **nonce** because clicking it twice has to
scroll twice. And the previews are computed from the messages store, so they
cover the chats whose transcripts have been loaded — the rest keep the member
count they always had.

### Binding the working directory (S5.2)

```
"Choose…"
  → useChatsStore.chooseWorkdir(chatId)
  → invoke('system.pickFolder')            // native modal, src/main/ipc/dialogs.ts
      cancelled → null → nothing happens, and no error is left behind
  → useChatsStore.setWorkdir(chatId, path)
  → invoke('chats.update', { id, patch: { workdir: path } })
  → assertWorkdir: absolute, statSync, isDirectory
      refused → validation + { reason: 'workdir_not_absolute' | 'workdir_missing'
                              | 'workdir_not_directory' }
  → store applies the returned chat
  → the header chip and the settings row re-render from it

"Clear" → setWorkdir(chatId, null)         // the one path that needs no dialog
```

Two calls rather than one backend method, for the reason `stores/skills.ts`
imports a folder the same way: the dialog is the single thing the backend cannot
do without electron, and keeping it a separate call keeps `chats.update` a plain
validated write that a future HTTP client can make on its own.

The chip prints `folderName(workdir)` with the whole path in `title`
(`lib/workdir.ts`) — the interesting half of a path is its last segment, and the
rest does not fit beside a title or in a 288px panel.

### Listing and revoking a grant (S5.15)

```
the Always allowed block (components/chat/grants-list.tsx)
  chat selected              -> invoke('permissions.grants.list', { chatId })
  permission.resolved
    with decision allowAlways -> the same call again, from lib/event-bridge.ts
  revoke clicked             -> invoke('permissions.grants.revoke', { chatId, toolName })
                             -> the block redraws from the **returned** list
  chat.deleted               -> the cached rows are dropped; the table's own
                                went with the chat, through the cascade
```

Nothing here is optimistic and nothing is derived: a row that vanished from the
screen while the grant stayed in the database is exactly the failure S5.15
exists to remove, so the only thing the block ever draws is an answer the
backend gave it.

### Setting the chat goal (S5.10)

```
the Goal block (components/chat/goal-settings.tsx)
  a draft: { kind, description, deliverable, materials }, seeded from chat.goal
  kind changed      → draft; persisted too, if the description already has text
  description blur  → persist
  deliverable blur  → persist
  material added / removed → persist immediately (no blur to wait for)
  → composeGoal(draft)      // null when the description is blank
  → useChatsStore.setGoal(chatId, goal)
  → invoke('chats.update', { id, patch: { goal } })
  → assertGoal(goal, patch.workdir ?? stored.workdir)
      refused → validation + { reason: 'goal_…' }   // nine of them, see backend.md
  → store applies the returned chat, then re-reads chats.goalStatus
  → the panel re-seeds from the stored value; the header chip re-renders
```

The block is the **only** control in the group settings that holds a draft, and
the reason is the column: a goal is one JSON field, so there is no per-field
patch to send, and persisting free text on every keystroke would be a write per
character. So it writes on blur — which is what the chat title already does.

Two edges fall out of "a goal is its description", and both are deliberate:
picking a kind while the box is empty changes the draft only, and **emptying**
the description of a chat that has a goal removes the goal. The way out is the
same gesture as the way in, rather than a second control that exists only to
undo the first.

### Switching automatic delivery off (S5.18)

```
the Goal block, kind === 'document'
  → <Toggle> inside goal-auto-deliver (data-enabled = the resolved value)
  → onAutoDeliverChange(false)
  → patchSettings({ autoDeliver: false })            // the page, not the draft
  → chats.update { patch: { settings: { autoDeliver: false } } }
  → mergeChatSettings writes the field; absent stays absent when nobody touched it
  → the page resolves `settings.autoDeliver !== false` and hands the block a boolean
```

It is **not part of the goal draft**: a goal is what the chat produces, and this
is what the runner does about it, which is a `ChatSettings` field like
`closingAgentId`. The block receives the resolved boolean from the page rather
than the raw setting, so "absent means on" is decided in one place — where the
settings are — and the block never has to know the rule. The switch persists
immediately, like a material and unlike the text fields, because there is no
free text to wait for.

### Picking a deliverable or a material (S5.10)

```
"Choose…"                              |  "Add…"
  pickDeliverable(workdir)             |    pickMaterials(workdir)
  → invoke('system.pickSavePath')      |    → invoke('system.pickPaths')
       cancelled → null → nothing      |         cancelled → [] → nothing
  → relativeToWorkdir(workdir, picked) |    → the same, per pick
       outside → null + errorDetails   |         outside → dropped + errorDetails
         { reason: goal_deliverable_…  |           { reason: goal_material_… }
           outside_workdir }           |
  → the draft field / the list, then persisted
```

The conversion is the point. The dialogs answer **absolute** paths and a
`ChatGoal` stores **relative** ones, because the folder is a machine-local
binding while the goal describes a project that outlives it. And because no
native dialog on any platform this runs on can be confined to a directory,
`relativeToWorkdir` returning `null` is the only place "you picked something
outside this chat's folder" can be noticed — so the renderer reports it the way
a backend rejection is reported: the same three store fields, a
`ValidationReason`, the same `translateFailure`, the same `chats-error` line.

A materials pick keeps what was inside and reports what was not, rather than
discarding the lot: a user who selected six files and one stray meant the six.

### Is the deliverable there yet? (S5.10, S5.12)

```
open a chat, or chat.updated for it,
or a round boundary, or the end of a run          (S5.12)
  → useChatsStore.loadGoalStatus(chatId)
  → invoke('chats.goalStatus', { chatId })
  → deliverablePath(goal, workdir) + existsSync
  → goalStatusByChat[chatId]                      (only if the answer changed)
  → goalChipState(goal, status) → the header chip
```

A **query**, not a column. Whether a file exists is a fact about the filesystem,
so a stored boolean would be wrong the moment anything created, moved or deleted
it — including something that is not this app — and the same reasoning already
keeps the member count off `Chat`. It is re-asked whenever the chat row changes,
which covers every edit the panel makes.

S5.12 adds the two moments an **executor turn** can have written the deliverable.
A round boundary is what catches a hand-off — the executor writes in a round of
its own and the review round starts the moment it finishes, so the chip flips
while the reviewers are still reading — and the end of the run catches the rest,
including a hand-off with nobody to review it. In `chats-page.tsx` that is two
extra dependencies on one effect (`running` and the active round).

Asking far more often made one thing matter that did not before: **an unchanged
answer must not write**. `loadGoalStatus` compares the two fields and returns an
empty patch when they match, because a fresh `ChatGoalStatus` object for a fact
that has not changed re-renders the chat page — message list included — in the
middle of a reply that is still streaming, and `react-virtuoso` re-measures the
row the streaming cursor is in.

`deliverablePath` (`executor/paths.ts`) is shared with the executor turn that
appends the deliverable's `FileRefPart`, so the header chip and the chip in the
transcript cannot come to name two different files.

### Adding an executor member (S5.2)

```
"+ Add" → the picker
            hasExecutor(members) && isExecutor(candidate)
              → the row is disabled, and its sub-line becomes chat.executorTaken
          otherwise → the usual setMembers path
  → invoke('chats.members.set')
  → assertOneExecutor over the resulting list
      two executors → validation + { reason: 'second_executor' }
```

The picker is the **explanation**; the handler is the **rule**. Disabling the row
is what stops the user wondering why a click did nothing, and the backend refusal
is what makes the invariant true for a second window or a later HTTP client.

### Handing the chat to its executor (S5.6)

```
HandoffButton                      // above the composer, below the permission stack
  handoffBlocker({ workdir, members, running })
    → 'handoff_no_workdir' | 'handoff_no_executor' | 'handoff_run_active' | null
  disabled = blocker !== null
  title    = blocker ? validationReasonMessage(t, blocker) : t('chat.handoffTitle')
  click → run.handoff(chatId) → invoke('chat.handoff', { chatId })
                                  → ChatRunner.handoff  (orchestration)
  ← message.created (a user row carrying the `handoff` notice)
  ← run.started / run.round … the executor, then everybody else
```

The button reads the three rules the backend applies, in the backend's order, so
the tooltip on the disabled control and the sentence under the composer after a
refusal are the same sentence. It is drawn for every selected chat and disabled
rather than hidden; the reason also lands in `data-blocked` for the end-to-end
spec, which must not assert on copy.

### Opening a chat

```
click a row
  → chats.select(id)
  → ChatsPage effect: messages.load(id) unless that chat is already loaded
  → invoke('messages.list', { chatId, limit: 100 })   // newest first
  → store reverses into oldest-first and renders
```

### Rendering a message (S2.5)

```
Message.parts
  → system-notice only, senderType 'system'
        → one centred dimmed line, `data-notice-key`, translateNotice(t, part)
  → reasoning parts
        → collapsed toggle + one-line preview
          auto-expanded and pulsing while reasoning streams and no text has begun
  → tool-call / tool-result
        → collectToolCalls() pairs them by toolCallId
          describeToolCall() → { toolName, argsPreview, state, resultCount, JSON }
          → ToolCard: one line collapsed, input + output expanded
  → text parts, joined
        → <Markdown>: react-markdown + remark-gfm
             p / li      → @Name highlighted with splitMentions (shared/mentions)
             a           → target=_blank rel=noreferrer → main's setWindowOpenHandler
                           → shell.openExternal for http(s), denied otherwise
             table       → wrapped in its own overflow-x container
             code inline → mono on bg-bg-muted (the prose rules)
             code fenced → <CodeBlock>: header (language + Copy) and, once
                           highlightCode() resolves, shiki's escaped markup
```

A row also carries the two **flag** readings, computed in the row model and
passed to `MessageItem` as props rather than re-read inside it: `conclusion`
(S5.16, `isConclusion`) and `viaClient` (S10.4, `originClient` — the client name
from an `OriginPart`, or `null`). `viaClient` draws one more badge on the header
line, `t('chat.viaClient', { client })`, and changes nothing else about the row:
a question an IDE sent is an ordinary user message, and the chip is the only
thing that says otherwise.

The list itself is `Message[] → TranscriptRow[]` (`buildTranscriptRows`) and then
one `react-virtuoso` row per entry. `followOutput` receives "are we at the
bottom"; when the answer is no, an arriving message raises the "jump to latest"
pill instead of moving the viewport.

### Sending with the autocomplete (S2.5)

```
keystroke in the textarea
  → extractMentionQuery(value, caret)      // the `@…` token under the caret
  → filterMentionCandidates(members, query) // longest name first, + @all
  → popover; ↑/↓ move, Esc closes
  → Enter / Tab / click
      → insertMention(text, span, name) → "@Name "
      → the DOM value and the caret are written synchronously, then setText
  → Enter with no popover
      → parseMentions(text, members)  // the same parser the backend runs
      → useRunStore.send(chatId, text, mentions)
```

The chip row is the same path through `appendMention`, and the Actions card is
the same path again through the composer's `submitText` handle — one send, one
parser, one store.

Since S5.14 that handle carries one more argument, `rounds`, all the way down:

```
ActionsCard.onSend(text, rounds?)
  → composer.submitText(text, rounds?)
  → ComposerProps.onSend(text, parseMentions(text, members), rounds?)
  → useRunStore.send(chatId, text, mentions, rounds?)
  → invoke('chat.send', { chatId, text, mentions?, rounds? })
```

"Start a vote" passes `VOTE_ROUNDS` (`1`); everything else passes nothing and
runs under the chat's own `maxAutoRounds`. It is threaded through the composer
rather than given its own store call precisely so the card keeps its rule —
nothing there bypasses `chat.send`, and the transcript records the sentence.

### A streaming reply (the path that matters)

```
Enter in the composer
  → useRunStore.send(chatId, text)
  → invoke('chat.send')            → ChatRunner (see ../orchestration/)
  ← message.created (user)         → messages store appends it
  ← run.started / run.round        → run store shows Stop
  ← message.created (agent, empty, streaming)
  ← message.delta × N              → append to the last part of that kind
  ← message.updated                → replace wholesale; status, usage, error
  ← run.finished                   → run store clears; the button goes back to Send
```

Deltas are increments and are applied by `applyDeltaToParts`; `message.updated`
is authoritative, so a dropped delta is cosmetic and the transcript still
converges.

### Usage in the header (S4.1)

```
open a chat  → useUsageStore.load(chatId) → messages.usageSummary
                                          → byChat[chatId] (whole transcript)
message.updated → event-bridge → useUsageStore.recompute(chatId)
                                   ├─ messages store holds the whole transcript
                                   │    → summarizeUsage(...) locally
                                   └─ it holds only a page
                                        → load(chatId) again
```

The header prints `12.4k tokens · $0.04`, or the tokens alone when nothing in the
chat could be priced; the member rows print each agent's share; the model badge
on a message carries `In … · out … · $…` as a tooltip. Three surfaces, one
summary object, no extra IPC per turn.

### Searching the chat list (S4.3)

```
type in the box → local state → 200 ms debounce → chats.search({ query })
                                                → matchIds in the chats store
                                                → the page filters `chats` by it
```

`matchIds` is `null` while the box is empty, which is how the column tells "not
filtered" from "filtered and nothing matched" — only the second shows the search
empty state. Filtering **hides rows**; it never regroups them, so the Today /
Yesterday / Earlier headings stay exactly where they were and `groupChats` drops
any that end up empty.

### Deleting a chat

```
kebab → Delete → Delete again
  → invoke('chats.delete', { id })
  → handler: ctx.runners.remove(id)   // abort first: the rows are about to go
             chats.delete(id)         // cascades to members and messages
             emit chat.deleted
  → stores: drop the chat, its transcript, its presences and its run state
```

## Key types and contracts

`Chat`, `ChatMember`, `Message`, `MessagePart`, `MessageStatus` and `Usage` are
unchanged from S1.1 except that **`Chat.goal` was added** (S5.10, with
`ChatGoal`, `GoalKind`, `GOAL_KINDS`, `MAX_GOAL_DESCRIPTION_CHARS` and
`ChatGoalStatus` beside it, plus nine more `VALIDATION_REASONS`) and that
**`Chat.workdir` is no longer reserved** (S5.2):
`ChatPatch` accepts it, and `VALIDATION_REASONS` / `ValidationReason` were added
beside `BackendError` for the refusals the renderer names precisely. S2.2 added
two input types next to them —
**`ChatCreateInput`** (a `ChatPatch` plus `memberAgentIds`) and **`ChatPatch`**
(every field optional, `settings` a partial that the backend merges) — plus the
`MIN_AUTO_ROUNDS` / `MAX_AUTO_ROUNDS` bounds both layers validate against.

| Channel / method | Request | Response | Notes |
|---|---|---|---|
| `chats.list` | — | `Chat[]` | Newest `updatedAt` first |
| `chats.get` | `{ id }` | `Chat` | `not_found` for an unknown id |
| `chats.create` | `{ input: ChatCreateInput }` | `Chat` | `memberAgentIds` seeds the members; without it the chat is empty unless the agent library is |
| `chats.update` | `{ id, patch: ChatPatch }` | `Chat` | Rename, `workdir` (absolute, existing, a directory — or `null`) and a **partial** `settings` merge; always bumps `updatedAt` |
| `chats.delete` | `{ id }` | `void` | Stops the run first; cascades |
| `chats.members.list` | `{ chatId }` | `ChatMember[]` | **New in S1.7.** Ordered by `position` |
| `chats.members.set` | `{ chatId, agentIds }` | `ChatMember[]` | Replaces the list; array index becomes `position` |
| `chats.search` | `{ query }` | `string[]` | Chat ids whose title or any message text matches; blank query means every chat |
| `chats.goalStatus` | `{ chatId }` | `ChatGoalStatus` | S5.10. Where the `document` goal's deliverable is and whether it exists. A chat with no such goal answers `{ deliverable: null, delivered: false }` |
| `messages.list` | `{ chatId, before?, limit? }` | `Message[]` | Newest first; `before` is a message id |
| `messages.usageSummary` | `{ chatId }` | `ChatUsageSummary` | Tokens and estimated cost, total and per agent, over the whole transcript |
| `chat.send` | `{ chatId, text, mentions?, rounds?, origin? }` | `Message` | The stored user message; output arrives as events. `validation('chat has no members')` before anything is written. `rounds` (S5.14) caps the automatic rounds of this chain only, bounded like `maxAutoRounds`. `origin` (S10.4) says a tool sent this for the user and becomes an `OriginPart`; its `client` is sanitised, never refused |
| `chat.handoff` | `{ chatId }` | `Message` | S5.6. The stored hand-off row; the executor's round and the review round after it arrive as events. Refused with `handoff_no_workdir` / `handoff_no_executor` / `handoff_run_active` |
| `chat.stop` | `{ chatId }` | `void` | Idempotent |

| Event | Payload | Emitted when |
|---|---|---|
| `chat.updated` | `{ chat }` | A chat is created, renamed or has its members replaced |
| `chat.deleted` | `{ chatId }` | A chat is deleted |
| `message.created` | `{ message }` | A message row is inserted (user or agent) |
| `message.delta` | `{ chatId, messageId, delta }` | One increment of a streaming message |
| `message.updated` | `{ message }` | A message reaches its final state |

The `run.*` and `presence.changed` events are emitted by `orchestration` and
`agent-turn`; this feature only reduces them.

## Tests

| File | Covers |
|---|---|
| `src/main/orchestration/chat-runner.test.ts` (`describe('chats handlers')`) | `chats.create` default title and settings; the `validation` refusal with no usable provider; rename bumping `updatedAt` and emitting `chat.updated`; the empty-title rejection; `messages.list` order and the `before` cursor; delete stopping the run and emitting `chat.deleted`. Also: the runner re-reads the members on the next run, and `chat.send` on an empty chat stores nothing |
| `src/main/handlers/chats.test.ts` | Who a new chat starts with (bootstrap / empty / explicit order), `members.set` validation and its event, every `ChatSettings` bound, S5.10's whole goal table against a **real** temporary folder (one case per `ValidationReason` — including a symlink out for each of the two `outside_workdir` ones — plus the shapes that must stay legal: a discussion on an unbound chat, a deliverable whose parent does not exist, a folder as a material, a folder and a goal in one call, clearing with `null`, and `chats.goalStatus` before and after the file appears), and S5.2's two rules: `workdir` accepted / cleared / refused as relative, blank, missing and a file, and the second-executor refusal on both `members.set` and `chats.create` (with one executor beside participants, and an executor-for-executor swap, both allowed) |
| `src/main/handlers/handlers.test.ts` | Every declared method has a handler; the ones still stubbed reject with `internal` |
| `src/renderer/src/stores/chats.test.ts` | `groupChats` (all three buckets, empty groups omitted, the 23:50 case, a future timestamp, order inside a group); load, create, rename guard; `chat.updated` upsert and re-sort; `chat.deleted` clearing the selection; `setWorkdir` binding and clearing, the rejection's `reason` kept in `errorDetails`, and `chooseWorkdir` writing nothing at all when the dialog is cancelled; and S5.10's `setGoal` (the whole object, `null` to remove, the refusal's reason kept), `pickDeliverable` (converted, refused outside, nothing left behind on cancel), `pickMaterials` (the ones inside kept and the stray reported, `[]` on cancel) and a deleted chat forgetting its goal status |
| `src/renderer/src/lib/workdir.test.ts` | `folderName`: the last segment, trailing separators, Windows separators, the filesystem root, a bare name, a name with a dot or a space. S5.10 adds `relativeToWorkdir`: the conversion, a path outside the folder, a sibling whose name starts with the same characters, the folder itself, no folder bound, and both separators |
| `src/renderer/src/components/chat/goal.test.ts` | `goalChipState` (S5.10): nothing without a goal, the kind for `discussion` and `codebase` (including a stale `document` status arriving for one), the file name and path for a `document`, openable **only** once delivered, and not delivered while the query has not answered |
| `src/renderer/src/stores/chats.test.ts` (S5.12) | `loadGoalStatus` keeping the **same object** when the answer has not changed, and writing a new one the moment `delivered` really flips |
| `src/renderer/src/lib/onboarding.test.ts` | `onboardingState` (S7.5): the first step of an empty installation, staying hidden while the settings row is still loading, hidden after Skip, hidden once a chat has a member, **still visible** with a provider saved, each of the five steps becoming current in turn, a local preset passing the credential step with an empty field, the models step needing a *stored* provider rather than a full draft, and a user who added a provider in Settings never being asked for one. Plus `credentialReady` over the sign-in states and a whitespace-only key |
| `src/renderer/src/stores/chats.test.ts` (S7.5) | `create(['agent-1'])` sending `memberAgentIds` and `create()` still sending `{}` |
| `src/renderer/src/components/chat/handoff.test.ts` | `handoffBlocker` (S5.6): the enabled case, each of the three refusals, a blank `workdir`, and the order the rules are applied in when more than one is broken |
| `src/renderer/src/i18n/errors.test.ts` | Every `BackendErrorCode` and every `ValidationReason` resolving to distinct real copy; `validationReasonOf` narrowing a known reason and ignoring everything else; `translateFailure` preferring a reason only under `validation` |
| `src/shared/pricing.test.ts` | The price table's shape, the specific-before-general match order, `estimateCost` (including a local preset costing nothing and an unknown model costing `null`), `contextWindowFor` and both formatters |
| `src/renderer/src/stores/usage.test.ts` | Client-side aggregation: the total moving on `message.updated`, the per-agent split, a local provider costing nothing, an unknown model reporting no cost, and the page-vs-whole-transcript fallback to the backend |
| `src/main/db/chats.test.ts` (`describe('search')`) | Title and message-text matches, one hit per chat, non-text parts ignored, `%` / `_` escaped, blank query, ordering and the user scope |
| `src/renderer/src/lib/message-view.test.ts` | `wasStopped`, and `messageText` stripping a trailing `[PASS]` while leaving a bare one alone |
| `src/renderer/src/stores/messages.test.ts` | `applyDeltaToParts` (append, kind switch, first part, whole part, no mutation); created / delta / updated reduction; ignored deltas; page reversal; failed load as state |
| `src/renderer/src/lib/reorder.test.ts` | The drag's index arithmetic in both directions, the no-op and the out-of-range cases |
| `e2e/chat.spec.ts` | The whole feature against a real local model: create, send, stream, stop, second chat, restart |
| `e2e/onboarding.spec.ts` | S7.5's acceptance sentence: an empty `userData` reaching a streamed reply **through the card alone** — preset, model typed in, provider saved, template agent, first chat, one reply — plus the card staying gone after a restart, Skip hiding it on its own installation across a restart, and Settings → About. Gated on a local Ollama like `chat.spec.ts` |
| `e2e/members.spec.ts` | Offline: an empty chat refusing a send, adding both agents, dragging one above the other and surviving a restart, removing one, persisting the group settings and the header badge, and a deleted agent leaving the chat |
| `e2e/editor.spec.ts` | S5.7, offline and always run: a path in a message body becomes a chip in a chat bound to a folder and nothing outside it does, the chat's folder is what decides, and the Editor setting round-trips through a restart. Owned by [`editor`](../editor/implement.md) |
| `e2e/executor.spec.ts` | Offline (S5.2): the role control writing `executor`, the badge in the agent list and the member panel, the picker greying a second executor and the backend refusing the same list, the folder chip appearing after `chats.update({ workdir })` and going away on Clear, the three invalid paths each refused with their own reason, and all of it surviving a restart. The native picker is not driven; the binding is written through the backend client. S5.5 adds the acceptance sentence: a chat with no executor shows no card (offline, always runs) and — behind the same `qwen2.5:3b` guard `mcp.spec.ts` uses — an executor asked for a file raises the card, nothing is on disk while it waits, Allow writes the file, the card disappears and the diff block appears and opens onto a `diff` code block. S5.6 adds two more: offline, the hand-off button is enabled with a folder and an executor and carries `data-blocked` naming the rule when either is missing (with the backend refusing on the same rule); behind the guard, two participants and an executor hold a short discussion, "Hand to executor" is clicked, the prompt is allowed, a file appears in the folder and a participant speaks again with nothing typed. S5.15 adds one more offline case, and it is this feature's panel rather than the executor's card: the **Always allowed** block starts empty, two grants written straight into the closed database are listed newest first after a relaunch, the revoke button removes one row and leaves the other, and revoking the last brings the empty state back |
| `src/renderer/src/components/chat/tool-call.test.ts` | `previewToolArgs`, `countToolResults` over the shapes a tool actually returns, `describeToolCall`'s three states, and `collectToolCalls` pairing by id rather than by position |
| `src/renderer/src/components/chat/file-refs.test.ts` | S5.7's detector, owned by [`editor`](../editor/implement.md): what resolves inside the folder, what is refused (a URL, `1.2:3`, a Windows path, prose with a slash), and the punctuation stripping |
| `src/renderer/src/components/chat/transcript-rows.test.ts` | `dayBucket` on every calendar boundary (23:50, a future stamp), `buildTranscriptRows`' interleaving and key stability, (S5.5) `collectDiffs` / `collectFileRefs` over a mixed part list, `countDiffLines` ignoring the `+++` / `---` headers and counting a concatenation of two patches, `formatFileRef` with and without a line, (S5.16) the row model marking a conclusion row and only that one, plus `isConclusion`, and (S10.4) the row carrying the client name of a message an IDE sent, plus `originClient` — the flag read wherever it sits, an empty name treated as none, the first of two winning, and the two flag parts not confused |
| `src/renderer/src/components/chat/conclusion.test.ts` | S5.16's three pure rules: `latestConclusion` (none, the newest of several, never a non-agent message), `conclusionPreview` (the first non-empty line, a leading heading marker skipped, the cap, `null` for a flag with no text) and `deliverableBlocker` (the enabled case and the four refusals in the backend's order, including a `codebase` goal) |
| `src/main/handlers/chats.test.ts` (S5.16) | `closingAgentId` stored, cleared with `null` back to an absent field, and refused when it is not a non-empty string |
| `src/main/handlers/chats.test.ts` (S10.4) | `sanitizeOriginClient`: an ordinary name, whitespace, a newline, `\r`, a tab, an ANSI escape, a NUL, a bidi override and a zero-width space; a non-Latin name kept; the cap, and that the cap does not leave a trailing space; `null` for empty, whitespace-only, control-only, and every non-string |
| `src/main/db/chats.test.ts` (S5.16) | `mergeChatSettings`: a cleared closing speaker is absent in the row and still absent after the JSON round trip |
| `e2e/closure.spec.ts` (S5.16 block, no model) | A seeded conclusion drawn as a card with its label and speaker, Copy putting the **markdown source** on the real clipboard, the header chip scrolling the card back into view past thirty later messages, and the chat list showing the conclusion's first line behind its translated label |
| `src/renderer/src/stores/permissions.test.ts` | The permission store (S5.5): a request drawing a card, several ordered oldest first and split per chat, `reply` calling `permission.reply` without removing anything optimistically, `permission.resolved` dismissing the card for all four decisions including `aborted`, a stop clearing every open prompt, a `not_found` rejection dropping the stale card, a second answer while the first is in flight being ignored, and a deleted chat forgetting only its own — plus S5.15's grants, which the Always allowed block reads: loaded on demand, reloaded after an `allowAlways` and not after a plain allow, a revoke redrawn from what the backend answers, a failed load answering `[]`, and a deleted chat forgetting them |
| `src/renderer/src/components/chat/permission-input.test.ts` | `describePermissionInput` (S5.5): a command line kept **verbatim** however long or oddly spaced, a write's path plus its capped content preview, an empty file still reading as a write, an edit's patch, and the fallback to raw JSON for an MCP tool and for arguments that are not the shape the schema promises |
| `src/renderer/src/components/chat/mention-query.test.ts` | `extractMentionQuery`'s boundary rules, `filterMentionCandidates`' longest-first order, and both insertion helpers' spacing |
| `src/renderer/src/components/chat/code-language.test.ts` | Every id, every alias, the first-word rule, and `null` for an unknown language |
| `e2e/polish.spec.ts` | Against a real local model: the header and member-row token counts, an automatic title replacing `New chat`, and the search box filtering the list down to the chat with the distinctive word in it. Captures `test-results/shots/polish.png` |
| `e2e/composer.spec.ts` | Against a real local model: `@Arc` → the popover → Enter → `@Architect `; the `@all` and member chips; a reply rendering a list and a `code` element; a fenced block rendering with a language header and a Copy button. Captures `test-results/shots/chat-polish.png` |

## Known limitations and TODOs

- **`stallTimeoutMs` / `hardTimeoutMs` are read by `AgentSupervisor`**
  ([`presence`](../presence/implement.md)), merged over `AppSettings.timeouts` at
  every heartbeat. Only the hard budget has a control in the group settings block;
  the stall override is honoured by the backend but has no UI of its own.
- **Reordering is mouse-only.** The per-member token count is real since S4.1
  and prints an em dash only for a member that has not spoken in this chat yet.
- **The chat-list conclusion preview needs the transcript.** It is computed from
  the messages store, so it appears for chats that have been opened in this
  session and not for the rest, which keep the member count. A preview for every
  chat would need a backend query.
- **Copy silently does nothing if the clipboard is refused.** The button simply
  does not switch to "Copied"; there is no error line, because nothing was lost
  and the text is selectable in the card.
- **The closing-speaker select is not checked against membership.** Removing the
  chosen member leaves the id stored; the select shows the default and the runner
  falls back to it, so the only visible effect is that re-adding that member
  restores the preference.
- **Cost is an estimate from a checked-in table** (`src/shared/pricing.ts`): a
  model the table does not know reports tokens and no price at all, and a local
  provider reports tokens and a cost of zero, which the UI omits. Editing the
  table is the whole maintenance story; see
  [`providers`](../providers/backend.md).
- **Search is substring-only.** No stemming, no ranking, no highlighting of the
  hit inside the row, and the result is capped at `CHAT_SEARCH_LIMIT` (200).
  Matching is over message **text** parts and the title — not over reasoning,
  tool arguments or tool output.
- **The message list is virtualized** (S2.5) but still loads one page of 100 with
  no upward paging: reaching the top of a long chat does not fetch the messages
  before it. `increaseViewportBy` is set generously (2000px each way) so a row
  that grows while it streams is not remeasured the moment it leaves the
  viewport; the cost is that a short chat is effectively not virtualized at all,
  which is the right trade for the length a chat usually has.
- **Syntax highlighting covers fourteen languages** (`code-language.ts`).
  Anything else renders as plain monospaced text rather than being guessed at.
  Adding one is a row in `SHIKI_LANGUAGE` and a loader in `lib/highlighter.ts`.
- **The Copy button does not report failure.** `navigator.clipboard` is either
  available or it is not, and a red message on a copy button is noise.
- **The permission card is not a modal**, so a user can switch chats with a
  prompt open. The card is per chat and comes back when that chat is reopened;
  nothing warns the user that another chat is waiting on them. A count on the
  chat-list row is the obvious fix and is not in S5.5.
- **A `file-ref` chip opens the file** since S5.7, and the chips a user actually
  sees come from the path **detector** over the body text: nothing produces a
  `FileRefPart` yet, so the stored-part rendering is still waiting for the step
  that emits them. See [`editor`](../editor/context.md).
- **Tool cards are unexercised by a real tool.** The parts are rendered and
  unit-tested against fixtures, and S3.1 produces the first real ones: a
  `tool-call` part now also carries `serverId` / `serverName`, which is what the
  card's `serverName · toolName` line reads.
- **`chats.members.list` is one call per chat** on load. See the trade-off table
  in `context.md`.
- **A goal's `materials` are recorded, validated and listed here; what is done
  with them is S5.11's** — they are inlined in every member's prompt up to a
  quarter of that model's context window, and named by path beyond it
  ([`agent-turn`](../agent-turn/implement.md)). Two consequences for this
  feature: the panel gives no indication of how much of a list will fit, and a
  material deleted after it was saved is dropped from the prompt silently, while
  the panel still lists it.
- **"Delivered" is polled, not watched.** `chats.goalStatus` runs when a chat is
  opened, on every `chat.updated` for it, at every round boundary and at the end
  of a run (S5.12), so a deliverable written by something that is not this app is
  noticed at the next such moment rather than immediately. A filesystem watcher
  is deliberately not in Phase 5.
- **The chip only flips for the chat that is open.** The query is asked for
  `selectedId`, so a hand-off finishing in a chat the user is not looking at
  leaves that chat's chip stale until they open it — which is the same moment it
  would have been asked anyway.
- **The Goal block's two dialogs are not driven end to end.** They are native
  modals, like the folder picker, so `e2e/executor.spec.ts` writes the goal
  through the backend client and asserts what the UI does with it. The
  conversion those buttons perform is unit-tested instead
  (`relativeToWorkdir`, and the two store actions).
- **`relativeToWorkdir` compares paths exactly.** Both strings come from one
  dialog rooted at the folder, so a case-insensitive volume cannot make them
  differ — but a path assembled some other way, on such a volume, with different
  case, would be refused as outside.
- **The one-executor rule is enforced on membership only.** Promoting an agent
  to `executor` while it is already in a chat that has one is not refused; see
  the known gap in `backend.md`.
- **A refused `workdir` prints in the left column**, with every other chats-store
  failure, rather than under the row the user clicked. The sentence names the
  reason, so it reads correctly there — but it is further from the control than
  it could be.
