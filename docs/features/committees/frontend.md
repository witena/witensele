# committees — Frontend

S9.2 built the **Committees page**: a fourth destination on the rail where a
committee is named, its members are put in order, and the topics it has been
convened on are listed. S9.3 made a committee something you can *use*: the
**New chat dialog** convenes a topic on one, **New topic** opens that dialog
from the committee's own page, the committee shows as a badge on the chat row
and in the chat header, and **Sync committee members** closes the gap the
snapshot leaves behind.

## Pages and components

| File | Responsibility |
|---|---|
| `src/renderer/src/pages/committees-page.tsx` | **S9.2**: the Agents page's two-column layout — the 264px list with its count and "+" on the left, the editor on the right. Owns the four loads (committees, agents, providers, chats) and the "click Delete again to confirm" arming, which is view state and resets whenever the selection moves |
| `src/renderer/src/components/committees/committee-list.tsx` | **S9.2**: one row per committee — the name and, under it, the member count. Free of i18next, like `AgentList`: the page passes the already-translated count label |
| `src/renderer/src/components/committees/committee-editor.tsx` | **S9.2**: the header (name, member count, Delete, Save) and the two-column body — name, description and the ordered member list on the left, the topics on the right. Everything writes into the store's `draft`; only Save reaches the backend |
| `src/renderer/src/components/committees/committee-topics.tsx` | **S9.2**: the chats whose `committeeId` is this one, newest first, each row selecting that chat and switching to the Chats page. **S9.3**: the `committee-new-topic` button, which opens the dialog *and then* navigates — this component does not survive `setPage('chats')`, so the request has to be in the store before the page changes. Disabled while the committee is unsaved and has no id |
| `src/renderer/src/components/agents/agent-picker.tsx` | **S9.2, extracted** from `member-panel.tsx`: the add-an-agent popover — the candidate rows, the executor badge, and the second executor shown disabled with `chat.executorTaken` under it. The open state, the outside-click and the positioning stay with the caller, because the member panel closes its picker from a listener anchored on the whole panel; a listener moved inside would fire before the Add button's own click and reopen what it just closed. `testIdPrefix` reproduces the panel's three ids exactly (`member-picker`, `member-candidate`, `member-candidate-executor`) |
| `src/renderer/src/components/ui/reorderable-list.tsx` | **S9.2, extracted** from `member-panel.tsx`: the draggable rows. Generic in the item, renders **no container element** (the caller's flex column and its `gap` are what lay the rows out), and calls `onReorder(from, to)` — the same arithmetic `lib/reorder.ts` has always done |
| `src/renderer/src/components/chat/member-panel.tsx` | **S9.2**: uses both of the above. Same DOM, same classes, same test ids — `e2e/members.spec.ts` is unchanged. **S9.3**: `member-sync-committee` under the list, drawn only when `missingCommitteeMemberIds` is non-empty. The panel does not know what a committee is — the page hands it the ids and the callback |
| `src/renderer/src/components/layout/nav-rail.tsx` | **S9.2**: the `committees` button, between Chats and Agents, `UsersRound`, `nav.committees` |
| `src/renderer/src/components/layout/app-shell.tsx` | **S9.2**: `committees` → `CommitteesPage` in the page lookup |
| `src/renderer/src/components/chat/new-chat-dialog.tsx` | **S9.3**: an optional title, committees as a single-select list that may be left empty, agents as a multi-select list where the committee's members are ticked and locked, a live "n members will join" line, Create and Cancel. A refusal keeps the dialog open and prints the reason inside it — the chat list's error line is behind the scrim |
| `src/renderer/src/components/ui/dialog.tsx` | **S9.3**: the shell's first modal primitive — `role="dialog"`, `aria-modal`, focus trapped and restored, Escape from a capturing document listener (a text field inside would otherwise eat it), backdrop dismiss on `mousedown` and only when the press started on the scrim. No `open` prop: the caller renders it or does not |
| `src/renderer/src/pages/chats-page.tsx` | **S9.3**: loads `committees.list` as a fourth list, resolves `Chat.committeeId` to a name for the header chip and the row badge, computes `missingCommitteeMembers`, and renders the dialog |
| `src/renderer/src/components/chat/chat-list.tsx` | **S9.3**: the `chat-item-committee` badge under the title, from a `committeeNames` lookup the page passes. An id the map cannot resolve draws nothing |

## State

| Store | Field | Type | Meaning |
|---|---|---|---|
| `stores/committees` | `committees` | `Committee[]` | **S9.2**: server-owned mirror of `committees.list`, newest `updatedAt` first. An update replaces the row *in place* rather than re-sorting it to the head — a row that jumped under the cursor on every Save would be worse than a list one reload behind its own ordering |
| `stores/committees` | `selectedId`, `mode`, `draft`, `dirty`, `saving` | | **S9.2**: the editor's lifecycle, on `stores/agents`' pattern. `draft` is a `CommitteeInput` copy, `mode` is `idle` / `create` / `edit`, and `dirty` starts **true** while creating (a new record has nothing stored to differ from) |
| `stores/committees` | `error`, `errorCode`, `errorDetails` | | **S9.2**: the last refusal. `errorDetails` is the rejection's own `details`, which is what lets `translateFailure` say "this group already has an executor" (`second_executor`) instead of "the request was rejected as invalid" |
| `stores/chats` | `chats[].committeeId` | `string \| null` | **S9.1**: server-owned, mirrored like the rest of `Chat`. **S9.2** reads it — it is what the topics list filters on |
| `stores/ui` | `page` | `Page` | **S9.2**: gained `'committees'`; `PAGES` is now `['chats', 'committees', 'agents', 'settings']`, which is rail order |
| `stores/ui` | `newChatDialog` | `{ open: boolean; committeeId?: string }` | **S9.3**: `committeeId` is a **seed**, not the live selection — the dialog copies it on mount and owns it from there, so a click in a list nothing else reads cannot re-render the shell. Closing clears it, or the next plain "+" would arrive with the last committee still ticked |
| `stores/chats` | `create(request)` | `readonly string[] \| NewChatRequest` | **S9.3**: widened. A bare array is still `memberAgentIds` (the first-run card's call, unchanged); the object adds `title` and `committeeId`. Empty fields are **omitted** from the payload, so `create({})` is byte for byte the call the "+" button used to make |

Component-local state, deliberately not in the store: the page's `deleteArmedId`
(view state that must reset on selection) and the editor's `picking` (whether
the member popover is open, which belongs to the screen, not to the record).

Membership is **not** a separate store field and not a separate call: it rides
on the entity, so `addMember` / `removeMember` / `moveMember` are `patchDraft`
in disguise and the whole list is written by `save`.

## Backend calls

Every call goes through `getBackend()` — no component touches `window.witena`
(CLAUDE.md rule #6).

| Call / subscription | Called from | Purpose |
|---|---|---|
| `committees.list` | **S9.2** `stores/committees.load`, from the page's mount effect | The left column |
| `committees.create` / `committees.update` | **S9.2** `stores/committees.save` | One write per Save, the member list included |
| `committees.delete` | **S9.2** `stores/committees.remove`, from the two-step Delete | Removes the committee; its topics keep their members and lose only `committeeId` |
| `agents.list`, `providers.list`, `chats.list` | **S9.2** the page's mount effect | The picker's candidates, the model line on a member row, and the topics list |
| `chat.updated` | the existing event bridge | Already carries `committeeId`, so a topic whose committee was deleted leaves this list without a reload |
| `committees.get` | — | Nothing calls it: the page holds the list it is editing. It exists for the server host and for S9.3 |
| `chats.create({ title?, committeeId?, memberAgentIds })` | **S9.3** `stores/chats.create`, widened, from the dialog's Create | Convene a topic. Only the *extras* travel: the committee expansion is the handler's |
| `chats.members.set` | **S9.3** `chats-page.tsx`, from the panel's Sync button | The current members plus the missing ones appended, never a removal. An ordinary membership write, so a `second_executor` refusal comes back through the path every other one uses |
| `committees.list` | **S9.3** the chats page's mount effect | Names for the two badges, the dialog's list, and the membership the sync compares against |

## Interaction states

| State | What the user sees |
|---|---|
| idle | The committee list; the "select or create one" placeholder in the editor area, which is the Agents page's own empty state |
| loading | The list is empty for the one tick `committees.list` takes; there is no skeleton, exactly as on the Agents page |
| streaming | Not applicable — a committee never runs |
| empty | An `EmptyState` card in the left column inviting the first committee |
| invalid | Save is **disabled** and the reason is under the name field (`committees.validation.*`). The store's `validateDraft` computes the same two rules the handler enforces, so the button is disabled rather than the click refused |
| error | `committees-error` under the list, translated from `errorCode` + `errorDetails` through `translateFailure` — never a backend sentence. A second executor is additionally greyed out *in the picker*, with the existing `chat.executorTaken` copy, so the refusal is usually prevented rather than reported |
| modal (S9.3) | The New chat dialog over a dimmed window. Escape, the backdrop, Cancel and the header's × all dismiss; Create closes it only on success, and a refusal prints `new-chat-error` inside the panel |
| drifted (S9.3) | The member panel shows `member-sync-committee` with the count of missing members. It is absent, not disabled, when there is nothing to sync — a permanently greyed button would suggest the feature was broken rather than unnecessary |

## Copy and i18n

S9.2 added `nav.committees` and the top-level `committees.*` namespace to both
locale files, and `committees` to CLAUDE.md's namespace list and to
`locales.test.ts`'s `EXPECTED_NAMESPACES`. S9.3 added `committees.newTopic`,
`common.close`, and the `chat.newChat*` / `chat.committeeBadgeTitle` /
`chat.syncCommittee*` keys — the dialog belongs to a chat, so its copy is in
the `chat` namespace. The tree is in
[`../i18n/frontend.md`](../i18n/frontend.md).

Five keys are deliberately **not** duplicated and are reused across the two
screens: `chat.executorTaken` (the picker's disabled sub-line, and the dialog's
blocked agent row), `agents.executorBadge` / `agents.executorBadgeTitle` (the
tag on a member row, a committee row and a dialog row), `chat.addMemberEmpty`
(an empty agent library, said the same way wherever one is offered) and
`nav.committees` (the dialog's section heading is the word the rail already
uses). They are the same rule, the same tag and the same words; a second
translation of any of them would be free to drift.

Committee and agent **names** are printed, never translated: they are stored
data, and a badge that said "Committee" instead of "Architecture review" would
tell the user nothing they did not already know. The sentence explaining what
the badge means is the tooltip, `chat.committeeBadgeTitle`.

Refusals are translated from `BackendErrorCode` and `ValidationReason` through
`i18n/errors.ts`, exactly as everywhere else. The backend produces no committee
copy at all.

## Accessibility and keyboard

- Every member row carries **Move up** and **Move down** buttons beside Remove,
  because dragging is pointer-only and this list is what decides who speaks
  first. They are the same `moveMember(from, to)` the drop handler calls, and
  they are disabled at the ends of the list rather than wrapping.
- The three hover controls use `opacity-0 group-hover:opacity-100
  focus-visible:opacity-100`, so a keyboard user sees the button the moment it
  is focused, as on the member panel's Remove.
- Delete is two-step (arm, then confirm) rather than a modal — the Agents page's
  and the chat list's pattern. The one modal in the feature is the New chat
  dialog, and it is modal because it composes three choices into one write.
- **The dialog is operable from the keyboard alone** (S9.3): focus lands inside
  the panel on open, Tab and Shift+Tab cycle within it, Escape dismisses, and
  focus returns to whatever had it before. Every row in both of its lists is a
  real `<button>`, and the tick beside a row is drawn rather than a real
  checkbox — the row is the control, and two focus stops for one decision would
  be worse than one.
- Every list row is a real `<button>`; the editor's fields are `Field` +
  `Input`, which wire `htmlFor` to the control's id.
