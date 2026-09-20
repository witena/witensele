# committees — Frontend

**There is no committee UI yet.** S9.1 is the data model and the API; the page
arrives in S9.2 and the New chat dialog in S9.3. This document records what
S9.1 changed in the renderer (almost nothing) and what the two later steps are
committed to, so the plan is not re-invented when they start.

## Pages and components

| File | Responsibility |
|---|---|
| `src/renderer/src/stores/chats.test.ts` | **S9.1**: the `Chat` fixture carries `committeeId: null`. The only renderer change in this step |
| `src/renderer/src/pages/committees-page.tsx` | **S9.2**: the Agents page's two-column layout — list on the left, editor on the right |
| `src/renderer/src/components/committees/committee-list.tsx` | **S9.2**: rows with a member count, and "+" |
| `src/renderer/src/components/committees/committee-editor.tsx` | **S9.2**: name, description, the ordered member list with add / remove / drag-to-reorder, two-step delete |
| `src/renderer/src/components/committees/committee-topics.tsx` | **S9.2**: the chats whose `committeeId` is this one, newest first; **S9.3** adds "New topic" |
| `src/renderer/src/components/chat/new-chat-dialog.tsx` | **S9.3**: at most one committee plus any number of individual agents |
| `src/renderer/src/components/chat/member-panel.tsx` | **S9.3**: the "Sync committee members" button; its picker and drag-to-reorder list are extracted in S9.2 for the committee editor to reuse, with no change to its own behaviour or test ids |

## State

| Store | Field | Type | Meaning |
|---|---|---|---|
| `stores/chats` | `chats[].committeeId` | `string \| null` | **S9.1**: server-owned, mirrored like the rest of `Chat`; nothing reads it yet |
| `stores/committees` | `committees` | `Committee[]` | **S9.2**: server-owned mirror, on the pattern of `stores/agents` |
| `stores/committees` | `editing`, `error`, `errorCode` | | **S9.2**: local editor state and the last refusal |
| `stores/ui` | `page` | `Page` | **S9.2**: gains `'committees'` |
| `stores/ui` | `newChatDialog` | `{ open: boolean; committeeId?: string }` | **S9.3**: so the Committees page can open the dialog with a committee preselected |

## Backend calls

Every call goes through `getBackend()` — no component touches `window.witena`
(CLAUDE.md rule #6).

| Call / subscription | Called from | Purpose |
|---|---|---|
| `committees.list` / `get` / `create` / `update` / `delete` | **S9.2** `stores/committees` | The whole page |
| `chats.create({ title?, committeeId?, memberAgentIds })` | **S9.3** `stores/chats.create`, widened from its `memberAgentIds?` argument | Convene a topic |
| `chats.members.set` | **S9.3** `member-panel.tsx` | "Sync committee members": the current members plus the missing ones appended, never a removal |
| `chat.updated` | the existing event bridge | Already carries `committeeId`, so a topic whose committee was deleted loses its badge without a reload |

## Interaction states

The Committees page (S9.2), for the record:

| State | What the user sees |
|---|---|
| idle | The committee list; the editor for the selected one |
| loading | The list's skeleton, as on the Agents page |
| streaming | Not applicable — a committee never runs |
| empty | An empty-state card inviting the first committee |
| error | The refusal translated from `ValidationReason` / `translateFailure`, never a backend sentence. A second executor is greyed out in the picker with the existing `chat.executorTaken` copy |

## Copy and i18n

Nothing in S9.1: this step adds no user-facing string, and the backend produces
none — its refusals are `ValidationReason` identifiers the renderer already
translates. S9.2 adds `nav.committees` and a `committees.*` namespace to both
locale files, and adds `committees` to CLAUDE.md's namespace list.

## Accessibility and keyboard

S9.2: the member list is reorderable by keyboard as well as by drag, and the
delete is two-step. S9.3: `components/ui/dialog.tsx` is the first modal
primitive — focus trap, Escape and backdrop click close it, `role="dialog"`
plus `aria-modal`.
