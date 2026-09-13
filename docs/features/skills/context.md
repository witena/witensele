# skills — Context

## Problem

An agent's system prompt is the only place to put "how we do this here", and it
is a scarce, shared resource: every sentence added to it is paid for on every
turn of every chat, by every model in the room. Long procedures — how to review
an architecture, how to write a release note, which checklist to walk — do not
fit there, and pasting one into a chat by hand is not something a user will do
twice.

Skills are the answer this project takes from the open **Agent Skills** format: a
folder with a `SKILL.md` in it. The prompt carries only each skill's *name and
description*; the agent reads the full instructions with a tool when it decides
one applies. Twelve skills therefore cost twelve lines, and the one that gets
used costs its real size only in the turn that used it.

## Scope

- `skills/loader.ts`: scanning `userData/skills/*/SKILL.md`, parsing frontmatter
  with `gray-matter`, listing and reading the files a skill bundles, importing a
  folder and deleting one — all path-confined, all cached.
- `skills/tools.ts`: the `Skills` section of the system prompt, and the two
  built-in tools `read_skill` and `read_skill_file`.
- The `skills.*` handlers, and `system.pickFolder` for the import dialog.
- Settings → Skills: the card list, the detail pane (body rendered as markdown,
  bundled file list), import and delete.
- The agent form's Skills checklist, bound to `agents.skillNames`, including the
  "missing" state.
- One sample skill shipped in `resources/skills/`, seeded into an empty library
  on first launch.

## Out of scope

| Not here | Who owns it |
|---|---|
| Editing a skill inside the app | Nothing does. A skill is a folder the user authors with their own tools; the app reads it |
| Executable skills (a skill that ships a script the agent runs) | Not in the MVP. Every capability that *does* something comes from an MCP server ([`mcp`](../mcp/context.md)), which is where a permission model already has to live |
| A skill marketplace or registry | Post-MVP. Import is a folder picker |
| Per-skill enablement inside a chat | Not in the MVP: skills are bound per agent, in the agent form |
| Versioning, updates, dependency resolution between skills | Out of scope. `version` is a string shown on the card |
| The tool loop itself (`stopWhen`, the tool message parts) | [`agent-turn`](../agent-turn/context.md), from S3.1 |
| `memory_save` / `memory_search` | [`memory`](../memory/context.md), S3.3 — different tools, same `ToolSet` |

## Dependencies

| Needs | From |
|---|---|
| `AppContext.userDataDir` (added in S3.2) and `skillsDir(ctx)` | [`backend-client`](../backend-client/context.md) |
| `agents.skillNames`, the agent form | [`agents`](../agents/context.md) |
| The turn that attaches the tools and assembles the prompt | [`agent-turn`](../agent-turn/context.md) |
| `Markdown`, to render a skill body | [`chats`](../chats/frontend.md) |
| `system.pickFolder`, the one electron-backed method | [`backend-client`](../backend-client/context.md) |

`agent-turn` depends on this feature in return: it calls `scanSkills` for the
prompt and `buildSkillTools` for the `ToolSet`.

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| The open **Agent Skills** folder format (`SKILL.md` + frontmatter) | A Witena-specific JSON manifest; skills as database rows | A skill written for another agent runtime works here unchanged, and the user can read, diff and version it with the tools they already have. A row in SQLite is none of those things |
| **Progressive disclosure**: only `name` and `description` in the prompt | Inline the whole body when a skill is enabled | The body is the expensive part and is usually irrelevant to a given turn. This is the entire reason the format exists |
| A skill with **no `description` is skipped**, and reported | Fall back to the folder name; inline the first paragraph | The description is the only thing the model sees; a skill without one can never be chosen. Reporting the folder is what lets the user fix it |
| `name` **falls back to the folder name** | Require it | A two-line SKILL.md should work. The folder name is what the user sees on disk anyway |
| Agents bind skills **by name**, not by a generated id | Give each skill an id in a sidecar file | There is no database row to hold an id, and a name is what both the user and the model say. The cost is that a renamed folder breaks a binding — which the editor shows as "missing" rather than silently dropping, so re-importing the folder restores it |
| `read_skill` and `read_skill_file` are attached **regardless of the side-effects rule** | Treat them like any other tool | The rule (PLAN, "Future extension") exists to stop several models writing over the user's work. These two are read-only and confined to `userData/skills/`, a directory the user filled *so that* agents would read it |
| Every path goes through `resolveInside` | Trust the model's argument; sanitize with a regex | The skill name and the file path both come from a language model. `..`, an absolute path and a symlink out of the folder are three different escapes and are closed together, by resolving and comparing against the folder's real path |
| Binary files and files over 200 KB are **refused** | Return base64; truncate | A tool result goes into the context window. A megabyte of PNG there is a wasted turn, and a truncated binary is worse than an error |
| The scan is **cached per directory**, invalidated on import and delete | Re-read on every turn; watch the filesystem | The prompt needs every enabled skill's description on every turn, so an uncached scan is a directory walk before every model call. A watcher is a lot of machinery for a folder the user edits by hand a few times a year |
| The library is a **reader** in the UI, not an editor | A built-in markdown editor | The content lives on disk and is versioned by whatever wrote it. Showing exactly what the agent will be given is the useful half; a second editor for the same file is how the two get out of sync |
| One sample skill is **shipped and seeded** into an empty library | Ship none; create one on demand | A capability nobody can see is a capability nobody uses. Seeding only into an *empty* library means a user who deleted it keeps their decision |

## Open questions

- **No filesystem watcher.** A SKILL.md edited outside the app is picked up on
  the next import, delete or app start. Settings → Skills is where a user would
  notice, and it is one restart away.
- **No per-skill file allowlist.** `read_skill_file` can read any text file in
  the folder. That is the format's own model, but a skill folder that happens to
  contain a `.env` would expose it to the agent that has the skill enabled.
- **`MAX_SKILL_FILES = 200` is a listing cap only.** A skill with more files
  still works; the agent is simply not told about the rest.
