# agent-turn — Context

## Problem

One agent speaking once. Everything between "it is your turn" and "here is your
message, finished": build the prompt this agent should see, call the model, stream
the answer into a message row the user is already watching, and leave that row in
a state that cannot be mistaken for "still going".

It is the smallest unit of the product, and the one place where a wrong decision
is invisible rather than loud — a missing `[name]:` prefix or a replayed `[PASS]`
does not throw, it just makes every answer slightly worse.

## Scope

- **System prompt assembly**, in PLAN's order: the agent's own `systemPrompt`,
  the group briefing, the executor's folder and tools when this agent is one
  (S5.4), the **workspace briefing** when the chat has a folder at all (S5.11),
  the enabled skills' `name — description` lines (S3.2), the whole `MEMORY.md`
  index (S3.3) and, last, the **materials** the goal marked (S5.11).
- **The materials** (`materials.ts`, S5.11): reading `goal.materials`, laying
  each entry out as a block — a file as its text, a folder as its listing plus
  its files — and stopping at a quarter of the model's context window, after
  which the rest are named by path with the note that `read_file` fetches them.
  Binary files are named, never inlined.
- **Which tools each member gets** (S5.11): all seven for the chat's executor,
  the four read-only ones for every other member of a chat with a folder, none
  at all without one.
- **The group briefing** in both languages (`briefing.ts` + `briefing.en.ts` +
  `briefing.zh-CN.ts`), following the UI language setting — including, since
  S5.10, the **chat's goal**: one sentence for its kind, the user's description
  verbatim, the deliverable for a `document`, and for a `codebase` the rule that
  the executor makes the change afterwards.
- **History transform** (`history.ts`): the shared transcript → this agent's
  `ModelMessage[]`.
- **The streaming turn** (`agent-turn.ts`): `streamText`, `fullStream`, the
  `message.delta` events, the periodic flush to SQLite, the terminal status, the
  usage, and the supervisor registration (`beginTurn` / `activity` / `endTurn`)
  around the turn.
- **Parsing the finished text for `@mentions`** (S2.3) and storing them on the
  message. *Who* that makes speak next is `orchestration`'s decision, not this
  one's.
- Storing the `inReplyTo` the caller passed, and accepting a **prebuilt history
  snapshot** so a parallel round can hand every speaker the same transcript.
- Appending one `DiffPart` per file the turn wrote, once the stream has ended
  (`diffPartsFrom`, S5.5): the patches the write tools returned, grouped by path
  in call order. The turn is where the stored parts are, so it is where "what did
  this turn change" can be answered without asking the filesystem.
- Appending a `FileRefPart` for the chat's deliverable when this turn is the one
  that brought it into existence (`deliveredRef`, S5.12): one `existsSync` before
  the stream, one after it. The turn is also the only thing that can answer
  "did *this* turn produce it", which is what makes the chip a statement rather
  than a decoration.
- Telling the reviewers of a hand-off that is what they are (`reviewing`, S5.12):
  one more section of the group briefing, for one round, set by the runner.
- **Deciding whether this agent's thinking is kept at all** (`showsThinking`,
  S5.14): when it is not, a `reasoning-delta` is discarded as the stream arrives
  rather than stored as a `ReasoningPart`. The request is unchanged — the model
  still thinks — and the delta still counts as activity for the supervisor.
- **The closure markers in the briefing** (S5.14): one rule beside `[PASS]` in
  both languages, teaching `[AGREED]` and `[CONTINUE]`, and the `closing` block
  that replaces it for the one turn that writes the group's conclusion.
- **Marking that turn's message as the conclusion** (`markConclusion`, S5.16): a
  `ConclusionPart` in front of the parts of a `closing` turn that finished
  `done`. The turn is where the stored parts are, so it is where the flag is
  written; what the flag *looks like* is [`chats`](../chats/frontend.md)'s.
- **Keeping a flag part out of the prompt** (S5.16, S10.4): `partsToText` lists
  the three kinds that contribute text, so `ConclusionPart` and — since S10.4 —
  `OriginPart` never reach a model. The second is the stronger rule of the two:
  a group told that an IDE is asking starts answering the IDE. Who *sent* a
  question belongs to the transcript, which is [`chats`](../chats/context.md)'s.
- **The closing block knows the goal** (S5.18): in a `document` chat it names
  the deliverable, says the executor writes it from this very message, and asks
  for the file's **content** rather than a summary — and forbids addressing the
  executor, naming a file or asking anyone to save anything, which is exactly
  what the closing turn that motivated the step did. A `codebase` chat gets the
  matching sentence without a file; a `discussion` chat, and a chat with no
  goal, get the S5.14 block unchanged and never hear the word "executor".

