# orchestration — Frontend

This feature is a main-process scheduler, so it has **no screen of its own**.
What the user sees of it is rendered by [`chats`](../chats/frontend.md): the Stop
button, the run status in the header, the round and "replying to" labels on a
message, and the highlighted `@Name` tokens in a reply. S2.5 polishes all of it;
S2.3 made it real.

S5.6 adds the one **control** that is this feature's own: "Hand to executor",
directly above the composer. It is the second way to start a run, so it lives in
the run store beside `send` and `stop` rather than in the Actions card, whose two
actions are deliberately ordinary messages. S5.16 adds a third caller of that
same store action: the conclusion card's "Write to the deliverable", which is
`handoff(chatId, 'deliver')` — the same call the Actions card makes, refused by
the same `handoffBlocker`.

## The renderer's half

| File | Responsibility |
|---|---|
| `src/renderer/src/stores/run.ts` | `activeByChat`, reduced from `run.started` / `run.round` / `run.finished`; `send(chatId, text, mentions?, rounds?)` (S5.14), `handoff(chatId, intent?)` (S5.6, S5.12) and `stop`; `errorDetails` beside `errorCode`, so a refusal's `ValidationReason` survives to the sentence |
| `src/renderer/src/components/chat/handoff-button.tsx` | The button above the composer: always drawn for a selected chat, disabled with the reason in its `title` and in `data-blocked` |
| `src/renderer/src/components/chat/handoff.ts` | `handoffBlocker({ workdir, members, running, intent?, goal? })` → the `ValidationReason` that disables it, or `null`. Pure, and the same four rules the backend applies in the same order. One function for both controls: "Write the deliverable" is the same rules plus `handoff_no_deliverable` (S5.12) |
| `src/renderer/src/components/chat/actions-card.tsx` | The Actions card's third row, "Write the deliverable" (`chat-write-deliverable`, S5.12): the **one** action in that card that is not an ordinary message — it calls `handoff(chatId, 'deliver')` — disabled with its reason in `data-blocked`, exactly like the button above the composer. Its "Start a vote" row is still an ordinary message, now sent with `VOTE_ROUNDS` (`1`, S5.14) |
| `src/renderer/src/lib/event-bridge.ts` | Routes the three `run.*` events into the store |
| `src/renderer/src/pages/chats-page.tsx` | The header's run status, and the members it passes to the composer and the message list |
| `src/renderer/src/components/chat/composer.tsx` | Renders Stop instead of Send while a run is active, and resolves `@Name` before sending |
| `src/renderer/src/components/chat/message-item.tsx` | `Round n`, `Replying to @x`, the accent-coloured mentions in the body, and (S5.16) the conclusion card around the body of a closing message |
| `src/renderer/src/components/chat/conclusion.ts` | `latestConclusion`, `conclusionPreview` and `deliverableBlocker` — the three pure questions the card, the header chip and the chat list ask about a transcript (S5.16) |
| `src/renderer/src/components/chat/markdown.tsx` | `highlightMentions`, applied to the children of `p` and `li` |
| `src/shared/mentions.ts` | The matching rule itself, shared with the backend |

| Store | Field | Type | Meaning |
|---|---|---|---|
| `run` | `activeByChat` | `Record<string, { round, speakers }>` | Backend-owned. Present = a run is in flight |
| `run` | `sendingByChat` | `Record<string, boolean>` | Local; covers the `chat.send` **or `chat.handoff`** round trip before `run.started` arrives |
| `run` | `errorDetails` | `unknown` | The `details` of the last refusal; `translateFailure` narrows it to a `ValidationReason` |

The rule the store is written around: **the run state comes from the events, not
from the local `send()` call.** A message sent during an active run joins that
run at its next round boundary and starts no second one, so a store that flipped
its own flag would show a Stop button for a run that does not exist — and leave
it showing after the real one finished. `run.test.ts` pins this down.

