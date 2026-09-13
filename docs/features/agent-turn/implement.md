# agent-turn — Implementation

## Approach

Four modules, each a pure function except the last:

| Module | Shape |
|---|---|
| `briefing.ts` | `(language, self, members) → string`, delegating to `briefing.en.ts` / `briefing.zh-CN.ts`. Also `resolveMainLanguage(setting)` |
| `history.ts` | `(self, agentsById, userName, messages) → ModelMessage[]` |
| `context-budget.ts` | `estimateTokens(text) → number` and `fitHistory({ system, messages, contextWindow, reserveForOutput }) → { messages, droppedCount, estimatedTokens }` |
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
  ├─ system  = agent.systemPrompt
  │            + buildGroupBriefing(...)                      (+ the memory rule, S3.3)
  │            + buildSkillsSection(enabledSkills(ctx, agent)) (S3.2, when any)
  │            + buildMemorySection(ctx.memory.readIndex(id))  (S3.3, when enabled)
  ├─ messages = toModelMessages({ self, agentsById,
  │               messages: options.history ?? listForContext(chat) })
  ├─ streamText({ model, system, messages, abortSignal, maxOutputTokens?, temperature? })
  │
  └─ for await (part of result.fullStream)
        every part      → supervisor.activity   (emits only when it clears `away`)
        text-delta      → append to the in-memory parts → message.delta { kind: 'text' }
        reasoning-delta → …                            → message.delta { kind: 'reasoning' }
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

Since **S3.3** they take a `memoryEnabled` flag and add one more rule when it is
set: save durable facts about the user or the project with `memory_save`. It is
conditional because a prompt that asks for a tool the model was not given is how
a model starts describing tool calls in prose.

### The executor section (S5.4)

`buildSystemPrompt` gained the chat, and inserts `buildExecutorSection(workdir)`
between the briefing and the skills — protocol, not reference material — under
exactly the condition that attaches the tools. It names the folder, lists the
seven tools and what each is for, says which three pause for the user, and ends
with the instruction that makes PLAN.md's review loop work: finish with a summary
of every file changed and ask the others to review it.

### Tools attached to one turn

`collectAgentTools` is the single place every tool passes through:

| Source | When | Rule |
|---|---|---|
| The agent's MCP servers | The record exists and is enabled | A `sideEffects` server goes to an `executor` only (S3.1), and since S5.4 **every** call to one of its tools is confirmed through `ctx.permissions` first |
| `read_skill`, `read_skill_file` | The agent has at least one skill that still exists on disk (S3.2) | Attached regardless of the side-effects rule: read-only, and confined to `userData/skills/` |
| `memory_save`, `memory_search` | `agent.memoryEnabled` (S3.3) | Likewise: the only thing they can write is this agent's own notes folder |
| The seven executor tools (S5.4) | `executorWorkdir(chat, agent, members)` is non-null | The opposite of an exception to the rule: `write_file`, `edit_file` and `run_command` are confirmed, and all seven are confined to the chat's folder ([`executor`](../executor/context.md)) |

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
  model?,        // already built; otherwise createModel builds one
  createModel?,  // default: resolveProvider + createLanguageModel
  onEvent?       // default: ctx.events.emit
}): Promise<{ message: Message; status: MessageStatus; aborted: boolean }>
```

`history` is what makes the two speaking modes differ: **sequential** omits it,
so every turn re-reads the transcript and sees the replies given earlier in the
same round; **parallel** reads it once at the start of the round and passes the
same array to every speaker, so the round's replies are invisible to each other
by construction rather than by timing.

Constants other modules and tests rely on: `FLUSH_INTERVAL_MS` (500),
`FLUSH_EVERY_DELTAS` (40), `ABORTED_ERROR` (`'aborted'`), `PASS_TOKEN`
(`'[PASS]'`), `DEFAULT_USER_NAME` (`'User'`), `SYSTEM_SENDER_NAME` (`'system'`).

| Event | Payload | Emitted when |
|---|---|---|
| `message.created` | `{ message }` | The empty `streaming` row is inserted |
| `message.delta` | `{ chatId, messageId, delta }` | Once per `text-delta` / `reasoning-delta` |
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
| `src/main/agents/briefing.test.ts` | Both languages: every member listed with its description, the agent told which one it is, the `[name]` and `@name` protocols, the `[PASS]` rule, the two languages differing, the one-member fallback, and `resolveMainLanguage` |
| `src/main/agents/agent-turn.test.ts` | The real `streamText` against `MockLanguageModelV4.doStream`: the event order, one delta per token, the empty `streaming` row, the presence pair, V4 usage mapping, reasoning as its own part and kind, `[PASS]` (and `[PASS]` *inside* a sentence not counting), provider failure, an already-aborted signal, a mid-stream abort keeping what arrived, the flush writing more than once, the prompt carrying the agent's own instructions plus the briefing plus the prefixed history, `temperature` / `maxOutputTokens` reaching the call, `createModel` being used when no model is passed, and — from S2.3 — the parsed `mentions`, no mentions on a `[PASS]`, `inReplyTo` stored (and absent when nobody asked), and a prebuilt `history` being used instead of the live transcript |
| `src/main/agents/agent-turn.test.ts` (S3.2 / S3.3 blocks) | The built-in tools end to end against a real skills folder and a real memory directory: the prompt carrying a skill's description but not its body, `read_skill` and `read_skill_file` answering, a traversal refused as an errored tool result, a missing skill skipped, `memory_save` writing the note **and** the index line, the index reaching the next prompt, the briefing's memory sentence appearing only when memory is on, and one agent unable to search another's notes |
| `src/main/agents/agent-turn.test.ts` (S5.5 block) | `diffPartsFrom` as a pure function — one block per file, several writes to one file concatenated at its first position, a missing trailing newline separated, and a denial / an unchanged edit / a `git_diff` / a malformed output each producing nothing — plus three whole turns through `streamText`: two files giving two blocks and two `part` deltas, a write then an edit of the same file giving one, and a denied write giving none |
| `src/main/agents/agent-turn.test.ts` (S5.4 block) | A `MockLanguageModelV4` calling `write_file` in a chat bound to a real temporary folder: the seven tools offered and the folder in the prompt, a `permission.requested` carrying the path and the content, `allow` writing the file and storing a `tool-result` with the patch, `deny` writing nothing and storing a `tool-error`, `allowAlways` not asking a second time, a participant and a folderless chat getting no tools at all, the two-executor tie broken by position, and a read-only tool and a path that leaves the folder never asking |
| `src/main/agents/context-budget.test.ts` | `estimateTokens` against ASCII, CJK and a real sentence (with a tolerance, because it is an approximation), and every `fitHistory` rule: nothing dropped when it fits, oldest first, the last user message protected, the note prepended once, the reserve and the system prompt both counted, and a window smaller than its own system prompt not looping |
| `src/main/agents/title.test.ts` | `sanitizeTitle` (whitespace, quotes in both scripts, trailing punctuation, a `Title:` preamble, the 60-character cap, and the empty result that triggers the fallback) and `fallbackTitle` |
| `src/shared/pass.test.ts` | `isPassOnly` versus `stripTrailingPass`: a bare token is an abstention and survives, a token after real content is a sign-off and goes |
| `src/main/agents/default-agent.test.ts` | Creating exactly one agent on the first usable provider, reusing it, preferring a user-created agent, and the `validation` refusal |

## Known limitations and TODOs

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
  `reserveForOutput = agent.params.maxTokens ?? DEFAULT_OUTPUT_RESERVE (4096)`;
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
