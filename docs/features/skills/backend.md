# skills — Backend

## Modules

| File | Responsibility |
|---|---|
| `src/main/skills/loader.ts` | The whole filesystem half: scan, cache, find, list files, read a file, read a skill, import, delete, seed. Handed a directory; imports no electron |
| `src/main/skills/tools.ts` | `buildSkillsSection` (the prompt lines) and `buildSkillTools` (`read_skill`, `read_skill_file` as AI SDK tools) |
| `src/main/handlers/skills.ts` | The four `skills.*` handlers: validation, plus `skillsDir(ctx)` |
| `src/main/ipc/dialogs.ts` | `system.pickFolder` — the one handler that imports electron, layered over the stub by `registerIpc` |
| `src/main/app-context.ts` | `userDataDir` on the context, plus `skillsDir(ctx)` / `memoryDir(ctx)` |
| `src/main/agents/agent-turn.ts` | `enabledSkills`, and the prompt and `ToolSet` assembly that use it |
| `resources/skills/architecture-review/` | The skill shipped with the build and seeded on first launch |

## Database

None. Skills live on the filesystem; the only database column involved is
`agents.skill_names` (a JSON array of names), which [`agents`](../agents/backend.md)
owns and which no migration in this step touched.

## IPC handlers

| Channel | Input | Output | Errors |
|---|---|---|---|
| `skills.list` | — | `{ skills, warnings }` | Never fails; a missing directory is an empty library |
| `skills.import` | `{ sourcePath, overwrite? }` | `SkillMeta` | `validation` for an empty / non-string path, a non-boolean `overwrite`, a file rather than a folder, a folder with no `SKILL.md`, a `SKILL.md` with no description, or a name already taken without `overwrite`. `not_found` when the folder does not exist |
| `skills.read` | `{ name }` | `SkillDetail` | `validation` for an empty name; `not_found` for an unknown one |
| `skills.delete` | `{ name }` | `void` | `not_found` for an unknown name |
| `system.pickFolder` | — | `string \| null` | `internal` outside the Electron transport (see below). Cancelling resolves `null`, which is not an error |

Nothing here emits an event. See [`implement.md`](./implement.md), "Importing a
skill".

**Deleting a skill does not unbind it** from the agents that listed it, unlike
`mcp.delete`. A skill is referenced by name, and that name is what the user would
re-import it under; dropping the binding would silently unconfigure every agent
the moment a folder is moved. The agent editor shows the name with a "missing"
tag instead, and the turn skips it.

## Events emitted

None.

## Filesystem

```
<userData>/skills/
  <folder>/
    SKILL.md          required; YAML frontmatter + markdown body
    <anything else>   bundled resources, readable with read_skill_file
```

Frontmatter: `description` (**required**), `name` (defaults to the folder name),
`version` (string), `tags` (a list, or one comma-separated string).

Ownership: the user's. The app writes here only on import and on first-launch
seeding, and deletes only a folder the user asked it to delete. Nothing here is
cleaned up automatically.

### Path confinement

`resolveInside(root, relPath)` is the single gate. It rejects an absolute path,
resolves the rest against `realpathSync(root)` and refuses anything that does not
stay under it, then — for a path that exists — `realpathSync`es the target too,
which is what catches a symlink pointing out of the folder. The listing walk
skips symlinks entirely and skips hidden entries.

This is a real input boundary, not a formality: `read_skill_file`'s `path` and
`read_skill`'s `name` are written by a language model. A refused path comes back
as a tool **error**, so the model is told it was refused instead of being handed
a file.

Two other caps apply to anything that would reach a context window:
`MAX_SKILL_FILE_BYTES` (200 KB) and a NUL-byte sniff that refuses binary files.

### The cache

`scanSkillsWithWarnings` memoizes per resolved directory, because the prompt
needs every enabled skill's description on **every turn** and an uncached scan
would put a directory walk in front of every model call. It is invalidated by
`importSkill`, `deleteSkill` and `seedSkills`; a file edited outside the app is
therefore not noticed until one of those, or until a restart.

### First-launch seeding

`seedSkills(sourceDir, skillsDir)` copies `resources/skills/*` into the library
when the library holds nothing. `src/main/index.ts` resolves `sourceDir`:
`app.getAppPath()/resources/skills` unpackaged, and
`process.resourcesPath/resources/skills` when packaged — S4.4's
`extraResources: resources -> resources` keeps the folder's own name, so the
packaged tree mirrors the repository and the path below it is the same string in
both builds (see [`../packaging/backend.md`](../packaging/backend.md), "The
resources path"). `e2e/skills-memory.spec.ts` depends on the unpackaged half: it
asserts the shipped skill is present on a fresh temporary `userData`.
`e2e/packaged.spec.ts` asserts the packaged half against the real bundle, which
is the only way that path can be checked.

## The electron exception

`system.pickFolder` is the only `BackendApi` method whose implementation needs
electron. It is confined rather than waived:

- `handlers/system.ts` declares it and rejects with `PICK_FOLDER_UNAVAILABLE`, so
  the Electron-free handler map stays total and a unit test gets a clear answer.
- `ipc/dialogs.ts` — in the directory that is already allowed to import electron
  (CLAUDE.md rule #5) — implements it with `dialog.showOpenDialog`.
- `registerIpc` spreads `dialogHandlers` over the map it was given, so only the
  Electron transport has the real one.

A future server build layers nothing and the rejection is the truth.

## External dependencies

| Dependency | Used for | Pitfalls |
|---|---|---|
| `gray-matter` | Parsing `SKILL.md` frontmatter | It is CommonJS with its own `.d.ts`; the default import works under `esModuleInterop`. It **throws** on malformed YAML, so every call is wrapped — one broken folder must not stop the library from loading. `matter(raw).content` keeps the body's leading newline, hence the `trim()` in `readSkill` |
| `ai` (`tool`, `jsonSchema`) | The two built-in tools | Declared with raw JSON Schema rather than zod, matching `mcp/tools.ts`: one schema dialect in the tool layer is one thing to check when a provider starts refusing a call. `execute` throwing is what makes the SDK emit a `tool-error` part, which is how a refused path reaches the model as a failure |
| `node:fs` `cpSync` | Importing a folder | `{ recursive: true, dereference: true }`: the library must hold real files, not pointers into a directory the user may move tomorrow |