## Out of scope

| Not here | Owned by |
|---|---|
| Who speaks and when | `orchestration` |
| Deciding who the `@mentions` in a reply make speak next | `orchestration` |
| The `@name` matching rule itself | `src/shared/mentions.ts`, shared with the composer |
| Tool **definitions**: the MCP pool, `read_skill` / `read_skill_file`, `memory_save` / `memory_search`, the seven executor tools | [`mcp`](../mcp/context.md) (S3.1), [`skills`](../skills/context.md) (S3.2), [`memory`](../memory/context.md) (S3.3), [`executor`](../executor/context.md) (S5.4). The turn calls `ctx.mcp`, `buildSkillTools`, `buildMemoryTools` and `buildExecutorTools`; the `stopWhen` loop, the tool message parts and **which of them an agent gets** are here |
| The permission prompt itself — the gate, the two events, `permission.reply` | [`executor`](../executor/context.md). The turn supplies the signal that cancels a pending prompt, and stores the resulting `tool-error` like any other |
| Drawing the `DiffPart`s — the collapsed block, the code block, the card that answered the prompt | [`executor`](../executor/frontend.md) and [`chats`](../chats/frontend.md). The turn produces the parts; the transcript decides what they look like |
| The content of the skills, memory and executor prompt sections | `skills`, `memory` and `executor` build the text; the turn decides the order and whether to include them |
| The goal itself — the panel, the validation, the column, the header chip | [`chats`](../chats/context.md), S5.10. This feature owns only what the goal *says to a model*, and its wording in both languages |
| The *contents* of the workspace briefing — the tree, the `.gitignore` rules, the git state | [`executor`](../executor/context.md), `executor/workspace.ts`. This feature decides **where in the prompt** it goes and **who** gets one |
| Which paths are marked as materials, and validating them | [`chats`](../chats/context.md), S5.10. This feature only reads the list |
| Heartbeat, stall / hard timeouts, deciding *when* to abort, the presence state machine | [`presence`](../presence/context.md). The turn owns the controller that gets aborted, and the `skipped` status that results |
| Announcing that a context was truncated **or that the materials did not fit**, and naming the chat | [`orchestration`](../orchestration/context.md). The turn *measures* (`fitHistory` → `droppedMessages`, `buildMaterialsSection` → `materialsOmitted`) and the runner *tells*, because both are facts about a run |
| **Reading** the closure markers and deciding the chain is over | [`orchestration`](../orchestration/context.md). The turn teaches the markers and stores whatever the model wrote; `#agreed` is what reads them |
| Displaying or pricing the stored `Usage` | [`chats`](../chats/context.md) and `src/shared/pricing.ts`. The turn records what the provider reported and nothing else |

## Dependencies

