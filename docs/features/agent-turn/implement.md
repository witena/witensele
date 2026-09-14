# agent-turn — Implementation

## Approach

Five modules, each a pure function except the last (`materials.ts` reads the
files it is pointed at and nothing else):

| Module | Shape |
|---|---|
| `briefing.ts` | `(language, self, members, memoryEnabled?, goal?) → string`, delegating to `briefing.en.ts` / `briefing.zh-CN.ts`. Also `resolveMainLanguage(setting)` |
| `history.ts` | `(self, agentsById, userName, messages) → ModelMessage[]` |
| `context-budget.ts` | `estimateTokens(text) → number` and `fitHistory({ system, messages, contextWindow, reserveForOutput }) → { messages, droppedCount, estimatedTokens }` |
| `materials.ts` (S5.11) | `buildMaterialsSection({ workdir, materials, contextWindow, share? }) → { text, inlined, listed, omitted, estimatedTokens }`, plus `hasBinaryExtension` and `readMaterialText` |
| `title.ts` | `sanitizeTitle` / `fallbackTitle`, and `generateChatTitle({ model, question, reply, signal }) → string \| null` |
| `default-agent.ts` | `ensureDefaultAgent(ctx)`, documented under [`chats`](../chats/backend.md) |
| `agent-turn.ts` | `runAgentTurn(options) → AgentTurnResult`; the only one with side effects |

