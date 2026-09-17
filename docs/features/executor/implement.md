# executor — Implementation

## Approach

Six modules under `src/main/executor/`, none of which knows what a chat runner
is, plus two rules in `agent-turn.ts` that decide which of them applies to which
member — and, since S5.5, one store and several renderer modules that make the
whole thing answerable.

| Module | Owns |
|---|---|
| `paths.ts` | `resolveInWorkdir(workdir, path)` → `{ absolute, relative }`, and nothing else. Every path an executor tool touches goes through it |
| `tools.ts` | The seven AI SDK tools, the constants that cap them, and `buildExecutorSection({ workdir, handoff, goal, branch })` (the prompt, plus `HANDOFF_BRIEFING` / `DELIVER_BRIEFING` and `goalHandoffLine` for the turn a hand-off schedules) |
| `permissions.ts` | `PermissionGate`: `ask` / `reply` / `pending` / `abortAll`, one promise per waiting prompt. Since S5.15 it also holds the grant lookup, the prompt timeout, and the rule that a `dangerous` call ignores both |
| `command-policy.ts` (S5.15) | `tokenizeCommand` and `classifyCommand`: is this command line `blocked`, `dangerous` or `normal`, and by which rule. Pure — the directories it measures against are arguments |
| `sandbox.ts` (S5.15) | `buildSandboxProfile` and `sandboxCommand`: the `sandbox-exec` wrapper an approved command really runs inside |
| `workspace.ts` (S5.11) | `walkTree` / `formatTree`, the `.gitignore` parser (`parseGitignore`, `loadIgnoreRules`, `isIgnored`), `gitInfo`, and `buildWorkspaceSection` — the folder as a model reads it |

| Renderer module (S5.5) | Owns |
|---|---|
| `stores/permissions.ts` | The open prompts, keyed by `requestId`, and the one call that answers them |
| `components/chat/permission-card.tsx` | The card: what it says, the three buttons, Enter and Escape |
| `components/chat/permission-input.ts` | What a call looks like on that card — verbatim for a command — and, since S5.15, whether to warn and whether to offer a grant |
| `components/chat/command-risk.ts` (S5.15) | One reason code, one sentence, in the active language |
| `components/chat/grants-list.tsx` (S5.15) | The "Always allowed" block of the group settings |
| `components/chat/diff-block.tsx` + `transcript-rows.ts` | The `DiffPart` block and the pure transforms behind it |
| `components/chat/file-ref-chip.tsx` | The `path:line` chip; since S5.7 it opens the file, and since S5.12 the backend emits the parts it draws as well as the detector |

The gate lives on `AppContext` (`ctx.permissions`) for the same reason the runner
registry and the MCP pool do: a pending prompt outlives the IPC call that raised
it — the tool call is suspended inside a turn while the card is on screen — and
`permission.reply` has to reach the very gate holding that promise.

`collectAgentTools` is the only place that knows all of them. It asks two
questions, in this order:

| Question | Answered by | Result |
|---|---|---|
| Is this agent *the* executor of a chat with a folder? | `executorWorkdir(chat, agent, members)` | All seven tools |
| Failing that, does the chat have a folder at all? | `workspaceWorkdir(chat)` (S5.11) | The four in `READ_ONLY_EXECUTOR_TOOLS` |

Both build the same `buildExecutorTools({...})` set and the second one picks
four keys out of it, so a participant's `read_file` is *the* `read_file` — same
confinement, same caps, same refusals — rather than a second implementation that
would drift. The same function wraps the MCP `call` closure so a `sideEffects`
server's tools ask first.

**The workspace briefing (S5.11).** `buildTurnPrompt` asks `workspaceWorkdir` the
same question and appends `buildWorkspaceSection({ workdir, goal, executor })`,
so the prompt can no more describe a folder the agent cannot read than it can
promise a tool it was not given. `executor: true` drops the read-only sentence,
which the executor's own section already covers in its list of seven.

**The hand-off briefing (S5.6).** `buildExecutorSection` takes a second
argument, and `buildSystemPrompt` passes `AgentTurnOptions.handoff` straight
into it. The flag is set by `ChatRunner` for exactly one turn — the executor's,
in the round `chat.handoff` scheduled — and reaches nothing else in the turn:

```
ChatRunner.handoff → #loop (stage 'executor') → #runRound(… implementing = executorId)
  → runAgentTurn({ …, handoff: agent.id === implementing })
    → buildSystemPrompt(…, handoff) → buildExecutorSection(workdir, handoff, goal)
      → […the standing section…, HANDOFF_BRIEFING + goalHandoffLine(goal)]
```

