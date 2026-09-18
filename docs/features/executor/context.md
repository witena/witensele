# executor — Context

## Problem

A group of models can reach a good conclusion and then leave the user to type it
out themselves. PLAN.md's answer is the **executor**: one member of the chat,
bound to one local folder, that can actually read the code, change it, run the
tests and report what it did — while every other member stays read-only, so
several models never write over each other and every change stays reviewable.

This feature is the acting half of that: the tools the executor has, the folder
they are confined to, the prompt that appears before anything with side effects
happens, the record of what changed (S5.5), the briefing it is given when the
user hands it the discussion (S5.6), and — since S5.11 — the **reading** half the
whole group shares: the four read-only tools every member gets and the workspace
briefing that tells them what is in the folder. The user must never
discover a file was rewritten; they must be asked, see what is about to change,
be able to say no, and afterwards read the diff of what they said yes to.

S5.15 adds the half that is about the prompt not being enough on its own. Two
kinds of call made the prompt the wrong instrument: one that should never be
offered — a prompt whose only right answer is Deny teaches the user to stop
reading prompts — and one that must be asked about *again* even in a chat where
"Always allow" was pressed an hour ago. So a command line is classified before
anything happens, the grant is a row the user can see and take back rather than
an invisible set in memory, a prompt nobody answers denies itself, and an
approved command runs with its writes confined to the folder.

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
  | `run_command` | **yes** | `/bin/sh -c` in the folder, timed out, output capped, killed on Stop. Since S5.15: classified by `command-policy.ts` first, and run under `sandbox-exec` |

- `executor/workspace.ts` (S5.11) — the `Workspace` section of **every**
  member's system prompt: the folder's basename, a tree capped at
  `MAX_TREE_ENTRIES` (200) and `MAX_TREE_DEPTH` (3) that honours the folder's own
  `.gitignore` and always skips `.git`, `node_modules`, the usual build outputs
  and files over 1 MB, and — for a `codebase` goal only — the branch and
  `git status --short`. Pure functions of a folder on disk, built once per turn.
- `executor/command-policy.ts` (S5.15) — the pure classifier every
  `run_command` line goes through before anything else happens: a tokenizer
  (quotes, `;`, `&&`, `||`, `|`, redirections, `$(…)`, backticks) and a table
  that answers `blocked`, `dangerous` or `normal` with a machine-readable
  reason. `blocked` never runs and never prompts; `dangerous` always prompts and
  ignores an `allowAlways` grant.
- `executor/sandbox.ts` (S5.15) — the generated `sandbox-exec` profile
  `run_command` runs under: reads and the network unchanged, writes confined to
  the working directory, the system temp directories and the null-ish devices.
  `AppSettings.executor.sandbox` switches it off.
- `executor/permissions.ts` — the `PermissionGate`: `ask()` suspends the tool
  call and emits `permission.requested`; `permission.reply` releases it with
  `allow`, `deny` or `allowAlways`; `permission.resolved` closes the card
  however it ended. Since S5.15 it also reads a `GrantStore` (the
  `permission_grants` table), denies a prompt nobody answered within
  `AppTimeouts.permissionTimeoutMs`, and ignores every grant for a `dangerous`
  call.
- The two grant methods, `permissions.grants.list` and
  `permissions.grants.revoke`, and the "Always allowed" block they feed in the
  chat's Group settings (S5.15).
- The rule in `collectAgentTools`, which since S5.11 has two rows rather than
  one: **all seven** tools go to *the* executor of a chat with a `workdir`, the
  **four read-only ones** (`READ_ONLY_EXECUTOR_TOOLS`, the complement of the
  gated set) go to every other member of that chat, and every tool of a
  `sideEffects` MCP server goes through the same gate.
- The `permission.reply` backend method and its handler.
- The renderer half (S5.5): `stores/permissions.ts`, the `PermissionCard` above
  the composer, the readable rendering of a call's input, the `DiffPart` block
  and the `FileRefPart` chip, and the readable tool-card labels for the seven
  tools. Written up in [`frontend.md`](./frontend.md); the surfaces live beside
  the rest of the transcript, which [`chats`](../chats/context.md) owns.
- One `DiffPart` per file a turn wrote, appended to the executor's message when
  the stream ends (`diffPartsFrom`, [`agent-turn`](../agent-turn/context.md)).
- **The goal's one sentence in the hand-off briefing** (S5.10):
  `goalHandoffLine` — the file a `document` chat is supposed to end with, or the
  change a `codebase` chat described. It **points at** the goal rather than
  restating it, because the goal is already in the group briefing the same
  prompt carries, and the goal itself belongs to
  [`chats`](../chats/context.md).