| Feature | What this one needs from it |
|---|---|
| [`providers`](../providers/context.md) | `resolveProvider` (the one place a key is decrypted) and `createLanguageModel` |
| [`database`](../database/context.md) | `MessageRepository.create` / `update` / `listForContext` |
| [`backend-client`](../backend-client/context.md) | The event bus and the `message.*` / `presence.changed` payloads |
| [`i18n`](../i18n/context.md) | The *setting* only. The briefing is model-facing text, not UI copy, and does not live in the locale files |
| [`executor`](../executor/context.md) | `buildExecutorTools`, `READ_ONLY_EXECUTOR_TOOLS`, `buildExecutorSection` (including S5.6's hand-off paragraph), `buildWorkspaceSection`, `resolveInWorkdir`, `walkTree` and `looksBinary`, plus `ctx.permissions`, `Chat.workdir` and `Agent.role` for the rules that decide which of them applies |
| [`orchestration`](../orchestration/context.md) | The caller. Since S5.6 it also passes `handoff` for the one turn a hand-off schedules — a `HandoffIntent` since S5.12 — and `reviewing` for every speaker of the round after it. Both change the prompt rather than the transcript |

`orchestration` depends on this feature: `ChatRunner` calls `runAgentTurn` once
per speaker and reads the returned status to decide how the run ends.

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| The message row is created **empty and `streaming`** before the request | Insert it when the first token arrives | A crash mid-stream then leaves a visible, explicable message instead of nothing, and the renderer has something to attach deltas to from the first event |
| Partial text is flushed to SQLite every 500 ms or 40 deltas | Write only at the end; write on every delta | Every-delta is a write per token; end-only loses a long answer to a crash. Two cheap counters buy most of the durability |
| A **user Stop** is `status: 'error'` with `error: 'aborted'`; a **hard timeout** is `status: 'skipped'` with `error: 'timeout'` | One status for both; a status of its own for Stop | Both arrive as an abort, and only `AbortSignal.reason` tells them apart (`presence/abort-reasons.ts`). The renderer has to distinguish "you stopped this" from "the group moved on without it", and the barrier has to read the second as a completed turn rather than as a stopped run — hence `aborted: false` in the result of a timeout |
| The turn creates an `AbortController` **of its own**, chained to the run's signal | Hand the run's signal to the supervisor | The run's signal is how Stop reaches every speaker at once; the supervisor has to reach exactly one. Chaining costs one listener and keeps both meanings intact |
| `runAgentTurn` never throws | Let the caller catch | Every failure has to end with a persisted terminal status and a `message.updated`, or the UI shows a cursor forever. Making that the function's own responsibility means no caller can forget |
| Reasoning is **not** fed back into later prompts | Include it like text | It is the model's scratch pad, it is not what the group heard, and replaying it inflates every later prompt |
| **"Show thinking" decides whether reasoning is stored at all** (S5.14), not whether it is requested | Ask the provider not to produce reasoning; render it collapsed and leave the data alone | No provider option was ever set from `params.reasoning`, and the ones that exist differ per vendor and per model — asking for less thinking would change the *answer*, which is not what the user wanted. What the first real use actually complained about is four open models each streaming a chain of thought into one transcript, and that is a rendering-and-storage problem: dropping the delta as it arrives leaves the answer identical and the transcript readable. Collapsing it in the UI was the other candidate and is what S2.5 already does; it was not enough, because the block is still there, still stored, and still four of them |
| The default is **per provider route**, written into `params` at creation (S5.14) | A global setting; always off; always on | An `anthropic`, `openai` or `google` model emits reasoning only when the user picked a thinking mode, and then they want to see it; the open-model route emits it whether or not anybody asked. Writing the answer at `agents.create` means a stored agent carries a choice of its own rather than a gap, and the same rule applied again at turn time is what keeps every agent written before S5.14 behaving |
| **`[AGREED]` / `[CONTINUE]` are taught here and read in `orchestration`** (S5.14) | Have the turn decide the round is over | Identical to `@mentions`: the finished text is here, the meaning of a round is there. The turn stores what the model wrote and nothing about a run |
| The closing block **replaces** the marker rule rather than adding to it (S5.14) | Append it and let the model work it out | A turn told both "end with a marker" and "write no marker" writes one |
| **Mentions are parsed here, scheduled elsewhere** | Let `ChatRunner` re-read the finished message and parse it | The finished text is already in hand at the terminal update, so parsing it there keeps **one** `message.updated` per turn instead of two, and a reply reaches the renderer with its mentions already on it. The rules that drop a self-mention, a non-member and a `[PASS]` are scheduling rules and live in `orchestration/scheduling.ts` |
| **The history is an optional parameter, not a mode flag** | A `parallel: boolean`; a second function | The turn does not need to know what a round is: either it is given a transcript or it reads one. That is the whole difference between the two speaking modes, expressed once |
| `passed` and `skipped` messages are dropped from history | Keep them with a marker | Replaying abstentions teaches the next speaker that abstaining is normal. The round bookkeeping that needs them lives in `ChatRunner` |
| The briefing exists in Chinese and English as **`.ts` files** | Locale files; one English briefing for everyone | It never reaches the renderer, so it has no i18n key; a Chinese-first model follows a Chinese prompt far more reliably. `briefing.zh-CN.ts` is the documented exception to the English-only rule |
| The briefing's `[name]:` and `@name` examples use a **real member of this chat** | A placeholder like `@name` | A model copies the example it is given |
| The briefing's **memory sentence is conditional** on the tools being attached (S3.3) | Always include it | A prompt that asks for a tool the model was not given is how a model starts describing tool calls in prose |
| The **goal lives in the briefing**, last, rather than in a section of its own (S5.10) | A `Goal` section beside the skills and memory ones; a paragraph at the top of the prompt | It is the same class of thing as the roster and the protocol — a rule of the room every member is held to — not reference material one of them may reach for, so it must survive a prompt being cut before the skills index does. Last because the end of a long prompt is the part a model is still following |
| A `codebase` goal states that the **executor** makes the change (S5.10) | Let the goal speak for itself | PLAN.md's one-writer rule is invisible to a participant that has just been told the group is changing a codebase, and a model told to change code with no tools writes the change out in prose as if it had |
| The **hand-off briefing points at the goal rather than restating it** (S5.10) | Repeat the whole goal in the executor section | The goal is already in the group briefing the same prompt carries, and a model given one instruction twice in two wordings follows neither reliably |
| **`handoff` is an option of the turn, not a fact about the agent or the chat** (S5.6) | A column on the chat; an executor that always reads the hand-off briefing | It is true of exactly one turn. An executor asked a follow-up question by a reviewer is not being handed the discussion again, and a prompt that said so would make it start over instead of answering |
| **`reviewing` is an option of the turn too** (S5.12), and it goes in the **group briefing** rather than in a section of its own | A `Review` section beside `Workspace`; a sentence in the executor's report | It is a rule of the room for one round — the same class of thing as the roster and the goal — and it has to sit immediately after the goal, because "judge it against the goal above" is only true if the goal is one line up |
| **The conclusion flag is written at the end of the turn, not seeded at its start** (S5.16) | Put the part in `parts` before the stream, so the card appears as the answer streams | Two real costs against one beat of latency: the tool-free retry is gated on `parts.length === 0`, which a seeded flag would silence, and a closing turn that then failed would be labelled as an answer it never produced. The flag is only written for a `done` turn, for the same reason |
| **A flag part rather than a `MessageKind` or a column** (S5.16) | A `kind` enum on `Message`; a boolean column; a `system` message beside the answer | `parts` is already the open, migration-free place where a message says what it is made of, and everything that reads a message ignores a part it does not know — the history transform included, which is what keeps the mark out of every prompt. A column would be a migration and a second place to ask the same question |
| **The delivered chip is "this turn delivered it", not "the file exists"** (S5.12) | A chip on every executor turn while the deliverable is there; a transcript scan for an earlier chip | A part attached to a turn is a statement about what that turn did — the same argument that keeps `git_diff` out of `diffPartsFrom`. Two `existsSync` calls say exactly that; a scan still could not tell a file this chat wrote from one already lying in the folder |
| The **executor section is conditional on the same rule that attaches the tools** (S5.4), and sits between the briefing and the skills | Always include it for an `executor`; put it with the skills | Same reason as the memory sentence, and the section is protocol rather than reference material: a model running out of attention should lose the reference first. `executorWorkdir` is the one function both the prompt and the tool set ask |
| **Every** member of a chat with a folder is given the workspace briefing (S5.11) | Only the executor; nobody | It is the counterpart of the read-only tools: an agent told it can read a folder and not told what is in it opens the discussion with three `list_dir` calls. The section is built once per turn, memoised inside the turn, because it walks the disk |
| The **materials go last**, after skills and memory (S5.11) | First, so they are certainly read; beside the briefing | They are the bulkiest part of the prompt and the purest reference material in it, and the same rule that puts skills after the briefing puts them after skills. Last is also immediately before the history they are meant to ground |
| The materials budget is a **fixed 25 % of the window**, not what the history leaves over | Whatever is left after `fitHistory`; a fixed token count | The materials are assembled once per turn while the history grows all chat long, so a leftover rule would inline a document in round one and silently drop it in round six — and a group that was quoting it would stop being able to. A fixed count would be wrong for both a 8 k and a 1 M window |
| Once one material does not fit, **the rest are listed** rather than skipped over | Keep inlining whatever still fits | A contiguous prefix is something the user can predict from the order they wrote. A set assembled by skipping is one nobody can explain, and each item is capped anyway |
| `materialsOmitted` is **reported**, and the notice is the runner's (S5.11) | Store the notice here | Identical to `droppedMessages`: a turn does not know a run is happening, and the runner is the only object that can say it once |
| Skills and memory come **after** the briefing in the prompt | Before it; interleaved | The briefing is how to behave, the other two are material to reach for. A model that runs out of attention should lose the reference material first, not the protocol |
| A `skillName` that no longer resolves is **skipped silently** during a turn | Fail the turn; insert a notice | A moved folder must not silence an agent that could still answer. The agent editor is where it is reported, because that is where it can be fixed |
| `'system'` is resolved from `Intl.DateTimeFormat().resolvedOptions().locale` | Ask the renderer | The prompt is assembled before any window is involved; a round trip inside a turn would be a needless dependency |

## Open questions

- Whether a `[PASS]` should be stored with its text at all, or with empty parts
  plus the status. Keeping the text makes the transcript self-explanatory in the
  database; the UI dims it either way.
- Whether the flush interval should adapt to the model's token rate rather than
  being two fixed constants.
- Whether a hidden `reasoning-delta` should still be *counted*, so the transcript
  could say "thought for 400 tokens" without storing the text. Today it is
  discarded entirely and only the provider's usage figures remain.
- Whether "show thinking" belongs on the agent at all rather than on the chat, or
  as a per-message expander that fetches the thinking on demand. It is on the
  agent because that is where the model is chosen, which is what decides how much
  thinking there will be.