**The goal's sentence (S5.10).** `goalHandoffLine(goal)` appends one more
sentence to that paragraph: for a `document`, the deliverable to write (creating
its parent folders) and to report the path; for a `codebase`, the change the
user described. A `discussion` goal, and a chat with none, add nothing —
`HANDOFF_BRIEFING` already says to implement the conclusion, and there is
nothing more concrete to point at. It is a **pointer, not a restatement**: the
goal is in the group briefing of the same prompt, and a model given one
instruction twice in two wordings follows neither reliably.

`HANDOFF_BRIEFING` is exported so a test can assert the prompt contains it, and
so the *absence* of it can be asserted on the executor's **second** turn — the
one a reviewer's `@` scheduled, which is an ordinary reply to a specific
question rather than a fresh hand-off.

## Data flow

The one path worth tracing is a confirmed write.

```
model emits tool-call write_file
  → streamText runs the tool's execute()
    → resolveInWorkdir(chat.workdir, path)          # refuses an escape here, before asking
    → PermissionGate.ask({ chatId, agentId, toolName, input, signal })
      → emit permission.requested { requestId, chatId, agentId, toolName, input }
        → (S5.5) renderer draws a card                        ── the turn is suspended ──
      ← permission.reply { requestId, decision }     # BackendClient → IPC → handlers/permissions.ts
      → emit permission.resolved { requestId, chatId, decision }
    → resolve the path again, read the old contents, mkdir -p, writeFileSync
    → return { path, created, bytes, patch }
  → agent-turn stores a tool-result part and emits message.delta { kind: 'part' }
  → model's next step reads the patch and writes its summary
  → stream ends: diffPartsFrom(parts) → one DiffPart per file
                 → message.delta { kind: 'part' } each, then messages.update
                   → renderer draws a collapsed diff block per file
```

The renderer half of the same trace, which is where the prompt is actually
answered:

```
permission.requested
  → lib/event-bridge.ts → usePermissionsStore.applyRequested
  → chats-page stacks a PermissionCard above the composer (oldest focused)
  ← Allow / Always allow / Deny, or Enter / Escape on the card
  → permissions.reply → invoke('permission.reply', { requestId, decision })
    → handlers/permissions.ts → ctx.permissions.reply → the waiting tool resumes
  → permission.resolved → applyResolved → the card is gone
```

Two failure paths are worth stating because neither is an error to show: a reply
the gate refuses with `not_found` (answered twice, or a stop this window missed)
drops the card silently, and a `permission.resolved` for a prompt this window
never saw is ignored.

Three variants end differently:

- **Deny** → `ask` resolves `{ allowed: false, reason: 'denied' }` → the tool
  throws `PermissionDeniedError` → the AI SDK emits `tool-error` → `agent-turn`
  stores a `tool-result` with `isError: true`, and the model reads "the user
  declined" on its next step. Nothing is written.
- **Stop while the prompt is open** → the turn's signal aborts → the gate
  resolves `{ allowed: false, reason: 'aborted' }` and emits
  `permission.resolved { decision: 'aborted' }` so the card disappears → the
  turn ends `error` / `'aborted'` as any stopped turn does.
- **A remembered `allowAlways`** → `ask` returns immediately and emits nothing:
  a card that appeared and vanished in the same frame is worse than no card.
- **Nobody answers** (S5.15) → after `AppTimeouts.permissionTimeoutMs` the gate
  finishes the prompt itself with `{ allowed: false, reason: 'timeout' }` and
  emits `permission.resolved { decision: 'timeout' }`. The tool throws the same
  `PermissionDeniedError` with a different sentence — "the user did not answer
  in time" — so the model can close its turn saying what is still waiting.

`run_command` follows the same shape with two steps in front of it and one
around it (S5.15):

```
model emits tool-call run_command
  → classifyCommand(line, { workdir })
    → blocked   → throw CommandBlockedError   # no prompt, no shell, and the
                                              # model reads why
    → otherwise → PermissionGate.ask({ …, risk })
                  → dangerous? ignore any grant, and the card warns
  → sandboxCommand({ command, mode, workdir })
    → sandbox-exec -p <profile> /bin/sh -c <line>   # or plain /bin/sh, with one
                                                    # notice, if it is missing
  → spawn, capped, killed on both the tool budget and the turn's signal
```

The child is killed on both the `toolTimeoutMs` budget and the turn's signal, as
before; the sandbox changes what it may write, not how it ends.