- **The hand-off briefing** (S5.6, S5.12): the paragraph `buildExecutorSection`
  appends for the one turn "Hand to executor" schedules. There are now **two** of
  them, picked by `HandoffIntent`:

  | Intent | Paragraph | Says |
  |---|---|---|
  | `implement` | `HANDOFF_BRIEFING` | implement the conclusion above, do not re-open the debate, report the paths you touched |
  | `deliver` | `DELIVER_BRIEFING` | the request you are answering quotes the conclusion and that is what the file must contain; write the file itself, create its parent folders, do not shorten it, and reply with the path and nothing else (reworded in S5.18 — until then it said the user had asked, which stopped being true the day a closed discussion started delivering itself, and asked for a two-line summary) |

  They are alternatives, never both: a model given the same instruction twice in
  two wordings follows neither reliably. Whichever applies, `goalHandoffLine` is
  appended to it. The *scheduling* of that turn and of the review round after it
  belongs to [`orchestration`](../orchestration/context.md); this feature only
  owns what the executor is told.
- **The branch a `codebase` hand-off is made on** (S5.12). `goalHandoffLine`
  names it when `gitInfo` knows one, and asks for a summary that lists the
  changed paths — the two things the review round needs in order to look at the
  right diff. The probe is run **once per turn** by `buildTurnPrompt` and handed
  to both this section and the workspace one, so the prompt cannot name two
  different branches and a large repository is not walked by `git` twice.
- **The chip for a delivered document** (S5.12): `deliverablePath` lives in
  `paths.ts` and is shared with `chats.goalStatus`, so the header and the
  transcript agree on which file the goal names; `deliveredRef` in
  [`agent-turn`](../agent-turn/context.md) is what turns it into a `FileRefPart`
  on the turn that produced it.

- **The materials briefing's reader** (S5.11) is `agents/materials.ts` and
  belongs to [`agent-turn`](../agent-turn/context.md); it reuses this feature's
  `resolveInWorkdir`, its binary probe and its tree walker, and the paths it
  reads come from the goal, which is [`chats`](../chats/context.md)'.

## Out of scope

