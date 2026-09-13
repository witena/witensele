# executor — Backend

## Modules

None of these imports electron; `node:fs`, `node:path`, `node:child_process` and
`node:crypto` are the point of the feature (CLAUDE.md rule #5 is about electron).

| File | Responsibility |
|---|---|
| `src/main/executor/paths.ts` | `resolveInWorkdir`, `realWorkdir`, `realPathOf`, `isInside`. The only place a path is turned into something the tools may touch |
| `src/main/executor/tools.ts` | `buildExecutorTools` (the seven AI SDK tools), `buildExecutorSection(workdir, handoff)` (the prompt) and `HANDOFF_BRIEFING` (the paragraph it appends for a hand-off, S5.6), `runCommand` (the captured, killable child process), the caps, `GATED_EXECUTOR_TOOLS`, `PermissionDeniedError`, `unifiedDiff`, `cap` |
| `src/main/executor/permissions.ts` | `createPermissionGate`: `ask` / `reply` / `pending` / `abortAll`, the `allowAlways` set |
| `src/main/handlers/permissions.ts` | The `permission.reply` handler: two validations, then `ctx.permissions.reply` |
| `src/main/app-context.ts` | `AppContext.permissions`, built with `emit: ctx.events.emit`; `close()` calls `abortAll()` after `runners.stopAll()` |
| `src/main/testing.ts` | The same gate for unit tests, with an injectable `newRequestId` so a suite can answer `request-1` |
| `src/main/agents/agent-turn.ts` | `executorWorkdir` (the attachment rule), the executor branch of `collectAgentTools`, the permission wrapper around a `sideEffects` MCP call, the executor section in `buildSystemPrompt` — extended by `AgentTurnOptions.handoff` (S5.6) — and, since S5.5, `diffPartsFrom`, which turns the stored tool results into one `DiffPart` per written file |
| `src/main/orchestration/chat-runner.ts` | Not this feature's file, but the only caller that ever sets `handoff: true`: `ChatRunner.handoff` schedules the executor's round and passes the flag for that one turn ([`orchestration`](../orchestration/backend.md)) |

## Database

None. This feature reads two columns other features own and writes nothing. The
`user` message a hand-off stores is written by `ChatRunner`
([`orchestration`](../orchestration/backend.md)), not here.

| Table | Column | Type | Notes |
|---|---|---|---|
| `chats` | `workdir` | `text` nullable | The folder every path is confined to. Added by S5.2's migration; re-resolved here on every call because it may have moved since |
| `agents` | `role` | `text` | `'executor'` is half the attachment rule |
| `mcp_servers` | `sideEffects` | `integer` (boolean) | Now decides **confirmation** as well as attachment |

No migration. `allowAlways` is deliberately in memory only.

## IPC handlers

| Channel | Input | Output | Errors |
|---|---|---|---|
| `permission.reply` | `{ requestId: string, decision: 'allow' \| 'deny' \| 'allowAlways' }` | `void` | `validation` — blank `requestId`, or a `decision` outside the union (refused rather than read as `deny`: silently denying a call the user allowed is the worse wrong answer, and the call stays pending). `not_found` — nothing is waiting on that id, because it was answered already or a stop closed it |

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

## Events emitted

| Event | Payload | Emitted when |
|---|---|---|
| `permission.requested` | `{ requestId, chatId, agentId, toolName, input }` | `PermissionGate.ask` suspends a gated call. Not emitted when a remembered `allowAlways` answers it, nor when the signal was already aborted |
| `permission.resolved` | `{ requestId, chatId, decision }`, `decision` being the reply or `'aborted'` | The prompt ends, exactly once per `requested`, on every path including `abortAll()` |

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

## External dependencies

| Dependency | Used for | Pitfalls |
|---|---|---|
| `diff` (9.x) | `createPatch(fileName, before, after, undefined, undefined, { context: 3 })` → the unified diff `write_file` and `edit_file` return | The package is dual-published; the ESM entry is what `externalizeDepsPlugin` leaves as a runtime import, so it must stay in `dependencies`, not `devDependencies`. `createPatch`'s 4th and 5th parameters are the old and new file *headers*; the options object (`{ context }`) is the 6th, so both have to be passed as `undefined` to reach it |
| `node:child_process` | `spawn('/bin/sh', ['-c', command], { cwd, detached: true, stdio: ['ignore','pipe','pipe'] })` | `detached: true` plus `process.kill(-pid)` is what actually kills a command's **children**; `child.kill()` alone leaves a `sleep` behind that nothing can see. `SIGTERM` first, `SIGKILL` after 2 s. Both the timeout and the abort timers are `unref`ed so a pending one cannot keep vitest alive. Output is capped as it arrives, not at the end, so a command that prints a gigabyte does not put a gigabyte in the heap on its way to being truncated |
| `node:fs` | `realpathSync`, `existsSync`, `statSync`, `readFileSync`, `writeFileSync`, `readdirSync({ withFileTypes: true })` | `realpathSync` of a path that does not exist **throws**, which is why `realPathOf` climbs to the deepest existing ancestor: the write case has nothing to realpath yet, and checking only the target is the hole a symlinked directory walks through. `readdirSync`'s return type is a union until `withFileTypes` is narrowed — annotate `Dirent[]` |
| `ai` | `tool({ description, inputSchema: jsonSchema(...), execute })`, the same shape as `skills/tools.ts` and `memory/tools.ts` | A thrown `execute` becomes a `tool-error` part, which is how a denial and a refused path reach the model. `execute`'s second argument is `ToolExecutionOptions` and requires `context` in ai 7.x — a test that calls `execute` directly must pass it |
| `node:crypto` | `randomUUID()` for `requestId` | Injectable (`newRequestId`) so a test can assert on `request-1` |

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
- **`resolveInWorkdir` returns the path as the caller spelled it**, not its
  realpath, so a symlink that stays inside the folder is reported as `lib/x.ts`
  rather than `src/x.ts`. The diff header should name the path the model used.