The grants have a flow of their own, and it is deliberately short:

```
reply allowAlways → the gate writes permission_grants (chat + tool)
                  → permission.resolved { decision: 'allowAlways' }
                    → event-bridge reloads that chat's grants
                      → the "Always allowed" block gains a row
revoke            → permissions.grants.revoke → the remaining list
                    → the block redraws from that answer, never optimistically
```

## Key types and contracts

Shared (`src/shared/types.ts`): `PERMISSION_DECISIONS`, `PermissionDecision`,
`isPermissionDecision`. Reused: `Chat.workdir`, `AgentRole`,
`McpServer.sideEffects`, `AppSettings.timeouts.toolTimeoutMs`, and — real since
S5.5 — `DiffPart` and `FileRefPart`, both reserved since S1.1. No shared type,
method or event was added by S5.5; it is the renderer catching up with the
contract S5.4 already defined.

Renderer types: `PendingPermission`, `PermissionsState` (`stores/permissions.ts`);
`PermissionInputView`, `PermissionBodyKind`, `CONTENT_PREVIEW_CHARS`
(`permission-input.ts`); `EXECUTOR_PREVIEW_ARG` (`tool-call.ts`).

| Channel / method | Request | Response | Notes |
|---|---|---|---|
| `permission.reply` | `{ requestId, decision }` | `void` | `validation` for a blank id or an unknown decision; `not_found` for an id nothing is waiting on — answered twice, or closed by a stop |

| Event | Payload | Emitted when |
|---|---|---|
| `permission.requested` | `{ requestId, chatId, agentId, toolName, input }` | A gated tool is about to run and the turn is suspended |
| `permission.resolved` | `{ requestId, chatId, decision }` where `decision` is a `PermissionDecision` or `'aborted'` | The prompt ended, **however** it ended. Exactly one per `permission.requested` |

Main-process types: `PermissionGate`, `PermissionRequest`, `PermissionOutcome`
(`permissions.ts`); `ExecutorToolContext`, `PermissionDeniedError`,
`EXECUTOR_TOOLS`, `GATED_EXECUTOR_TOOLS`, `READ_ONLY_EXECUTOR_TOOLS`,
`HANDOFF_BRIEFING`, `goalHandoffLine`, `looksBinary` (`tools.ts`); `ResolvedPath`
(`paths.ts`); `IgnoreRule`, `TreeEntry`, `TreeResult`, `GitInfo`,
`WorkspaceSectionInput`, `MAX_TREE_ENTRIES`, `MAX_TREE_DEPTH`,
`MAX_TREE_FILE_BYTES`, `SKIPPED_TREE_DIRS` (`workspace.ts`); `executorWorkdir`,
`workspaceWorkdir` and `AgentTurnOptions.handoff` (`agents/agent-turn.ts`).

`chat.handoff` itself is [`orchestration`](../orchestration/implement.md)'s
method; this feature contributes only the sentence the executor reads.

## Tests

