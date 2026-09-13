# memory — Implementation

## Approach

```
memory/store.ts     stateful   createMemoryStore(dir) → the per-agent file operations
memory/tools.ts     pure       a store + an agent id → memory_save / memory_search
                               and buildMemorySection(index)
handlers/memory.ts  transport  validation, and "does this agent exist"
```

`createMemoryStore(memoryDir)` is built once in `createAppContext` and lives on
the context as `ctx.memory`, for the same reason the repositories do: it is the
one object that knows where an agent's notes are. The directory comes from
`AppContext.userDataDir` (added in S3.2), so the whole feature runs against a
temporary folder in vitest and imports no electron (CLAUDE.md rule #5).

## Data flow

### The agent remembers something

```
main  runAgentTurn  (agent.memoryEnabled)
      ├ buildSystemPrompt
      │   … briefing (+ the memory sentence, both languages) …
      │   + buildMemorySection(ctx.memory.readIndex(agent.id))   ← MEMORY.md, capped at 8 KB
      │
      ├ collectAgentTools
      │   … MCP tools, skill tools …
      │   + buildMemoryTools(ctx.memory, agent.id)
      │
      └ streamText → tool-call memory_save { title, content }
            store.saveNote(agentId, { title, content })
              ├ notes/<slug>-<shortid>.md   ← frontmatter { title, createdAt } + the body
              └ MEMORY.md                   ← one appended line
            → "Saved \"<title>\" to notes/….md."
```

No event. The next turn's prompt carries the new line because the index is read
fresh each time; the agent editor's panel reads the files when it opens.

### The user reads or edits it

```
Agents → an agent → Memory across chats
  renderer  useMemoryStore.load(agentId)   → memory.list   → MemoryEntry[]
  renderer  click a row (or MEMORY.md)     → memory.read   → { path, content }
  renderer  edit the textarea              (no round trip; `draft` vs `saved`)
  renderer  Save                           → memory.write  → then memory.list again
  renderer  the trash icon                 → memory.delete → then memory.list again
```

`memory.write` re-reads the list afterwards because a note's title lives inside
the file that was just rewritten — patching the row in place would show a title
the file no longer has.

## The index format

```md
# Memory

- [Project name](notes/project-name-1a2b3c4d.md) — The project is called Witena.
```

`- [Title](notes/file.md) — hook`. The hook is the first non-empty, non-heading
line of the note, trimmed to 100 characters. Anything in the file that is not an
index line — a heading, the user's own prose — is left untouched by every write,
and a line whose link leaves `notes/` is ignored when parsing.

A note is:

```md
---
title: Project name
createdAt: 1757000000000
---

The project is called Witena.
```

## Key types

| Type | Where | Purpose |
|---|---|---|
| `MemoryEntry` | `shared/types.ts` | `{ id, title, path, createdAt }` — one index line, `id` being the path |
| `MemorySearchHit` | `shared/types.ts` | `{ path, title, snippet }` — **new in S3.3** |
| `MemoryStore` | `main/memory/store.ts` | The eight operations, bound to one directory |
| `MemoryNoteInput` | `main/memory/store.ts` | `{ title, content }` |

Constants other modules and tests rely on: `MEMORY_INDEX` (`'MEMORY.md'`),
`NOTES_DIR` (`'notes'`), `MEMORY_HEADING` (`'# Memory'`), `MAX_SEARCH_HITS` (10),
`MEMORY_PROMPT_MAX_BYTES` (8192), `MEMORY_TRUNCATED`.

## IPC contract

| Method | Input | Output |
|---|---|---|
| `memory.list` | `{ agentId }` | `MemoryEntry[]` |
| `memory.read` | `{ agentId, path }` | `{ path, content }` |
| `memory.write` | `{ agentId, path, content }` | `MemoryEntry` |
| `memory.delete` | `{ agentId, path }` | `void` |
| `memory.search` | `{ agentId, query }` | `MemorySearchHit[]` |

The first three were declared in S1.1 and rejected with `internal` until now;
`memory.delete` and `memory.search` are **new in S3.3** and were added to
`BackendApi`, `BACKEND_METHODS` and `shared/contracts.test.ts` together.
`memory.search` exists so the panel can grow a search box without a new method,
and because it is the same question the model asks.

## Tests

| File | What it covers |
|---|---|
| `src/main/memory/store.test.ts` | Against a real temporary directory: `slugify` and `hookOf`; a save writing frontmatter and **appending exactly one index line**; two saves keeping their order and one heading; the user's prose surviving a save; two notes with the same title getting different files; two agents kept apart; empty title / content and a path-shaped agent id refused; the index parsed into entries and a link outside `notes/` ignored; search by body, **title ranked above body**, no match, empty query, the 10-hit cap and a snippet cut on both sides; read/write round-tripping a note and the index; the index readable before the first save; **traversal refused** (`../..`, another agent) with the outside file untouched; delete removing the file and its line; deleting the index emptying it; and `buildMemorySection` — whole index, the empty case, and the 8 KB cap cutting on a line boundary with the marker |
| `src/main/handlers/memory.test.ts` | An unknown agent refused with `not_found` **and no directory created for it**, validation on every input, the files landing under the injected `userDataDir`, the index readable before the first save, and a traversal refused through the wire |
| `src/main/agents/agent-turn.test.ts` | With a real `streamText`: `memory_save` writing the file **and** appending the index line, the index reaching the next turn's prompt and `memory_search` answering from it, the briefing's memory sentence appearing only while memory is on, no tools and no section when it is off, both built-in families offered together, and one agent's search not reaching another agent's notes |
| `src/renderer/src/stores/memory.test.ts` | `isDirty`; loading one agent and dropping the open file when the panel moves to another; the editor lifecycle (open, edit, save, clean again, the list re-read); opening the index; saving nothing with nothing open; delete closing the open file |
| `e2e/skills-memory.spec.ts` | With `qwen2.5:3b` on Ollama: the model calling `memory_save`, and the note still being there **after a restart**, read by a process that has just started |

## Known limitations and TODOs

- Nothing prunes or deduplicates; see the open questions in
  [`context.md`](./context.md).
- Search is a substring scan over every note body on every call. At a few hundred
  short notes that is microseconds; at ten thousand it is not.
- `memory.write` does not validate the index's syntax, so a hand-edited file can
  silently list fewer entries than it appears to.
- The panel has no search box yet, although `memory.search` is there for it.
