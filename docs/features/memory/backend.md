# memory — Backend

## Modules

| File | Responsibility |
|---|---|
| `src/main/memory/store.ts` | `createMemoryStore(dir)`: the index, the notes, search, the path guard. Handed a directory; imports no electron |
| `src/main/memory/tools.ts` | `buildMemorySection` (the prompt section and its 8 KB cap) and `buildMemoryTools` (`memory_save`, `memory_search`) |
| `src/main/handlers/memory.ts` | The five `memory.*` handlers: validation, and "does this agent exist" |
| `src/main/app-context.ts` | `ctx.memory`, built from `memoryDir(ctx)` |
| `src/main/agents/agent-turn.ts` | Attaches the tools and the section when `agent.memoryEnabled` |
| `src/main/agents/briefing.{en,zh-CN}.ts` | One conditional sentence asking the agent to save durable facts |

## Database

None. Memory lives on the filesystem; the only database column involved is
`agents.memory_enabled`, which [`agents`](../agents/backend.md) owns and which no
migration in this step touched.

## IPC handlers

| Channel | Input | Output | Errors |
|---|---|---|---|
| `memory.list` | `{ agentId }` | `MemoryEntry[]` | `validation` for an empty id; `not_found` for an unknown agent |
| `memory.read` | `{ agentId, path }` | `{ path, content }` | As above, plus `validation` for a path that leaves the folder and `not_found` for a missing note. `MEMORY.md` answers `''` rather than failing |
| `memory.write` | `{ agentId, path, content }` | `MemoryEntry` | As above, plus `validation` when `content` is not a string |
| `memory.delete` | `{ agentId, path }` | `void` | As above; `MEMORY.md` empties the index instead of deleting it |
| `memory.search` | `{ agentId, query }` | `MemorySearchHit[]` | As above, plus `validation` when `query` is not a string. An empty query is `[]`, not an error |

Every handler calls `ctx.repos.agents.get` first. That is the one rule the store
cannot enforce: without it, a typo'd id would quietly create a directory for an
agent that does not exist.

## Events emitted

None — deliberately. See [`context.md`](./context.md), "A save emits no event".

## Filesystem

```
<userData>/memory/
  <agentId>/
    MEMORY.md          the index, injected into every system prompt
    notes/
      <slug>-<id>.md   one note, with { title, createdAt } frontmatter
```

Created lazily: an agent that has never remembered anything has no directory, and
`memory.list` answers `[]` rather than creating one. Nothing removes an agent's
folder when the agent is deleted — the files are the user's, and a deleted agent
is exactly the case where a stray note is worth keeping rather than destroying.

### Path confinement

`resolveInside` is shared with the skills loader rather than written twice: it
rejects absolute paths and `..`, and `realpathSync`es both the root and an
existing target so a symlink cannot leave the folder. On top of it, `agentDir`
refuses an id containing a separator or `..`, because the id is itself a path
segment a caller controls.

The result is that neither the model (through `memory_save`) nor the editor
(through `memory.write`) can touch another agent's notes, the database beside
them, or anything else on disk.

### The prompt cap

`buildMemorySection` carries the whole index up to `MEMORY_PROMPT_MAX_BYTES`
(8 KB), cutting on a **line** boundary and appending `MEMORY_TRUNCATED`. The
index is the one part of the system prompt that grows with use, so it is the one
part that needs a ceiling; a cut mid-entry would name a note at a path the model
cannot read, which is why the boundary matters.

## Why the tools bypass the side-effects rule

`collectAgentTools` withholds a `sideEffects` MCP server from every agent that is
not an `executor` (PLAN.md, "Future extension"). `memory_save` writes and is
still attached to participants:

- The only path it can write is `userData/memory/<agentId>/notes/`, created by
  this app, for this agent, and enforced by `resolveInside`.
- It cannot reach the user's files, another agent's notes, the network, a shell
  or the database.
- The rule exists so that several models cannot overwrite each other's work in a
  shared working directory. An agent's own notebook is neither shared nor the
  user's work.

Without the write there is no feature, so the exception is stated here and in the
module header rather than being left implicit.

## External dependencies

| Dependency | Used for | Pitfalls |
|---|---|---|
| `gray-matter` | Note frontmatter, both directions | `matter.stringify(content, data)` writes the YAML block; `matter(raw).data` reads it back. It throws on malformed YAML, so the reads are wrapped — a note a user hand-edited badly must not break the list. `createdAt` is written as a number and read back as one; a note whose frontmatter is missing falls back to the file's mtime |
| `ai` (`tool`, `jsonSchema`) | The two built-in tools | Raw JSON Schema, matching `mcp/tools.ts` and `skills/tools.ts`. `execute` returning a **string** is what the transcript renders in the tool card |
| `node:crypto` `randomUUID` | The short id in a note's file name | Sliced to 8 hex characters: enough for a folder that holds hundreds of files, and `existsSync` is checked anyway because parallel speakers can save in the same millisecond |