| File | Covers |
|---|---|
| `src/main/executor/paths.test.ts` | `..`, an absolute path outside, a symlink to a file and to a directory, a **new** file through a symlinked directory, an absolute path inside, a missing workdir, `isInside` on a sibling with a shared prefix |
| `src/main/executor/permissions.test.ts` | allow, deny, `allowAlways` and that it does not leak to another tool or chat, abort by signal, an already-aborted signal drawing no card, an unknown `requestId`, a second reply, one resolution per request, `abortAll` — plus (S5.15) the grant written through the injected store, a grant the store already had answering with no card at all, a `dangerous` call asking anyway and recording nothing, no `risk` on a tool that has no verdict, and the timeout: it denies itself as `'timeout'`, refuses a reply that arrives afterwards, never fires on an answered prompt, and is off when the budget is zero |
| `src/main/executor/command-policy.test.ts` (S5.15) | The tokenizer (operators, quoted operators, redirection targets, `2>&1` as one token, a substitution recorded and not parsed, a pipe, a background `&`), `resolvePathWord` (relative, `~`, `$HOME`, a flag, an assignment, an unexpandable variable), every `blocked` rule once, every `dangerous` rule once, a redirection outside the folder, the worst-of-a-chain rule, and sixteen look-alikes that must stay `normal` — `rm file.txt`, `git status`, `echo "sudo"` and `npm test 2>&1` among them |
| `src/main/executor/sandbox.test.ts` (S5.15) | The profile's rule **order** (the trap: SBPL takes the last match), that reads and the network are untouched, the devices, a quote escaped in a folder name, both spellings of the temp directory; `sandboxCommand` wrapping the shell rather than the program, and running plainly when the setting is off or the binary is missing. Then three runs against the **real** `sandbox-exec`: a write inside the folder succeeds, a write to the home directory fails with `not permitted` and leaves no file, and a read outside the folder still works — the limit of the feature, stated as a test |
| `src/main/db/permissionGrants.test.ts` (S5.15) | Empty for a chat nobody granted anything in, the point read, scoping to one chat, surviving a reopen, a repeat grant keeping its first timestamp, newest-first ordering, revoking one and only one, an idempotent revoke, and the cascade asserted straight against the table |
| `src/main/executor/tools.test.ts` | Each of the seven against a temp directory and a real `/bin/sh`: the tool set, reads and refusals, the diffs `write_file` / `edit_file` return, the ambiguous-match refusal, a denied call writing nothing, the timeout kill, the abort kill, the output cap, `git_diff` in and out of a repository, the briefing |
| `src/main/handlers/permissions.test.ts` | `permission.reply` releasing a waiting call, `not_found`, a blank id, an unknown decision leaving the call still waiting — plus (S5.15) an `allowAlways` landing in the real table and coming back from `grants.list`, a revoke answering with what is left, a revoked grant making the next call ask again, an idempotent revoke on a chat that does not exist, and the two validations |
| `src/main/agents/agent-turn.test.ts` | A `MockLanguageModelV4` calling `write_file`: the seven tools offered and the folder in the prompt, allow → file on disk plus a `tool-result` carrying the patch, deny → `tool-error` and nothing written, `allowAlways` not asking twice, a participant and a folderless chat getting no tools, the two-executor tie broken by position, a read-only tool and a refused path never asking |
| `src/shared/contracts.test.ts` | `permission.reply` in `BACKEND_METHODS`, the `permission` namespace, and the shapes of both events — plus (S5.15) the two `permissions.grants.*` methods, the `permissions` namespace, `'timeout'` in the resolved decision, the optional `risk` on the request, and the two new defaults |
| `src/main/agents/agent-turn.test.ts` (S5.5 block) | `diffPartsFrom` over the part shapes a turn really stores — one block per file, several writes to one file concatenated at its first position, a patch without a trailing newline separated, and a denial, an unchanged edit, a `git_diff` and a malformed output all producing nothing — plus three whole turns: two files giving two blocks and two `part` deltas, a write followed by an edit of the same file giving one, and a denied write giving none |
| `src/renderer/src/stores/permissions.test.ts` | Request, order, reply, resolve on all four decisions, a stop clearing every prompt, a `not_found` dropping the stale card, a double answer, and a deleted chat — plus (S5.15) the verdict carried onto the card, the field left absent when none was sent, a `'timeout'` dropping the card, the grants loaded on demand, reloaded after an `allowAlways` and *not* after a plain allow, a revoke redrawn from the backend's list, a failed load answering `[]`, and a deleted chat's grants forgotten |
| `src/renderer/src/components/chat/permission-input.test.ts` | The verbatim command, the capped write preview, the empty file, the edit's patch, and both fallbacks to raw JSON — plus (S5.15) `describePermissionCard`: a dangerous call warns and withholds the grant button while keeping the command verbatim, a normal one does neither, a tool with no verdict does neither, and a `blocked` verdict fails safe |
| `src/renderer/src/components/chat/command-risk.test.ts` (S5.15) | The key each reason maps to, a non-empty line for all sixteen in **both** locale files, and no line for a code the policy cannot produce |
| `src/renderer/src/components/chat/tool-call.test.ts` (S5.5 block) | `write_file(path)`, `run_command(command)` flattened and capped, `search_files(query)`, an MCP tool of the same name keeping the generic preview, and a missing argument falling back |
| `src/renderer/src/components/chat/transcript-rows.test.ts` | `collectDiffs` / `collectFileRefs` over a mixed part list, `countDiffLines`, `formatFileRef` |
| `e2e/executor.spec.ts` (S5.15 block) | Offline: the "Always allowed" block starts empty, two grants written straight into the closed database are listed newest first after a relaunch, the revoke button removes one row and leaves the other — asserted against `permissions.grants.list` as well as against the screen — and revoking the last brings the empty state back |
| `e2e/executor.spec.ts` | Offline: a chat with no executor shows no card, and the hand-off button carries `data-blocked` naming the rule that disabled it. Behind the `qwen2.5:3b` guard: the card appears, nothing is on disk while it waits, Allow writes the file, the card goes away and the diff block appears and opens onto a `diff` code block — and (S5.6) two participants plus an executor discuss, "Hand to executor" is clicked, the prompt is allowed, a file appears in the folder and a participant speaks again without anybody typing |
| `src/main/executor/tools.test.ts` (`goalHandoffLine`, S5.10, S5.12) | The deliverable and its parent folders for a `document`, the change for a `codebase`, nothing for a discussion or a chat with no goal, the line reaching `buildExecutorSection` only when `handoff` is set, and — S5.12 — the branch named when `gitInfo` knew one and left out when it did not, plus the summary that lists changed paths |
| `src/main/executor/tools.test.ts` (`buildExecutorSection (deliver)`, S5.12) | The deliver paragraph asking for the file, its parent folders and a two-line summary, with the path from `goalHandoffLine` and *without* the implement paragraph; the implement intent keeping its own and not gaining the two-line rule; and all three shapes sharing one prefix, which is what makes the briefing a suffix |
| `src/main/executor/paths.test.ts` (S5.12) | `deliverablePath`: the join, `null` for every goal that is not a `document` naming a file and for a chat with no folder, and a path answered for a file — and a folder — that is not there |
| `src/main/agents/agent-turn.test.ts` (S5.12 block) | Seven whole turns: the `FileRefPart` on the turn that brought the deliverable into existence and on no other (a later rewrite, a different file, a goal that names none, a participant while something else wrote it), the review block reaching a reviewer's prompt and not an ordinary one, and the deliver briefing reaching the executor's |
| `src/main/executor/workspace.test.ts` (S5.11) | The walker against real temporary folders: the sort order, `maxDepth`, `maxEntries` and its marker, the always-skipped folders, the size cap, and a `.gitignore` with a comment, a bare name, a `dir/`, a `*.tmp` and a `!keep.tmp`; the parser's anchoring, `?`, `**` and un-ignoring rules and that an uncompilable pattern throws nothing; `gitInfo` answering `null` outside a repository and naming the branch inside one; and the section itself — the folder and its listing, the empty folder, the executor's missing sentence, and the git half appearing for `codebase` and for nothing else |
| `src/main/agents/agent-turn.test.ts` (S5.11 block) | A whole participant turn in a chat with a folder: the four read-only tools offered and none of the three that write (asserted one by one), the folder and its listing in the prompt, a marked material in the prompt with the unmarked file's contents *not* in it, a real `read_file` call on that unmarked file coming back with its contents, `materialsOmitted` reported when a material was too large, and a chat with no folder getting neither tools nor section |
| `src/main/orchestration/chat-runner.test.ts` (S5.6 block) | The briefing this feature contributes, asserted where it is used: the handed-over turn's prompt contains `HANDOFF_BRIEFING` and the folder, and the executor's next turn contains the folder but not the briefing. A Stop inside the handed-over turn leaves `ctx.permissions.pending()` empty and nothing on disk |

