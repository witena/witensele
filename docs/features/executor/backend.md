# executor — Backend

## Modules

None of these imports electron; `node:fs`, `node:path`, `node:child_process` and
`node:crypto` are the point of the feature (CLAUDE.md rule #5 is about electron).

| File | Responsibility |
|---|---|
| `src/main/executor/paths.ts` | `resolveInWorkdir`, `realWorkdir`, `realPathOf`, `isInside`. The only place a path is turned into something the tools may touch. Plus `deliverablePath(goal, workdir)` (S5.12): the one spelling of "where a `document` goal's file is", shared with `chats.goalStatus` |
| `src/main/executor/tools.ts` | `buildExecutorTools` (the seven AI SDK tools), `buildExecutorSection({ workdir, handoff, goal, branch })` (the prompt), `HANDOFF_BRIEFING` and `DELIVER_BRIEFING` with `handoffBriefing(intent)` picking between them (S5.6, S5.12), `goalHandoffLine(goal, branch)` (the sentence S5.10 adds to that paragraph, naming the deliverable or the change, and since S5.12 the branch), `runCommand` (the captured, killable child process), the caps, `GATED_EXECUTOR_TOOLS`, `PermissionDeniedError`, `unifiedDiff`, `cap` |
| `src/main/executor/workspace.ts` | `buildWorkspaceSection` (the `Workspace` prompt section), `walkTree` / `formatTree` (the bounded listing), `parseGitignore` / `loadIgnoreRules` / `isIgnored` (the hand-written ignore rules), `gitInfo` (`spawnSync` git, `null` outside a repository), and the caps `MAX_TREE_ENTRIES`, `MAX_TREE_DEPTH`, `MAX_TREE_FILE_BYTES`, `MAX_STATUS_LINES`, `SKIPPED_TREE_DIRS` (S5.11) |
| `src/main/executor/command-policy.ts` | S5.15. `tokenizeCommand` (quotes, operators, redirections, `$(…)`, backticks), `classifyCommand(line, { workdir, home })` → `CommandRisk`, `resolvePathWord`, `programName`, `blockedCommandMessage` (the model-facing English for a refusal). Pure: no `node:fs`, no context |
| `src/main/executor/sandbox.ts` | S5.15. `buildSandboxProfile`, `sandboxCommand`, `sandboxAvailable`, `systemTempDirs`, `SANDBOX_EXEC`, `WRITABLE_DEVICES` |
| `src/main/executor/permissions.ts` | `createPermissionGate`: `ask` / `reply` / `pending` / `abortAll`. Since S5.15 it takes a `GrantStore` and a `timeoutMs` accessor, and `createMemoryGrantStore` is the fallback a unit test gets |
| `src/main/handlers/permissions.ts` | `permission.reply`, plus S5.15's `permissions.grants.list` and `permissions.grants.revoke` — both a validation and a repository call |
| `src/main/db/repositories/permissionGrants.ts` | S5.15. `list` / `has` / `grant` / `revoke` over `permission_grants` |
| `src/main/app-context.ts` | `AppContext.permissions`, built with `emit: ctx.events.emit`, the repository as its `GrantStore`, and a `timeoutMs` that re-reads the setting per prompt; `close()` calls `abortAll()` after `runners.stopAll()` |
| `src/main/testing.ts` | The same gate for unit tests, with an injectable `newRequestId` so a suite can answer `request-1`, the real grants repository, and `permissionTimeoutMs` off by default |
| `src/main/agents/agent-turn.ts` | `executorWorkdir` (the attachment rule) and `workspaceWorkdir` (S5.11's: any member of a chat with a folder), the executor branch of `collectAgentTools`, the permission wrapper around a `sideEffects` MCP call, the executor section in `buildSystemPrompt` — extended by `AgentTurnOptions.handoff` (S5.6, now a `HandoffIntent`) — `diffPartsFrom`, which turns the stored tool results into one `DiffPart` per written file (S5.5), and `deliveredRef`, which adds a `FileRefPart` when the turn brought the deliverable into existence (S5.12) |
| `src/main/orchestration/chat-runner.ts` | Not this feature's file, but the only caller that ever sets `handoff`: `ChatRunner.handoff` schedules the executor's round and passes the intent for that one turn, and sets `reviewing` for every speaker of the round after it ([`orchestration`](../orchestration/backend.md)) |

### Reused elsewhere

`looksBinary` gained a second caller with S5.11: `agents/materials.ts` uses the
same null-byte probe to decide what it may inline, so "binary" means one thing in
the product rather than two. `walkTree` is likewise shared — the workspace
briefing and a marked **folder** produce the same listing.

`resolveInWorkdir` has a second caller since S5.7: `src/main/editor/open.ts`
holds `system.openInEditor`'s path to the same boundary, so a `vscode://` URL
can never be built for a file outside the chat's folder. It is imported rather
than re-derived — the four ways out this module's header tabulates are exactly
the ones a second implementation would get wrong.

## Database

One table of its own since S5.15, plus the columns other features own. The
`user` message a hand-off stores is written by `ChatRunner`
([`orchestration`](../orchestration/backend.md)), not here.

| Table | Columns | Notes |
|---|---|---|
| `permission_grants` | `chat_id` → `chats.id` (cascade), `tool_name`, `created_at`; primary key on the pair | S5.15's migration `0004`. A pure join table like `chat_members`: no id, no `user_id` (the chat carries the user, and a cascade cannot check a second column), and `onConflictDoNothing` so a repeat grant keeps the timestamp the user's decision had |

| Table | Column | Type | Notes |
|---|---|---|---|
| `chats` | `workdir` | `text` nullable | The folder every path is confined to. Added by S5.2's migration; re-resolved here on every call because it may have moved since |
| `agents` | `role` | `text` | `'executor'` is half the attachment rule; since S5.11 it decides *which* tools rather than *whether* any |
| `chats` | `goal` | `text` nullable (JSON) | `goal.materials` is what `agents/materials.ts` reads; `goal.kind === 'codebase'` is what adds the git half of the workspace briefing |
| `mcp_servers` | `sideEffects` | `integer` (boolean) | Now decides **confirmation** as well as attachment |
| `settings` | `data.executor.sandbox` | JSON | S5.15. `'workdir-write'` (default) or `'off'`, read once per turn when the tools are built |
| `settings` | `data.timeouts.permissionTimeoutMs` | JSON | S5.15. Read once per prompt, so changing it applies to the next card rather than the next launch |

## IPC handlers

| Channel | Input | Output | Errors |
|---|---|---|---|
| `permission.reply` | `{ requestId: string, decision: 'allow' \| 'deny' \| 'allowAlways' }` | `void` | `validation` — blank `requestId`, or a `decision` outside the union (refused rather than read as `deny`: silently denying a call the user allowed is the worse wrong answer, and the call stays pending). `not_found` — nothing is waiting on that id, because it was answered already or a stop or a timeout closed it |
| `permissions.grants.list` | `{ chatId }` | `PermissionGrant[]`, newest first | `validation` — a blank `chatId`. A chat that does not exist answers `[]`: this is a question about grants, not a way to probe for chat ids |
| `permissions.grants.revoke` | `{ chatId, toolName }` | The **remaining** grants | `validation` — either field blank. Idempotent otherwise; revoking what was never granted succeeds, because the only thing asked for is that it not be there afterwards |

## The command policy (S5.15)

`classifyCommand(line, { workdir, home })` runs before the prompt, in
`run_command`'s `execute`. Its verdict decides three things: whether the tool
throws at once, whether the gate may answer from a grant, and what the card
warns about.

| Verdict | Rules | What happens |
|---|---|---|
| `blocked` | `sudo` / `su` / `doas` / `pkexec`; `mkfs*`, `dd of=/dev/…`, `diskutil erase…`, `hdiutil`, `fdisk`; `shutdown` / `reboot` / `halt`; a fork bomb; a recursive `rm`, or a recursive `chmod` / `chown`, whose target resolves to `/`, `~`, `$HOME` or outside the folder | `CommandBlockedError`, carrying `blockedCommandMessage(reason)`. No prompt, no shell |
| `dangerous` | Any other recursive delete; `push`, `reset --hard`, `clean`, `rebase`, `filter-branch`, `commit --amend`, `branch -D`; `npm`/`cargo`/`gem`/`twine`/`docker` publish; a download piped into a shell; `$(…)` or backticks anywhere; a path argument — or a redirection target — that resolves outside the folder; a trailing `&`, `nohup`, `disown` | Always prompts, ignores every grant, and the card shows the reason and hides "Always allow" |
| `normal` | Everything else | Exactly what S5.4 did |

Four properties worth knowing before changing it:

- **The verdict of a line is the worst of its segments.** `npm test && git push`
  is a push, and the reason names the rule that decided rather than the last one
  that matched.
- **Paths are resolved lexically**, against `workdir` and `home`, with no
  filesystem access at all. A symlink is `paths.ts`'s problem, and a classifier
  that hit the disk could not answer for a folder that has been unmounted.
- **A bare word with no separator is a path relative to the folder**, so
  `rm file.txt` is `normal` and `rm ../file.txt` is not. A word containing an
  unexpandable `$` is "unknown" rather than "outside": guessing either way would
  be a lie.
- **Command substitution is recorded, not parsed.** `$(…)` runs a whole second
  command line, and a classifier that got that nesting subtly wrong would be
  worse than one that says "a command that computes part of itself is worth
  asking about".

## The write sandbox (S5.15)

```
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "<workdir>") (subpath "<temp dirs>") …)
(allow file-write* (literal "/dev/null") …)
(allow file-write* (regex #"^/dev/(tty|fd|ptmx|pty)"))
```

Passed inline with `sandbox-exec -p`, wrapping `/bin/sh -c <line>` so that
everything the line spawns inherits it.

| Detail | Why |
|---|---|
| `(allow default)` first, then `(deny file-write*)`, then the allowances | SBPL takes the **last** matching rule. The reverse order produces a profile that looks right and confines nothing, which is why the test shells out rather than only asserting on the string |
| Every writable path is listed twice, as given and realpathed | The sandbox matches the real path, and `/tmp` is a symlink to `/private/tmp` on macOS — as is everything `mkdtemp` returns. A profile naming only `/tmp` denies every write to it |
| Reads and the network are untouched | A build that cannot fetch its dependencies is not a build; reads are the permission prompt's business |
| `/dev/null` and friends are allowed by literal, `/dev/tty*` by regex | A pseudo-terminal is allocated per device node and cannot be named in advance |
| A missing `sandbox-exec` runs the command plainly and raises `notices.sandboxUnavailable` **once per turn** | The alternative — refusing to run anything — turns one deprecated binary into a broken product |

## Diff parts

`diffPartsFrom(parts)` runs once, after the stream ends and before the terminal
update, over the parts the turn has already stored. It reads the `patch` the
write tools return and appends one `DiffPart` per file, each as a
`message.delta` of kind `part` followed by the final `messages.update`.

| Rule | Why |
|---|---|
| Only `write_file` and `edit_file` calls | `git_diff` returns a `patch` too, and it *reports* on the folder rather than changing it. Posting it would claim the executor wrote something it only looked at |
| Only results without `isError`, with a non-blank `patch` | A denied write, a refused path and an edit that changed nothing all have nothing to show |
| Grouped by the `path` the **tool** returned | That is the path as resolved against the folder, not the string the model typed |
| Walked in **call** order, patches concatenated in that order | Two writes issued in one step finish in whichever order the filesystem answers. A block order that depends on that would reshuffle between two identical turns |
| A patch that does not end in a newline gets one | Two `+++` headers running into each other would break the block |
| Appended even when the turn was stopped or failed afterwards | The writes really happened. Hiding them is the one thing the transcript must never do |

## The delivered chip (S5.12)

`deliveredRef(deliverable, existedBefore)` runs immediately after
`diffPartsFrom`, on an **executor** turn of a chat whose goal is a `document`
naming a file. It appends at most one `FileRefPart`, carrying the **absolute**
path — what `system.openInEditor` takes, and what `chats.goalStatus` answers with
for the header chip.

The rule is *the turn that delivered it, and only that turn*: the deliverable was
not on disk when the turn started (one `existsSync` before the stream) and is on
disk now (one after it).

| Consequence | Why it is right |
|---|---|
| A later turn that rewrites the deliverable gets **no** chip | It did not deliver the document; its `DiffPart` is the record of what it did. Same argument as `diffPartsFrom` ignoring `git_diff` |
| A deliverable that already existed before the chat ever ran gets **no** chip | The header chip has read "delivered" since the chat was opened; nothing is hidden |
| A file deleted by hand and written again gets a **new** chip | That turn really did deliver it again |
| A participant's turn never gets one | Participants cannot write, so a file appearing while one spoke was somebody else's doing |
| The turn need not have *written* it with a tool | `run_command` produces files and returns no patch. The question the chip answers is whether the deliverable is there |
| A stopped or failed turn keeps its chip | The file is on disk either way — the same rule the diffs follow |

Two alternatives were rejected: a chip on *every* executor turn while the file
exists (a claim each of them produced it), and "the first executor turn in a chat
whose deliverable exists" (a transcript scan that still cannot tell a file this
chat wrote from one that was already lying in the folder).

## Events emitted

| Event | Payload | Emitted when |
|---|---|---|
| `permission.requested` | `{ requestId, chatId, agentId, toolName, input, risk? }` | `PermissionGate.ask` suspends a gated call. Not emitted when a remembered `allowAlways` answers it, nor when the signal was already aborted. `risk` is present only for `run_command` (S5.15), and is what a `dangerous` card warns about — it is sent rather than recomputed because classifying a line needs the folder and the home directory |
| `permission.resolved` | `{ requestId, chatId, decision }`, `decision` being the reply, `'aborted'` or `'timeout'` | The prompt ends, exactly once per `requested`, on every path including `abortAll()` and S5.15's own timeout |

## Filesystem

Everything happens inside `Chat.workdir`, which the **user** owns: this feature
creates nothing of its own under `userData` and cleans nothing up. Writes are
`writeFileSync` with `mkdirSync(dirname, { recursive: true })` first, so a new
file may create directories; nothing is ever deleted.

The caps, all in `tools.ts`:

| Constant | Value | Applies to |
|---|---|---|
| `MAX_READ_BYTES` | 200 KB | `read_file`, and the per-file limit of `search_files` |
| `MAX_OUTPUT_CHARS` | 32 KB per stream | `run_command`, `git_diff` |
| `MAX_DIR_ENTRIES` | 500 | `list_dir` |
| `MAX_SEARCH_HITS` | 100 | `search_files` |
| `MAX_SEARCH_FILES` | 5 000 | the `search_files` walk |
| `TRUNCATION_MARKER` | `… (truncated)` | appended wherever text was cut |

`search_files` prunes hidden entries and `.git`, `node_modules`, `.venv`,
`venv`, `__pycache__`, `.next`, `dist`, `out`, `build`, `target`, `.cache`, and
stops at depth 12 so a symlink loop cannot spin.

The briefing's own caps live in `workspace.ts` and are a different set, because
it is describing a folder rather than searching it:

| Constant | Value | Applies to |
|---|---|---|
| `MAX_TREE_ENTRIES` | 200 | the whole listing, after which it says how many it printed |
| `MAX_TREE_DEPTH` | 3 | how far below the folder it descends |
| `MAX_TREE_FILE_BYTES` | 1 MB | a file larger than this is not listed at all |
| `MAX_STATUS_LINES` | 40 | `git status --short` in a `codebase` chat |
| `SKIPPED_TREE_DIRS` | `.git`, `node_modules`, `.venv`, `venv`, `__pycache__`, `.next`, `.nuxt`, `.turbo`, `dist`, `out`, `build`, `target`, `coverage`, `.cache` | never descended into, whatever `.gitignore` says |

## External dependencies

| Dependency | Used for | Pitfalls |
|---|---|---|
| `diff` (9.x) | `createPatch(fileName, before, after, undefined, undefined, { context: 3 })` → the unified diff `write_file` and `edit_file` return | The package is dual-published; the ESM entry is what `externalizeDepsPlugin` leaves as a runtime import, so it must stay in `dependencies`, not `devDependencies`. `createPatch`'s 4th and 5th parameters are the old and new file *headers*; the options object (`{ context }`) is the 6th, so both have to be passed as `undefined` to reach it |
| `/usr/bin/sandbox-exec` | S5.15's write sandbox, `-p <profile> /bin/sh -c <line>` | Deprecated by Apple and still the only thing of its kind on macOS. SBPL's last-rule-wins ordering is the trap; the realpath of every allowed subpath is the second one. A missing binary is a notice, never a refusal to run |
| `node:child_process` | `spawn('/bin/sh', ['-c', command], { cwd, detached: true, stdio: ['ignore','pipe','pipe'] })`, or the `sandbox-exec` wrapper around it | `detached: true` plus `process.kill(-pid)` is what actually kills a command's **children**; `child.kill()` alone leaves a `sleep` behind that nothing can see. `SIGTERM` first, `SIGKILL` after 2 s. Both the timeout and the abort timers are `unref`ed so a pending one cannot keep vitest alive. Output is capped as it arrives, not at the end, so a command that prints a gigabyte does not put a gigabyte in the heap on its way to being truncated |
| `node:fs` | `realpathSync`, `existsSync`, `statSync`, `readFileSync`, `writeFileSync`, `readdirSync({ withFileTypes: true })` | `realpathSync` of a path that does not exist **throws**, which is why `realPathOf` climbs to the deepest existing ancestor: the write case has nothing to realpath yet, and checking only the target is the hole a symlinked directory walks through. `readdirSync`'s return type is a union until `withFileTypes` is narrowed — annotate `Dirent[]` |
| `ai` | `tool({ description, inputSchema: jsonSchema(...), execute })`, the same shape as `skills/tools.ts` and `memory/tools.ts` | A thrown `execute` becomes a `tool-error` part, which is how a denial and a refused path reach the model. `execute`'s second argument is `ToolExecutionOptions` and requires `context` in ai 7.x — a test that calls `execute` directly must pass it |
| `node:crypto` | `randomUUID()` for `requestId` | Injectable (`newRequestId`) so a test can assert on `request-1` |
| `node:child_process` (`spawnSync`) | `gitInfo`: `git -C <dir> rev-parse --is-inside-work-tree`, `rev-parse --abbrev-ref HEAD`, `status --short` | Synchronous on purpose — `buildTurnPrompt` is synchronous and the calls are milliseconds — but with `timeout: 2_000` and every failure mapped to `null`, so a folder on a stalled network mount costs the briefing its git half rather than costing the chat its turn. A repository with no commits answers `HEAD` to `--abbrev-ref`, which is why `symbolic-ref --short HEAD` is the fallback |

## Pitfalls found the hard way

- **The MCP side-effects gate had to move into the `call` closure**, not into
  `mcp/tools.ts`: that module is pure and knows nothing about a chat. It also
  means the flag that decides *whether an agent may have a tool* and the flag
  that decides *whether a call is confirmed* are read in one place from one
  record.
- **`agent-turn.test.ts`'s existing "attaches the same server to an executor"
  case started timing out** the moment side-effecting MCP calls began asking:
  there was nobody to answer, so the turn waited for the hard timeout. Every
  suite that runs an executor now subscribes a one-line "user" that replies.
- **`edit_file` re-reads the file after the prompt** and refuses if it changed.
  Writing the copy read *before* the prompt would silently revert an edit the
  user made while deciding.
- **`.gitignore` is parsed rather than delegated.** Adding the `ignore` package
  was the alternative; the parser covers comments, blanks, `!`, a trailing `/`,
  a leading `/`, `*`, `?` and `**`, which is what a root ignore file contains.
  Getting an exotic pattern wrong costs one extra line in a listing — it decides
  nothing about what may be read, which is `paths.ts`'s job. Only the folder's
  own file is read: nested ones, `.git/info/exclude` and the global excludes are
  not.
- **The tree is sorted, not `readdir` order.** The same folder has to produce the
  same briefing twice, or two prompts cannot be compared with each other.
- **`resolveInWorkdir` returns the path as the caller spelled it**, not its
  realpath, so a symlink that stays inside the folder is reported as `lib/x.ts`
  rather than `src/x.ts`. The diff header should name the path the model used.
- **The sandbox profile has to name the realpath** (S5.15). The first version of
  the test bound the chat to a `mkdtemp` directory and asserted that a write
  *inside* the folder succeeded; it failed, because macOS hands back
  `/var/folders/…` and the sandbox matches `/private/var/folders/…`. Both
  spellings are listed now, and `buildSandboxProfile` realpaths for itself
  rather than trusting the caller to have done it.
- **`2>&1` must tokenize as one redirection.** Matching `>` and then `&`
  separately made every stderr-merging command look like a background process,
  which is a `dangerous` verdict on `npm test 2>&1`. The tokenizer consumes
  redirection operators whole, including a leading file descriptor.
- **The temp allowance makes a temp working directory unconfined against temp.**
  The suite's own working directories are `mkdtemp`s, so "a write outside the
  folder fails" has to be asserted against somewhere that is *not* a temp
  directory — the home directory, in both `sandbox.test.ts` and `tools.test.ts`.
  A sibling folder under `/tmp` proves nothing.