`stop()` likewise does not clear the state itself; `run.finished` does. The abort
takes a moment to unwind, and the button must not lie about it.

## What the events become on screen

| Event | Rendered as |
|---|---|
| `run.started` | The Stop button stays up (it appeared on send) |
| `run.round` | The header's right-hand status: "Round 2 · Architect, Reviewer speaking" (`chat.runStatus`), with the ids resolved to names through the agents store |
| `presence.changed` | The dot on the member row and on the message avatar follows that agent through the four states. Presence is per (chat, agent), so the parallel speakers of one round do not flip each other back. The state machine behind it is [`presence`](../presence/frontend.md)'s |
| `run.finished` | The status disappears and the button returns to Send, whatever the reason |
| `message.created` with a `system-notice` | A dimmed line in the transcript, translated by `translateNotice` — `notices.noMentions`, `notices.maxRoundsReached`, `notices.runFailed`, and from S5.14 `notices.consensus` and `notices.voteClosed` |
| `run.round` with one speaker, right after `notices.consensus` | The closing turn (S5.14). Until S5.16 nothing on the screen marked it as special; now the message it produces arrives carrying a `ConclusionPart` and is drawn as the **conclusion card** — see [`chats`](../chats/frontend.md), which owns the card, the header chip and the chat-list preview |

## Message header and body

- **`Round n`** — from `Message.round`, printed for anything above 0. Rounds are
  numbered **within a run**, so the first answer to a new question is Round 1
  again; the number keeps climbing only while the agents keep each other going.
- **`Replying to @x`** — from `Message.inReplyTo`, the agent ids whose
  previous-round messages mentioned this agent, plus the literal `user`. The
  names are resolved at render time from the agents store (an agent can be
  renamed long after the message was written) and joined into one string, so the
  sentence stays translatable as a whole (`chat.replyingTo` takes `{{names}}`).
- **Mentions** — `@Name` tokens naming a member of this chat are painted in the
  accent colour by decorating the rendered children of `p` and `li` rather than
  by rewriting the markdown source, which would also hit code fences and links.

`data-round`, `data-author` and `data-notice-key` are on the row for the
end-to-end specs: they assert on those rather than on rendered copy, which keeps
them language-independent.

## Backend calls

| Call / subscription | Called from | Purpose |
|---|---|---|
| `invoke('chat.send', { chatId, text, mentions? })` | The composer, on Enter or Send | Stores the message and starts or joins a run. `mentions` is what the composer resolved with `parseMentions`; the backend parses the text again, so it is a hint rather than the authority |
| `invoke('chat.handoff', { chatId, intent? })` | The "Hand to executor" button, and the Actions card's "Write the deliverable" (`intent: 'deliver'`, S5.12) | Stores the hand-off message and runs implement + review. Refused with `handoff_no_workdir` / `handoff_no_executor` / `handoff_no_deliverable` / `handoff_run_active`, which are the four states the controls are already disabled in — the call is what a stale window or a second client meets. `intent` is **omitted** for a plain hand-off rather than sent as `'implement'`: the backend's default is the one that decides |
| `invoke('chat.stop', { chatId })` | The Stop button | Aborts every active turn and drops what is pending |
| `subscribeTo('run.*')` (via the bridge) | Bootstrap | Drives the Send / Stop swap and the header status |

## Interaction states

