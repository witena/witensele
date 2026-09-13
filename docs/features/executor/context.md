# executor — Context

## Problem

A group of models can reach a good conclusion and then leave the user to type it
out themselves. PLAN.md's answer is the **executor**: one member of the chat,
bound to one local folder, that can actually read the code, change it, run the
tests and report what it did — while every other member stays read-only, so
several models never write over each other and every change stays reviewable.

This feature is the acting half of that: the tools the executor has, the folder
they are confined to, and the prompt that appears before anything with side
effects happens. The user must never discover a file was rewritten; they must be
asked, see what is about to change, and be able to say no.

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

## Out of scope

| Not here | Who owns it |
|---|---|
| The permission **card**, the diff block and the `file-ref` chip in the transcript | S5.5. This step is backend only; nothing in the renderer draws a prompt yet, so an executor turn in the running app waits until the user's Stop closes it |
| Appending a `DiffPart` per written file to the executor's message | S5.5. The tools already **return** the unified diff (`patch`) that step needs |
| "Hand to executor" and the review round | S5.6 |
| Opening a path in the editor | S5.7 |
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
| **Every** tool of a `sideEffects` MCP server asks | Only tools whose name looks dangerous | The flag is the server's own declaration that its tools change the world; this layer cannot tell which of `create_issue` and `list_issues` is which, and guessing wrong in that direction is silent |
| Tools return an **object** with a `patch` field, not a rendered string | A string the renderer parses back | Two consumers want different things from one result: the model wants something to reason about and S5.5 wants the diff. JSON serves both, and the MCP wrapper's string rendering exists only because MCP hands us content blocks |
| The unified diff comes from the `diff` package | Hand-rolled line comparison | It is the record of what an agent did to the user's files. A format with a specification, not one with whatever the author remembered of it (STEPS S5.4 says so outright) |
| An **absolute path inside the folder is accepted** | Refuse every absolute path, as `skills/loader.ts` does | The executor is told its folder in the briefing and reads absolute paths out of compiler output and `git status`. Refusing them would fail on a path this app printed |
| Confinement is re-checked on **every call**, and again after a permission prompt | Resolve once per turn | The folder can be renamed between two tool calls, and a file can change while the user is deciding. `edit_file` re-reads and refuses if the file moved under it |
| `run_command` runs `/bin/sh -c` in a **detached process group** | `shell: true`; a plain `spawn` | Killing the group takes the command's own children with it. A `sleep 30` that survived Stop is a process nobody can see and nobody kills |
| A non-zero exit code is a **result**, not a thrown error | Throw on failure | Failing tests are the most useful thing `run_command` returns. A throw would hide the output that explains them |
| The chat's executor is **the first `executor` member in `position` order** | Trust `agents.role` alone | S5.2 recorded a known gap: `agents.update` can still promote a participant that is already in a chat with an executor. Two writers in one folder is exactly what the one-writer decision exists to prevent, so the tie is broken deterministically rather than by whichever turn runs first |
| An executor in a chat with **no** `workdir` gets no tools, silently | Refuse to add the member; insert a notice | S5.2 chose to allow the member, so this is the other half of that choice. The agent is still a useful discussion partner |

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