| Not here | Who owns it |
|---|---|
| The transcript around the card — the message list, the code block, the composer the card sits on | [`chats`](../chats/context.md). S5.5 adds components to that page; the rules they follow are here |
| Scheduling the hand-off and the review round, and the `chat.handoff` method | [`orchestration`](../orchestration/context.md), S5.6 `[x]`. The button that calls it is [`chats`](../chats/context.md)'s |
| Opening a path in the editor, and finding `path:line` tokens in message **text** | [`editor`](../editor/context.md), S5.7 `[x]`. It reuses `resolveInWorkdir` from this feature as its own confinement rule, and makes the diff headers and the file tool cards clickable |
| `agents.role` as a first-class choice, the executor badge, `Chat.workdir` and its picker | [`agents`](../agents/context.md) and [`chats`](../chats/context.md), S5.2 `[x]` |
| Tools that come from an MCP server | [`mcp`](../mcp/context.md). This feature only decides **when** one of them is confirmed |
| `read_skill` / `memory_save` and why they bypass the side-effects rule | [`skills`](../skills/context.md), [`memory`](../memory/context.md) |
| A **real** sandbox — a container, a restricted `PATH`, confining what a command may *read* or send | Nobody yet. S5.15 confines writes and nothing else; see "Open questions" |

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
| ~~`allowAlways` is **not persisted**~~ → since S5.15 it **is**, in `permission_grants` | Keep it in a `Set`; a column on `chats` | S5.4's reason was right and its conclusion was half the fix: what makes a durable grant dangerous is that the user cannot *see* it, and the answer to that is a list with a revoke button, not a grant that dies when the app does. The rest of S5.15 is what makes it safe — the grants are drawn in Group settings, and a `dangerous` command ignores them |
| A command is classified **before** the prompt, and a `blocked` one never becomes a card (S5.15) | Show the card with Allow disabled; show it with a warning | A prompt whose only right answer is Deny teaches the user that prompts are noise, which is the one thing a permission prompt cannot afford. The model reads a refusal it can talk about instead |
| The policy is a **guard rail**, explicitly not a security boundary (S5.15) | Present it as a sandbox | One variable assignment defeats every rule in it, and a script it runs is not read at all. Saying so in the module header, the docs and the settings copy is the only way the rule stays useful: what it buys is that the *common accidents* either cannot happen or cannot be approved by a grant given for something else |
| A `dangerous` command ignores every grant, and its card hides "Always allow" (S5.15) | Let a grant answer it; disable the button | A grant for `run_command` was a decision about running commands, not about publishing. Hidden rather than disabled because a disabled button invites the user to work out why, and the answer is "this button would do nothing" |
| The sandbox confines **writes only**; reads and the network stay open (S5.15) | Confine reads as well; deny the network | A build that cannot fetch its dependencies is not a build, and a `read_file` every participant may make anyway is not made safer by blocking `cat`. Writes are the irreversible half, and the half the user cannot review after the fact |
| The profile allows the system **temp** directories (S5.15) | The working directory alone | A compiler that cannot write a temp file fails in a way nobody can debug from a transcript, and `/tmp` holds nothing the user would mind an executor touching. The consequence is stated rather than hidden: a chat bound to a folder *inside* `/tmp` is not usefully confined against the rest of `/tmp` |
| `sandbox-exec -p`, with the profile **inline** | A generated profile file | No temp file to create, to clean up, or to leak when a turn is killed mid-command |
| The shell runs **inside** the sandbox (`sandbox-exec … /bin/sh -c …`) | Sandbox the first program of the line | Wrapping the program would confine it and nothing a `&&` chain, a pipe or a script it started ever spawned |
| A prompt denies **itself** after `permissionTimeoutMs`, with `'timeout'` as its own decision (S5.15) | Reuse `deny`; rely on the turn's hard timeout | "Nobody was at the machine" and "the user looked at this and said no" are different facts, and the model is told which. Relying on the hard timeout recorded the turn as `skipped`, which is true and not the reason |
| The gate reaches the grants through an injected `GrantStore` | Reach for the repository | The gate must not know what a database is (CLAUDE.md rule #5), and its test wants three lines of array rather than a migrated file |
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
| **Every** member of a chat with a folder gets the four read-only tools (S5.11) | Only the executor; a read-only filesystem MCP server the user attaches by hand | PLAN.md's "Future extension" point 2 says it outright: participants may be given read-only tools so they can ground the discussion in the real code. A group arguing about a file none of them can open is the failure this removes, and the read-only four cannot write, so the one-writer rule is untouched |
| The read-only set is **derived** from `GATED_EXECUTOR_TOOLS` | A second hand-written list | A tool that becomes gated must stop reaching participants in the *same* edit. A second list is a second place to forget |
| The workspace tree is in the **prompt**, not left to `list_dir` | Let the model call `list_dir` when it wants to | The first round is the one that matters, and a group that spends it calling `list_dir` answers generically. A 200-entry tree is a few hundred tokens once per turn |
| The `.gitignore` parser is **hand-written** | Add the `ignore` package | Getting a rare pattern wrong costs one extra line in a listing — nothing here decides what may be *read*; `paths.ts` is the boundary. That is not worth a dependency, and the forms that occur in a root `.gitignore` are few |
| The git half is added for **`codebase` goals only** | Always, when the folder is a repository | `git status --short` in a working repository is dozens of lines about something nobody in a `document` chat asked about |
| The read-only sentence is **left out of the executor's** workspace section | Print it for everyone | The executor's own section already lists all seven tools and says which ask first. The same instruction in two wordings is followed less reliably than one |

## Open questions

- **The sandbox confines writes, not reads.** S5.15 closed half of S5.4's gap:
  an approved command can no longer write outside the folder, and it can still
  print the contents of a private key into the transcript. The permission prompt
  is still the boundary for everything a command *reads* or *sends*, which is
  why the command line is shown verbatim. Confining reads needs a policy for
  what a build legitimately reads — `~/.npmrc`, `~/.cargo`, the toolchain — and
  is a step of its own.
- **`sandbox-exec` is deprecated by Apple** and has been for years, while
  remaining the only thing of its kind on the platform. A macOS that removes it
  makes every command run unsandboxed behind one notice; an App Sandbox
  entitlement or a real container is the replacement, and neither is free.
- **The policy can be defeated by a variable or a script.** An assignment and an
  expansion is one way round it, and a `./deploy.sh` is not read at all. It is a
  guard rail against the common accident, not a boundary — stated here, in the
  module header and in the settings copy so it cannot quietly be read as more.
- Whether `search_files` should accept a regular expression and a glob filter,
  or whether asking the executor to `run_command` `rg` is the better answer once
  `run_command` exists.
- Whether the prompt should be able to answer "allow, but show me the diff
  first" for `write_file`. The tool computes the patch only *after* the grant, so
  the card previews the content it was given rather than the diff against what is
  on disk; `edit_file` already sends the patch in its input.
- **A prompt is invisible from another chat.** The card is per chat and a user
  looking at a different one is not told that an executor is waiting. A count on
  the chat-list row is the obvious shape.
- **A revoked grant does not un-answer a call already in flight.** A tool
  released by a grant a millisecond before the user revoked it still runs. The
  alternative is holding every gated call until a revoke could not arrive, which
  would slow the common case down to protect a case that is a race by
  definition.
- **Only the folder's own `.gitignore` is read** (S5.11). Nested ignore files,
  `.git/info/exclude` and the user's global excludes are not, so a monorepo that
  ignores per package lists a few files it would not have. The always-skipped set
  covers the folders that matter.
- **The tree is rebuilt every turn.** It is one bounded walk per turn and it is
  memoised *within* a turn, but four members in a round walk the same folder four
  times. A per-run cache keyed on the folder is the obvious shape, and needs an
  invalidation rule the executor's own writes would have to trip.