| State | What the user sees |
|---|---|
| idle | Send button, enabled when there is a chat and some text |
| sending | Stop appears immediately — `sendingByChat` covers the gap before `run.started` |
| running | Stop stays until `run.finished`, and the header names the round and its speakers |
| stopped | The button returns to Send; each interrupted message shows the "Stopped" hint |
| max rounds | The button returns to Send and a notice line explains why nobody is speaking any more |
| nobody mentioned | In `mention-only`: no agent row at all, one notice line |
| error | The button returns to Send; the failure is on the message row. A run that failed entirely also leaves a `runFailed` notice |
| hand-off available | "Hand to executor" is enabled: the chat has a folder, has an executor, and is idle |
| delivery available | "Write the deliverable" is enabled: all of the above, and the chat's goal is a `document` naming a file |
| hand-off unavailable | The same button, **disabled**, with the missing rule in its `title` — no folder, no executor, or a run in flight. Disabled rather than hidden: a control that vanishes teaches nothing |
| handed over | The transcript gains a user row reading "Handed to X…", the executor answers alone, and every other member reviews in the next round. Nothing else about the screen is special |
| agreed | The dimmed consensus line, then one more agent message with the group's conclusion, then the composer back to Send (S5.14). The user's next message starts a new chain as usual |
| agreed, in a `document` chat with a folder and an executor | The same, and then — with nobody clicking — the dimmed `handoffDeliver` line with the conclusion quoted under it, the executor's turn with its `write_file` permission card, the diff block and the delivered chip, and the other members' review (S5.18). Turned off per chat by the Goal block's "Write the deliverable automatically" switch ([`chats`](../chats/frontend.md)) |
| voted | "Start a vote" sends `@all` plus its prompt with `rounds: 1`: every member answers once and the dimmed `voteClosed` line ends it, whatever the chat's Max automatic rounds says (S5.14) |

Sending while a run is active is **not** blocked: the message appears
immediately and is answered from the next round. See the decision table in
[`context.md`](./context.md).

## Copy and i18n

| Key | Used for |
|---|---|
| `chat.round` | `Round {{round}}` on a message |
| `chat.replyingTo` | `Replying to {{names}}` on a message |
| `chat.runStatus` | `Round {{round}} · {{speakers}} speaking` in the header |
| `notices.noMentions` | The `mention-only` message that named nobody |
| `notices.maxRoundsReached` | The automatic-round cap, with `{{max}}` |
| `notices.runFailed` | An internal failure, with `{{message}}` |
| `notices.agentSkipped` | Written by `agent-turn` when the hard timeout skipped a member; see [`presence`](../presence/frontend.md) |
| `notices.allOffline` | Written by the runner when every speaker of a round is offline |
| `notices.contextTruncated` | Written once per run per agent when `fitHistory` had to drop messages, with `{{agent}}` and `{{dropped}}` (S4.2) |
| `notices.materialsTruncated` | Written once per **chat** when a member could not fit the goal's materials, with `{{agent}}` and `{{omitted}}` (S5.11) |
| `notices.consensus` | The group agreed and the chain stopped; the conclusion is the message under it (S5.14). No parameters |
| `notices.voteClosed` | A chain that carried its own `rounds` cap has run them — "Start a vote" is its one caller (S5.14). No parameters |
| `chat.handoff` | The button's label |
| `chat.handoffTitle` | Its tooltip while it is enabled |
| `chat.writeDeliverable`, `chat.writeDeliverableTitle` | The Actions card's third row and its tooltip while enabled (S5.12) |
| `errors.handoff_no_workdir`, `errors.handoff_no_executor`, `errors.handoff_no_deliverable`, `errors.handoff_run_active` | The tooltip while either control is **disabled**, and the sentence under the composer if the call is refused anyway. One set of words for one rule |
| `notices.handoff` | The hand-off message itself, with `{{agent}}` — rendered by `translateNotice` on a `user` row (S5.6) |
| `notices.handoffDeliver` | The same for a `deliver` hand-off, with `{{agent}}` and `{{path}}` (S5.12) |
| `notices.runStopped` | Reserved; Stop writes no notice, because the interrupted row already says so |

## Accessibility and keyboard

Send and Stop occupy the **same slot** rather than sitting side by side: a run is
either happening or not, and two controls would leave the user guessing which one
applies. Both are reachable by keyboard in the composer's tab order, and the
icon-only Send carries a translated `aria-label`. The run status is plain text in
the header rather than a live region; S2.5 decides whether it should announce
itself.
