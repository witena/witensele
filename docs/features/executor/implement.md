# executor — Implementation

## Approach

Three modules under `src/main/executor/`, none of which knows what a chat runner
is, plus one rule in `agent-turn.ts` that decides whether any of them applies —
and, since S5.5, one store and four renderer modules that make the whole thing
answerable.

| Module | Owns |
|---|---|
| `paths.ts` | `resolveInWorkdir(workdir, path)` → `{ absolute, relative }`, and nothing else. Every path an executor tool touches goes through it |
| `tools.ts` | The seven AI SDK tools, the constants that cap them, and `buildExecutorSection` (the prompt) |
| `permissions.ts` | `PermissionGate`: `ask` / `reply` / `pending` / `abortAll`, one promise per waiting prompt |

| Renderer module (S5.5) | Owns |
|---|---|
| `stores/permissions.ts` | The open prompts, keyed by `requestId`, and the one call that answers them |
| `components/chat/permission-card.tsx` | The card: what it says, the three buttons, Enter and Escape |
| `components/chat/permission-input.ts` | What a call looks like on that card — verbatim for a command |
| `components/chat/diff-block.tsx` + `transcript-rows.ts` | The `DiffPart` block and the pure transforms behind it |
| `components/chat/file-ref-chip.tsx` | The `path:line` chip, which copies until S5.7 |

The gate lives on `AppContext` (`ctx.permissions`) for the same reason the runner
registry and the MCP pool do: a pending prompt outlives the IPC call that raised
it — the tool call is suspended inside a turn while the card is on screen — and
`permission.reply` has to reach the very gate holding that promise.

`collectAgentTools` is the only place that knows all three: it asks
`executorWorkdir(chat, agent, members)` whether this agent is the chat's
executor and the chat has a folder, and if so it merges
`buildExecutorTools({...})` into the `ToolSet`. The same function wraps the MCP
`call` closure so a `sideEffects` server's tools ask first.

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

`run_command` follows the same shape and then spawns; the child is killed on
both the `toolTimeoutMs` budget and the turn's signal.

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
`EXECUTOR_TOOLS`, `GATED_EXECUTOR_TOOLS` (`tools.ts`); `ResolvedPath`
(`paths.ts`); `executorWorkdir` (`agents/agent-turn.ts`).

## Tests

| File | Covers |
|---|---|
| `src/main/executor/paths.test.ts` | `..`, an absolute path outside, a symlink to a file and to a directory, a **new** file through a symlinked directory, an absolute path inside, a missing workdir, `isInside` on a sibling with a shared prefix |
| `src/main/executor/permissions.test.ts` | allow, deny, `allowAlways` and that it does not leak to another tool or chat, abort by signal, an already-aborted signal drawing no card, an unknown `requestId`, a second reply, one resolution per request, `abortAll` |
| `src/main/executor/tools.test.ts` | Each of the seven against a temp directory and a real `/bin/sh`: the tool set, reads and refusals, the diffs `write_file` / `edit_file` return, the ambiguous-match refusal, a denied call writing nothing, the timeout kill, the abort kill, the output cap, `git_diff` in and out of a repository, the briefing |
| `src/main/handlers/permissions.test.ts` | `permission.reply` releasing a waiting call, `not_found`, a blank id, an unknown decision leaving the call still waiting |
| `src/main/agents/agent-turn.test.ts` | A `MockLanguageModelV4` calling `write_file`: the seven tools offered and the folder in the prompt, allow → file on disk plus a `tool-result` carrying the patch, deny → `tool-error` and nothing written, `allowAlways` not asking twice, a participant and a folderless chat getting no tools, the two-executor tie broken by position, a read-only tool and a refused path never asking |
| `src/shared/contracts.test.ts` | `permission.reply` in `BACKEND_METHODS`, the `permission` namespace, and the shapes of both events |
| `src/main/agents/agent-turn.test.ts` (S5.5 block) | `diffPartsFrom` over the part shapes a turn really stores — one block per file, several writes to one file concatenated at its first position, a patch without a trailing newline separated, and a denial, an unchanged edit, a `git_diff` and a malformed output all producing nothing — plus three whole turns: two files giving two blocks and two `part` deltas, a write followed by an edit of the same file giving one, and a denied write giving none |
| `src/renderer/src/stores/permissions.test.ts` | Request, order, reply, resolve on all four decisions, a stop clearing every prompt, a `not_found` dropping the stale card, a double answer, and a deleted chat |
| `src/renderer/src/components/chat/permission-input.test.ts` | The verbatim command, the capped write preview, the empty file, the edit's patch, and both fallbacks to raw JSON |
| `src/renderer/src/components/chat/tool-call.test.ts` (S5.5 block) | `write_file(path)`, `run_command(command)` flattened and capped, `search_files(query)`, an MCP tool of the same name keeping the generic preview, and a missing argument falling back |
| `src/renderer/src/components/chat/transcript-rows.test.ts` | `collectDiffs` / `collectFileRefs` over a mixed part list, `countDiffLines`, `formatFileRef` |
| `e2e/executor.spec.ts` | Offline: a chat with no executor shows no card. Behind the `qwen2.5:3b` guard: the card appears, nothing is on disk while it waits, Allow writes the file, the card goes away and the diff block appears and opens onto a `diff` code block |

`npm test`: 77 files, 1121 tests. `npm run typecheck` clean.

## Known limitations and TODOs

- **A prompt is invisible from another chat.** The card is per chat, and nothing
  tells a user looking elsewhere that an executor is waiting on them.
- **`allowAlways` is still neither visible nor revocable.** The card offers it;
  nothing lists what has been granted or takes it back short of quitting.
- **A `write_file` card previews content, not a diff**, because the tool computes
  the patch only after the grant. `edit_file` shows its patch.
- **Nothing emits a `FileRefPart` yet.** The chip renders one and copies it;
  producing them from agent text, and opening them, is S5.7.
- **The shell is not sandboxed** (see `context.md`, "Open questions"): `cwd` is
  confined, the command is not.
- `search_files` is a substring scan with a hard-coded prune list, not a
  ripgrep. Once `run_command` exists, `rg` is available to the executor anyway.
- `run_command` assumes `/bin/sh`, which is correct for the macOS-only build and
  would need a branch on Windows.
