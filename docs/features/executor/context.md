# executor — Context

## Problem

A group of models can reach a good conclusion and then leave the user to type it
out themselves. PLAN.md's answer is the **executor**: one member of the chat,
bound to one local folder, that can actually read the code, change it, run the
tests and report what it did — while every other member stays read-only, so
several models never write over each other and every change stays reviewable.

This feature is the acting half of that: the tools the executor has, the folder
they are confined to, the prompt that appears before anything with side effects
happens, the record of what changed (S5.5), and the briefing it is given when the
user hands it the discussion (S5.6). The user must never
discover a file was rewritten; they must be asked, see what is about to change,
be able to say no, and afterwards read the diff of what they said yes to.

## Scope

- `executor/paths.ts` — path confinement against `Chat.workdir`: `..`, absolute
  paths outside the folder, and symlinks (existing **and** not-yet-created)
  whose realpath leaves it.
- `executor/tools.ts` — the seven built-in tools and the `Executor` section of
  the system prompt:

  | Tool | Asks first | What it does |
  |---|---|---|
  | `read_file` | no | Read a text file, capped and binary-sniffed |
  | `list_dir` | no | List a directory, directories marked with `/` |
  | `search_files` | no | Case-insensitive substring search, `.git` / `node_modules` pruned |
  | `git_diff` | no | `git --no-pager diff` in the folder |
  | `write_file` | **yes** | Create or replace a file; returns the unified diff |
  | `edit_file` | **yes** | Replace one exact string; returns the unified diff |
  | `run_command` | **yes** | `/bin/sh -c` in the folder, timed out, output capped, killed on Stop |

- `executor/permissions.ts` — the `PermissionGate`: `ask()` suspends the tool
  call and emits `permission.requested`; `permission.reply` releases it with
  `allow`, `deny` or `allowAlways`; `permission.resolved` closes the card
  however it ended.
- The rule in `collectAgentTools`: executor tools are attached only to **the**
  executor of a chat that has a `workdir`, and every tool of a `sideEffects` MCP
  server goes through the same gate.
- The `permission.reply` backend method and its handler.
- The renderer half (S5.5): `stores/permissions.ts`, the `PermissionCard` above
  the composer, the readable rendering of a call's input, the `DiffPart` block
  and the `FileRefPart` chip, and the readable tool-card labels for the seven
  tools. Written up in [`frontend.md`](./frontend.md); the surfaces live beside
  the rest of the transcript, which [`chats`](../chats/context.md) owns.
- One `DiffPart` per file a turn wrote, appended to the executor's message when
  the stream ends (`diffPartsFrom`, [`agent-turn`](../agent-turn/context.md)).
- **The hand-off briefing** (S5.6): the paragraph `buildExecutorSection` appends
  for the one turn "Hand to executor" schedules — implement the conclusion above,
  do not re-open the debate, report the paths you touched. The *scheduling* of
  that turn and of the review round after it belongs to
  [`orchestration`](../orchestration/context.md); this feature only owns what the
  executor is told.

## Out of scope

| Not here | Who owns it |
|---|---|
| The transcript around the card — the message list, the code block, the composer the card sits on | [`chats`](../chats/context.md). S5.5 adds components to that page; the rules they follow are here |
| Scheduling the hand-off and the review round, and the `chat.handoff` method | [`orchestration`](../orchestration/context.md), S5.6 `[x]`. The button that calls it is [`chats`](../chats/context.md)'s |
| Opening a path in the editor, and finding `path:line` tokens in agent **text** | S5.7. In S5.5 a `file-ref` chip copies the reference, and nothing produces one yet |
| `agents.role` as a first-class choice, the executor badge, `Chat.workdir` and its picker | [`agents`](../agents/context.md) and [`chats`](../chats/context.md), S5.2 `[x]` |
| Tools that come from an MCP server | [`mcp`](../mcp/context.md). This feature only decides **when** one of them is confirmed |
| `read_skill` / `memory_save` and why they bypass the side-effects rule | [`skills`](../skills/context.md), [`memory`](../memory/context.md) |
| Sandboxing the shell (a container, a seccomp profile, a restricted `PATH`) | Nobody yet. See "Open questions" |

