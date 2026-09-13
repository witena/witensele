# orchestration — Frontend

This feature is a main-process scheduler, so it has **no screen of its own**.
What the user sees of it is rendered by [`chats`](../chats/frontend.md): the Stop
button, the run status in the header, the round and "replying to" labels on a
message, and the highlighted `@Name` tokens in a reply. S2.5 polishes all of it;
S2.3 made it real.

## The renderer's half

| File | Responsibility |
|---|---|
| `src/renderer/src/stores/run.ts` | `activeByChat`, reduced from `run.started` / `run.round` / `run.finished`; `send(chatId, text, mentions?)` and `stop` |
| `src/renderer/src/lib/event-bridge.ts` | Routes the three `run.*` events into the store |
| `src/renderer/src/pages/chats-page.tsx` | The header's run status, and the members it passes to the composer and the message list |
| `src/renderer/src/components/chat/composer.tsx` | Renders Stop instead of Send while a run is active, and resolves `@Name` before sending |
| `src/renderer/src/components/chat/message-item.tsx` | `Round n`, `Replying to @x`, and the accent-coloured mentions in the body |
| `src/renderer/src/components/chat/markdown.tsx` | `highlightMentions`, applied to the children of `p` and `li` |
| `src/shared/mentions.ts` | The matching rule itself, shared with the backend |

| Store | Field | Type | Meaning |
|---|---|---|---|
| `run` | `activeByChat` | `Record<string, { round, speakers }>` | Backend-owned. Present = a run is in flight |
| `run` | `sendingByChat` | `Record<string, boolean>` | Local; covers the `chat.send` round trip before `run.started` arrives |

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
| `message.created` with a `system-notice` | A dimmed line in the transcript, translated by `translateNotice` — `notices.noMentions`, `notices.maxRoundsReached`, `notices.runFailed` |

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
| `notices.runStopped` | Reserved; Stop writes no notice, because the interrupted row already says so |

## Accessibility and keyboard

Send and Stop occupy the **same slot** rather than sitting side by side: a run is
either happening or not, and two controls would leave the user guessing which one
applies. Both are reachable by keyboard in the composer's tab order, and the
icon-only Send carries a translated `aria-label`. The run status is plain text in
the header rather than a live region; S2.5 decides whether it should announce
itself.
