# skills — Implementation

## Approach

Three layers, each usable without the one above it:

```
skills/loader.ts    pure-ish   a directory → SkillMeta[]; read, import, delete, seed
skills/tools.ts     pure       SkillMeta[] → the prompt section and two AI SDK tools
handlers/skills.ts  transport  validation, and which directory (skillsDir(ctx))
```

The loader is handed a **path**, never a context, so every case in its suite runs
against a temporary folder. The directory comes from `AppContext.userDataDir`,
which S3.2 added and which `src/main/index.ts` fills from `app.getPath('userData')`
— the same injection rule the database path already followed (CLAUDE.md rule #5).

`agent-turn.ts` is the only backend consumer: `enabledSkills(ctx, agent)`
resolves the agent's `skillNames` against the scan, `buildSkillsSection` turns
them into prompt lines, and `buildSkillTools` turns them into a `ToolSet`.

## Data flow

### Importing a skill

```
Settings → Skills → Import folder
  renderer  useSkillsStore.importFolder()
  renderer  backend.invoke('system.pickFolder')        → an absolute path, or null
  main      ipc/dialogs.ts → electron dialog.showOpenDialog({ openDirectory })
  renderer  backend.invoke('skills.import', { sourcePath })
  main      handlers/skills validates the input
  main      importSkill(): source is a folder? has SKILL.md? declares a description?
  main      cpSync(source, <skillsDir>/<folder>, { recursive, dereference })
  main      invalidateSkillCache(skillsDir)
  renderer  load() + select(name) → the new skill is listed and opened
```

No event is emitted. The library is edited on one screen by one user, so the
store applies its own writes — the same rule `stores/mcp.ts` and `stores/agents.ts`
follow.

### One turn with skills

```
main  runAgentTurn
      ├ buildSystemPrompt
      │   agent.systemPrompt
      │   + group briefing            (briefing.ts)
      │   + buildSkillsSection(enabledSkills(ctx, agent))     ← names + descriptions only
      │   + memory section            (S3.3, when enabled)
      │
      ├ collectAgentTools
      │   … MCP tools …
      │   + buildSkillTools(skillsDir(ctx), enabledSkills(…)) ← read_skill, read_skill_file
      │
      └ streamText({ tools, stopWhen: stepCountIs(MAX_TOOL_STEPS) })
            tool-call  read_skill { name }
              → readSkill(dir, name)  → "# <name>\n\n<body>" + the bundled file list
            tool-call  read_skill_file { name, path }
              → resolveInside(skill.path, path) → text, or an error the model can act on
```

Both tool calls become ordinary `tool-call` / `tool-result` message parts with no
`serverId`, so the transcript draws the same card it draws for an MCP tool, with
the bare tool name and no server prefix.

### First launch

`src/main/index.ts` calls `seedSkills(bundledSkillsDir(), skillsDir(ctx))` once,
right after the context is built. It copies `resources/skills/*` into the library
**only when the library is empty**, so a user who deleted the sample does not get
it back. A packaged build finds the same folder under `process.resourcesPath`.

## Key types

| Type | Where | Purpose |
|---|---|---|
| `SkillMeta` | `shared/types.ts` | `{ name, description, path, folder, version?, tags?, fileCount }` — the card and the prompt line |
| `SkillDetail` | `shared/types.ts` | `{ meta, body, files }` — what the detail pane and `read_skill` show |
| `SkillWarning` | `shared/types.ts` | `{ folder, reason }` for a folder that could not be used |
| `ScanResult` | `main/skills/loader.ts` | `{ skills, warnings }`, the cached unit |

## IPC contract

| Method | Input | Output |
|---|---|---|
| `skills.list` | — | `{ skills: SkillMeta[]; warnings: SkillWarning[] }` |
| `skills.import` | `{ sourcePath, overwrite? }` | `SkillMeta` |
| `skills.read` | `{ name }` | `SkillDetail` |
| `skills.delete` | `{ name }` | `void` |
| `system.pickFolder` | — | `string \| null` |

`skills.read`, `skills.delete` and `system.pickFolder` are **new in S3.2** and
were added to `BackendApi`, `BACKEND_METHODS` and `shared/contracts.test.ts`
together. `skills.list` changed shape: it answers with the warnings beside the
skills rather than with a bare array.

`system.pickFolder` is the one method whose real implementation imports electron;
see [`../backend-client/backend.md`](../backend-client/backend.md).

## Tests

| File | What it covers |
|---|---|
| `src/main/skills/loader.test.ts` | Against a real temporary directory: frontmatter parsing (name, description, version, tags in both spellings), the folder-name fallback, a skill skipped for a missing description and one for malformed YAML, hidden folders and folders without a SKILL.md ignored, the empty-directory answer, the cache and its invalidation, the file listing (hidden files, symlinks, the 200 cap), `readSkill` stripping the frontmatter, **traversal refused four ways** (`..`, a sibling skill, an absolute path, a symlink out), binary and oversized files refused, import (copy, overwrite refusal, overwrite, nothing written when refused), delete, and seeding (empty library, missing library, non-empty library left alone) |
| `src/main/handlers/skills.test.ts` | The directory coming from the injected `userDataDir`, input validation on every method, a warning reported through the wire, and **a deleted skill staying on the agents that named it** |
| `src/main/agents/agent-turn.test.ts` | The loop end to end with a real `streamText`: the prompt carrying the description but **not** the body, both tools offered, `read_skill` returning the body, `read_skill_file` returning a bundled file, a traversal attempt coming back as an errored tool result with none of the secret in it, no tools and no section when the agent has no skills, and a skill whose folder is gone being skipped rather than failing the turn |
| `src/renderer/src/stores/skills.test.ts` | `missingSkillNames` (name, folder, case, whitespace), the detail pane closing when its skill disappears, and the import flow including **a cancelled dialog doing nothing at all** |
| `e2e/skills-memory.spec.ts` | The real thing: the shipped skill present on a fresh installation, its detail pane, the agent binding, and — with `qwen2.5:3b` on Ollama — an agent actually calling `read_skill` |

## Known limitations and TODOs

- No filesystem watcher; the cache is invalidated by the app's own writes only.
- `read_skill_file` can read any text file in a skill folder (no allowlist).
- A skill's tools are all-or-nothing per agent; there is no per-skill scoping
  inside a chat.
- `importSkill` copies with `dereference: true`, so a source folder full of
  symlinks lands as real files — deliberate, but it means importing a large
  linked tree copies it.