## Dependencies

| Feature | What this one needs from it |
|---|---|
| [`chats`](../chats/context.md) | `Chat.workdir`, validated against the real filesystem when the user picks it (S5.2) |
| [`agents`](../agents/context.md) | `Agent.role === 'executor'` |
| [`agent-turn`](../agent-turn/context.md) | `collectAgentTools` attaches the tools, `buildSystemPrompt` carries the briefing, and the turn's `AbortSignal` is what cancels a pending prompt |
| [`backend-client`](../backend-client/context.md) | The event bus, the two `permission.*` events and the `permission.reply` method |
| [`mcp`](../mcp/context.md) | `McpServer.sideEffects`, which now decides confirmation as well as attachment |

S5.5 depends on this one: the permissions store reads the two events and calls
`permission.reply`, and the diff blocks are built from the `patch` these tools
return.

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| **Built-in** file, search, shell and git tools rather than an MCP filesystem server | Ship a `filesystem` MCP preset and call it done | PLAN.md's executor is defined by the permission prompt and the diff it posts back, neither of which an external server can provide. A built-in tool can return a unified diff, resolve every path against *this chat's* folder and be cancelled by the turn's own signal. The MVP's "no built-in file tools" rule (PLAN, "Capability boundaries") was written for **participants**, and this is the exception it reserved |
| The gate asks per **tool**, and `allowAlways` remembers **chat + tool** | Per call; per agent; per path | "Always allow in this chat" is PLAN.md's own wording. Per-path would make the grant meaningless (a second path asks again) and per-agent would hand one model the whole folder on one click |
| `allowAlways` is **not persisted** | A column on `chats` | A grant that survived a restart is a permission the user cannot see and does not remember giving. Closing the app is always a way back to being asked |
| A denial is a **tool error the model reads**, in English | A turn-ending failure; a system notice | The executor should be able to say "you declined the write, here is what I wanted to do instead" — which it can only do if the refusal comes back into its context. It is prompt content like an MCP server's error text, not UI copy, so CLAUDE.md rule #4 does not make it a `notices.*` key |
| Read-only tools never ask | Ask for everything | A prompt per `read_file` trains the user to click Allow without looking, which is how a permission prompt stops being one |
| The card is **above the composer**, not a modal | A modal dialog; a banner in the header | Several prompts can be open at once, and the transcript above the card is exactly the context needed to judge the call. A modal would hide it and would have to pick one prompt to be about |
| Enter and Escape are handled **on the card**, and the card — not the Allow button — takes focus | A document-level listener; `autoFocus` on Allow | A global listener would steal Enter from the composer, where Enter sends. A focused default button is one stray keypress away from approving a write, and approving is meant to be a decision |
| The `run_command` line is printed **verbatim**, never shortened | A summarised or prettified command | The shell is not sandboxed: only `cwd` is confined, so the prompt is the entire boundary. A boundary that paraphrases is a boundary that lies |
| A `write_file` card previews the **content**, not a diff | Compute the diff before asking | The tool computes the patch only after the grant, because the file it would diff against may change while the user decides. `edit_file` already sends its patch, so the two cards differ — see "Open questions" |
| One `DiffPart` per **file**, not per call | One per write | An executor that creates a file and then edits it twice changed one file. Three blocks for one file would read as three changes |
| The diff blocks are **collapsed** by default | Expanded | A turn that touched six files would push the agent's own summary — the thing to read first — off the screen. The header carries the path and `+n -n`, which is enough to decide |
| Blocks are ordered by **call** order, not by the order the results came back | Result order | Two writes issued in one step finish in whichever order the filesystem answers, and a transcript that reshuffles between two identical turns cannot be compared with anything |
| A denial is **not** a system notice | `notices.permissionDenied` in the transcript | It is already visible as the failed tool card it was. A notice repeating it would be the app narrating the user's own click back to them |
| **Every** tool of a `sideEffects` MCP server asks | Only tools whose name looks dangerous | The flag is the server's own declaration that its tools change the world; this layer cannot tell which of `create_issue` and `list_issues` is which, and guessing wrong in that direction is silent |
| Tools return an **object** with a `patch` field, not a rendered string | A string the renderer parses back | Two consumers want different things from one result: the model wants something to reason about and S5.5 wants the diff. JSON serves both, and the MCP wrapper's string rendering exists only because MCP hands us content blocks |
| The unified diff comes from the `diff` package | Hand-rolled line comparison | It is the record of what an agent did to the user's files. A format with a specification, not one with whatever the author remembered of it (STEPS S5.4 says so outright) |
| An **absolute path inside the folder is accepted** | Refuse every absolute path, as `skills/loader.ts` does | The executor is told its folder in the briefing and reads absolute paths out of compiler output and `git status`. Refusing them would fail on a path this app printed |
| Confinement is re-checked on **every call**, and again after a permission prompt | Resolve once per turn | The folder can be renamed between two tool calls, and a file can change while the user is deciding. `edit_file` re-reads and refuses if the file moved under it |
| `run_command` runs `/bin/sh -c` in a **detached process group** | `shell: true`; a plain `spawn` | Killing the group takes the command's own children with it. A `sleep 30` that survived Stop is a process nobody can see and nobody kills |
| A non-zero exit code is a **result**, not a thrown error | Throw on failure | Failing tests are the most useful thing `run_command` returns. A throw would hide the output that explains them |
| The chat's executor is **the first `executor` member in `position` order** | Trust `agents.role` alone | S5.2 recorded a known gap: `agents.update` can still promote a participant that is already in a chat with an executor. Two writers in one folder is exactly what the one-writer decision exists to prevent, so the tie is broken deterministically rather than by whichever turn runs first |
| An executor in a chat with **no** `workdir` gets no tools, silently | Refuse to add the member; insert a notice | S5.2 chose to allow the member, so this is the other half of that choice. The agent is still a useful discussion partner |
| The hand-off paragraph is a **suffix** of the same executor section, added only for that one turn | A separate section; always present | The folder and the tool list must be described once, in one order, in both situations. And the instruction is wrong outside a hand-off: an executor re-`@`-ed by a reviewer is being asked something specific, not being handed the whole discussion again |
| It is **model-facing English**, not a `notices.*` key | An i18n key rendered into the prompt | Prompt text is in the same class as the group briefing and the skills section: the model reads it, the user never does. CLAUDE.md rule #4 governs UI copy |

## Open questions

- **The shell is not sandboxed.** `run_command` runs as the user, with the
  user's environment, and `cwd` is the only thing confined — `cat ../../secret`
  inside a command is not stopped by `paths.ts`. The permission prompt is the
  whole boundary, which is why S5.5 must show the command line verbatim. A real
  sandbox (a container, a restricted `PATH`, seccomp) is a step of its own.
- Whether `search_files` should accept a regular expression and a glob filter,
  or whether asking the executor to `run_command` `rg` is the better answer once
  `run_command` exists.
- Whether a permission prompt should have a timeout of its own, rather than
  relying on the turn's hard timeout to end a prompt nobody answered.
- Whether the prompt should be able to answer "allow, but show me the diff
  first" for `write_file`. The tool computes the patch only *after* the grant, so
  the card previews the content it was given rather than the diff against what is
  on disk; `edit_file` already sends the patch in its input.
- **A prompt is invisible from another chat.** The card is per chat and a user
  looking at a different one is not told that an executor is waiting. A count on
  the chat-list row is the obvious shape.
- `allowAlways` is still neither visible nor revocable (S5.4's note): the card
  offers it, and nothing lists what has been granted.
