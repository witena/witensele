# memory — Context

## Problem

Every chat starts from nothing. An agent that was told the project's name, the
stack it uses and the constraint the group agreed on last week has to be told all
of it again in the next chat, by a user who has already said it once. That is the
single most obvious way a multi-agent group chat wastes the user's time.

Memory gives each agent a small markdown directory it owns: an index that goes
into every system prompt, and one note per thing it decided was worth keeping. It
writes with `memory_save`, searches with `memory_search`, and the user can read,
edit or delete any of it by hand.

## Scope

- `memory/store.ts`: `<memoryDir>/<agentId>/MEMORY.md` plus `notes/*.md` — read
  the index, parse its entries, save a note, search, read and write a file,
  delete a note. Path-confined per agent.
- `memory/tools.ts`: the `Memory` section of the system prompt (the index, capped
  at 8 KB) and the two built-in tools.
- One sentence in the **group briefing**, in both languages, telling the agent to
  save durable facts — added only when the tools are actually attached.
- The five `memory.*` handlers.
- The agent form's "Memory across chats" panel: the toggle, the entry list, an
  editable index and note, and per-note delete.

## Out of scope

| Not here | Who owns it |
|---|---|
| Deciding *what* is worth remembering | The model. The briefing says "durable facts about the user or the project"; nothing enforces it |
| Semantic search / embeddings | Not in the MVP. Search is a case-insensitive substring scan over an index and a handful of notes, which is the right tool at this size |
| Memory shared between agents, or per chat | Deliberately not. Memory is per agent, so one agent's conclusions never silently become another's |
| Automatic summarization or compaction of the index | Post-MVP. The prompt cap truncates; the user prunes |
| Context truncation of the transcript | S4.2 |
| The tool loop itself | [`agent-turn`](../agent-turn/context.md) |
| `read_skill` / `read_skill_file` | [`skills`](../skills/context.md), S3.2 — different tools, same `ToolSet` |

## Dependencies

| Needs | From |
|---|---|
| `AppContext.userDataDir`, `memoryDir(ctx)`, `ctx.memory` | [`backend-client`](../backend-client/context.md) |
| `agents.memoryEnabled` and the agent form | [`agents`](../agents/context.md) |
| The turn that attaches the tools and assembles the prompt | [`agent-turn`](../agent-turn/context.md) |
| `resolveInside`, the path guard | [`skills`](../skills/backend.md) — shared rather than written twice |

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| **Markdown files, not database rows** | A `memories` table | The user can open, edit, diff, back up and delete them with the tools they already have. A memory the user cannot inspect is one they cannot trust — and the first thing anyone asks about a remembering agent is "what does it think it knows?" |
| **An index plus notes**, Claude Code style | One long file; one file per fact with no index | The index is small enough to carry in every prompt and tells the agent what it knows; the notes hold what it knows, and are read only when they matter. One long file makes every turn pay for everything |
| Memory is **per agent**, never per chat | Per chat; shared across the group | A chat is a conversation, not an identity. The point is that a fact learned in chat A is known in chat B — and one agent's conclusions must not silently become another's |
| The prompt carries the index, capped at **8 KB**, cut on a line boundary | No cap; summarize instead | It is the one part of the prompt that grows without bound. 8 KB is a few hundred entries and never the reason a context window overflows. A cut mid-entry would name a note at a path the model cannot read, hence the line boundary and the explicit marker |
| `memory_save` and `memory_search` **bypass the side-effects rule** | Treat `memory_save` as a write and reserve it for executors | The rule protects the *user's* work from several models writing over each other. The only thing these can write is `userData/memory/<agentId>/`, created by this app for this agent. An agent's own notebook is not the user's work — and without the write there is no feature |
| A save emits **no event** | A `memory.saved` event and a live-updating panel | Nothing on screen depends on it: the transcript already shows the tool card, and the only view of the notes is the agent editor's panel, which loads when it opens. A store plus a subscription for a list nobody is looking at is machinery for its own sake |
| The index is **appended to, never rewritten** | Regenerate it from the notes on every save | The user is allowed to write prose around the list, reorder it and prune it. A save that reformatted the document would throw that away — and regenerating would resurrect entries the user deleted on purpose |
| A note file name is `<slug>-<shortid>.md` | The slug alone; a timestamp; a UUID | The slug makes the folder readable; the short id makes two notes with the same title two files. Parallel speakers can save in the same millisecond, so a timestamp is not unique either |
| The briefing's memory sentence is **conditional** | Always say it | A prompt that asks for a tool the model has not been given is how a model starts describing tool calls in prose |
| Deleting `MEMORY.md` **empties the index but keeps the notes** | Delete every note too | It is the destructive-looking action in the panel, and the files are the user's. An index the user emptied is recoverable by hand; deleted notes are not |
| Search ranks a **title** match above a body match | No ranking; recency only | "What is the project called" should find the note called "Project name" before one that mentions the project in passing |

## Open questions

- **Nothing ever prunes.** An agent that saves on every turn grows an index until
  the 8 KB cap starts hiding entries. A compaction pass ("merge duplicates, drop
  stale facts") is the obvious next step.
- **No deduplication.** The same fact saved twice is two notes and two index
  lines; only the model's own judgement prevents it.
- **Substring search has no stemming and no synonyms.** "database" does not find
  "DB". At a few hundred short notes this is still better than an embedding index
  the user cannot inspect, but it will not stay that way.
- **The index is not validated on write.** The editor will happily save a
  malformed list; the parser then lists fewer entries than the file appears to
  have.