`runAgentTurn` takes its storage, its event sink and its model by injection and
imports no electron, so the whole feature is exercised in vitest against a
temporary database file and a `MockLanguageModelV4` (CLAUDE.md rule #5).

## Data flow

```
ChatRunner picks a speaker
  │
  ├─ messages.create({ parts: [], status: 'streaming', round })   → message.created
  ├─ supervisor.beginTurn → presence.changed { working }
  │
  ├─ system  = agent.systemPrompt                              ── buildTurnPrompt, once per turn
  │            + buildGroupBriefing(...)                      (+ the memory rule, S3.3)
  │            + buildExecutorSection({ workdir, handoff,      (S5.4, the chat's executor only)
  │                                    goal, branch })          (handoff: the intent, S5.6/S5.12)
  │            + buildWorkspaceSection({ workdir, goal, … })   (S5.11, every member, when bound)
  │            + buildSkillsSection(enabledSkills(ctx, agent)) (S3.2, when any)
  │            + buildMemorySection(ctx.memory.readIndex(id))  (S3.3, when enabled)
  │            + buildMaterialsSection({ workdir, materials }) (S5.11, last, when the goal has any)
  ├─ messages = toModelMessages({ self, agentsById,
  │               messages: options.history ?? listForContext(chat) })
  ├─ streamText({ model, system, messages, abortSignal, maxOutputTokens?, temperature? })
  │
  └─ for await (part of result.fullStream)
        every part      → supervisor.activity   (emits only when it clears `away`)
        text-delta      → append to the in-memory parts → message.delta { kind: 'text' }
        reasoning-delta → if showsThinking(ctx, agent)  → message.delta { kind: 'reasoning' }
                          otherwise discarded (S5.14): not stored, not emitted,
                          still counted as activity above
        finish          → usage = toUsage(part.totalUsage)
        abort           → aborted = true
        error           → failure = message
        ↳ every 500 ms or 40 deltas: messages.update({ parts })

  ├─ timedOut = isTimeoutAbort(turnSignal.reason)
  ├─ mentions = passed || skipped ? [] : parseMentions(text, members)
  ├─ messages.update({ parts, status, mentions, usage?, error? })  → message.updated
  ├─ timedOut → messages.create(agentSkipped notice)               → message.created
  └─ supervisor.endTurn   → presence.changed { available | offline }
```

`abortSignal` above is **not** the run's signal. The turn creates an
`AbortController` of its own and forwards the run's abort into it, so Stop still
reaches every speaker of a round while the supervisor's hard timeout reaches
exactly one. `AbortSignal.reason` is what says which happened.

The final block runs on **every** path — normal finish, abort, provider failure,
even a signal that was already aborted before the first request — because a row
left in `streaming` shows a cursor forever.

### Terminal status

| Condition | `status` | `error` |
|---|---|---|
| The stream finished and the trimmed text is exactly `[PASS]` | `passed` | — |
| The stream finished otherwise | `done` | — |
| The turn was aborted with a `TimeoutAbortReason` (the supervisor's hard timeout) | `skipped` | `'timeout'` |
| Otherwise aborted, or an `abort` part arrived (the user pressed Stop) | `error` | `'aborted'` |
| Anything else failed | `error` | the provider's message |

A `skipped` turn also inserts an `agentSkipped` system message and returns
`aborted: false`, so the round barrier treats it as a completed turn rather than
as the run having been stopped.

### History transform

| Source message | Becomes |
|---|---|
| The user's | role `user`, prefixed `[User]: ` |
| Another agent's | role `user`, prefixed `[Name]: ` |
| **This** agent's | role `assistant`, no prefix |
| A system notice | role `user`, prefixed `[system]: `, rendered from the key into short English |

Then: consecutive same-role messages are merged with a blank line (several
providers reject two adjacent user messages, and one round of three agents
produces exactly that), and empty, `passed` and `skipped` messages are dropped.

### The group briefing

Per PLAN's "One agent turn": the member list with descriptions, which member the
agent is, that other members arrive as `[name]:` prefixed user messages, `@name`
to call on someone, and `[PASS]` to abstain. Both language files say the same
things in the same order, so they can be diffed side by side.

Since **S5.14** the rules carry one more line, immediately after the `[PASS]`
one: end every reply with `[AGREED]` or `[CONTINUE]` on its own last line, and
once everyone writes `[AGREED]` the discussion stops and the conclusion goes to
the user. It is **one** line rather than the two it started as, and that is not
tidying: two lines of marker protocol measurably pulled a 3B participant's
attention away from the workspace briefing, and `e2e/executor.spec.ts`'s "answers
from the materials, and reads an unmarked file when asked" started failing
because the model reached for `read_file` instead of the context it had been
given. A briefing is a budget.

The line is **absent** for the closing turn, which gets `closingSection()`
instead — the last block of the prompt, and the only one that contradicts the
rules above: the group has agreed, write the conclusion for the user, no new
argument, no `@`, no marker.

Since **S3.3** they take a `memoryEnabled` flag and add one more rule when it is
set: save durable facts about the user or the project with `memory_save`. It is
conditional because a prompt that asks for a tool the model was not given is how
a model starts describing tool calls in prose.

### The goal section (S5.10)

Since **S5.10** they also take the chat's `ChatGoal`, and append a final
`Goal of this chat` section when there is one — for **every** member, because
what the group is for is not a fact about one role:

| Line | Present for |
|---|---|
| One sentence naming what the kind means | Always |
| `What the user asked for: <description>` — **verbatim** | Always |
| The deliverable's relative path, and that answers are judged by whether they improve it | `document` |
| That the member changes no file itself: the executor makes the change after the discussion, from the conclusion | `codebase` |

Verbatim is the load-bearing word: the description is the one part of the whole
prompt the user wrote, and paraphrasing it would be the app rewriting the brief.
The section is **last** for the reason skills and memory come after the
briefing, inverted — it is protocol of the strongest kind, and the end of a long
prompt is the part a model is still following.

A chat with **no** goal gets no section at all, not a paragraph saying so: a
chat with no goal is a discussion nobody bothered to name, and explaining that
would be prompt spent on nothing. A test asserts the two briefings are byte for
byte identical in that case.

### The executor section (S5.4)

`buildSystemPrompt` gained the chat, and inserts `buildExecutorSection(workdir)`
between the briefing and the skills — protocol, not reference material — under
exactly the condition that attaches the tools. It names the folder, lists the
seven tools and what each is for, says which three pause for the user, and ends
with the instruction that makes PLAN.md's review loop work: finish with a summary
of every file changed and ask the others to review it.

**S5.6** adds one optional flag on top: `AgentTurnOptions.handoff`, passed
straight into `buildExecutorSection`, which appends `HANDOFF_BRIEFING` —
implement the conclusion above, do not re-open the debate, report the paths —
plus, since **S5.10**, `goalHandoffLine(goal)`: the file to write (with its
parent folders) for a `document`, or the change to make for a `codebase`, and
nothing at all for a discussion, where `HANDOFF_BRIEFING` already says everything
there is to say. It points at the goal rather than restating it, because the goal
is already in the group briefing of the same prompt. `ChatRunner` sets it for
exactly one turn, the executor's in the round "Hand to executor" scheduled
([`orchestration`](../orchestration/implement.md)), and it reaches nothing else
in the turn: not the history, not the tools, not the result. A reviewer, and an
executor re-`@`-ed later, are being asked something specific and must not be told
the discussion is over.

**S5.12** turns that flag into a `HandoffIntent`. `deliver` swaps
`HANDOFF_BRIEFING` for `DELIVER_BRIEFING` — write the file itself, create its
parent folders, finish with a summary of exactly two lines — and a `codebase`
goal's `goalHandoffLine` gains the branch `gitInfo` reports plus the request for
a summary listing every changed path. The two paragraphs are alternatives, never
both.

### The review block (S5.12)

`AgentTurnOptions.reviewing` reaches `buildGroupBriefing`, which appends one more
block **after** the goal, in both languages: the executor has just changed files,
read the diffs in its message above, and judge them against the goal rather than
against what you would have written. It goes in the group briefing rather than in
a section of its own for the reason the goal does — it is a rule of the room —
and it goes *after* the goal because "the goal above" has to be one line up. A
chat with no goal gets the same block pointing at the conclusion in the
transcript instead, since a hand-off in a chat that never set a goal is legal.

### The delivered chip (S5.12)

Two `existsSync` calls bracket the turn: one before the stream, on
`deliverablePath(chat.goal, chat.workdir)` for an **executor** of a `document`
chat, and one after it, in `deliveredRef`. A file that was not there and is there
now produces one `FileRefPart` carrying the **absolute** path, appended
immediately after the diff blocks. Every other case produces nothing — including
a later turn that rewrites the deliverable, which is claiming credit it did not
earn, and a participant's turn, which cannot write. The rules and the rejected
alternatives are tabulated in
[`executor/backend.md`](../executor/backend.md#the-delivered-chip-s512).

### The workspace briefing and the materials (S5.11)

Two more sections, decided by one new rule: `workspaceWorkdir(chat)`, which asks
only whether the chat has a folder. `executorWorkdir` answers who may *write*;
this one answers who may *read*, which since S5.11 is everybody in the room.

| Section | Position | Present when |
|---|---|---|
| `Workspace` | After the executor section, before the skills | The chat has a `workdir`. It is protocol — which folder, what is in it, what you may do to it — so it goes with the executor section rather than with the reference material |
| `Materials` | **Last**, after the memory index | The chat has a `workdir` **and** a goal with a non-empty `materials` list |

`Materials` is last because it is the bulkiest and purest reference material in
the prompt, and the same argument that puts skills after the briefing puts the
materials after skills: a model that runs out of attention should lose the
document before it loses the protocol. Last is also immediately before the
history it exists to ground.

The budget is `contextWindow * 0.25`, measured with `fitHistory`'s own
`estimateTokens` so the two numbers mean the same thing. Items are taken in the
order the user listed them until one does not fit; from there on every remaining
item is named by path under a line saying `read_file` will fetch it. A **folder**
expands into its listing plus its text files, so the cut falls between files
rather than inside one, and a binary file is never inlined at any budget.

`buildTurnPrompt` returns `{ text, materialsOmitted }` and `buildSystemPrompt` is
its `text`; the count travels out through `AgentTurnResult.materialsOmitted`, and
`ChatRunner` turns it into the `materialsTruncated` notice — **once per chat**,
because the materials do not change between rounds
([`orchestration`](../orchestration/implement.md)). The prompt is built at most
once per turn, memoised inside `runAgentTurn`, because it walks the folder and
reads files and `consume` can run twice when a provider turns out to reject
tools.

### Tools attached to one turn

`collectAgentTools` is the single place every tool passes through:

| Source | When | Rule |
|---|---|---|
| The agent's MCP servers | The record exists and is enabled | A `sideEffects` server goes to an `executor` only (S3.1), and since S5.4 **every** call to one of its tools is confirmed through `ctx.permissions` first |
| `read_skill`, `read_skill_file` | The agent has at least one skill that still exists on disk (S3.2) | Attached regardless of the side-effects rule: read-only, and confined to `userData/skills/` |
| `memory_save`, `memory_search` | `agent.memoryEnabled` (S3.3) | Likewise: the only thing they can write is this agent's own notes folder |
| The seven executor tools (S5.4) | `executorWorkdir(chat, agent, members)` is non-null | The opposite of an exception to the rule: `write_file`, `edit_file` and `run_command` are confirmed, and all seven are confined to the chat's folder ([`executor`](../executor/context.md)) |
| The four read-only ones (S5.11) | `executorWorkdir` said no and `workspaceWorkdir(chat)` is non-null | PLAN.md's read-only rule: every member of a chat with a folder may read it, none but the executor may change it. `READ_ONLY_EXECUTOR_TOOLS` is the complement of `GATED_EXECUTOR_TOOLS`, so the two rules cannot drift apart, and they are the *same* tool objects — same confinement, same caps — picked out of the same built set |

`executorWorkdir` is the attachment rule in one function, and it needs all three
of its arguments: the agent's `role` must be `executor`, the chat must have a
`workdir`, and the agent must be **the first `executor` in the member list** —
`agents.update` can still promote a participant that is already a member (S5.2's
recorded gap), and two writers in one folder is what PLAN.md's one-writer
decision exists to prevent.

The built-in tools have no `origins` entry, so their `tool-call` parts carry no
`serverId` and the transcript draws the card with the bare tool name.

## Key types and contracts

```ts
runAgentTurn({
  ctx, chat, agent, members, round, signal,
  inReplyTo?,    // agent ids (plus 'user') stored on the message for the UI label
  history?,      // a transcript snapshot; omitted, the turn reads listForContext itself
  handoff?,      // S5.6/S5.12: this turn was handed the work; extends the executor section
  reviewing?,    // S5.12: this round reviews what the executor changed
  closing?,      // S5.14: this turn writes the group's conclusion; swaps the marker rule
  model?,        // already built; otherwise createModel builds one
  createModel?,  // default: resolveProvider + createLanguageModel
  onEvent?       // default: ctx.events.emit
}): Promise<{
  message: Message
  status: MessageStatus
  aborted: boolean
  droppedMessages: number    // S4.2: history messages the budget removed
  materialsOmitted: number   // S5.11: materials listed rather than inlined
}>
```

`history` is what makes the two speaking modes differ: **sequential** omits it,
so every turn re-reads the transcript and sees the replies given earlier in the
same round; **parallel** reads it once at the start of the round and passes the
same array to every speaker, so the round's replies are invisible to each other
by construction rather than by timing.

Constants other modules and tests rely on: `FLUSH_INTERVAL_MS` (500),
`FLUSH_EVERY_DELTAS` (40), `ABORTED_ERROR` (`'aborted'`), `PASS_TOKEN`
(`'[PASS]'`), `AGREED_TOKEN` (`'[AGREED]'`), `CONTINUE_TOKEN` (`'[CONTINUE]'`),
`DEFAULT_USER_NAME` (`'User'`), `SYSTEM_SENDER_NAME` (`'system'`). The three
markers are re-exported from `briefing.ts` and defined in `@shared/markers`.

| Event | Payload | Emitted when |
|---|---|---|
| `message.created` | `{ message }` | The empty `streaming` row is inserted |
| `message.delta` | `{ chatId, messageId, delta }` | Once per `text-delta`; once per `reasoning-delta` only when this agent shows its thinking (S5.14) |
| `message.updated` | `{ message }` | The turn reaches its terminal status |
| `presence.changed` | `{ presence }` | `AgentSupervisor` emits it; the turn calls `beginTurn` / `activity` / `endTurn` |
| `message.created` | the `agentSkipped` notice | The hard timeout skipped this turn |

Presence belongs to `AgentSupervisor` ([`presence`](../presence/implement.md)),
not to this file: the turn only reports that a turn *began*, that something
arrived, and how it *ended*. The supervisor owns the session, the heartbeat, the
`away` / `offline` transitions and the abort that produces a `skipped` message.

## Tests

| File | Covers |
|---|---|
| `src/main/agents/history.test.ts` | Every rule in the table above, one case each: prefixes, roles, the unknown-agent fallback, merging in both directions, dropping `passed` / `skipped` / empty / streaming, reasoning excluded, notices rendered and unknown keys skipped, and the same transcript producing a different view per agent |
| `src/main/agents/briefing.test.ts` | Both languages: every member listed with its description, the agent told which one it is, the `[name]` and `@name` protocols, the `[PASS]` rule, the two languages differing, the one-member fallback, and `resolveMainLanguage`. S5.10 adds the goal section in both languages — nothing at all without a goal, the description verbatim for all three kinds, the deliverable named for a `document`, the executor rule present for a `codebase` and absent otherwise |
| `src/main/executor/tools.test.ts` (`goalHandoffLine`) | S5.10: the deliverable and its parent folders for a `document`, the change for a `codebase`, nothing for a discussion or a chat with no goal, and the line reaching `buildExecutorSection` **only** on the hand-off turn |
| `src/main/agents/agent-turn.test.ts` | The real `streamText` against `MockLanguageModelV4.doStream`: the event order, one delta per token, the empty `streaming` row, the presence pair, V4 usage mapping, reasoning as its own part and kind, `[PASS]` (and `[PASS]` *inside* a sentence not counting), provider failure, an already-aborted signal, a mid-stream abort keeping what arrived, the flush writing more than once, the prompt carrying the agent's own instructions plus the briefing plus the prefixed history, `temperature` / `maxOutputTokens` reaching the call and **neither** being set for an agent with empty `params` (the S5.9 shape), `createModel` being used when no model is passed, and — from S2.3 — the parsed `mentions`, no mentions on a `[PASS]`, `inReplyTo` stored (and absent when nobody asked), and a prebuilt `history` being used instead of the live transcript |
| `src/main/agents/agent-turn.test.ts` (S3.2 / S3.3 blocks) | The built-in tools end to end against a real skills folder and a real memory directory: the prompt carrying a skill's description but not its body, `read_skill` and `read_skill_file` answering, a traversal refused as an errored tool result, a missing skill skipped, `memory_save` writing the note **and** the index line, the index reaching the next prompt, the briefing's memory sentence appearing only when memory is on, and one agent unable to search another's notes |
| `src/main/agents/agent-turn.test.ts` (S5.12 block, `runAgentTurn and a document goal`) | Seven whole turns: the `FileRefPart` appended when the deliverable appears and not when it was already there, not for another file, not without a `document` goal and not for a participant; the review block in a reviewer's prompt and not in an ordinary one; and `DELIVER_BRIEFING` plus the path in a `deliver` hand-off's prompt, with the implement paragraph absent |
| `src/main/agents/briefing.test.ts` (S5.12 block) | The review block in both languages: absent byte for byte in an ordinary round, appended **after** the goal when the round is a review, and pointing at the conclusion instead when the chat has no goal |
| `src/main/agents/agent-turn.test.ts` (S5.5 block) | `diffPartsFrom` as a pure function — one block per file, several writes to one file concatenated at its first position, a missing trailing newline separated, and a denial / an unchanged edit / a `git_diff` / a malformed output each producing nothing — plus three whole turns through `streamText`: two files giving two blocks and two `part` deltas, a write then an edit of the same file giving one, and a denied write giving none |
| `src/main/agents/agent-turn.test.ts` (S5.11 block) | A whole **participant** turn in a chat with a folder: the four read-only tools offered and `write_file` / `edit_file` / `run_command` each asserted absent, the folder and its listing in the prompt, a marked material in the prompt while an unmarked file's contents are not, a real `read_file` call on that unmarked file returning its contents, `materialsOmitted` reported for a material too large to inline, and a chat with no folder getting neither tools nor a `Workspace` section |
| `src/main/agents/agent-turn.test.ts` (S5.4 block) | A `MockLanguageModelV4` calling `write_file` in a chat bound to a real temporary folder: the seven tools offered and the folder in the prompt, a `permission.requested` carrying the path and the content, `allow` writing the file and storing a `tool-result` with the patch, `deny` writing nothing and storing a `tool-error`, `allowAlways` not asking a second time, a participant and a folderless chat getting no tools at all, the two-executor tie broken by position, and a read-only tool and a path that leaves the folder never asking |
| `src/main/agents/materials.test.ts` (S5.11) | `buildMaterialsSection` against a real temporary folder: nothing for an empty list, one file inlined under its path, several in list order, a folder expanded into its tree and then its files, a budget too small for anything, a budget that takes a prefix and lists "the rest" (including a small file behind a large one that is *not* rescued), the share respected across twenty files, a binary file listed and not spending the budget, a missing material dropped, a material that resolves outside the folder dropped, and one enormous file cut at the per-file cap; plus `hasBinaryExtension` and the null-byte fallback in `readMaterialText` |
| `src/main/agents/context-budget.test.ts` | `estimateTokens` against ASCII, CJK and a real sentence (with a tolerance, because it is an approximation), and every `fitHistory` rule: nothing dropped when it fits, oldest first, the last user message protected, the note prepended once, the reserve and the system prompt both counted, and a window smaller than its own system prompt not looping |
| `src/main/agents/title.test.ts` | `sanitizeTitle` (whitespace, quotes in both scripts, trailing punctuation, a `Title:` preamble, the 60-character cap, and the empty result that triggers the fallback) and `fallbackTitle` |
| `src/shared/markers.test.ts` | `isPassOnly` versus `closureMarker` versus `stripTrailingMarkers`: a bare `[PASS]` is an abstention and survives, a marker after real content is a sign-off and goes, a marker quoted mid-sentence is neither, two trailing markers are both removed, `closureMarker` reads only the very end, is case-sensitive, and answers `null` for `[PASS]` — which is what keeps an abstention out of the consensus test |
| `src/main/agents/agent-turn.test.ts` (S5.14 cases) | Reasoning deltas **stored** when the agent chose to show its thinking, **dropped** when it chose not to and when it made no choice on an `openai-compatible` provider, and stored again for an agent with no choice on an `anthropic` one — with the answer, the status and the delta kinds asserted in each |
| `src/main/agents/briefing.test.ts` (S5.14 cases) | Both markers present in the rules in both languages; the closing block absent byte for byte in an ordinary turn, and replacing the marker rule when `closing` is set — the roster, the `[name]:` protocol and `[PASS]` all still there |
| `src/main/handlers/agents.test.ts` (S5.14 block) | The creation default per provider type: hidden for `openai-compatible` and for a local preset, shown for `anthropic` / `openai` / `google`, and an explicit choice left alone in both directions. Plus a non-boolean `reasoning` refused |
| `src/shared/presets.test.ts` (S5.14 block) | `showsThinkingByDefault` over the open-model route, the three first-party adapters, and every preset flagged `local` |
| `src/main/agents/default-agent.test.ts` | Creating exactly one agent on the first usable provider, reusing it, preferring a user-created agent, and the `validation` refusal |

## Known limitations and TODOs

- **The workspace tree is walked once per turn, not once per round** (S5.11). It
  is memoised inside a turn, so a tool-rejection retry does not walk twice, but
  four members in one round walk the same folder four times. A per-run cache
  keyed on the folder needs an invalidation rule that an executor's own writes
  would trip.
- **The materials are re-read every turn as well**, and the budget is computed
  per agent, so two members with different context windows can inline different
  amounts of the same list. That is correct — the budget is a fraction of *their*
  window — but it means the notice names one agent rather than describing the
  chat.
- **A turn with no tools at all is still the common case.** An agent with no MCP
  server, no skill and no memory gets no `tools` and no `stopWhen`, so a model
  that wants to call one simply answers in prose. Where the tools come from when
  there are some is the table above; see
  [`../mcp/implement.md`](../mcp/implement.md) for the full path of one call,
  [`../skills/implement.md`](../skills/implement.md) and
  [`../memory/implement.md`](../memory/implement.md) for the built-in ones.
- **`MAX_TOOL_STEPS = 8` covers every tool family together.** A turn that reads
  two skills and searches memory has spent three of its eight steps before it
  answers.
- **Context truncation is an estimate, not a tokenizer** (S4.2). `estimateTokens`
  counts CJK at one token per character and everything else at a quarter, which
  is accurate to roughly ±20% across the providers this app talks to. A real
  tokenizer would mean a WASM blob per encoding and would be exact for OpenAI and
  wrong for everyone else. The budget is
  `contextWindow - reserveForOutput - estimate(system)`, with
  `reserveForOutput = agent.params.maxTokens ?? DEFAULT_OUTPUT_RESERVE (4096)`
  — and since S5.9 no agent form writes `maxTokens`, so the fallback is the
  normal path rather than the exception;
  the oldest messages go first, the **last user message never does**, and when
  anything went a one-line note is prepended to the first survivor. The number
  dropped is returned as `droppedMessages` so `ChatRunner` can tell the user once
  per run. Summarizing what was dropped, rather than discarding it, is still
  future work.
- **The context window comes from a checked-in table** (`contextWindowFor` in
  `src/shared/pricing.ts`), and an unknown model falls back to a deliberately
  small `DEFAULT_CONTEXT_WINDOW` (32 768). Guessing low costs a few old messages;
  guessing high costs a rejected request.
- **The user's display name is a constant** (`'User'`). There is no user profile
  yet; the server version gives it one.
- **Hidden thinking is discarded, not summarised** (S5.14). A `reasoning-delta`
  the agent does not show is dropped as it arrives: nothing is stored, nothing is
  emitted, and the transcript cannot say "thought for 400 tokens" afterwards. The
  provider's own usage figures still count those tokens, which is the only trace
  left — and the only one the cost line needs.
- **The closure markers are taught, never enforced.** A model that ignores the
  briefing writes no marker, and the turn stores exactly what it wrote. Small
  local models are unreliable here; see
  [`../orchestration/implement.md`](../orchestration/implement.md) for what that
  costs.