`npm test`: 97 files, 1724 tests. `npm run typecheck` clean.

## Known limitations and TODOs

- **A prompt is invisible from another chat.** The card is per chat, and nothing
  tells a user looking elsewhere that an executor is waiting on them.
- **A revoked grant does not un-answer a call already in flight** (S5.15). A
  tool released a millisecond before the revoke landed still runs.
- **A `write_file` card previews content, not a diff**, because the tool computes
  the patch only after the grant. `edit_file` shows its patch.
- **The only `FileRefPart` the backend emits is the deliverable's** (S5.12).
  Every other chip a user sees still comes from S5.7's text detector, so a turn
  that read six files reports none of them as parts.
- **The sandbox confines writes, not reads** (S5.15; see `context.md`, "Open
  questions"). An approved command still reads anything the user can read, and
  the system temp directories are writable, so a chat bound to a folder inside
  `/tmp` is not usefully confined against the rest of `/tmp`.
- **The command policy is a guard rail, not a boundary** (S5.15). A variable
  expansion, or a script the line runs, defeats every rule in it.
- **`sandbox-exec` is deprecated** and macOS-only. When it is absent the command
  runs unconfined behind one `notices.sandboxUnavailable` line.
- **Only the root `.gitignore` is read** (S5.11), and the tree is walked once per
  *turn* rather than once per round — four members walk the same folder four
  times.
- `search_files` is a substring scan with a hard-coded prune list, not a
  ripgrep. Once `run_command` exists, `rg` is available to the executor anyway.
- `run_command` assumes `/bin/sh`, which is correct for the macOS-only build and
  would need a branch on Windows.
