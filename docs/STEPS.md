# Witena Step-by-Step Execution List

`PLAN.md` is the target end state. This file breaks it into small steps that are executed and verified one at a time. Rules for every step:

- A step is done only when every item under "Acceptance" is met, the feature's four docs are updated, `npm test` passes, and the work is committed.
- Status markers: `[ ]` not started, `[~]` in progress, `[x]` done (with completion date).
- Steps are executed strictly in order. If a step reveals that the plan must change, update `PLAN.md` first, then continue.
- Everything committed is in English (see the language rule in `PLAN.md`).

---

## Phase 0: Preparation

### S0.1 Project skeleton `[x]` (2026-09-13)
What: package.json, tsconfig, electron-vite config, Tailwind, vitest; an empty window.
Acceptance:
- `npm install` succeeds, better-sqlite3 is rebuilt against Electron
- `npm run dev` opens a window whose title bar and page show Witena
- `npm run typecheck` passes
- `npm test` runs one smoke test

### S0.2 Documentation skeleton and project conventions `[x]` (2026-09-13)
What: `docs/README.md` index, `docs/features/` directory with the four-document template, root `CLAUDE.md` stating the conventions (four docs per feature, test gate, no hard-coded UI strings, English-only repository, `CLAUDE.local.md` as the gitignored Chinese copy).
Acceptance: files exist; CLAUDE.md is picked up by later sessions.

### S0.3 First commit and push `[x]` (2026-09-13, PR #1)
Acceptance: `git log` has commits; the GitHub repository's main branch shows the code.

---

## Phase 1: Skeleton (PLAN milestone 1)

### S1.1 Shared contracts `[x]` (2026-09-13)
What: `src/shared/types.ts` (domain types), `events.ts` (typed events), `backend.ts` (BackendClient interface).
Acceptance: typecheck passes; the four docs under `docs/features/backend-client/` are written.

### S1.2 Database `[x]` (2026-09-13)
What: drizzle schema (providers, agents, mcp_servers, chats, chat_members, messages, settings; all with userId / UUID / timestamps), migrations, opening `userData/witena.db`.
Acceptance:
- Unit tests run CRUD on every table against a temporary database file
- After `npm run dev`, witena.db appears under the userData directory

### S1.3 IPC and the Electron BackendClient implementation `[x]` (2026-09-13)
What: preload exposes `invoke` and `onEvent`; renderer `lib/backend.ts` implements BackendClient; main-process handler registry, event bus, secret store and application context; `settings.get` / `settings.update` as the first real handlers; a Playwright Electron harness in `e2e/`.
Acceptance:
- The renderer calls `system.ping` and receives pong; the main process emits a test event and the renderer receives it — both asserted end to end by `npm run e2e`
- `npm run typecheck`, `npm test`, `npm run build` and `npm run e2e` pass
- Nothing outside `src/main/index.ts` and `src/main/ipc/` imports electron

### S1.4 i18n `[x]` (2026-09-13)
What: i18next + react-i18next, `locales/zh-CN.json` and `en.json`, language persisted in the settings table, follows the system language on first launch.
Acceptance:
- Unit test: both locale files have identical key sets
- Switching the language in settings takes effect immediately and survives a restart

### S1.5 UI shell `[x]` (2026-09-13)
What: navigation rail, three page shells (Chats / Agents / Settings), three-column layout, dark theme with the mockup colours, plus the reusable primitives (`components/ui/`) and layout helpers (`components/layout/`) every later screen is built from. The S1.3 smoke widgets moved to Settings -> Developer.
Acceptance: a screenshot matches the mockup in layout and colours; docs under `docs/features/ui-shell/`.

### S1.6 Providers `[x]` (2026-09-13)
What: `shared/presets.ts`; settings page to add / edit / delete providers; SecretStore (safeStorage) encrypting keys; fetch `/models`; test connection; `providers/registry.ts` creating model instances.
Acceptance:
- Add Ollama (local) and one OpenAI-compatible preset, fetch their model lists, test connection reports success
- Keys are stored encrypted in the DB
- Unit tests: the preset table is complete; the registry constructs an instance for all four provider types
Done: 14 presets in `src/shared/presets.ts`; `src/main/providers/{registry,discovery,resolve}.ts`; the seven `providers.*` handlers; the Settings -> Providers list and editor; `stores/providers.ts`; `e2e/providers.spec.ts` drives the Ollama flow against the real local server (its two network assertions are annotated as skipped when Ollama is not running). Docs in `docs/features/providers/`.

### S1.7 Single-agent chat end to end `[x]` (2026-09-13)
What: chats CRUD and the left column list; minimal ChatRunner (one agent); AgentTurn streaming via streamText; messages persisted; composer and Stop button.
Acceptance:
- Create a chat, send a message, see a token-by-token streaming reply
- Stop interrupts the reply
- Messages survive an app restart
- Integration test: a mock model runs one full send → stream → persist cycle
Done: `src/main/agents/{briefing,briefing.en,briefing.zh-CN,history,agent-turn,default-agent}.ts`;
`src/main/orchestration/chat-runner.ts` with `ChatRunnerRegistry` on the AppContext;
the ten `chats.*` / `messages.list` / `chat.*` / `agents.list` handlers (`chats.members.list`
was added to `BackendApi`, which had a setter but no getter); the renderer's
`stores/{chats,messages,run,presence,agents}.ts` behind one `lib/event-bridge.ts`;
the chat page wired to the mockup (`components/chat/*`). `e2e/chat.spec.ts` drives a
real `qwen2.5:1.5b` through Ollama — create, stream, stop, restart — and skips the whole
file when localhost:11434 does not answer. Docs in `docs/features/{chats,agent-turn,orchestration}/`.
`orchestration` is deliberately partial: one agent, one round. S2.3 adds round scheduling,
@mentions, parallel speaking and the barrier.

---

## Phase 2: Multi-agent (PLAN milestone 2)

### S2.1 Agents CRUD and configuration page `[x]` (2026-09-13)
What: agents table CRUD; configuration page with basic info, provider and model dropdowns, parameters, system prompt; list page.
Acceptance: create 3 agents on different providers, they survive a restart; unit tests for CRUD.
Done: `agents.get/create/update/delete` in `src/main/handlers/agents.ts`, with the
name rules S2.3 will resolve `@mentions` against (non-empty, no `@`, unique
case-insensitively), an existing `providerId`, a non-empty `modelId` and bounded
`params`; deletion stops the runs of every chat the agent was in and emits one
`chat.updated` each. `stores/agents.ts` grew to full CRUD plus the editor draft
(`selectedId` / `mode` / `draft` / `dirty`) and `validateDraft`. The page is
`pages/agents-page.tsx` with `components/agents/{agent-list,agent-editor,agent-display}`,
built to the `Agents.dc.html` artboard; Skills, MCP servers and the memory body
are empty states naming S3.2, S3.1 and S3.3. `e2e/agents.spec.ts` drives the whole
screen offline. Docs in `docs/features/agents/`.

### S2.2 Chat members and chat settings `[x]` (2026-09-13)
What: chat_members add / remove / reorder; member panel on the right; chat settings (mode, sequential / parallel, max rounds, timeouts).
Acceptance: agents can be added to, removed from and reordered within a chat; chat settings persist.
Done: `chats.create` takes `memberAgentIds` (`ChatCreateInput`) and only falls back
to `ensureDefaultAgent` while the agents table is empty; `chats.update` takes a
`ChatPatch` whose `settings` is merged field by field and fully validated;
`chats.members.set` checks every agent and emits `chat.updated`; `chat.send`
rejects a chat with no members before storing anything. The member panel gained
the add popover, remove, native HTML5 drag reordering (`lib/reorder.ts`) and the
usage placeholder, and the group-settings block writes straight through to
`chats.update`. `e2e/members.spec.ts` covers add, reorder across a restart,
remove, the settings and the empty-membership refusal. Docs updated in
`docs/features/chats/`.

### S2.3 Orchestration engine `[x]` (2026-09-13)
What: full ChatRunner: roundrobin / mention-only, sequential / parallel, @parsing, PASS, maxAutoRounds, barrier, stop; history transform (name prefixes, role mapping, merging consecutive messages).
Acceptance:
- Unit tests: @parsing, next-round speakers, history transform, barrier completion
- Mock-model integration tests: full multi-round runs in both modes
- Real models: 3 agents; in sequential mode later agents cite earlier ones; parallel mode streams simultaneously; an @mention triggers round 2; the chain stops at the limit
Done: `src/shared/mentions.ts` (longest-name-first `@` matching, `@all`, CJK,
shared with the composer); `src/main/orchestration/scheduling.ts` (the pure
"who speaks next", including `inReplyTo` and the round-limit predicate);
`chat-runner.ts` rewritten as one run with a round loop — a user message sent
mid-run now joins that run at the next boundary and resets the automatic-round
counter instead of starting a second run. `runAgentTurn` gained an optional
`history` snapshot (the parallel barrier hands every speaker the same one),
`inReplyTo`, and the mentions it parses out of the finished reply. `Message`
gained `inReplyTo` (migration `0001_spooky_odin.sql`). Notices `noMentions`,
`maxRoundsReached` and `runFailed`; `ChatRunnerRegistry.getState` exposes the
round, its speakers, the active turns and the pending messages for S2.4. The
renderer prints `Round n · replying to @x`, highlights `@Name` in a reply and
shows "Round n · X, Y speaking" in the header. `e2e/orchestration.spec.ts`
drives two real Ollama models through both speaking modes, `mention-only` and
the `noMentions` notice. Docs rewritten in `docs/features/orchestration/`.

### S2.4 Presence and heartbeat `[x]` (2026-09-13)
What: AgentSession, AgentSupervisor ticking every second, stall / hard timeouts, skip with a system message, provider probing; dots shown in the member panel and on message avatars.
Acceptance:
- Unit tests: transitions between the four states
- Integration test: a mocked stuck agent turns orange at 30 s, grey at 120 s, is skipped, and the round continues
- Dots change colour live in the UI
Done: `src/main/presence/{supervisor,abort-reasons}.ts` — `AgentSupervisor` on
`ctx.supervisor` with an injected `SupervisorClock`, `getTimeouts`,
`listChatIdsForAgent`, `listAgentIdsForChat` and `probeProvider`, so the state
machine is unit-tested on a fake clock with no storage and no network.
`runAgentTurn` now chains an `AbortController` of its own to the run's signal and
drives `beginTurn` / `activity` / `endTurn`; a `TimeoutAbortReason` makes the
message `skipped` / `'timeout'` and inserts the `agentSkipped` notice, and it
returns `aborted: false` so the barrier reads a skip as a completed turn. The
runner filters `isOffline` speakers out of every round and writes `allOffline`
when that leaves nobody. Two new handlers (`presence.list`, `presence.retry`),
`stores/presence.ts` seeding from the first and the member panel's "Retry" button
calling the second, `away · Ns` counted in the renderer, and Settings → Timeouts
& heartbeat with the three budgets and the colour legend. `e2e/presence.spec.ts`
drives a real Ollama member beside a provider pointing at a non-routable address.
Docs in `docs/features/presence/`.

### S2.5 Message rendering and composer polish `[x]` (2026-09-13)
What: markdown and code highlighting, collapsible reasoning, tool cards, round and "replying to @who" labels, dimmed PASS, @ autocomplete, Enter / Shift+Enter.
Acceptance: matches the mockup.
Done: `shiki` (core build, JavaScript regex engine, `vitesse-dark`, fourteen
grammars imported on demand) behind `lib/highlighter.ts` and
`components/chat/code-language.ts`; `code-block.tsx` gives every fence a language
header and a Copy button. `markdown.tsx` now routes fenced blocks to it, wraps
tables in their own scroller and marks every link `target="_blank" rel="noreferrer"`,
which `setWindowOpenHandler` in `src/main/index.ts` answers by handing http(s) to
`shell.openExternal` and denying everything else. Reasoning is collapsed behind a
one-line preview and auto-expands, pulsing, only while it is the thing streaming.
`tool-call.ts` + `tool-card.tsx` render `tool-call` / `tool-result` parts as the
mockup's one-line card (S3.1 produces the first real one; the pairing and the
summaries are unit-tested against fixtures). A `system` message is now one centred
dimmed line with no avatar, keeping `data-notice-key`. The list is virtualized with
`react-virtuoso` over `buildTranscriptRows`, with day separators, `followOutput`
only at the bottom and a "Jump to latest" pill. The composer grew an `@`
autocomplete (`mention-query.ts`: token extraction, longest-name-first filtering,
insertion), clickable mention chips plus `@all`, and an auto-growing textarea up to
8 lines. The Actions card is real: both buttons compose an `@mention` plus a
localized prompt and go through the normal `chat.send`. `e2e/composer.spec.ts`
drives the popover, the chips and both rendering paths against a real Ollama model
and captures `test-results/shots/chat-polish.png`. Docs updated in
`docs/features/chats/` and `docs/features/ui-shell/`.

---

## Phase 3: Capabilities (PLAN milestone 3)

### S3.1 MCP `[x] (2026-09-13)`
What: MCP servers settings page (stdio / http, test connection); MCPManager lazy connection and tool discovery; agent ↔ server binding; tool call and result cards.
Rule: servers flagged `sideEffects` are only attached to `executor` agents; `participant` agents receive read-only tools only (see "Future extension" in PLAN.md). The settings page shows the flag and explains it.
Acceptance: register `@modelcontextprotocol/server-everything`; an agent lists and calls its tools; unit test for tool schema conversion.
Done: `src/main/mcp/{manager,tools}.ts` — `McpManager` pools one lazily-connected
client per server over stdio and Streamable HTTP, caches `listTools` per
connection, runs `callTool` under `settings.timeouts.toolTimeoutMs` with the MCP
SDK's own `RequestOptions.signal` / `timeout`, probes a saved row *or an unsaved
draft* with a throwaway client, and keeps a 200-line stderr ring buffer per
server. `tools.ts` is pure: `${slug}__${tool}` keys sanitized to `[a-zA-Z0-9_-]`
with a reverse map back to `{ serverId, serverName, toolName }`, the MCP schema
wrapped untouched in `jsonSchema()`, content blocks flattened to text and
`isError` thrown so the SDK emits a `tool-error` part. `agent-turn.ts` gained
`collectAgentTools` — which is where the **rule** lives: a `sideEffects` server is
attached only to an `executor` — plus `stopWhen: stepCountIs(8)`, `tool-call` /
`tool-result` message parts pushed as `part` deltas, and a one-shot retry without
tools (with a `notices.toolsUnsupported` line) for a model whose provider rejects
them. Seven `mcp.*` handlers; `mcp.update` drops the pooled client when anything
it connects with changes, `mcp.delete` closes it and unbinds the id from every
agent. Settings → MCP servers is the two-column card list plus editor, with the
transport `SegmentedControl`, args and env as line-based text, the side-effects
explanation from PLAN.md, "Test connection" showing the tool list, and "Show log"
for stderr. The agent form's MCP block is now a real checklist that greys out a
side-effecting server for a participant. Unit tests use the SDK's own `McpServer`
over `InMemoryTransport`; `e2e/mcp.spec.ts` spawns the real
`@modelcontextprotocol/server-everything` through `npx` and, with `qwen2.5:3b` on
Ollama, watches an agent call `echo` and a tool card appear. Docs in
`docs/features/mcp/`.

### S3.2 Skills `[x] (2026-09-13)`
What: scan `userData/skills`; import a folder; agents select skills; system prompt injects name / description; `read_skill` and `read_skill_file` tools.
Acceptance: drop in a sample SKILL.md; the agent reads the full text when needed; unit test for frontmatter parsing.
Done: `src/main/skills/loader.ts` — `scanSkills` / `scanSkillsWithWarnings` over
`<skillsDir>/<folder>/SKILL.md` with `gray-matter`, `name` falling back to the
folder and a missing `description` skipping the folder into a warning list;
`listSkillFiles` (hidden files and symlinks excluded, capped at
`MAX_SKILL_FILES`), `readSkill`, `readSkillFile` (200 KB and a binary sniff),
`importSkill` (validated before a byte is copied, `overwrite` refused by
default), `deleteSkill`, `seedSkills` and a per-directory cache the writes
invalidate. `resolveInside` is the one path gate — absolute, `..` and symlink
escapes all refused against the folder's real path — and `memory/store.ts`
reuses it. `skills/tools.ts` builds the prompt's `Skills` section and the two
read-only tools, which `collectAgentTools` attaches **regardless of the
side-effects rule** (documented there and in `docs/features/skills/`).
`AppContext` gained the injected **`userDataDir`** plus `skillsDir()` /
`memoryDir()`, wired from `src/main/index.ts`, which also seeds
`resources/skills/architecture-review/` into an empty library on first launch.
`skills.read` / `skills.delete` and **`system.pickFolder`** were added to
`BackendApi` / `BACKEND_METHODS` / `contracts.test.ts`; `system.pickFolder` is
the documented electron exception — a stub in `handlers/system.ts` that
`registerIpc` layers `ipc/dialogs.ts` over. Settings → Skills is the card list
plus a reader (markdown body, bundled files, two-click Delete, "Import folder"),
and the agent form's Skills block is a real checklist that tags a name the
library can no longer resolve as missing. Docs in `docs/features/skills/`.

### S3.3 Memory `[x] (2026-09-13)`
What: `userData/memory/<agentId>/MEMORY.md` and notes; `memory_save` and `memory_search` tools; viewer and editor on the configuration page.
Acceptance: a fact remembered in chat A is recalled in chat B; unit tests for index read/write.
Done: `src/main/memory/store.ts` — `createMemoryStore(dir)` on `ctx.memory`:
`readIndex`, `listEntries` (parsing `- [Title](notes/x.md) — hook`), `saveNote`
(a `<slug>-<shortid>.md` note with `{ title, createdAt }` frontmatter plus one
**appended** index line, so hand-written prose survives), `search`
(case-insensitive, title ranked above body, snippets, capped at
`MAX_SEARCH_HITS`), `readNote`, `writeFile`, `deleteNote`, all confined per agent
by `resolveInside`. `memory/tools.ts` adds `memory_save` / `memory_search` and
the prompt's `Memory` section, which carries the whole index up to
`MEMORY_PROMPT_MAX_BYTES` (8 KB) and truncates on a line boundary with a marker;
both tools bypass the side-effects rule because the only thing they can write is
the agent's own notes folder, which `docs/features/memory/` writes out in full.
The briefing gained **one conditional sentence in both languages** asking the
agent to save durable facts. `memory.list/read/write` were implemented and
`memory.delete` / `memory.search` added to the contract. The agent form's
"Memory across chats" block is the toggle plus `memory-panel.tsx`: the entry
list with `MEMORY.md` first, an editable textarea with Save, and per-note delete.
`e2e/skills-memory.spec.ts` drives both steps against real `qwen2.5:3b` — the
seeded skill, its detail pane, the binding, a real `read_skill` call, a real
`memory_save`, and the note still being there after a relaunch — capturing
`test-results/shots/{skills,memory}.png`. Docs in `docs/features/memory/`.

---

## Phase 4: Polish (PLAN milestone 4)

### S4.1 Usage and cost `[x]` (2026-09-13)
Acceptance: token counts per message, per member and per chat are correct and shown in the header.
Done: `src/shared/pricing.ts` — `MODEL_PRICING`, a hand-maintained table of
approximate USD list prices **as of 2026-09** (Claude Opus/Sonnet/Haiku, the
GPT-5 / 4.1 / 4o families, Gemini 2.5, DeepSeek, Qwen, GLM, Kimi, MiniMax,
Doubao) matched first-hit-wins by regular expression so a vendor-prefixed id
(`anthropic/claude-sonnet-4`) still resolves — plus `estimateCost({ modelId,
presetId }, usage)` (`null` for a model the table does not know, **`0` for a
`local` preset**, because Ollama and LM Studio tokens are free and a `null` would
poison a mixed chat's total), `contextWindowFor` and the `formatTokens` (`12.4k`)
/ `formatCost` (`$0.04`, `<$0.01`) helpers. `src/shared/usage.ts`'s
`summarizeUsage` is the **one** copy of the arithmetic: the new
`messages.usageSummary` handler runs it over the database, and
`stores/usage.ts` runs it over the transcript already in the store on every
`message.updated`, so a nine-turn run costs one IPC call rather than nine (the
store falls back to the handler when it holds only a page — `messages.complete`).
Three surfaces: the chat header's `12.4k tokens · $0.04`, each member row's share
replacing the em-dash placeholder, and a tooltip on a message's model badge with
`In … · out … · $…`. One real bug came out of it: `createOpenAICompatible` needed
**`includeUsage: true`**, without which every OpenAI-compatible endpoint — most
of the preset list — streams no usage at all.

### S4.2 Context truncation `[x]` (2026-09-13)
Acceptance: unit test shows an over-long history is dropped oldest-first while keeping the system prompt.
Done: `src/main/agents/context-budget.ts` — `estimateTokens` (CJK at one token per
character, everything else at a quarter, rounded up; unit-tested with a tolerance
because it is an approximation by construction, not a tokenizer) and
`fitHistory({ system, messages, contextWindow, reserveForOutput })`, which drops
the **oldest** non-system messages until
`estimate(system) + estimate(messages) <= contextWindow - reserveForOutput`,
**never drops the last user message**, and prepends
`[Earlier messages were omitted to fit the context window.]` to the first
survivor when anything went. Wired into `runAgentTurn` for both history paths —
the sequential turn's fresh read and the snapshot a parallel round shares — with
`contextWindow = contextWindowFor(agent.modelId)` and
`reserveForOutput = agent.params.maxTokens ?? 4096`. The count is returned as
`AgentTurnResult.droppedMessages` and `ChatRunner` turns it into a
`contextTruncated` system notice **once per run per agent** (both locales), which
is the right grain: per round would bury the discussion, per chat would never
mention it again. `history.ts` also gained a 4 KB cap on each replayed
`tool-result` (`MAX_TOOL_RESULT_CHARS`), the database keeping the whole output.

### S4.3 Automatic titles and search `[x]` (2026-09-13)
Acceptance: a title is generated after the first message; the left column search filters chats.
Done: `src/main/agents/title.ts` — `generateChatTitle` asks the **first member's**
model for "a title of 3 to 6 words in the language of the conversation" with
`maxOutputTokens: 24` and a 15 s budget chained to the run's signal, and
`sanitizeTitle` (whitespace, quotes in both scripts, trailing punctuation, a
`Title:` preamble, 60 characters) turns the answer into a row label; every error
is swallowed and `fallbackTitle` uses the first 40 characters of the question, so
a chat always ends up better named than `New chat`. `ChatRunner.#maybeTitle` runs
it after the loop and before `run.finished`, only while the title is **exactly**
`DEFAULT_CHAT_TITLE` and only once a `done` agent message exists — the comparison
is the whole mechanism, so a chat the user renamed is never retitled and there is
no "generated" flag to keep in sync. It is injectable as
`ChatRunnerOptions.generateTitle`. `ChatRepository.search` + the `chats.search`
handler match the title and every message **text** part case-insensitively: SQL
`LIKE` over the JSON blob narrows (fast, over-matching) and JavaScript decides
(precise), with `escapeLike` making `%` and `_` literals under `ESCAPE '\\'`,
capped at 200 and ordered like `chats.list` so the left column keeps its Today /
Yesterday / Earlier headings while filtering. The search box is live again,
debounced 200 ms, with its own empty state. Reviewer's polish: a trailing `[PASS]`
after real content is stripped for display and for the model history
(`src/shared/pass.ts`, shared so both sides read the identical rule) while the
status stays `done` — the stored parts keep what the model actually wrote.
`e2e/polish.spec.ts` drives all three against real `qwen2.5:1.5b` and captures
`test-results/shots/polish.png`. Docs in `docs/features/{chats,agent-turn,
orchestration,providers}/`.

### S4.4 Packaging `[x]` (2026-09-13)
Acceptance: electron-builder produces a macOS dmg; after installation the app launches and completes one conversation.
Done: `electron-builder.yml` — `com.witena.app` / `Witena`, `files: [out/**,
package.json]` (no `node_modules` entry: electron-builder appends the production
tree itself), `asarUnpack` for `better-sqlite3` because **`dlopen` cannot read a
`.node` out of an asar archive**, `extraResources: resources -> resources`, and a
single unsigned `dmg` for `arm64` (`hardenedRuntime: false`, `identity: null` —
explicitly null so the artifact does not silently pick up whatever identity is in
the building machine's keychain). `bundledSkillsDir()` in `src/main/index.ts` now
resolves `process.resourcesPath/resources/skills` when packaged, keeping the
packaged tree a mirror of the repository so a later addition to `resources/`
ships without another config edit. The migrations needed nothing: S1.2 inlined
them with `import.meta.glob('?raw')`, so they are string literals inside
`out/main/index.js`.

The icon is original and drawn here: `build/icon.svg` (a rounded square in the
accent `#d8a656` with a white stroked "W"), rasterised by **using the Electron
binary as the SVG renderer** — no rasteriser is installed on this machine — then
`sips` into `build/icon.iconset/` (gitignored) and `iconutil -c icns` into
`build/icon.icns`. `npm run dist` / `dist:dir`; `npm run e2e:packaged` drives
`e2e/packaged.spec.ts` through its own `playwright.packaged.config.ts` against
the app copied off the mounted dmg (`WITENA_APP_PATH`), asserting the three
things a checkout cannot vouch for: the shell renders out of the asar, the
shipped skill is in Settings -> Skills, and one real Ollama reply completes —
which is the strongest of the three, because it can only happen if the native
module loaded and the migrations ran. `playwright.config.ts` gained a
`testIgnore` for it and for `e2e/demo.record.ts`, the filmed product tour that
produces `docs/assets/`; the repository `README.md` and an MIT `LICENSE` were
added on top. Docs in `docs/features/packaging/`.

---

## Phase 5: Executors and external systems (PLAN "Future extension", points 1–3)

The MVP is complete. This phase builds the three layers PLAN.md reserves
interfaces for: the connector gallery, the executor agent, and opening files in
the editor — plus one step (S5.3) that was added while the phase was under
way: signing in to Anthropic instead of pasting a key. Point 4 (server and multi-user) and the VS Code *extension* (the
second half of point 3) stay out: the extension needs a backend reachable from
outside Electron, which is the server work, so both move together to a later
phase.

Every step below follows the same rules as Phases 1–4 and they are repeated
here because a step is handed to a fresh session: `docs/features/<feature>/`
(all four documents) updated in the same commit as the code; a new feature is
started from `docs/features/_template/` and gets a row in `docs/README.md`;
every user-facing string is a key in **both** `en.json` and `zh-CN.json`;
main-process text is a `SystemNoticePart` key; nothing outside
`src/main/index.ts` and `src/main/ipc/` imports electron (the handler modules
live in `src/main/handlers/`, the electron-only overlays in `src/main/ipc/`);
`npm run typecheck` and `npm test` pass; everything committed is English; the
step's marker here is flipped to `[x]` with the date in the same commit.

### S5.1 Connector gallery `[x] (2026-09-13)`
What: a preset table of common MCP servers and a picker that prefills the MCP
editor from one, so "add the GitHub server" is one click plus a token rather
than a command typed from memory.
- `src/shared/mcp-presets.ts`, shaped like `src/shared/presets.ts`: static data,
  no electron, no node. `McpPreset { id, name, transport, command?, args?,
  env?, url?, sideEffects, docsUrl, requires? }`. `env` lists the variables the
  server needs with **empty** values (`GITHUB_PERSONAL_ACCESS_TOKEN: ''`), so
  the environment box opens showing `KEY=` lines to fill in. `requires` names
  the runner the command needs (`npx`, `uvx`, `docker`) for the card hint.
  Presets, at least: `everything` (demo, read-only), `filesystem` (side
  effects; one path argument the user edits), `git` via `uvx mcp-server-git`
  (side effects), `github` (side effects, token), `fetch` via `uvx
  mcp-server-fetch` (read-only), `brave-search` (read-only, key),
  `sequential-thinking` (read-only), `slack` (side effects, token), `notion`
  (side effects, token), `playwright` (`@playwright/mcp`, side effects). Names
  are brand names and are not translated; each preset's one-line description
  is `settings.mcp.presets.<id>` in both locale files.
- Settings → MCP servers → "Add server" opens the editor with a preset grid
  above the form (reuse or generalise `components/settings/preset-grid.tsx`;
  a "Custom" tile is the blank form). Picking a tile calls a new store action
  `applyPreset(id)` that replaces the draft's transport, command, args, env,
  url and `sideEffects` and keeps the name if the user already typed one,
  otherwise uses the preset id. Each tile shows a read-only / side-effects
  badge and the `requires` hint; the editor keeps working exactly as before
  once a tile is picked. The gallery is not shown when editing a saved server.
- Unit tests: ids unique; every preset has a description key in both locale
  files (extend the pattern of `i18n/locales.test.ts` rather than duplicating
  it); stdio presets have a command and http presets a URL; `applyPreset`
  keeps a typed name and sets `sideEffects` from the preset.
- e2e: in `e2e/mcp.spec.ts`, register `everything` **through the gallery**
  (tile → Test → tools listed → Save) instead of typing the command; keep the
  typed-Enter assertion on the arguments box.
Acceptance: picking "GitHub" yields a stdio draft running `npx -y
@modelcontextprotocol/server-github` with `GITHUB_PERSONAL_ACCESS_TOKEN=` in the
environment box and the side-effects switch on; picking "Fetch" leaves it off;
the tests above pass. Docs: `docs/features/mcp/` (all four).
Done: `src/shared/mcp-presets.ts` is the table — eleven entries (the ten the step
names plus `custom`, which is the blank form), shaped like `presets.ts` and
static in the same way: no electron, no node, no backend method, and **no stored
`presetId`**. Unlike a provider, nothing in an MCP server's life depends on which
tile it came from — there is no logo to pick again and no key rule to derive — so
the gallery's selection is view state in `McpEditor` rather than a column and a
migration. `env` values are empty strings on purpose (`GITHUB_PERSONAL_ACCESS_TOKEN: ''`),
which is what makes the environment box open as a form to fill in and what keeps
a preset from ever carrying a secret; `sideEffects` is set from what a server's
tools *can* do (`git` writes because `git_commit` exists, `playwright` because a
browser clicks real buttons), because that flag is the one field a tile writes
that is not cosmetic — `collectAgentTools` reads it. `components/settings/mcp-preset-grid.tsx`
is a **sibling** of `preset-grid.tsx`, not a generalisation of it: a connector
tile answers "what is this and will it change anything" with a badge, a
description and the runner hint, and folding both into one component would have
meant six optional slots and would have pulled the providers feature into this
step to gain a shared `<button>`. The grid is mounted only while `mode ===
'create'`, and `applyPreset` rewrites transport, command, args, env, url and
`sideEffects` **unconditionally** — `custom` after `github` has to leave an empty
form — while keeping a name the user already typed and otherwise filling it with
the preset **id**, since the name is also the tool prefix (`everything__echo`).
Five keys plus the `settings.mcp.presets.*` subtree in both locale files; brand
names stay data. The description is a runtime key, so `locales.test.ts` gained the
check `used-keys.test.ts` cannot do: the description keys in both files are
exactly the preset ids, in both directions. `src/shared/mcp-presets.test.ts`
asserts the table's invariants including the acceptance sentence itself;
`src/renderer/src/stores/mcp.test.ts` covers `applyPreset`; `e2e/mcp.spec.ts` now
registers `everything` through the tile — prefill asserted, then the arguments
retyped key by key with a real Enter, which is the regression the gallery must
not hide — and checks the grid is gone once the row is saved. Docs in
`docs/features/mcp/`.

### S5.2 Executor role and the chat working directory `[x]` (2026-09-13)
What: make the two reserved fields real. `agents.role = 'executor'` becomes a
first-class choice with an explanation, and a chat can be bound to a local
folder.
- `Chat.workdir`: `ChatPatch` accepts `workdir: string | null`. The `chats.update`
  handler validates it (absolute; exists; is a directory; `validation` error
  code otherwise, checked with `node:fs` — allowed in handlers) and the runner
  reads it from the chat record. A chat settings row "Working directory" with
  "Choose…" (`system.pickFolder`, which already exists) and "Clear"; the chat
  header shows the folder's basename as a chip with the full path in `title`.
- One executor per chat: adding a second executor member is refused by the
  member handler (`validation`, key `notices.secondExecutor` or an error code
  the renderer translates — follow how member errors are surfaced today) and
  the member picker greys the candidate with a hint. A chat with an executor
  member but no `workdir` is allowed; S5.4 simply attaches no executor tools.
- Agent editor: the existing role control gets the PLAN.md explanation inline
  (discussion agents are read-only; one executor writes, with confirmation)
  and the agent list, member rows and message headers show an "executor"
  badge. `agents.mcpServerIds` and the side-effects checklist keep their
  current behaviour.
- Unit tests: `chats.update` workdir validation (relative path, missing path, a
  file), the second-executor refusal, the chats store patch; renderer display
  helpers for the badge and the chip.
- e2e: `e2e/members.spec.ts` (or a new `executor.spec.ts`) creates an executor
  agent, adds it to a chat, sees the badge, and sees a second executor refused.
  The folder picker is native and is not driven; set `workdir` through the
  backend client in the test and assert the chip.
Acceptance: a chat shows its folder chip after `chats.update({ workdir })`; an
invalid path is refused with a translated error; two executors cannot join one
chat. Docs: `docs/features/chats/` and `docs/features/agents/` (all four each).
Done: `ChatPatch.workdir` is `string | null` and `assertWorkdir` in
`src/main/handlers/chats.ts` checks it against the **real filesystem** —
absolute, `statSync` succeeds, `isDirectory()` — which is why that module now
reads `node:fs` and `node:path` (rule #5 is about electron, not about Node).
`statSync` follows symlinks on purpose: a symlink to a directory is a perfectly
good working directory, and the check that matters — a path *inside* the folder
whose realpath leaves it — is per file and belongs to S5.4. The race is
acknowledged rather than closed: the folder can vanish between the check and the
first tool call, which is why S5.4 resolves every path again at use. The same
rules run on `chats.create`, because `assertChatPatch` is shared. Nothing new
was needed in the runner: `ChatRunner` already re-reads the chat record every
round, so `workdir` reaches the orchestrator with no plumbing at all, and
attaching tools to it is S5.4's job rather than dead code written early.

`assertOneExecutor` refuses a member list holding two `executor` agents, on both
`chats.members.set` and `chats.create`. It lives where membership is **written**
because `members.set` replaces the whole list and is therefore the only place
that can see the resulting set — which also makes swapping one executor for
another in a single call correctly legal. The **known gap** is recorded rather
than papered over: `agents.update` can still *promote* a participant that is
already in a chat with an executor, so S5.4 must pick a chat's executor
deterministically (first `executor` in `position` order) instead of assuming the
set has exactly one.

The step's one real design decision was how a refusal says *which* rule it broke.
`BackendErrorCode` is a failure taxonomy of seven classes, and "the request was
rejected as invalid" is the right sentence almost everywhere because the control
that sent the request is on screen saying what it wanted — but not for a folder
that turned out to be a file. So `shared/types.ts` gained `VALIDATION_REASONS` /
`ValidationReason` (`workdir_not_absolute`, `workdir_missing`,
`workdir_not_directory`, `second_executor`), carried in `BackendError.details` as
an **identifier the renderer translates**, never a sentence the backend wrote.
`i18n/errors.ts` gained `validationReasonOf` (narrowing, so an unknown reason
from a newer backend degrades to the generic copy rather than printing a raw
id), a literal-`switch` `validationReasonMessage`, and `translateFailure(t, code,
details)` — which is also the one place a store's `errorCode` + `errorDetails`
becomes copy, so no component rebuilds a `BackendError` literal in JSX any more.

Renderer: `stores/chats.ts` keeps `errorDetails` beside `errorCode` and gained
`setWorkdir` and `chooseWorkdir` (two calls rather than one method, exactly as
`stores/skills.ts` imports a folder — the dialog is the single thing the backend
cannot do without electron, and a cancelled dialog must write nothing and leave
no error). The group-settings block has a "Working directory" row with "Choose…"
and "Clear", and the header carries an accent chip holding `folderName(workdir)`
with the whole path in `title` — `lib/workdir.ts` is `basename` written by hand,
because the renderer project has no Node types. The path itself is printed, never
translated: it is data. **The role control did not exist** despite the step's
wording — only the `allowSideEffects={draft.role === 'executor'}` site read the
field — so the agent editor gained a two-segment control with PLAN.md's rule
printed under it rather than in a tooltip, and picking "Executor" immediately
un-greys the `sideEffects` rows in the MCP checklist below it. The badge is drawn
from `isExecutor` / `hasExecutor` in `agent-display.ts` by all four surfaces that
show it (agent list, member row, member picker, message header) rather than from
four literal comparisons; the picker uses `hasExecutor` to disable a second
executor and replace its model line with `chat.executorTaken`, so the click that
the backend would refuse is not offered at all.

One deliberate non-change: a refused `workdir` prints in the left column's
`chats-error` line with every other chats-store failure rather than under the row
the user clicked. One store, one error field, one place it is rendered — and the
reason sentence is now specific enough to read correctly anywhere.

Tests: `handlers/chats.test.ts` covers `workdir` accepted, cleared, and refused
as relative / blank / missing / a file, plus the second-executor refusal on both
handlers and the two shapes that must stay legal; `stores/chats.test.ts` covers
both new actions including the cancelled dialog; `lib/workdir.test.ts` and
`agent-display.test.ts` cover the display helpers; `i18n/errors.test.ts` now
proves the reason mapping is total and that `errors` holds exactly the codes plus
the reasons. `e2e/executor.spec.ts` is new and offline — it drives the role
control, both badges, the greyed candidate, the chip appearing after a
`chats.update({ workdir })` made through the backend client, "Clear", the three
refusals with their reasons, and a restart. The native picker is not driven,
which the file says in its header. `e2e/members.spec.ts` needed no change and
still passes. Docs in `docs/features/{chats,agents,i18n}/`.

### S5.3 Anthropic sign-in `[x]` (2026-09-13)
What: an Anthropic provider can authenticate with the user's Anthropic account
instead of an API key. Closed-source providers gain an authentication mode;
open-source and local providers keep API keys only. This step implements the
mode for Anthropic; OpenAI and Google get the field and a disabled control,
and their sign-in flows are left for a later step once their programs allow it.
- **Mechanism: delegate to the official Anthropic CLI (`ant`).** `ant auth
  login` runs the OAuth flow in the system browser and stores a profile under
  `~/.config/anthropic/` (`$ANTHROPIC_CONFIG_DIR` when set); `ant auth
  print-credentials --access-token` prints a short-lived access token and
  refreshes it when needed; `ant auth status` reports the active credential
  source and workspace; `ant auth logout` clears the profile. Witena stores
  **no token of its own** — the CLI owns the credentials — so `SecretStore` is
  untouched. Requests made with such a token carry `Authorization: Bearer
  <token>` and the header `anthropic-beta: oauth-2025-04-20`, and must **not**
  carry `x-api-key`. Install on macOS: `brew install anthropics/tap/ant` then
  `xattr -d com.apple.quarantine "$(brew --prefix)/bin/ant"`.
- `ProviderInput.auth: 'apiKey' | 'oauth'` (default `'apiKey'`), a new
  nullable `auth` column on `providers` through an additive migration (follow
  `docs/features/database/`), and validation: `oauth` is accepted only for
  `type === 'anthropic'` with no custom `baseUrl`, and an `oauth` provider is
  valid without a key. `providerRequiresApiKey` returns false for it.
- `src/main/providers/anthropic-cli.ts` (Electron-free, `node:child_process`
  allowed): an `AnthropicCli` interface injected into the registry —
  `status()`, `login()`, `logout()`, `accessToken()` — with the real
  implementation spawning `ant`. A missing binary (`ENOENT`) maps to a new
  `BackendErrorCode` `ant_missing`; a profile that is not logged in maps to
  `ant_not_logged_in`. **Derive the status from `ant auth print-credentials`
  with no flags**, which prints JSON (`type`, `access_token`, `expires_at`
  as unix seconds, `refresh_token`, `scope`, `organization_uuid`,
  `organization_name`, `account_email`, `workspace_id`, `workspace_name`) and
  fails when no profile is logged in; never parse the text of `ant auth
  status` (its `--format json` flag does not apply to that command, verified
  on `ant` 1.32.0). Keep the token fields inside the main process: the status
  sent to the renderer carries `organizationName`, `accountEmail`,
  `workspaceName` and `expiresAt` only. Tokens are fetched per model
  construction through `--access-token` and cached in memory until 60 seconds
  before `expires_at`.
- Model construction (`providers/registry.ts`): for an `oauth` provider,
  `createAnthropic({ apiKey: '', fetch })` where `fetch` is a wrapper that
  deletes `x-api-key`, sets `Authorization: Bearer <token>` and merges
  `oauth-2025-04-20` into `anthropic-beta`. `providers.fetchModels` and
  `providers.testConnection` go through the same wrapper.
- Backend methods `providers.authStatus()`, `providers.login()` (resolves when
  the CLI exits; the CLI opens the browser itself) and `providers.logout()`,
  added to `BackendApi`, `BACKEND_METHODS` and `shared/contracts.test.ts`.
- Provider editor: an "Authentication" `SegmentedControl` (API key / Sign in
  with Anthropic), rendered only for the Anthropic type, disabled with a hint
  for OpenAI and Google, absent for everything else. In sign-in mode the key
  field is replaced by a panel with the status line (signed in as
  `<workspace>` / not signed in / `ant` not installed, with the install
  command shown in monospace), "Sign in" and "Sign out" buttons and a spinner
  while the CLI runs. Test connection and Fetch models keep working. The
  provider card shows a "signed in" badge instead of the key indicator.
- Unit tests: the fetch wrapper (headers replaced, `x-api-key` removed,
  existing `anthropic-beta` merged); `anthropic-cli.ts` against a **fake
  `ant`** — a temporary executable script placed first on `PATH` — covering
  missing binary, logged in, not logged in, `print-credentials` and a failing
  exit; validation (`oauth` rejected for OpenAI, accepted without a key for
  Anthropic); the registry building an `oauth` model; the providers store and
  the editor's mode switch.
- e2e: `e2e/providers.spec.ts` gains a case with `ant` absent from `PATH`
  (launch with a PATH that lacks it): the sign-in panel shows the
  "not installed" state and Save is refused with a translated error; the
  sign-in click itself is not driven (it needs a browser and an account).
Acceptance: with `ant` installed and `ant auth login` done, an Anthropic
provider in sign-in mode passes Test connection, fetches the model list and
completes a chat turn with no key stored; without `ant` the editor explains
what to install; the tests above pass. Docs: `docs/features/providers/` and
`docs/features/database/` (all four each).
Done: `ProviderAuth` is a **field on the provider**, not a fifth `ProviderType`.
The endpoint, the model list and the adapter are identical either way — only the
headers differ — so a new type would have forked `registry.ts`, `discovery.ts`,
the preset table and the logo rules to express one boolean. The column is
nullable with no default (`0002_mysterious_madelyne_pryor.sql`, one `ALTER TABLE
… ADD auth text`), and the meaning of `NULL` lives in `providerAuth()` in
`shared/presets.ts` rather than in SQL: `NOT NULL DEFAULT 'apiKey'` would have
rewritten every row *and* stated the same fact in two places. `providerRequiresApiKey`
answers `false` for an `oauth` provider, which is what makes the form saveable
with the key field gone.

`src/main/providers/anthropic-cli.ts` is the only module in the app that ever
holds a token, and it holds one for as long as the CLI says it is valid, minus
sixty seconds. **Witena stores no credential of its own**: `SecretStore` is
untouched, no column holds a token, and `ant auth logout` signs Witena out too,
because there was never a second copy. Two deliberate readings of the step. First,
the status is derived from `ant auth print-credentials` — the step's own
instruction, because `ant auth status` prints prose and its `--format json` flag
does not apply to that subcommand — and **the same call also supplies the token**,
rather than a second spawn of `--access-token`: it is the call that carries
`expires_at`, which the cache rule needs, so using both would mean two child
processes per cache miss for one fact. Second, `not-installed` and `signed-out`
are **states, not rejections**: they are the ordinary condition of a machine that
has never used the CLI and the panel exists to render them, so `providers.authStatus`
never rejects and the two new `BackendErrorCode`s (`ant_missing`,
`ant_not_logged_in`) are reserved for calls that had to *do* something —
`providers.login`, `providers.logout`, and Save. That split is also why those two
are codes while the form's two refusals (`oauth_unsupported_provider`,
`oauth_custom_base_url`) are S5.2 `ValidationReason`s: a reason narrows the
refusal of one request, a code describes the state of the machine.

`oauthFetch` is one wrapper used by both paths, which is the only way the beta
flag cannot be forgotten in one of them: it deletes `x-api-key` (the API refuses
a request carrying both), sets `Authorization: Bearer`, and **merges**
`oauth-2025-04-20` into `anthropic-beta` rather than assigning it, because the
SDK sets that header itself for other features. `createAnthropic({ apiKey: '' })`
is deliberate — omitting `apiKey` makes the adapter hunt for `ANTHROPIC_API_KEY`
and throw — and the empty header it produces is deleted before the request
leaves. The token is fetched **per request** through the injected `AnthropicCli`,
so a model instance built once and used for an hour keeps working. Binary
resolution walks `PATH` and then `/opt/homebrew/bin`, `/usr/local/bin` and
`$HOME/go/bin`, because a packaged Electron app is launched by `launchd` with a
minimal `PATH` and cannot see a Homebrew install; `WITENA_ANT_BIN` replaces the
whole search with one absolute path.

Save refuses a provider the CLI cannot authenticate, on `create` and on `update`,
and the `auth` rules are checked against the **stored row merged with the patch** —
`{ auth: 'oauth' }` alone says nothing about the type it lands on. The editor
renders the Authentication control for the three first-party types only: live for
Anthropic, disabled with a hint for OpenAI and Google ("not yet" and "never" are
different statements), and absent for `openai-compatible`, which is somebody
else's URL with no account behind it. In sign-in mode the panel **replaces** the
key field; the install command is printed as data, not as copy, exactly like a
working directory path. The card's badge is neutral rather than green: the record
says this provider signs in, which is not a claim that the login still works —
only a probe can make that claim, and it then shows "Connected".

Tests: `anthropic-cli.test.ts` drives the **real** implementation against a fake
`ant` — an executable script first on the injected `PATH` — covering resolution,
all three states, the cache expiring early and being dropped on logout, a
non-zero exit, output that is not JSON, and the rule that `stdout` (the token)
never reaches an error message while `stderr` does. `registry.test.ts` pins the
wrapper's three header edits and inspects the headers of a real `doGenerate`;
`handlers.test.ts` covers the two reasoned refusals, both `ant_*` refusals of
Save, and the merged check on update; `provider-display.test.ts` tests the
editor's mode switch as `authControl`, which is how a decision made in JSX stays
testable in a suite with no DOM. `e2e/providers.spec.ts` relaunches the app with
`WITENA_ANT_BIN` pointing at nothing — the only way to get a machine with no
`ant` on a developer machine that has one — and drives everything except the
browser flow itself.

**Verified against the real API**, with the developer's own `ant auth login`:
the status reads back (organisation, account, workspace, expiry), and
`providers.fetchModels` returns the live list of 11 models through the wrapper,
which proves the header rewriting end to end. A generation is refused by the API
with `Your credit balance is too low…` — HTTP 400 `invalid_request_error`, an
account-balance answer rather than an authentication one, and the identical
refusal comes back from a bare `curl` with the same headers. So the acceptance
sentence "completes a chat turn with no key stored" is **unverified for want of
API credit on that account**, not for want of code; it is recorded in the Phase 6
backlog. Docs: `docs/features/providers/` and `docs/features/database/` (all four
each), plus the `i18n` and `backend-client` documents that the two new error
codes and the three new methods made out of date.


### S5.4 Executor tools and the permission gate `[x]` (2026-09-13)
What: the built-in tools an executor uses on the chat's folder, and the prompt
that runs before anything with side effects. Backend only; S5.5 builds the UI.
- New feature `executor` (`docs/features/executor/`, README row). Code in
  `src/main/executor/`: `paths.ts` (confinement: resolve against `workdir`,
  refuse `..` escapes and symlinks whose realpath leaves the folder),
  `tools.ts` (AI SDK tools: `read_file`, `list_dir`, `search_files`,
  `write_file`, `edit_file` — exact-string replace —, `run_command` with
  `cwd = workdir`, a timeout from `settings.timeouts.toolTimeoutMs`, output
  capped and truncated with a marker, and `git_diff`), and `permissions.ts`.
  `write_file` and `edit_file` return the unified diff of what they changed
  (add the `diff` package; do not hand-roll a diff) so S5.5 can post it.
- `PermissionGate`: `ask({ chatId, agentId, toolName, input, signal })` emits
  the reserved `permission.requested` event and resolves when
  `permission.reply({ requestId, decision })` arrives with `allow`, `deny` or
  `allowAlways` (remembered per chat + tool for the life of the process, as
  PLAN.md's "always allow in this chat"). Add `permission.reply` to
  `BackendApi`, `BACKEND_METHODS` and `shared/contracts.test.ts`, and a
  `permission.resolved` event so the renderer can dismiss a prompt the run
  cancelled. Stop aborts pending prompts through the turn's signal; a denied
  or aborted call returns a tool error the model reads ("the user declined").
- Which calls prompt: `write_file`, `edit_file`, `run_command`, and every tool
  of an MCP server flagged `sideEffects` (the flag's reserved purpose in
  `schema.ts`). `read_file`, `list_dir`, `search_files`, `git_diff` do not.
- `collectAgentTools` gains the chat (it needs `workdir`): executor tools are
  attached only when `agent.role === 'executor'` **and** the chat has a
  `workdir`; a participant never gets them, whatever the chat says. The
  executor's system prompt gets a briefing: the folder, the tools, and the
  instruction to finish with a summary of what changed and to ask for review.
- Unit tests: confinement (`../x`, an absolute path outside, a symlink out),
  each tool against a temp directory, the gate (allow, deny, always, abort by
  signal, an unknown `requestId`), and `agent-turn.test.ts` with a
  `MockLanguageModel` that calls `write_file`: a `permission.requested` event,
  a reply of `allow` writes the file and the turn ends with a `tool-result`;
  `deny` ends with a `tool-error`; a participant with the same chat gets no
  executor tools.
Acceptance: the tests above; `npm run typecheck`; nothing under
`src/main/executor/` imports electron. Docs: `docs/features/executor/` (new,
all four) and `docs/features/agent-turn/` (all four).
Done: `src/main/executor/` is three files that know nothing about each other's
callers. `paths.ts` is `resolveInWorkdir(workdir, path) → { absolute, relative }`
and the boundary is the whole module. It is **not** `skills/loader.ts`'s
`resolveInside` with a different root: that function refuses every absolute path,
which is right for a skill's bundled files and wrong for an executor that is told
its folder in the briefing and reads absolute paths out of compiler output — so
an absolute path inside the folder is resolved like any other and held to the
same test. The case a shorter implementation gets wrong is the **write**:
`existsSync` is false for a file that is about to be created, so realpathing the
target proves nothing, and `realPathOf` climbs to the deepest existing ancestor,
resolves *that*, and re-appends the missing tail. `workdir/link/new.txt` where
`link` points at `/etc` is refused for that reason and has its own test. Every
resolution starts from `realpathSync(workdir)`, so S5.2's acknowledged race — the
folder can vanish between the picker and the first tool call — is closed by
re-resolving rather than by trusting the earlier check.

`tools.ts` is the seven tools plus `buildExecutorSection`. Four read
(`read_file`, `list_dir`, `search_files`, `git_diff`) and run immediately; three
change something (`write_file`, `edit_file`, `run_command`) and ask first, with
`GATED_EXECUTOR_TOOLS` as the **actual** test rather than a comment — the `gate`
wrapper checks membership, so moving a tool between the columns is one edit. A
prompt per `read_file` was rejected outright: it trains the user to click Allow
without looking, which is how a permission prompt stops being one. The tools
return **objects**, not the rendered strings `mcp/tools.ts` produces, because two
consumers want different things from one result — the model wants something to
reason about, S5.5 wants `patch` — and JSON serves both. The diffs come from the
`diff` package's `createPatch` (added to `dependencies`; its 4th and 5th
parameters are file *headers*, the options object is the 6th). `edit_file`
re-reads the file **after** the prompt and refuses if it changed, because writing
the copy read before the prompt would silently revert an edit the user made while
deciding. `run_command` spawns `/bin/sh -c` `detached`, so `process.kill(-pid)`
takes the command's own children with it — `child.kill()` alone leaves a `sleep`
behind that nothing can see — SIGTERM then SIGKILL after 2 s, on both the
`toolTimeoutMs` budget and the turn's abort, and output is capped **as it
arrives** rather than at the end. A non-zero exit is a returned result, not a
throw: failing tests are the most useful thing the tool produces.

`permissions.ts` is one promise per waiting prompt. A tool call is already an
`await` inside `streamText`'s loop, so suspending it needs no state machine — the
turn is simply not finished until the tool is — and several prompts can be open
at once in a parallel round. `permission.resolved` is emitted **exactly once per
`permission.requested`, on every path**, which is what lets S5.5 dismiss a card
without knowing why it went away; `aborted` is that path for a stop. Two cases
emit nothing at all rather than a card that dies in the same frame: a remembered
`allowAlways`, and a signal that was already aborted when `ask` was called.
`allowAlways` is keyed on **chat + tool** and is not persisted — PLAN.md's
"always allow in this chat", and a grant that survived a restart would be a
permission the user cannot see and does not remember giving. `permission.reply`
answers `not_found` for an id nothing is waiting on (answered twice, or closed by
a stop) and `validation` for a decision outside the union, deliberately **not**
treating an unknown decision as `deny`: silently denying a call the user allowed
is the worse of the two wrong answers, and the call stays pending.

The attachment rule is `executorWorkdir(chat, agent, members)` in
`agent-turn.ts`, and it is the single thing both `collectAgentTools` and
`buildSystemPrompt` ask, so the prompt can never promise a tool the model was not
given. It takes the member list because S5.2's **known gap** is real:
`agents.update` can still promote a participant already sitting in a chat with an
executor, so the chat's executor is the first `executor` in `position` order and
the second one gets nothing. The MCP half of the rule moved into the `call`
closure `collectAgentTools` builds rather than into `mcp/tools.ts`, which is pure
and knows nothing about a chat — which also means the flag that decides whether
an agent may *have* a tool and the flag that decides whether a call is
*confirmed* are now read in one place from one record. That change made the
existing `attaches the same server to an executor` case hang until the hard
timeout, since nothing answered; it now subscribes a one-line "user" that
replies, and gained a sibling proving a denial comes back as an errored tool
result.

A denied or cancelled call throws `PermissionDeniedError`, whose message the
**model** reads on its next step ("The user declined to allow write_file… say
what you wanted to do and why"). That is prompt content in the same class as an
MCP server's error text, not backend-authored UI copy, so it is an English
sentence rather than a `notices.*` key — and this step consequently adds **no
locale keys at all**; the card's own copy lands with S5.5.

Tests: `executor/paths.test.ts` (18) covers `..`, an absolute path outside, a
symlink to a file and to a directory, a *new* file through a symlinked directory,
an absolute path inside, a vanished workdir, and `isInside` on a sibling sharing
a prefix; `executor/permissions.test.ts` (10) covers the five cases the step
names plus the one-resolution-per-request invariant and `abortAll`;
`executor/tools.test.ts` (36) drives all seven against a temp directory and a
real `/bin/sh`, including the timeout kill, the abort kill and the output cap;
`handlers/permissions.test.ts` (5) covers the handler's two refusals;
`agent-turn.test.ts` gained a nine-case S5.4 block with a `MockLanguageModelV4`
calling `write_file` — allow writes the file and stores a `tool-result` carrying
the patch, deny stores a `tool-error` and writes nothing, `allowAlways` does not
ask twice, a participant and a folderless chat get no tools, and the
two-executor tie is broken by position. `npm test`: 75 files, 1078 tests.
Docs in `docs/features/executor/` (new), `docs/features/agent-turn/`,
`docs/features/mcp/` and `docs/features/backend-client/`.

### S5.5 Permission prompt, diff and file-ref rendering `[x]` (2026-09-13)
What: the renderer half of S5.4 — the user can answer the prompt, and what the
executor changed is visible in the transcript.
- `stores/permissions.ts`: pending requests keyed by `requestId`, filled from
  `permission.requested`, cleared by `permission.resolved`; `reply(requestId,
  decision)` calls `permission.reply`. A `PermissionCard` above the composer
  (one per pending request, oldest first) shows the agent, the tool, a readable
  rendering of the input (path and a preview for a write, the command line for
  `run_command`, raw JSON otherwise) and three buttons: Allow, Always allow in
  this chat, Deny. Enter allows, Escape denies. The card disappears on
  `permission.resolved` however the request ended.
- After an executor turn, the backend appends one `DiffPart` per file the turn
  wrote (from the diffs S5.4's tools return; several writes to one file are
  concatenated in order) to the executor's message. `message-item.tsx` renders
  a `DiffPart` as a collapsible block headed by the path, using the existing
  `code-block.tsx` with the `diff` language; `transcript-rows.ts` learns the
  part. A `FileRefPart` renders as a `path:line` chip; in this step it copies
  the path on click (S5.7 makes it open the editor).
- Tool cards for the executor tools get readable labels (`write_file(path)`,
  `run_command(cmd)`) through `tool-call.ts`.
- Unit tests: the permissions store (request, resolve, reply, stop clears),
  `transcript-rows` with `diff` and `file-ref` parts, the tool-call labels.
- e2e: `e2e/executor.spec.ts` — with `qwen2.5:3b` on Ollama (the same guard as
  `mcp.spec.ts`), an executor bound to a temp folder is asked to create a file;
  the prompt card appears, Allow is clicked, the file exists on disk and a diff
  block is in the transcript. Without the model the spec asserts only that a
  chat without an executor shows no card.
Acceptance: the flow above end to end with a real local model; the tests
above. Docs: `docs/features/executor/` and `docs/features/chats/` (all four
each).
Done: the card is **above the composer, not a modal**, and that is the decision
the rest follows from. Several prompts can be open at once — a parallel round, or
two chats — the transcript above the card is exactly the context needed to judge
the call, and a modal would have to hide it and pick one prompt to be about. So
the cards stack oldest first between the message list and the composer, and Enter
and Escape are bound **on the card** rather than on the document: a global
listener would take Enter away from the composer, where Enter sends. The oldest
card takes focus so the shortcuts work without a click, and the **card** takes it
rather than the Allow button, because a focused default button is one stray Enter
away from approving a write.

`stores/permissions.ts` is a reducer over the two events and one call, and the
rule that matters is that **nothing is optimistic**: a card is removed by
`permission.resolved`, never by the click that answered it — the tool call has
not returned when the reply resolves. A reply the gate refuses with `not_found`
(answered twice, or a stop this window missed) drops the card silently: a stale
permission prompt must stop being offered, not sit there with an error under it.
A second answer while the first is in flight is ignored, which is also what makes
Enter-on-a-focused-button harmless.

`permission-input.ts` decides what a call looks like, and `run_command` is the
case it exists for: the command line is printed **verbatim**, in monospace, and
is the one body that is never capped, because the shell is not sandboxed and the
prompt is therefore the entire boundary. `write_file` shows the path and a
1 200-character preview of the content — not a diff, because the tool computes
the patch only *after* the grant — `edit_file` shows the patch it already sent,
and anything else falls back to raw JSON, which is also where arguments that are
not the shape the schema promises land: a model that sent `write_file` without a
`content` string is exactly when the user should see what it really sent.

`diffPartsFrom` in `agent-turn.ts` runs once when the stream ends, over the parts
already stored, and appends one `DiffPart` per **file**. Grouping is by the path
the tool returned (the resolved one, not the string the model typed) and the walk
is in **call** order rather than result order: two writes issued in one step
finish in whichever order the filesystem answers, and a transcript that
reshuffles between two identical turns cannot be compared with anything. It
ignores `git_diff`, which returns a `patch` but only reports on the folder, and
appends the blocks even when the turn was stopped or failed afterwards — the
writes really happened. The pure helpers (`collectDiffs`, `collectFileRefs`,
`countDiffLines`, `formatFileRef`) went into `transcript-rows.ts` so the
components stayed markup and the cases could be tested without a DOM.

S5.5 adds **no shared type, method or event and no `notices.*` key**. A denial is
already visible as the errored tool card it was, carrying the English sentence
the *model* read; a notice repeating it would be the app narrating the user's own
click back to them. The eleven new keys are all under `chat.*`, and the three
things on these surfaces that are never translated — the path, the command line
and the patch — are data, the same rule the working-directory chip follows.

Tests: `stores/permissions.test.ts` (9), `permission-input.test.ts` (8),
`transcript-rows.test.ts` gained 9 (`collectDiffs`, `collectFileRefs`,
`countDiffLines`, `formatFileRef`), `tool-call.test.ts` gained 6 for the executor
labels, and `agent-turn.test.ts` gained an eight-case `diffPartsFrom` block plus
three whole turns. Writing the last of those found a real ordering bug: two
dependent calls in one step race, so the mock model now makes one call per step,
and the grouping was moved from result order to call order. `npm test`: 77 files,
1121 tests; `npm run typecheck` clean. `e2e/executor.spec.ts` ran with
`qwen2.5:3b` present and all 8 cases passed — the card appeared, nothing was on
disk while it waited, Allow wrote the file and the diff block opened onto a
`diff` code block. Docs in `docs/features/executor/` (all four, `frontend.md`
rewritten), `docs/features/chats/`, `docs/features/agent-turn/`,
`docs/features/backend-client/` and `docs/features/i18n/`.

### S5.6 Hand to executor and the review loop `[x]` (2026-09-13)
What: PLAN.md's workflow — discuss → "hand to executor" → it implements the
group's conclusion → posts what changed → the others review.
- A "Hand to executor" action in the chat (next to the composer, or in the
  header; pick the one that reads best with the existing `actions-card.tsx`),
  enabled only when the run is idle, the chat has a `workdir` and an executor
  member. It calls a new `chat.handoff({ chatId })` (add to `BackendApi`,
  `BACKEND_METHODS`, `contracts.test.ts`).
- `ChatRunner.handoff`: persists a user message that carries a
  `notices.handoff` system-notice part and mentions the executor only; runs the
  executor's turn; then schedules **one** review round in which every
  participant member speaks (roundrobin order, regardless of the chat's
  `mode`), fed by the executor's message and its diffs; then the normal `@`
  mechanics apply, so the executor can be re-@'d to iterate and
  `maxAutoRounds` still caps the chain. Stop works at every point.
- The executor's briefing (S5.4) is extended for a handoff: implement the
  conclusion of the discussion above, do not re-open the debate, report
  changes with paths.
- Unit tests in `chat-runner.test.ts`: the handoff message and its mentions;
  the executor speaks first and alone; exactly one review round follows with
  the participants; no review round when there are no participants; Stop
  during the executor's turn ends the run and leaves no pending permission.
- e2e: extend `e2e/executor.spec.ts` under the same model guard: two agents
  plus an executor, a short discussion, "Hand to executor", a file appears, a
  participant's review message follows.
Acceptance: the tests above; the button is disabled without a folder or an
executor and enabled with both. Docs: `docs/features/orchestration/`,
`docs/features/executor/` and `docs/features/chats/` (all four each).
Done: a hand-off is **two staged rounds of an ordinary run**, and everything else
follows from that. `ChatRunner.handoff` validates, stores the message, sets
`#handoffTo` and starts the normal loop; `#loop` *takes* that field once — not
reads it, because `#start`'s restart would otherwise hand the same chat over
twice — and spends it over two iterations: `planFromHandoff` (the executor,
alone) and then `planFromReview` (everybody else, in `position` order, replying
to it). Both are **merged** with whatever the previous round scheduled rather
than replacing it, so a message the user sent while the executor was working is
still answered by the review round. From the third round on it is ordinary `@`
scheduling, which is what makes "re-`@` the executor to iterate" free: nothing in
the runner knows the chain started as a hand-off. Stop, the barrier, the offline
filter, the truncation notice and `maxAutoRounds` needed no change at all.

Both plans ignore the chat's `mode` deliberately. `roundrobin` would put four
models in front of the executor before it started working, and `mention-only`
would answer a hand-off with the `noMentions` notice instead of a review — the
mode describes how a *typed* message is answered, and this is not one. The review
round is "everybody except the executor" rather than "every participant": the two
sets differ only in S5.2's known gap (a promoted second executor), where the
extra agent has no tools and nothing to lose by reviewing.

What is stored is a **`user` message whose only part is the `handoff` notice
key**, mentioning the executor alone. It is the user speaking — it is what the
executor replies to, it carries the mention that schedules the turn, and it is
what someone scrolling back has to see — so a `system` row would have been the
app narrating an instruction the user gave. That also meant `history.ts` needed a
`handoff` entry in `NOTICE_TEXT`: a notice with no prompt rendering is skipped,
and the executor would have been handed an empty request.

The briefing is `HANDOFF_BRIEFING`, appended by `buildExecutorSection(workdir,
handoff)` and reached by `AgentTurnOptions.handoff`, which the runner sets for
exactly one turn (`implementing` in `#runRound`). A reviewer must not be told to
"implement the conclusion", and neither must an executor a reviewer `@`-ed
afterwards: that one is being asked something specific, which is asserted by the
*absence* of the paragraph in its second prompt.

The three refusals are S5.2's layer: `handoff_no_workdir`, `handoff_no_executor`
and `handoff_run_active` as `ValidationReason`s. `components/chat/handoff.ts`'s
`handoffBlocker` computes the **same three from the same facts in the same
order** in the renderer, so the disabled button's tooltip and a rejection's
sentence are one string (`validationReasonMessage`), and only two locale keys
were needed for the control itself. A hand-off is refused rather than queued
while a run is active, because merging it into a round somebody else's mentions
had filled would make "the executor speaks alone" untrue.

The button is above the composer rather than in the Actions card: that card's two
actions are ordinary messages and say so in its header comment — nothing there
bypasses `chat.send` — while this is a backend path of its own. It is disabled,
never hidden, and carries the reason in `data-blocked` so the end-to-end spec can
assert *which* rule applies without reading copy.

Tests: `chat-runner.test.ts` gained a nine-case `ChatRunner (hand to executor)`
block (the stored message and its mentions; the executor alone in a `roundrobin`
chat then one review round with the other two and their `inReplyTo`; the briefing
in the handed-over prompt and the executor's answer in the reviewers'; no review
round when the executor is the only member; a reviewer's `@` scheduling a third
round whose prompt no longer carries the briefing, until `maxAutoRounds` takes
the floor back; a Stop inside the executor's `write_file` leaving
`permissions.pending()` empty, nothing on disk and no review round; and the three
refusals), `scheduling.test.ts` six for the two new plans, `handoff.test.ts` five
for the blocker, `run.test.ts` two for the store, plus `contracts.test.ts` and
`handlers.test.ts`. `npm test`: 78 files, 1143 tests; `npm run typecheck` clean.
`e2e/executor.spec.ts` ran with `qwen2.5:3b` present: 10 passed, including the
new offline case and the full hand-off — two participants and an executor
discussed, "Hand to executor" was clicked, the prompt was allowed, a file
appeared in the folder and a participant reviewed it with nothing typed. Docs in
`docs/features/orchestration/`, `docs/features/executor/`,
`docs/features/chats/`, `docs/features/agent-turn/`,
`docs/features/backend-client/` and `docs/features/i18n/`.

### S5.7 Open in editor `[x] (2026-09-13)`
What: PLAN.md point 3, step one — file paths and diffs in a message open in
the user's editor. New feature `editor` (`docs/features/editor/`, README row).
- Settings → Developer gains an "Editor" block: `vscode` (default, opens
  `vscode://file/<path>:<line>`), `cursor` (`cursor://file/...`), or `custom`
  with a command template (`{path}` and `{line}` placeholders, default
  `code -g {path}:{line}`). `AppSettings.editor` with a default in
  `DEFAULT_APP_SETTINGS`; settings migration is additive.
- `system.openInEditor({ path, line? })`: the URL schemes need
  `shell.openExternal`, which is electron, so the real implementation is an
  overlay in `src/main/ipc/` exactly like `dialogs.ts`, and
  `handlers/system.ts` declares the method and rejects with a clear code. The
  custom command is spawned from the Electron-free handler (`node:child_process`
  is allowed there). The path must be absolute and, when the chat has a
  `workdir`, inside it; otherwise the call is refused.
- Rendering: `FileRefPart` chips open the editor on click; the `DiffPart`
  header path is clickable; a pure `components/chat/file-refs.ts` finds
  `path:line` and `path` tokens in agent text that resolve inside the chat's
  `workdir` (relative or absolute) and `markdown.tsx` renders them as the same
  chip. Tool cards for `read_file` / `write_file` / `edit_file` get an "open"
  icon.
- Unit tests: the settings default and patch, the command-template expansion
  (quoting a path with spaces), the path detector (inside the folder, outside,
  a URL, a version number like `1.2:3` that is not a path), the refusal of a
  path outside `workdir`.
- e2e: the editor cannot be observed; assert that a `file-ref` chip is rendered
  for a seeded message and that clicking it calls the backend once (stub
  `system.openInEditor` through the developer settings test hook if one
  exists, otherwise skip the click).
Acceptance: with VS Code installed, clicking a chip in a chat bound to a folder
opens that file at that line; the tests above. Docs: `docs/features/editor/`
(new, all four), `docs/features/chats/` (all four).
Done: the method is the **first one that is only half window-system**, and that
is what shaped the code. `vscode://file/<path>:<line>` needs `shell.openExternal`;
`code -g <path>:<line>` needs `node:child_process`, which the Electron-free layer
may use. So instead of a stub plus an override, the whole *decision* went into
`src/main/editor/open.ts` — confinement, the URL, the command and its quoting —
and it returns a **plan** rather than doing anything. `handlers/system.ts` runs a
`command` plan and rejects a `url` plan with `OPEN_IN_EDITOR_UNAVAILABLE`;
`src/main/ipc/editor.ts` runs both. A server build with a custom editor
configured therefore works unchanged, which neither `pickFolder` nor `applyTheme`
can say — and, more to the point, the path cannot be confined differently in the
two builds, because neither of them validates anything of its own.

Rule 2 is `resolveInWorkdir` **imported**, not re-derived: S5.4's four ways out of
a folder (`..`, an absolute path, a symlink, a symlink to a path that does not
exist yet) are already closed there and a second implementation would be a second
chance to get the fourth one wrong. Rule 1 — absolute — is the renderer's
resolution arriving as an answer rather than a question: the detector already had
to resolve a token against the folder in order to decide whether to draw a chip,
so sending the result means one resolution, in one place, and
`editor_path_not_absolute` names a real client bug rather than a user mistake.
Confinement applies only when the call names a chat that has a folder, which is
deliberate: a path in a message is *model* output and must be confined, while a
call with no chat is the user asking for a specific file and refusing to open
their own `~/notes.md` would be second-guessing a direct instruction.

The detector (`components/chat/file-refs.ts`) is the part that needed the most
restraint, because it draws a button over prose. Its rules are written as a table
of **rejections** in the file header, and the one doing most of the work is that
a relative token must end in an extension with a letter in it: that is what keeps
`1.2:3`, `read/write` and `and/or` out, at the documented cost of never chipping
`Makefile`. A URL, a Windows path, a leftover colon (`mailto:`) and an `@` in a
token with no separator are the other four. It is lexical — the renderer has no
filesystem and cannot follow a symlink — so it decides what to *draw* and the
backend re-resolves through `realpathSync` on the click; the two are allowed to
differ in one direction only, chip-then-refuse, never the reverse.

Two deliberate widenings of the step as written. **Detection runs on every message
body, the user's included**, because the sender does not change what a token
means — a pasted stack trace deserves the same click — and because it is what
makes the behaviour observable end to end without a live model: `e2e/editor.spec.ts`
is entirely offline and always runs, rather than sitting behind an Ollama guard.
And **an inline code span that is entirely one reference becomes a chip**, since
`` `src/a.ts:42` `` is how a model writes a path more often than not; a fenced
block is left alone, or a directory listing would become forty buttons.

S5.5's copy-on-click is **gone** rather than kept beside the open: it was
explicitly a placeholder for this step, and a 20-pixel target with two meanings is
worse than either one — the reference is still selectable text in the message. A
refused open paints the chip red for 2.5 seconds and says so in its tooltip;
nothing is written into the transcript, because that would be the app narrating a
click back at the user. The diff header became **two** buttons (expand, and the
path) rather than one inside another, which is invalid markup and unreachable by
keyboard.

`{path}` is substituted **already quoted** (`shellQuote`: single quotes, with
`'\''` for an embedded quote), which is what makes the naive default template
correct for `/Users/ada/My Projects/a.ts` and what keeps `notes.md; rm -rf ~` a
filename. The hint says not to quote the placeholder yourself, and writes its own
`{path}` / `{line}` with **single** braces — i18next would have interpolated the
double-brace spelling away to nothing. The Editor block sits in Settings →
Developer because its custom mode is a shell command, and `settings.update`
validates both fields for the reason `theme` is validated: an unknown kind falls
through every branch of `planOpenInEditor` and a blank command spawns an empty
shell line, neither of which fails in a way the user can see.

Tests: `editor/open.test.ts` (22) drives both rules against a real temporary
folder — including a symlink out and a `..` — plus the two URLs, the encoding, the
quoting (a space, a single quote, a `;`, a missing line, a repeated placeholder)
and the three plans; `file-refs.test.ts` (28) is weighted towards the rejections;
`handlers.test.ts` gained nine (the URL branch's rejection, a custom command
really running via a marker file the child writes, the two refusals, and
`settings.update`'s `editor` validation); `tool-call.test.ts` six for which cards
get an "open" icon; `settings.test.ts` four for the store. `npm test`: 82 files,
1234 tests; `npm run typecheck` clean. `e2e/editor.spec.ts` ran after
`npm run build`: 6 passed — the Editor block's three kinds and its conditional
command field, both surviving a restart; a chip for `src/main.ts:12` and none for
`/etc/passwd:1` or `1.2:3`; the backend really running the call the chip would
make; both refusals; and no chip at all once the folder is cleared.
`e2e/executor.spec.ts` was re-run for the diff and tool-card changes: 14 passed.
The **click itself is not driven**: `shell.openExternal` would launch the
developer's real editor, there is no test hook to stub the method, and
`window.witena` is a `contextBridge` object whose methods cannot be replaced from
the page — so the spec asserts the chip is a real button carrying the path and the
line, and separately that the backend accepts exactly that call. That gap, and
the fact that the acceptance sentence ("with VS Code installed…") was therefore
verified by reading rather than by clicking, are in the Phase 6 backlog. Docs:
`docs/features/editor/` (new, all four), `docs/features/chats/` (all four),
`docs/features/{backend-client,executor,ui-shell,i18n}/` and the README index.

### S5.8 Light theme `[x]` (2026-09-13)
What: a light appearance next to the existing dark one, and a setting that
follows the operating system.
- `AppSettings.theme: 'system' | 'light' | 'dark'`, default `'system'` for a
  fresh installation; a stored `'dark'` keeps meaning dark. `AppSettingsPatch.theme`
  accepts the three values; the handler rejects anything else with the
  `validation` code.
- Tokens: keep the dark palette in `@theme static` as the base, and add a
  complete light palette under `:root[data-theme='light']` that overrides
  **every** `--color-*` token the base defines (backgrounds, borders, foreground
  steps, accent, avatar, presence, danger, status surfaces). Set
  `color-scheme: dark` / `light` on the root alongside so native controls and
  scrollbars follow. Choose light values with the same roles and contrast steps
  as the dark ones (warm off-white grounds, the same amber accent darkened
  enough for AA contrast on white, status colours that stay distinguishable);
  the presence-dot hues stay recognisable in both.
- `src/renderer/src/lib/theme.ts`: a pure `resolveTheme(setting, prefersDark)`
  returning `'light' | 'dark'`, and `applyTheme(setting)` that stamps
  `data-theme` on `document.documentElement` and, for `'system'`, subscribes to
  `matchMedia('(prefers-color-scheme: dark)')` and re-stamps on change (returns
  the unsubscribe). Applied once at startup from the loaded settings and again
  whenever the setting changes.
- Code blocks: highlight with a light theme when the resolved theme is light
  (shiki dual themes through CSS variables, or re-highlight on change — pick
  what `code-block.tsx` already makes easy) so code is not a dark island on a
  light page.
- Settings → Appearance: a three-segment `SegmentedControl` — System / Light /
  Dark — with test ids `theme-system`, `theme-light`, `theme-dark`, replacing
  the placeholder text the section shows today. The section's existing language
  control is untouched.
- The Electron window: the initial `backgroundColor` should match the theme that
  will be painted, so the first frame is not a dark flash on a light theme (read
  the stored setting where the window is created, resolve `'system'` with
  `nativeTheme.shouldUseDarkColors`), and `nativeTheme.themeSource` should follow
  the setting so the title-bar traffic lights and native dialogs match. Both are
  electron-only and belong in `src/main/index.ts` and an overlay in
  `src/main/ipc/` (a `system.applyTheme` method declared in `handlers/system.ts`
  as a no-op / rejection, exactly like `system.pickFolder`), never in business
  logic.
- Unit tests: `resolveTheme` for the six combinations; a test that reads
  `index.css` and asserts every `--color-*` token in the `@theme static` block
  has a light override (so a token added later cannot silently stay dark); the
  settings store patch and the handler's validation of the three values and
  rejection of a fourth.
- e2e: a new `e2e/theme.spec.ts` — clicking Light sets `data-theme="light"` on
  `html` and the body's computed background is light; Dark sets it back; System
  follows `page.emulateMedia({ colorScheme })`; the choice survives a restart.
Acceptance: the three-way control works, every screen is readable in light mode
(no hard-coded dark colour left), the first frame after launch is not a dark
flash on a light theme, the tests above pass. Docs: `ui-shell` and `i18n` (all
four each) and `docs/features/backend-client/` for the new method.
Done: the light theme is **one CSS block and one attribute**. `index.css` keeps
the dark palette in `@theme static` as the base and adds
`:root[data-theme='light']`, which redefines all 28 `--color-*` tokens;
`lib/theme.ts` stamps `data-theme` on `<html>` and nothing else. No component
branches on the theme, no class is written twice and no page has to subscribe to
anything, because a Tailwind utility compiles to `var(--color-…)` and the
variable is what changes. The palette is not an inversion. Each foreground keeps
**at least** its dark counterpart's contrast on its own surface (`fg-faint` is
4.05:1 on `bg-base` where the dark one is 3.37:1); the accent is *darkened*
rather than lightened, because `#d8a656` is a 1.9:1 amber on white — `#92600f`
is the same hue at 4.9:1, and `bg-accent` with `text-bg-base` on it is AA in both
directions; and the rail stays the **recessed** surface in both themes, which
literal lightness inversion would have put on top. The palette checks in
`lib/theme.test.ts` read `index.css` as text and fail when a token added to the
base has no override, which is the one way this can rot silently.

`'system'` is a rule, not a value, so it is resolved at use and never stored
resolved — the same decision the language made in S1.4, for the same reason: a
machine that flips at sunset should take the app with it. `resolveTheme` lives in
`@shared/theme` rather than in the renderer, because the main process makes the
identical decision from `nativeTheme.shouldUseDarkColors` when it picks the
window's `backgroundColor`, and two copies of that boolean would be two chances
to disagree about the **first frame** — the one frame no stylesheet can correct.
`WINDOW_BACKGROUND` is the app's only duplicated colour for the same reason, and
the test asserts it equals `--color-bg-base` in both blocks. `activateTheme`
exists on top of `applyTheme` to own the single `matchMedia` subscription: a
leaked listener would be invisible until the OS flipped and repainted an app that
was explicitly set to light.

Code blocks switch through **CSS variables, not a re-highlight**: `highlightCode`
asks shiki for `vitesse-dark` and `vitesse-light` at once with
`defaultColor: false`, so every token span carries `--shiki-light` and
`--shiki-dark` and two rules in `index.css` choose. Re-highlighting would have
meant a second pass over a transcript holding hundreds of blocks, each flickering
back to plain text mid-stream — and it would have had to reach into
`components/chat/`, which this step deliberately did not touch. `highlighter.test.ts`
asserts both variables are present and no literal `color:` is, because the
function returns `null` on failure and a theme mistake would otherwise look like
a passing app with duller code.

`system.applyTheme` is the **second** method whose implementation must import
electron, and it is arranged exactly like `system.pickFolder`: declared in
`shared/backend.ts`, rejecting in `handlers/system.ts` with
`APPLY_THEME_UNAVAILABLE`, real in `src/main/ipc/theme.ts`, layered by
`registerIpc`. It carries no state — the setting is stored by `settings.update`
like any other — so it is a notification, resolves `void`, and the store ignores
its failure: window chrome that did not get tinted must never fail the setting.
`settings.update` validates the *value* of `theme` (the only setting whose
content is checked) because a stored `'sepia'` would resolve to light and leave
the user with a theme no control in the app explains.

`e2e/theme.spec.ts` drives the control, flips `prefers-color-scheme` with
`page.emulateMedia` while `'system'` is selected (the `matchMedia` listener is
the kind of code that works in a fake and not in Chromium), and after a restart
asserts both `data-theme` and `BrowserWindow.getBackgroundColor()` — the frame
painted before the renderer exists. Five light screenshots land in
`test-results/shots/`; the chat, settings, agents, providers and agent-editor
screens were looked at, and a real `qwen2.5:3b` transcript with a highlighted
Python block was checked in light mode outside the suite. Docs in
`docs/features/{ui-shell,i18n,backend-client}/`.

### S5.9 No sampling parameters in the agent form `[x] (2026-09-13)`
What: the agent editor stops asking for Temperature and Max tokens. The product
decision, recorded here and in `docs/features/agents/context.md`: real users do
not tune sampling, they pick a model and write a prompt; current models' provider
defaults are what everyone should run with, and two numeric fields with
validation copy were friction with no upside.
- Remove the two controls, their draft fields, their range validation and their
  locale keys (`agents.temperature`, `agents.maxTokens`, the two range messages,
  and any hint keys) from `agent-editor.tsx`, `stores/agents.ts` and both locale
  files. The `used-keys` and `locales` tests must stay green.
- Keep `Agent.params.temperature` / `maxTokens` in the shared type, the row and
  the handler validation: both are optional already, an agent that was saved with
  values keeps behaving as before, and the backend needs no migration. The
  handler continues to reject out-of-range values so a future API caller cannot
  store nonsense.
- `agent-turn.ts` and `context-budget.ts` keep their fallbacks
  (`DEFAULT_OUTPUT_RESERVE`, provider-default sampling); confirm with a test that
  an agent with no params streams with neither `maxOutputTokens` nor
  `temperature` set.
- `docs/PLAN.md`: adjust the wording that lists "parameters" among what the agent
  page configures, so the plan does not promise a control the product removed.
- Unit tests: the store no longer exposes the fields (or ignores them), the
  editor's validation path for them is gone, the handler still validates them,
  the turn falls back. e2e: `e2e/agents.spec.ts` no longer fills them; if it
  asserted them, replace with an assertion that the fields are absent
  (`agent-temperature` / `agent-max-tokens` test ids, whatever they were, have
  count 0).
Acceptance: the agent form shows model, prompt, role, skills, MCP servers and
memory only; an agent saved earlier with a temperature still uses it; typecheck
and tests pass. Docs: `docs/features/agents/` (all four) and
`docs/features/agent-turn/` if its text mentions the controls.
Done: this is a **deletion step**, and the whole of it is that the two fields
stayed where they were useful and left where they were not. `AgentParams` is
untouched, the `params` column is untouched, `assertParams` still bounds both
values, and `agent-turn.ts` still spreads `temperature` / `maxOutputTokens` into
`streamText` when an agent has them — so an agent configured before today keeps
sampling exactly as it did and there is no migration to write. What went is the
*writing* path: two `Field`s in `agent-editor.tsx`, `TEMPERATURE_MIN` /
`TEMPERATURE_MAX` and the range branches in `validateDraft`, the
`temperature` / `maxTokens` members of `AgentDraftErrors`, and four locale keys
per language (`agents.temperature`, `agents.maxTokens`, the two
`agents.validation.*Range` messages) — five, counting the already-dead
`agents.parameters` section title, whose block no longer exists. The reasoning
toggle stays and is now the only caller of `patchParams`: it changes what the
model *produces* rather than how it samples, which is a product choice and not a
knob.

The fallbacks that were written as the exception are now the normal path, which
is the one thing worth testing rather than asserting: `agent-turn.test.ts` gained
a case where an agent with empty `params` streams with **neither** option set,
next to the existing one where a tuned agent's values reach the call, and
`fitHistory` therefore reserves `DEFAULT_OUTPUT_RESERVE` for practically every
turn from now on. On the renderer side `validateDraft` deliberately stays silent
about a temperature it can no longer produce — the store's test asserts the
silence — and a separate test opens a stored agent that has both values and
checks the draft carries them through an unrelated edit, because the draft is
what `saveDraft` sends back and dropping them there would have quietly reset
records this step promised not to touch. `e2e/agents.spec.ts` asserts the two
test ids have count 0 while the editor is open; it never filled them, so there
was nothing to remove.

### S5.10 Chat goal `[x]` (2026-09-13)
What: the right-hand panel lets the user say what the chat is for, and every
agent is briefed with it.
- `Chat.goal: ChatGoal | null` where `ChatGoal = { kind: 'discussion' |
  'document' | 'codebase', description: string, deliverable?: string,
  materials: string[] }`; a nullable JSON `goal` column on `chats` through an
  additive migration (`docs/features/database/`). `ChatPatch.goal` accepts a
  goal or `null`. Handler validation with `ValidationReason`s (S5.2's layer):
  `description` non-empty and at most 2 000 characters; `deliverable` required
  for `document`, a relative path with no `..` that stays inside `workdir`
  (reuse `executor/paths.ts`), the parent folder need not exist; `materials`
  relative paths that exist inside `workdir`; `document` and `codebase` require
  a `workdir`.
- Group settings (member panel) gains a **Goal** block under "Working
  directory": a `SegmentedControl` Discussion / Document / Codebase (test ids
  `goal-discussion`, `goal-document`, `goal-codebase`), a description
  `TextArea` (`goal-description`), for `document` a deliverable path `Input`
  relative to the folder (`goal-deliverable`) **plus a "Choose…" button**
  (`goal-deliverable-pick`) that opens the native save dialog through a new
  `system.pickSavePath({ defaultDir })` overlay in `src/main/ipc/dialogs.ts`
  (`dialog.showSaveDialog`, starting in `workdir`; the file need not exist),
  whose absolute result the renderer turns into the relative path and refuses
  with a translated reason when it lies outside `workdir` — so the user may
  type the path or pick it in Finder, and both end in the same field. The
  **Materials** list (`goal-materials`, rows with a remove button, an "Add…"
  button) calls a new `system.pickPaths` overlay in the same file — files and
  folders, multi-select. Both overlays are declared and rejected in
  `handlers/system.ts` exactly like `pickFolder`. Paths picked outside
  `workdir` are refused with a translated reason. Saving is per field on blur,
  as the rest of the panel does.
- The chat header shows the goal kind as a chip next to the folder chip; for
  `document` the chip carries the deliverable's basename and, once the file
  exists, reads "delivered" and opens it in the editor on click (S5.7).
- Briefing: `buildGroupBriefing` gains a "Goal" section for every member —
  the kind in one sentence, the description verbatim, the deliverable path
  for `document`, and for `codebase` the instruction that changes are made by
  the executor after the discussion. The executor's hand-off briefing (S5.6)
  names the deliverable or the change.
- Unit tests: the validation table (each reason once), the store patch, the
  briefing section for the three kinds, the chip states. e2e: set a
  `document` goal on a chat bound to a temp folder, see the chip, create the
  deliverable on disk, see "delivered".
Acceptance: a goal round-trips through the panel and survives a restart;
every agent's system prompt carries it; invalid paths are refused with a
translated reason. Docs: `docs/features/chats/`, `docs/features/agent-turn/`,
`docs/features/database/`, `docs/features/backend-client/` (all four each).
Done: `Chat.goal` is one nullable JSON column (migration
`0003_acoustic_vermin.sql`, the third of exactly the shape `0001` and `0002`
established) holding the whole `ChatGoal`. One column rather than four, because
the four fields are only ever read and written together and a `deliverable`
means nothing without its `kind`; and **replaced** rather than merged, because
`materials` is a list the user removes from and a merge has no spelling for
"this list is now empty". That is the one patch field in the storage layer that
is deliberately not a merge, and it is what makes the Goal block hold a draft.

The step's real design work was the **path rule**, and it has two halves that
land in different processes. A goal stores paths **relative to `workdir`**,
because the folder is a machine-local binding while the goal describes a project
that outlives it being moved, cloned or restored from a backup — so
`assertGoal` refuses an absolute path and a `..` with one reason
(`*_not_relative`: they share a fix, "write it relative to the folder") and a
path that leaves the folder with another (`*_outside_workdir`: a different
mistake, discovered by a different check). That second check is S5.4's own
`resolveInWorkdir`, reused verbatim, which is what guarantees a goal can never
name a file the executor would be refused at the moment of use — symlinks
included, which each of the two has a test for. The other half is that **no
native dialog on any platform this runs on can be confined to a directory**, so
the conversion from the absolute path a dialog returns is the renderer's
(`relativeToWorkdir` in `lib/workdir.ts`, hand-written like `folderName` because
the renderer project has no Node types) and so is noticing that a pick fell
outside the folder. That refusal is reported through the *same* three store
fields, the same `ValidationReason` and the same `translateFailure` as a backend
rejection, so the user cannot tell — and does not need to — which side noticed.
A materials pick keeps what was inside and reports what was not: six files with
one stray among them meant the six.

The validation table is nine `ValidationReason`s and two refusals that carry
**none**, and that line is the point rather than an omission: a reason is a
sentence a user is meant to act on, so it exists for every refusal a control can
produce and for none that only a hand-written call can (a `deliverable` on a
`codebase` goal — the panel drops the field when the kind changes — and a
malformed object). Two asymmetries are deliberate: a **deliverable is never
checked for existence** and its parent folder need not exist, because not
existing yet is the whole point of one, while a **material must exist**, because
it is something the group reads. And `document` / `codebase` — or any material —
require a `workdir`, which is why those two segments are **disabled with the
reason under them** rather than hidden: the same argument as S5.6's hand-off
button, and it needed a per-option `disabled` on `SegmentedControl`, the only
shared primitive this step touched.

"Delivered" is a **query** (`chats.goalStatus`), not a field on `Chat` or a
column. Whether a file exists is a fact about the filesystem, so a stored boolean
is wrong the moment anything creates, moves or deletes it — including something
that is not this app — and `docs/features/chats/context.md` had already refused
exactly this shape once, for the member count. The renderer asks when a chat is
opened and again on every `chat.updated` for it (a primitive `updatedAt`
selector, so the effect does not re-run on every store write), which covers
every edit the panel makes; S5.12 adds the executor turn as one more moment, and
a filesystem watcher is in the Phase 6 backlog. `goalStatus` uses `join` rather
than `resolveInWorkdir` on purpose: the path was confined when it was saved, and
a folder that has since gone should answer "not delivered" to a chip that only
wants to know whether to say so.

The Goal block is the **only** control in the group settings that holds a draft,
and the column is why: there is no per-field patch to send, and persisting free
text on every keystroke would be a write per character. So it writes on blur,
which is what the chat title already does. Two edges fall out of
`chats.update` refusing a blank description — a goal *is* its description, since
a kind alone says nothing a model can act on — and both are deliberate rather
than discovered: picking a kind while the box is empty changes the draft only,
and **emptying** the description of a chat that has a goal removes the goal. The
way out is the same gesture as the way in, instead of a second control that
exists only to undo the first; that it is not discoverable is in the backlog.

The briefing carries the goal for **every** member, executor or not — what the
group is for is not a fact about one role — and it goes in the group briefing,
**last**, rather than in a section of its own beside skills and memory: it is the
same class of thing as the roster and the protocol, a rule of the room, so it
must survive a prompt being cut before the reference material does, and the end
of a long prompt is the part a model is still following. The description is
placed **verbatim** in both languages, because it is the one part of the whole
prompt the user wrote. A `codebase` goal adds the sentence that makes PLAN.md's
one-writer rule visible to a participant — you change no file, the executor does
it afterwards — without which a model told to change a codebase writes the change
out in prose as if it had; a test asserts the word `executor` is absent from the
other two kinds. A chat with no goal gets **no section at all**, asserted byte
for byte, rather than a paragraph explaining that it has none. The hand-off
briefing gains one sentence (`goalHandoffLine`) naming the deliverable or the
change, and it **points at** the goal rather than restating it, because the goal
is already in the group briefing of the same prompt and a model given one
instruction twice in two wordings follows neither reliably.

The chip is a button **only when it is openable**. Three of its four states are
plain chips, because a delivered document is the only one with a file to open and
a control whose click can only fail is worse than text; both branches carry the
same `data-kind` / `data-delivered`, so the spec reads one place. It opens
through S5.7's `openInEditor` and paints red for the same 2.5 s on a refusal,
which makes it that feature's fifth caller and the first outside the transcript.

Tests: `handlers/chats.test.ts` gained a 20-case `chats.update goal` block
against a real temporary folder (one per reason, a symlink out for each of the
two `outside_workdir` ones, the shapes that must stay legal, and `goalStatus`
before and after the file appears), `briefing.test.ts` eleven across both
languages, `executor/tools.test.ts` four for `goalHandoffLine`,
`db/chats.test.ts` two for the whole-object replace across a reopen,
`stores/chats.test.ts` nine, `lib/workdir.test.ts` six for
`relativeToWorkdir`, and `components/chat/goal.test.ts` seven for the chip.
`npm test`: 83 files, 1293 tests, all passing; `npm run typecheck` clean.
`e2e/executor.spec.ts` ran after `npm run build`: **12 passed**, including the
two new offline cases — the two kinds disabled with their hint before a folder
is bound, the chip naming the deliverable after one is, `data-delivered`
flipping to `true` once the file is written, the three refusals, and all of it
surviving a restart — and the two Ollama-gated ones, which found `qwen2.5:3b`
and really ran. `e2e/members.spec.ts`, `editor.spec.ts`, `i18n.spec.ts`,
`theme.spec.ts` and `ui-shell.spec.ts` were re-run for the chat page and the
`SegmentedControl` change: 23 passed. The two native dialogs and the chip's
click are **not** driven, for the reasons S3.2 and S5.7 already record; that
gap, the polled delivery check and the exact path comparison are in the Phase 6
backlog. Docs: `docs/features/{chats,agent-turn,database,backend-client}/` (all
four each) plus `docs/features/{executor,editor,i18n,ui-shell}/`.

### S5.11 Read-only workspace tools and the materials briefing `[x] (2026-09-13)`
What: every member can read the folder, and the materials the user marked are
already in front of them when the first round starts.
- `collectAgentTools` attaches `read_file`, `list_dir`, `search_files` and
  `git_diff` to **every** member of a chat with a `workdir` (participants
  included; the executor keeps its full set). These are the S5.4 tools,
  unchanged, confined to `workdir`, and they never prompt. Nothing that writes
  is ever attached to a participant, whatever the goal says — this is PLAN's
  read-only rule, and a test proves it for each writing tool.
- A **workspace briefing** section in every member's system prompt when the
  chat has a `workdir`: the folder's basename, a tree listing capped at 200
  entries and depth 3 that honours `.gitignore` and always skips `.git`,
  `node_modules`, build outputs and files over 1 MB, and — for `codebase` —
  the current branch and `git status --short` summary. Pure, tested, cached
  per turn.
- **Materials**: each `goal.materials` entry is inlined (a file: its text; a
  folder: its tree plus each text file up to a per-file cap) as a "Materials"
  section placed after the briefing and before the history. The section is
  measured with `estimateTokens` and trimmed under the same budget rules as
  `fitHistory` (S4.2): files are included in list order until the budget for
  materials (a fixed share of the context window, e.g. 25 %) is spent; the
  rest are listed by path with the note that `read_file` fetches them. Binary
  files are listed, never inlined. A `notices.materialsTruncated` line is
  emitted once per chat when trimming happened.
- Unit tests: the tree walker (caps, ignores, depth), the materials assembly
  under a small budget (inline then list), binary detection, the tools
  attached to a participant (read-only four) versus the executor (all seven),
  a `MockLanguageModel` participant turn that calls `read_file` and gets the
  content. e2e (Ollama-gated as in `executor.spec.ts`): two participants and
  a folder holding one text file marked as material; the first reply quotes
  it without any tool call; a follow-up question makes an agent call
  `read_file` on a second, unmarked file and a tool card appears.
Acceptance: a participant reads but cannot write; a marked material is in the
first reply's context; large materials degrade to a list rather than blowing
the budget. Docs: `docs/features/executor/`, `docs/features/agent-turn/`,
`docs/features/chats/` (all four each).
Done: the step is two rules and two prompt sections, and the rules are what the
code is organised around. `collectAgentTools` now asks **two** questions instead
of one: `executorWorkdir(chat, agent, members)` (S5.4's, unchanged) decides who
may write, and the new `workspaceWorkdir(chat)` — one condition, the chat has a
folder — decides who may read, which since this step is everybody in the room.
The read-only set is `READ_ONLY_EXECUTOR_TOOLS`, **derived** as the complement of
`GATED_EXECUTOR_TOOLS` rather than written out a second time, so a tool that
becomes gated stops reaching participants in the same edit; and a participant's
`read_file` is literally the executor's, picked by key out of the same
`buildExecutorTools` set, so the confinement, the caps and the refusals cannot
drift into two behaviours. `agent-turn.test.ts`'s old "a participant gets no
executor tools at all" case became "the four that read and none of the three that
write", the three asserted **one by one** so a regression names what it let
through, with a sibling that sets a `codebase` goal and proves the goal cannot
buy a participant a writing tool.

`executor/workspace.ts` is the briefing: `walkTree` (sorted, directories first,
capped at 200 entries and depth 3, files over 1 MB and `SKIPPED_TREE_DIRS` left
out), `formatTree`, a hand-written `.gitignore` parser, `gitInfo`, and
`buildWorkspaceSection`. The `ignore` package was the alternative and was
rejected on a narrow argument rather than on principle: nothing in this module
decides what may be **read** — `paths.ts` is the boundary — so a pattern parsed
wrongly costs one extra line in a listing, which is not worth a dependency. The
parser covers what a root `.gitignore` contains (comments, blanks, `!`, a
trailing `/`, a leading `/`, `*`, `?`, `**`, last match wins) and only the
folder's own file is read; nested ones are in the backlog. Two decisions in the
section itself: the git half is added for a **`codebase` goal only**, because
`git status --short` in a working repository is dozens of lines nobody in a
`document` chat asked for; and the read-only sentence is left out for the
**executor**, whose own section already lists all seven tools — the same
instruction in two wordings is followed less reliably than one. `gitInfo` is
`spawnSync` with a 2 s timeout and every failure mapped to `null`, so a folder on
a stalled mount costs the briefing its git half rather than costing the chat its
turn.

`agents/materials.ts` is the other half, and its two rules are the ones worth
arguing about. The budget is a **fixed 25 % of the context window**, not what the
history leaves over: the materials are assembled once per turn while the history
grows all chat long, so a leftover rule would inline a document in round one and
silently drop it in round six — a group that was quoting it would stop being able
to, for no reason it could see. And once one item does not fit, **the rest are
listed** rather than skipped over in favour of whatever still fits: a contiguous
prefix is something a user can predict from the order they wrote, and each item
is capped at 64 KB first, so one enormous file cannot starve a list on its own.
A folder expands into its listing plus its files, so the cut falls between files;
a binary file is listed and never inlined (extension first, then the same
null-byte probe `read_file` uses, now exported so "binary" means one thing in the
product); a material deleted since it was saved is dropped **silently** rather
than listed, because listing it would tell the model to `read_file` something
that will answer "no such file".

The prompt order is unchanged where it matters and extended at both ends of the
reference material: `Workspace` sits with the executor section (protocol — which
folder, what is in it, what you may do to it) and `Materials` goes **last**,
after skills and memory, because it is the bulkiest and purest reference material
in the prompt and the same argument that puts skills after the briefing puts the
document after skills — last is also immediately before the history it grounds.
`buildSystemPrompt` split into `buildTurnPrompt` (returning `{ text,
materialsOmitted }`) and a one-line wrapper, so the count reaches
`AgentTurnResult` without every test that asserts on a prompt having to unwrap an
object; the prompt is memoised **inside** `runAgentTurn` rather than hoisted out
of `consume`, because `consume` runs twice for a model whose provider rejects
tools and because a failure while assembling it has to stay on the turn's own
error path — `runAgentTurn` promises never to throw.

The notice is the one place this step deliberately differs from the thing it was
told to mirror. `contextTruncated` is once per run per agent; `materialsTruncated`
is once per **chat**, because the materials are a property of the goal and are
identical in every round of every run until the user edits the list, so a second
sentence would say exactly what the first said. The dedupe is therefore a scan of
the transcript for an existing notice with that key behind a boolean field
`#loop` does not clear — which also means a relaunch does not repeat it. Only the
first agent that trimmed is named: different members have different windows and
therefore different budgets, and naming each would be one complaint written four
ways.

Tests: `executor/workspace.test.ts` (22) covers the walker against real temporary
folders — order, depth, the entry cap and its marker, the always-skipped folders,
the size cap, and a `.gitignore` with a comment, a bare name, a `dir/`, a `*.tmp`
and a `!keep.tmp` — the parser's anchoring, `?`, `**` and negation rules and that
an uncompilable pattern throws nothing, `gitInfo` in and out of a repository, and
the section's five shapes; `agents/materials.test.ts` (14) drives the budget with
a deliberately tiny `contextWindow` rather than megabyte fixtures: list order, a
folder expanded, nothing fitting, a prefix inlined with "the rest" listed
(including the small file behind the large one that is *not* rescued), the share
respected across twenty files, a binary file listed without spending budget, a
missing and an escaping material dropped, and the per-file cut; `agent-turn.test.ts`
gained a six-case S5.11 block — the four tools and the three absences, the folder
and its listing in a participant's prompt, a marked material present while an
unmarked file's contents are not, a real `read_file` call coming back with the
file, `materialsOmitted` reported, and a folderless chat getting neither tools nor
section; `chat-runner.test.ts` gained the notice once per chat and none when the
materials fit. `npm test`: 85 files, 1337 tests, all passing; `npm run typecheck`
clean. `e2e/executor.spec.ts` ran after `npm run build` with `qwen2.5:3b`
present, so nothing was skipped: **13 passed**, including the new case — two
participants, one marked file, a first reply that quotes its codeword with
`tool-card` count 0, and a follow-up that produces a `read_file` card on the file
nobody marked, with no permission card anywhere. The per-turn tree walk, the root
`.gitignore` limitation and the panel's silence about what will fit are in the
Phase 6 backlog. Docs: `docs/features/{executor,agent-turn,chats}/` (all four
each) plus `docs/features/{orchestration,i18n}/`.

### S5.12 Goal-aware delivery `[x] (2026-09-13)`
What: the goal changes what "done" means, and the app shows it.
- `document`: after any executor turn, if the deliverable now exists, the
  turn's message gains a `FileRefPart` to it and the header chip flips to
  "delivered"; the hand-off briefing tells the executor to write the
  deliverable (creating parent folders) and to finish with a two-line summary.
  A new quick action in `actions-card.tsx`, "Write the deliverable", is the
  hand-off with that instruction, enabled under the same rules as
  `chat-handoff`.
- `codebase`: the review round (S5.6) is briefed with the goal, so reviewers
  judge the diff against it; the hand-off briefing includes the branch and
  asks for a summary that lists changed paths.
- `discussion`: unchanged, except that the goal is in the briefing (S5.10).
- Unit tests: the `FileRefPart` appended when the deliverable appears and not
  otherwise; the review briefing includes the goal; the quick action's
  enabled rule. e2e (Ollama-gated): a `document` goal, "Write the
  deliverable", Allow on the prompt, the file exists, the chip reads
  "delivered", clicking the chip calls `system.openInEditor` once (stubbed as
  in S5.7's spec).
Acceptance: the three kinds behave as the table in PLAN.md says; tests pass.
Docs: `docs/features/orchestration/`, `docs/features/executor/`,
`docs/features/chats/` (all four each).
Done: the step is **one argument, one part and one prompt block**, and each of
the three was the choice worth arguing about.

`chat.handoff` takes an optional `intent` — `'implement'` (the default, S5.6
unchanged) or `'deliver'` — rather than gaining a second method. The two differ
in the notice key they store and the paragraph the executor's briefing gains, and
in **nothing else**: the same executor is picked by the same rule, the same user
message shape is stored, the same two staged rounds run, and `#loop` carries the
intent beside the executor id without reading it. A `chat.deliver` would have
been `handoff()` copied for the sake of its last paragraph, and the four refusals
would then have had two orders to keep in step. `contracts.test.ts` pins the
argument as optional, which is what lets the old button keep sending nothing:
the backend's default is the one that decides what a plain hand-off means, and
the renderer omits the field rather than spelling `'implement'` out. The fourth
`ValidationReason`, `handoff_no_deliverable`, is checked **after** the folder and
the executor and **before** the run — the transient rule is last, so a chat that
is both running and has nothing to deliver is told about the deliverable, which
is the one that will still be true in a minute. `handoffBlocker` grew the same
argument rather than a `deliverBlocker` wrapper, for the same reason: a wrapper
would have had its own idea of where the new rule goes.

The `FileRefPart` rule is **the turn that delivered it, and only that turn**: the
deliverable was not on disk when the turn started and is on disk now, sampled by
two `existsSync` calls bracketing the stream. "Every executor turn while the file
exists" would put a chip on the turn that fixed a typo in it, which is a claim
that turn did not earn — the same argument `diffPartsFrom` already makes about
`git_diff` — and "the first executor turn in a chat whose deliverable exists"
needs a transcript scan and still cannot tell a file this chat wrote from one
that was lying in the folder when it opened. The consequences are deliberate and
each has a test: a rewrite gets no second chip (its `DiffPart` is the record), a
deliverable that predates the chat gets none (the header chip has said
"delivered" since it was opened), a file deleted by hand and written again gets a
new one, and a participant never gets one whatever appeared while it spoke. It is
not conditional on a *write tool* having run, because `run_command` produces
files and returns no patch. `deliverablePath` moved into `executor/paths.ts` so
`chats.goalStatus` and the turn compute the same path from the same code.

The review round (S5.6) was, until now, the only round in the product that was
never told what it was: four models handed a diff and left to guess. `reviewing`
adds one block to the **group briefing** — not a section of its own — placed
immediately after the goal, because "judge it against the goal above" is only
true if the goal is one line up; a chat with no goal gets the same block pointing
at the conclusion in the transcript, since a hand-off without a goal is legal.
The `codebase` half of `goalHandoffLine` gained the **branch** and the request
for a summary listing changed paths, which meant `buildTurnPrompt` had to run
`gitInfo` itself and hand the one result to both the executor section and the
workspace section: two probes would be two `spawnSync` calls on a large
repository and a chance for one prompt to name two branches.

Two things the step changed that were not in its text. `buildExecutorSection`
became an options object, because a fourth positional parameter after
`(workdir, handoff, goal)` is where a call site starts getting them wrong. And
`loadGoalStatus` now writes **nothing** when the answer is unchanged — which is
not a tidiness pass but a bug this step introduced and the end-to-end suite
caught: refreshing the query at every round boundary meant a fresh
`ChatGoalStatus` object during a streaming reply, the chat page re-rendered, and
`react-virtuoso` re-measured the row the cursor was in. The chip's new moments
are the round boundary and the end of the run, which between them cover a
hand-off (the executor writes in its own round; the review round starting is what
flips the header while the reviewers are still reading) and every other executor
turn.

Tests: `agent-turn.test.ts` gained a seven-case `runAgentTurn and a document goal`
block (the chip appearing and the four ways it must not, the review block in a
reviewer's prompt and not an ordinary one, the deliver briefing in the
executor's); `briefing.test.ts` gained seven across both languages, including
that the review block is byte-for-byte absent in an ordinary round and that it
lands after the goal; `tools.test.ts` gained four (the deliver paragraph and its
two-line summary, the implement one unchanged, all three shapes sharing one
prefix, and the branch); `paths.test.ts` four for `deliverablePath`;
`chat-runner.test.ts` seven (the `handoffDeliver` notice with the relative path
and the same two rounds, the briefing reaching the executor and the notice
reaching the reviewers as prose, the review round told and the executor not, the
round after it told neither, the refusal with no goal and with a `codebase` one,
the folder and the executor still checked first, and an unknown intent);
`handoff.test.ts` five for the new rule and its place in the order;
`stores/chats.test.ts` one for the unchanged-answer rule; `stores/run.test.ts`
one for the intent on the wire; plus `contracts.test.ts`. `npm test`: 85 files,
1374 tests, all passing; `npm run typecheck` clean. `e2e/executor.spec.ts` ran
after `npm run build` with `qwen2.5:3b` present, so nothing was skipped: **15
passed**, including the two new cases — the quick action's four disabled states
with the backend refusing on the same rule, and the whole delivery: the action
clicked, `handoffDeliver` in the transcript, Allow on the permission card,
`docs/RELEASE.md` on disk, the header chip flipping to `data-delivered="true"`
with nobody touching the goal, and the chip a real button carrying
`data-path="docs/RELEASE.md"`. The chip's **click is not driven**, for the reason
S5.7 recorded. The rest of the end-to-end suite was re-run for the chat-page and
Actions-card changes: 82 passed, with one pre-existing failure that is not this
step's — `chat.spec.ts`'s streaming-cursor race, which fails on a *warm* Ollama
whenever the reply finishes between the two assertions, and which was confirmed
to fail three times out of three on `3688233` under the same conditions. Docs:
`docs/features/{orchestration,executor,chats}/` (all four each) plus
`docs/features/{agent-turn,backend-client,editor,i18n}/`.

### S5.13 Google sign-in `[x]` (2026-09-13)
What: the Google provider gains the same authentication choice the Anthropic
one has (S5.3): paste a Gemini API key, or sign in with a Google account. The
mechanism mirrors S5.3 exactly — delegate to the official CLI, store no token
of our own, only rewrite request headers.
- **Mechanism: `gcloud` application-default credentials.** `gcloud auth
  application-default login` runs Google's OAuth flow in the browser and
  stores a refresh token under `~/.config/gcloud/application_default_credentials.json`;
  `gcloud auth application-default print-access-token` prints a short-lived
  access token, refreshing it when needed; `gcloud auth application-default
  revoke` signs out; `gcloud config get-value project` and `gcloud auth
  application-default set-quota-project <id>` name the Google Cloud project
  the usage is billed to. Requests then carry `Authorization: Bearer <token>`
  and `x-goog-user-project: <project>` and must **not** carry
  `x-goog-api-key`. The user needs the Google Cloud SDK installed (`brew
  install --cask google-cloud-sdk`) and a project with the Generative
  Language API enabled and billing attached — the sign-in panel says so.
  Not used, deliberately: the Gemini CLI / Antigravity OAuth client and the
  `cloudcode-pa.googleapis.com` Code Assist endpoint that pi's extension
  reuses. Those tokens are first-party to Google's own tools and are the same
  shape as the Claude Code tokens Anthropic now refuses; Witena uses only the
  public Gemini API with credentials the user's own CLI holds.
- Data: `ProviderInput.auth` (S5.3) accepts `'oauth'` for `type === 'google'`
  as well, with no custom `baseUrl`; the S5.3 validation reasons apply. No
  migration (the column exists). `providerRequiresApiKey` returns false.
- `src/main/providers/google-cli.ts` (Electron-free, `node:child_process`):
  a `GoogleCli` interface injected into the registry — `status()`, `login()`,
  `logout()`, `accessToken()`, `project()` — with the real implementation
  spawning `gcloud`. Resolve the binary as S5.3 does for `ant` (`PATH`, then
  `/opt/homebrew/bin`, `/usr/local/bin`, `~/google-cloud-sdk/bin`, with a
  `WITENA_GCLOUD_BIN` override). Status is derived from
  `print-access-token` succeeding plus the ADC file's presence and the
  configured project; a missing binary maps to `gcloud_missing`, no ADC to
  `gcloud_not_logged_in`, no project to `gcloud_no_project` (new
  `BackendErrorCode`s, translated in the renderer). The status sent to the
  renderer carries `account` (from `gcloud auth application-default
  print-access-token` is opaque — read the account from `gcloud config
  get-value account`) and `project` only; tokens never leave the main
  process. Tokens are cached in memory until 60 s before their expiry
  (`gcloud auth application-default print-access-token --format=json`
  reports it if available; otherwise assume 55 minutes).
- Model construction: `createGoogleGenerativeAI({ apiKey: '', fetch })`
  with a wrapper that deletes `x-goog-api-key`, sets `Authorization` and
  `x-goog-user-project`. `providers.fetchModels` and
  `providers.testConnection` go through the same wrapper. Generalise the
  S5.3 header-rewriting `fetch` helper so both providers share it.
- Backend methods: extend `providers.authStatus` / `login` / `logout` to
  take `{ type: 'anthropic' | 'google' }` (keep the contract test in step)
  rather than adding three more methods.
- Provider editor: the S5.3 "Authentication" control is enabled for the
  Google type (it was disabled with a hint); the sign-in panel shows the
  account and project, "Sign in", "Sign out", and — when no project is set —
  a project id `Input` that calls `set-quota-project`. OpenAI stays disabled
  with its hint.
- Unit tests: the shared fetch wrapper for both header sets; `google-cli.ts`
  against a fake `gcloud` script on `PATH` (missing, logged in, not logged
  in, no project, failing exit); validation (`oauth` accepted for google,
  still rejected for openai); the registry building an oauth Google model;
  the editor's control enabled for google.
- e2e: `e2e/providers.spec.ts` gains the Google sign-in panel's "not
  installed" state (launch with `WITENA_GCLOUD_BIN` pointing nowhere).
- Real-API check, as in S5.3: `gcloud` 553 is installed on the development
  machine; if the developer has run `gcloud auth application-default login`
  and set a quota project, build the provider through the registry and run
  `fetchModels` and one `generateText`; report what came back. If ADC is
  absent, say so — do not run the login yourself (it needs the browser and
  the user's account).
Acceptance: with ADC present and a project set, a Google provider in sign-in
mode passes Test connection, lists models and completes a chat turn with no
key stored; without `gcloud` the panel explains what to install; the tests
above pass. Docs: `docs/features/providers/` (all four).
Done: three things were **generalised** rather than duplicated, and each of them
is the reason the other two were cheap. `oauthFetch` now takes the vendor's edits
as data — `remove` the API-key header, `set` the headers whose value comes from
the credential, `merge` into a comma-separated list one the SDK also writes —
because the risk it exists to manage is *forgetting an edit*, and one place that
applies them is the only way that cannot happen twice. `cli-process.ts` holds the
`PATH` search and the child process, because sixty lines of ENOENT-versus-exit-code
handling gets fixed in one copy and not the other. And `anthropic-sign-in.tsx`
became `provider-sign-in.tsx` with a `type` prop rather than gaining a Google
sibling: the three states, the busy flag, the error line, the two buttons and the
"Sign in doubles as look again" rule *are* the component, and what differs is
three strings, an install command and one extra control. `AnthropicAuthStatus`
became `ProviderAuthStatus` for the same reason — every consumer treats it as
"the machine's login state plus a few labels", and which labels a vendor fills is
a fact about the vendor, not about the shape.

The `{ type }` argument went on the three existing methods, as the step asked. A
fourth method was still needed — `providers.setQuotaProject` — and it is
deliberately *not* `{ type }`-shaped: a quota project is a Google concept with no
Anthropic counterpart, and a method that is meaningless for half of its own
argument's values is worse than one named after what it does.

**Everything parsed was checked first.** `gcloud auth application-default
print-access-token --format=json` prints one **object** whose token field is
`token`, not `access_token`; its `expiry.datetime` is a **naive UTC** timestamp
(05:14:51 while `date -u` read 04:14:51), so the `Z` is appended rather than
letting the platform apply the local zone — which would be wrong by the offset
everywhere outside UTC, and wrong in the unsafe direction east of it. `gcloud
config get-value account` is **not** parsed: its unset answer is the word
`(unset)` on stderr with an empty stdout and exit code 0, which is prose
pretending to be a value; `config list --format=json` omits the key instead and
answers account and project in one spawn. With no ADC, `print-access-token` exits
**1** after about ten seconds — it probes the Compute Engine metadata server three
times first — which is why the read timeout is 60 s rather than S5.3's 30 s.

A **missing quota project is not a fourth state**: the user is signed in, the
panel says so and offers a field, and `gcloud_no_project` is raised only where a
request actually has to be made (the fetch wrapper, which asks `project()` before
it asks for a token, so nothing is sent). Save accepts a project-less Google
provider on purpose — refusing it would make a one-field gap look like a broken
login.

**The real-API check could not be completed, and the reason is new information.**
ADC appeared on the development machine during the run (the developer signed in),
so the wrapper was driven against the real `gcloud` 553.0.0: from a
`launchd`-shaped `PATH` of `/usr/bin:/bin` it found the binary in
`/opt/homebrew/bin`, reported `signed-in`, parsed the expiry (one hour out),
returned a live `ya29.` token and rejected `gcloud_no_project`, there being no
quota project. But a bare `curl` of `GET
https://generativelanguage.googleapis.com/v1beta/models` with `Authorization:
Bearer <ADC token>` answers **HTTP 403 `ACCESS_TOKEN_SCOPE_INSUFFICIENT`**, with
and without `x-goog-user-project`. The token carries the ADC defaults (`openid`,
`userinfo.email`, `email`, `cloud-platform`, `sqlservice.login`), so the endpoint
wants a scope `cloud-platform` does not imply — probably
`https://www.googleapis.com/auth/generative-language.retriever`, which `gcloud
auth application-default login --scopes=…` can request. That flag was **not**
added speculatively: it turns a login known to complete into one that might be
refused at the consent screen, and proving otherwise needs a browser and the
user's own account, which this step is explicitly not allowed to drive. So the
acceptance sentence is **unverified end to end**, and both halves of that — the
missing quota project and the scope — are in the Phase 6 backlog.

Tests: `google-cli.test.ts` drives the **real** implementation against a fake
`gcloud` (33 cases), mirroring `anthropic-cli.test.ts` — resolution, all three
states, signed-in-with-no-project, the `config list` fallback *and* the proof it
is not spawned when the ADC carries both labels, the cache and its 55-minute
assumption, `stdout` never reaching a message, and a refused project id.
`registry.test.ts` pins both header sets through the one wrapper and proves a
project-less Google credential makes no request at all. `handlers.test.ts` covers
the `{ type }` routing, the Google refusals of Save, a project-less provider
saving anyway, `setQuotaProject`, and `fetchModels` carrying the two headers with
**no `key=` in the URL** — an empty `?key=` beside a bearer token is refused, so
`discovery.ts` now omits the parameter rather than sending it blank.
`e2e/providers.spec.ts` relaunches with `WITENA_GCLOUD_BIN` pointing at nothing
alongside `WITENA_ANT_BIN` and adds the Google case on that run: the control is
live rather than disabled, the panel is `data-auth-type="google"`, the install
command is the cask one, and Save is refused with `gcloud_missing` — the Google
code, which is exactly what a single shared status would have got wrong. Docs:
`docs/features/providers/` (all four) plus `backend-client` and `i18n`, which the
changed signatures and the three new codes made out of date.

### S5.14 Discussion closure `[x] (2026-09-13)`
What: three small product rules the first real use surfaced. Thinking is not shown
for open models unless asked; a discussion that has reached agreement stops and
hands the user the conclusion; a vote is one round.
- **Thinking hidden by default on open models.** `Agent.params.reasoning` changes
  meaning from "ask for reasoning output" to **"show thinking"**: when it is not
  `true`, `agent-turn.ts` discards `reasoning-delta` parts instead of storing
  `ReasoningPart`s (the model still thinks; provider options are unchanged), so
  the transcript shows the answer only. The default is decided when an agent is
  created (`agents.create` and `createFromTemplate`): `false` for a provider that
  is local or `openai-compatible` (the open-model route: Ollama, DeepSeek,
  Moonshot, vLLM …), `true` for `anthropic`, `openai` and `google`. Existing
  agents keep whatever they have; an agent with the field absent follows the same
  provider rule at turn time. The toggle's label and hint in both locales say
  "Show thinking".
- **Agreement ends the chain.** The group briefing gains a rule beside `[PASS]`:
  in an automatic round a participant ends its reply with `[AGREED]` when it has
  nothing to add and accepts the position on the table, otherwise with
  `[CONTINUE]`. Both markers are stripped from the stored text the way `[PASS]`
  is (`@shared/pass` grows into `@shared/markers`, with tests; keep the old export
  name working or update every import). `ChatRunner`: after a round in which
  **every** participant who spoke (executors excluded; the round after a hand-off
  keeps its S5.6 behaviour) ended with `[AGREED]` and no mention is pending, the
  runner stops scheduling rounds, stores a `notices.consensus` system line, and
  runs one **closing turn** by the first member in speaking order with a closing
  briefing: state the group's conclusion for the user in a few lines, no new
  arguments, no marker. The user's next message starts a new chain as usual. A
  round with any `[CONTINUE]`, or with no marker at all, continues under
  `maxAutoRounds` exactly as today. Applies in `roundrobin` mode; in
  `mention-only` mode the chain is `@`-driven and the markers are stripped but
  ignored.
- **A vote is one round.** `ChatSendInput.rounds?: number` (1 … `MAX_AUTO_ROUNDS`)
  overrides `chat.settings.maxAutoRounds` for the chain that message starts; the
  actions card's "Start a vote" passes `rounds: 1`, so every member answers once
  and the run ends with a `notices.voteClosed` line rather than the max-rounds
  notice. Validation in the handler; the contract test updated.
- Unit tests: reasoning deltas dropped when the flag is off and stored when on;
  the creation default per provider type; marker parsing and stripping for both
  markers and their absence; the runner stopping on unanimous `[AGREED]`,
  continuing on one `[CONTINUE]`, ignoring executors, the closing turn's briefing
  and the notice; `rounds: 1` ending after one round with the vote notice;
  `mention-only` ignoring the markers.
- e2e (Ollama-gated as the other specs are; `qwen2.5:3b` and `qwen2.5:1.5b` are
  present on this machine): a two-agent chat whose prompts tell both to agree
  immediately ends after one round with the consensus line and a closing message;
  "Start a vote" produces exactly one round. Run after `npm run build` and report
  honestly.
Acceptance: the tests above; a discussion that agrees stops by itself with a
conclusion; a vote never runs a second round. Docs:
`docs/features/orchestration/`, `docs/features/agent-turn/`,
`docs/features/agents/` and `docs/features/chats/` (all four each).
Done: the three rules turned out to share one property — **each is a place where
the product was storing or scheduling more than the user asked for** — and none of
them needed a new mechanism.

*Show thinking.* `params.reasoning` had never been read: no provider option was
ever derived from it, so "ask for reasoning output" described nothing. Giving it
the meaning its position already implied cost one `case` in `agent-turn.ts`'s
`fullStream` switch — a hidden `reasoning-delta` is dropped before `appendDelta`,
so it is neither stored nor emitted, while the `ctx.supervisor.activity` call
above the switch still counts it, because the model really is working. The
decision itself is `showsThinking(ctx, agent)`, read once per turn: the agent's
own boolean when it has one, and otherwise `showsThinkingByDefault(provider)` from
`@shared/presets` — false for a local or `openai-compatible` provider, true for
the three first-party adapters. That same function is what `agents.create` writes
into a new agent's `params` (`withThinkingDefault`), which is why the default
lives in the handler rather than in the three renderer call sites: the editor's
Save, Duplicate and the first-run card's `createFromTemplate` all go through
`agents.create`. `undefined` therefore keeps meaning "nobody has chosen" rather
than `false`, and the editor's toggle renders the *effective* answer
(`draft.params.reasoning ?? showsThinkingByDefault(provider)`) so the switch never
moves under the user at Save. `agents.update` deliberately does not re-apply the
default: moving a Claude agent to Ollama is not the user changing their mind.

*Agreement.* `src/shared/pass.ts` became `src/shared/markers.ts` and every import
was updated rather than aliased — four call sites, and a name that lied would have
been worse than the churn. `closureMarker(text)` reads `[AGREED]` / `[CONTINUE]`
off the very end of a reply and answers `null` for anything else **including
`[PASS]`**, which is what keeps an abstention out of the consensus test;
`stripTrailingMarkers` removes all three the way S4.3 removed one, at the two
places the text is read and never from the stored parts. The runner's half is
`#agreed`, six conditions that are all the same conservatism — `roundrobin` only,
not a hand-off's rounds, nothing mentioned, nothing pending, at least one
non-executor speaker finished, every such speaker ending with `[AGREED]` — because
the failure that matters is a discussion cut short, not one that runs a round too
long. A missing marker means "carry on". `#runClosing` is then an **ordinary round
with one speaker**: it bumps `#round`, emits `run.round`, and passes
`closing: true`, so Stop, the barrier, presence and the usage accounting all work
on it with no case of their own. `scheduling.ts` was not touched at all.

The briefing's new rule is **one line, not two**, and that is the one thing here
that was measured rather than reasoned. Two lines of marker protocol pulled a 3B
participant's attention off the workspace briefing far enough that
`e2e/executor.spec.ts`'s "answers from the materials" started failing — the model
reached for `read_file` instead of the context it had already been given. Collapsing
the rule to one line put it back. A briefing is a budget.

*The vote.* `ChatSendInput.rounds` is held in `#pendingRounds` and taken into a
loop-local at the same boundary that resets `roundsSinceUser`, so the cap and the
counter it caps always move together; it dies with its chain. It is checked
**twice** — at the top of the next iteration beside `maxAutoRounds`, and again at
the end of the round that just ran — because a vote whose answers mention nobody
schedules nothing and would otherwise leave through the empty-plan branch in
silence. The cap is tested before agreement: the user named the number. The
renderer threads an optional `rounds` through `ActionsCard.onSend` →
`composer.submitText` → `runStore.send` → `chat.send` rather than giving the vote
a backend path of its own, which keeps the Actions card's own rule intact — the
transcript still records exactly the sentence that was asked.

Tests: `markers.test.ts` (24 cases), a 19-case
`ChatRunner (discussion closure)` block, four reasoning cases in
`agent-turn.test.ts`, the creation default per provider type in
`handlers/agents.test.ts`, `showsThinkingByDefault` in `presets.test.ts`, the
closing block in `briefing.test.ts`, `rounds` in `run.test.ts` and
`contracts.test.ts`. `e2e/closure.spec.ts` drives both rules against real
`qwen2.5:3b`; its consensus test asks in a fresh chat up to three times, because
what is unreliable is a 3B model writing the marker (about three runs in four,
with a system prompt written for the purpose) rather than the runner reacting to
it — the file's header records the three ways it failed first. Docs: all four
documents of `orchestration`, `agent-turn`, `agents` and `chats`, plus
`i18n/backend.md` for the two new notice keys.

### S5.15 Executor command safety and visible grants `[x]` (2026-09-17)
What: `run_command` stops being "anything the user clicks Allow on", and "always
allow" stops being invisible.
- **A command policy**, pure and unit-tested (`src/main/executor/command-policy.ts`):
  tokenize the command line (quotes, `;`, `&&`, `||`, `|`, redirections, `$(…)`
  and backticks) and classify it as `blocked`, `dangerous` or `normal`, with a
  machine-readable reason. `blocked` never runs and never prompts — the tool
  returns an error the model reads: privilege escalation (`sudo`, `su`, `doas`),
  disk and device writes (`mkfs`, `dd of=/dev/…`, `diskutil erase…`),
  shutdown/reboot, fork bombs, and a recursive delete or chmod/chown whose target
  resolves to `/`, `~`, `$HOME` or outside the working directory. `dangerous`
  always prompts, ignores any "always allow" grant, and the card shows a warning
  with the reason: any other recursive delete, `git push`, `git reset --hard`,
  `git clean`, history rewriting, package publishing, a download piped into a
  shell, command substitution, a path argument that resolves outside the working
  directory, background processes (`&`, `nohup`). Everything else is `normal` and
  behaves as today. The policy is a guard rail, not a sandbox — say so in the docs.
- **A write sandbox on macOS**: `run_command` runs under `/usr/bin/sandbox-exec`
  with a generated profile that allows reads everywhere the user can read, and
  allows writes only under the working directory, the system temp directories and
  `/dev/null`-style devices; network stays allowed.
  `AppSettings.executor.sandbox: 'workdir-write' | 'off'` (default
  `'workdir-write'`), surfaced in Settings → Developer with an explanation; when
  `sandbox-exec` is missing the tool runs unsandboxed and says so once through a
  `notices.*` line. Test against the real `sandbox-exec` on this machine: a
  command that writes outside the folder fails, one that writes inside succeeds.
- **Grants are stored and visible**: a `permission_grants` table (additive
  migration: `chat_id`, `tool_name`, `created_at`, unique on the pair) replaces
  the in-memory set; `permissions.grants.list({ chatId })` and
  `permissions.grants.revoke({ chatId, toolName })` added to `BackendApi`,
  `BACKEND_METHODS` and `contracts.test.ts`; deleting a chat deletes its grants.
  The chat's Group settings gain an "Always allowed" list with a revoke button
  per row (test ids `grants-list`, `grant-row`, `grant-revoke`); empty state when
  there are none.
- **A prompt times out**: a pending `permission.requested` is auto-denied after
  `AppSettings.timeouts.permissionTimeoutMs` (default 5 minutes, configurable
  next to the other timeouts), resolving with reason `timeout` in
  `permission.resolved`; the model reads "the user did not answer in time".
- The permission card shows the policy verdict for `run_command`: nothing for
  `normal`, a warning line with the translated reason for `dangerous` (and no
  "Always allow" button). All strings through `t()` in both locale files; reasons
  are codes translated in the renderer.
- Unit tests: the policy table (each blocked and dangerous rule once, plus
  look-alikes that must stay `normal`, e.g. `rm file.txt`, `git status`,
  `echo "sudo"`), the sandbox profile generation and the two real `sandbox-exec`
  runs, grants persisted / listed / revoked / cascade on chat delete, the timeout,
  `dangerous` ignoring a grant, the card's rendering inputs. e2e: extend
  `e2e/executor.spec.ts` offline — a grant written through the backend shows in
  the panel and disappears on revoke.
Acceptance: the tests above; a blocked command never reaches the shell; a write
outside the folder fails under the sandbox; grants survive a restart and can be
revoked. Docs: `docs/features/executor/`, `docs/features/chats/`,
`docs/features/database/`, `docs/features/backend-client/` (all four each).
Done: the step is four independent guards around one tool, and the reason they
belong in one step is that each of them is unsafe without the others. A durable
grant is a standing permission unless it is listed and revocable; a listed grant
is a false promise unless a `git push` ignores it; a policy that refuses `sudo`
buys nothing while an approved `npm install` can still write to the home
directory; and a sandbox that confines writes is no help to a user who walked
away from an open prompt.

**The policy is a guard rail and the docs say so in three places** — the module
header, `executor/context.md` and the Settings copy. `classifyCommand` is pure:
it takes the line, the working directory and the home directory, resolves paths
*lexically* and touches no filesystem, so the whole table is a unit test and a
folder that has been unmounted cannot make it throw. Its own tokenizer, not a
shell parser: quoting, operators and redirections are the three things that make
"which word is the program" wrong, and everything else is noise. Command
substitution is **recorded rather than parsed** — `$(…)` is a second command line
whose nesting a half-parser would get subtly wrong, so it is simply always worth
asking about. The look-alike half of the test table is the half that keeps the
feature usable: `rm file.txt`, `git status`, `echo "sudo"` and `npm test 2>&1`
must stay `normal`, and the last of those cost a rewrite of the tokenizer — a
naive scan read `>` then `&` as "redirect, then background" and flagged every
stderr-merging command in existence.

**A `blocked` command never becomes a card**, which is the decision the rest of
the prompt design depends on: a prompt whose only right answer is Deny teaches
the user that prompts are noise. The model gets `CommandBlockedError` with a
sentence naming the rule and telling it not to work around the limit — English,
like `PermissionDeniedError`, because it is prompt content rather than UI copy.

**The sandbox is `sandbox-exec -p` wrapping `/bin/sh`**, not wrapping the first
program: anything else would confine `sh` and nothing a `&&` chain spawned. The
profile is `(allow default)`, then `(deny file-write*)`, then the allowances —
SBPL takes the *last* matching rule, and the reverse order yields a profile that
looks right and confines nothing, which is exactly why the test shells out to the
real binary instead of asserting on the string. Two things were found that way:
every writable path has to be listed as given **and** realpathed (`/tmp` is
`/private/tmp`, and so is everything `mkdtemp` returns), and the system temp
directories have to be writable or a compiler fails in a way nobody can debug
from a transcript. That last allowance has a consequence stated in the docs
rather than hidden: a chat bound to a folder inside `/tmp` is not usefully
confined against the rest of `/tmp`, which is also why both "a write outside
fails" assertions target the home directory. Reads and the network are
deliberately untouched, so the prompt is still the boundary for what a command
reads or sends — half of S5.4's gap, closed, and the half that is irreversible.

**Persisting the grants reverses S5.4 on purpose.** S5.4 refused, on the grounds
that a grant surviving a restart is a permission the user cannot see; the grounds
were right and the conclusion was half the fix. `permission_grants` is a pure
join table like `chat_members` — the pair is the key, `onConflictDoNothing` keeps
a repeat grant's original timestamp, and `ON DELETE CASCADE` is the whole of
"deleting a chat deletes its grants", asserted straight against the table because
`list` would answer `[]` either way. The gate reaches it through an injected
`GrantStore` (CLAUDE.md rule #5), so its suite still runs against a three-line
array. Two methods rather than one namespace entry: `permission.reply` answers
*a* prompt, `permissions.grants.*` manages a chat's standing grants, and
`permission.grants.revoke` would have read as an operation on the pending
request. `revoke` returns the **remaining** list, because a row that vanished
from the screen while the grant stayed in the database is the precise failure
this step removes.

**`'timeout'` is its own decision**, not a second spelling of `deny`: one of them
means the user looked at the call and said no. The budget is read per prompt
rather than captured at startup, so changing it applies to the next card; `0`
disables it, which is what every suite that answers its own prompts wants.

The card **hides** "Always allow" for a dangerous call rather than disabling it —
the gate ignores a grant for exactly those lines, so the button would be a
promise the product does not keep, and a disabled button invites the user to work
out why. What to draw is decided in `describePermissionCard` and rendered in the
component, the split `goal.ts` and `handoff.ts` already use, so both rules are
unit-tested with no DOM. The sixteen reason codes are translated by a `switch` of
literal `t()` calls rather than a computed key, so `used-keys.test.ts` sees every
one.

`npm test`: 97 files, 1724 tests, all passing; `npm run typecheck` clean.
`e2e/executor.spec.ts` alone: 12 passed, 4 skipped — the four behind the
`qwen2.5:3b` guard, because Ollama was not running on this machine. The new
offline case writes two grants into the closed database with `sqlite3` (the
technique `providers.spec.ts` uses), relaunches, and asserts the list, the
ordering, one revoke and the empty state, against `permissions.grants.list` as
well as against the screen.

### S5.16 The conclusion as a first-class message `[x] (2026-09-17)`
What: when a discussion closes, the user should see *the answer*, set apart from
the talk that produced it, and be able to take it somewhere.
- **A conclusion is marked.** The closing turn's message (S5.14) carries a new
  `ConclusionPart` (`{ type: 'conclusion' }`, a flag part stored first in
  `parts`; no migration). `transcript-rows.ts` and `message-item.tsx` render such
  a message as a distinct card: a "Conclusion" label, the accent edge the design
  tokens already provide, the closing speaker named underneath, and two actions —
  **Copy** (the markdown source) and, when the chat's goal is `document` and the
  hand-off rules of S5.12 allow it, **Write to the deliverable**, which starts the
  `deliver` hand-off with the conclusion quoted in the instruction. The history
  converter treats the part as invisible (the model never sees a flag).
- **The latest conclusion is findable.** The chat header shows a small
  "Conclusion" chip when the transcript holds one; clicking scrolls to it. The
  chat list's preview line for such a chat is the conclusion's first line,
  prefixed by the translated label.
- **Who closes is a setting.** `ChatSettings.closingAgentId?: string` — Group
  settings gain a "Closing speaker" select (members only; default "First in
  speaking order"). The runner uses it when that member is present, available and
  not an executor; otherwise it falls back to the first eligible member, as S5.14
  does today.
- **`mention-only` can close too.** In `mention-only` mode, when a round's
  speakers all ended with `[AGREED]` and nobody was mentioned, the runner closes
  exactly as in `roundrobin` (notice + closing turn). A round that mentions
  someone continues as today.
- Unit tests: the part added to the closing message and to nothing else; the
  history converter ignoring it; the closing-speaker rule with its three
  fallbacks; `mention-only` closing and not closing; the row model for a
  conclusion; the chat-list preview; the deliverable action's enabled rule. e2e:
  extend `e2e/closure.spec.ts` — seed a transcript containing a conclusion through
  the backend client (deterministic, no model needed) and assert the card, the
  Copy button writing the clipboard, the header chip scrolling to it, and the
  chat-list preview; keep the existing model-gated case untouched. Run only
  `e2e/closure.spec.ts` and `e2e/orchestration.spec.ts` (do not run the whole
  suite; other agents share this machine's Ollama).
Acceptance: the tests above; a closed discussion shows one visibly different
conclusion card that can be copied and, for a document goal, written out. Docs:
`docs/features/orchestration/`, `docs/features/chats/` and
`docs/features/agent-turn/` (all four each).
Done: the step is **one part, one setting and one deleted condition**, and the
part is the piece the other two hang off.

*The part.* `ConclusionPart` is `{ type: 'conclusion' }` — a flag with no content
— and choosing that shape over a `MessageKind` or a column is what made the rest
of the step small. `parts` is already the open, migration-free place where a
message says what it is made of, every reader ignores a part it does not know
(the history transform included, which is exactly what keeps the mark out of
every prompt: a model shown it would learn to write one), and a row written
before today simply has none. It is written by `markConclusion` at the
**terminal update** rather than seeded before the stream, which costs one beat of
latency and buys two things: the tool-free retry is gated on `parts.length === 0`
and a seeded part would silence it, and a closing turn that failed would
otherwise be labelled as an answer it never produced. Only a `done` turn is
marked, for the same reason.

*The setting.* `ChatSettings.closingAgentId` is one optional field of the
existing JSON column, and the interesting half is that it is the first setting a
control can **unset**. `undefined` cannot carry that across a transport — JSON
drops the key, and a dropped key is what "leave this alone" already means in a
field-by-field merge — so `null` is the wire word for "clear it", the shared type
gained `ChatSettingsPatch` to say so, and `mergeChatSettings` in the chat
repository is the single place it becomes an absent field again. The stored
`ChatSettings` therefore still reads `closingAgentId?: string`, and the invariant
holds for every caller including a future server. `closingSpeaker` is exported
and pure, with three fallbacks that are three ways a preference goes stale — the
member left, the member is offline, the member turns out to be the executor — and
the fallback is **S5.14's rule unchanged**. The asymmetry there is deliberate and
recorded: the *setting* refuses an executor, because an executor does not vote on
the consensus and is the wrong voice to state one, while the *fallback* may reach
one, because a chat that has nobody else available must still hand back an answer
rather than silently skip the conclusion.

*The deleted condition.* `#agreed` lost `chat.settings.mode !== 'roundrobin'` and
gained nothing. S5.14 had excluded `mention-only` on the grounds that "everybody
agreed" is not a statement one named member can make; that reads the rule wrong.
What closes a chain is that everybody who spoke is finished **and nothing is left
scheduled**, and in `mention-only` the second half is the stronger statement —
the speakers were the ones the previous turn asked for, and they asked for
nobody. A round that does mention somebody is stopped by the `carried.speakers`
condition that was already there, which is that mode's own way of ending a chain.
One deleted line, two tests.

Three smaller decisions. **Copy goes through `navigator.clipboard`**, not through
a new backend method: rule #6 is that the renderer reaches the *backend* only
through `BackendClient`, and the clipboard is not the backend — a
`system.copyToClipboard` would have put a desktop capability into a contract the
server build has to implement. **"Write to the deliverable" is hidden when the
goal is not a document and disabled with its reason otherwise**, because a
permanently dead control on a card in a discussion chat explains a feature that
chat is not using, while the other three refusals are states the user can act on;
it calls the same `handoffBlocker` the Actions card does, through a one-line
`deliverableBlocker`, so the two can never disagree. And a `deliver` hand-off now
**quotes** the chat's latest conclusion as a block quote in the message it
stores (`conclusionQuote`, capped at 2 000 characters): the transcript is
budgeted and its oldest messages fall out of a long prompt while the instruction
never does. Nothing the app wrote is in that quote — the sentence the user reads
is the `handoffDeliver` notice, which is a key.

The card is a **card around the message**, not a copy pinned to the top of the
chat: the transcript is the record, in the order things happened, and a floating
duplicate is a second thing to keep in step with it. The header chip is how it is
found from the top of a long chat, and it *scrolls to* the card — with a nonce,
because clicking the chip twice has to scroll twice, and through a ref rather
than a dependency, because a list that rebuilds on every streamed token would
otherwise drag the viewport back while the next answer arrives.

Tests: `chat-runner.test.ts` gained a six-case `the conclusion as a message
(S5.16)` block plus two rewritten `mention-only` cases and two `deliver`-quote
cases; `agent-turn.test.ts` four (the flag on a closing turn, not on an ordinary
one, not on a failed one, and `markConclusion`); `history.test.ts` two;
`conclusion.test.ts` ten (new file); `transcript-rows.test.ts` two;
`handlers/chats.test.ts` three; `db/chats.test.ts` one. `npm test`: 94 files,
1617 tests, all passing; `npm run typecheck` clean. `e2e/closure.spec.ts` ran
after `npm run build`: **1 passed, 2 skipped** — the new S5.16 case passed, and
the two S5.14 cases skipped because **no Ollama was running on this machine**
(`http://localhost:11434/v1/models` did not answer at all), so their behaviour is
unchanged but unverified in this run; the same is true of
`e2e/orchestration.spec.ts`, whose four cases all skipped for the same reason.
`e2e/members.spec.ts`, `i18n.spec.ts` and `ui-shell.spec.ts` were re-run for the
chat-page and chat-list changes: 13 passed. The S5.16 e2e case needs no model —
it pushes a `message.created` carrying the flag down the app's own event channel,
because **no backend method creates an agent message** (the only writer is
`runAgentTurn`) — and asserts the card, the real clipboard, the chip scrolling
past thirty later messages, and the chat-list preview. Docs: all four documents
of `orchestration`, `chats`, `agent-turn`, `database` and `i18n`.

### S5.17 Light-theme review and a theme-aware avatar palette `[x] (2026-09-17)`
What: S5.8 proved the light theme on a handful of mostly empty screens. This step
looks at every surface with content on it, in both themes, fixes what it finds,
and makes the two things that ignored the theme — agent avatars and provider logo
tiles — follow it.
- **A review harness**: `e2e/theme-review.spec.ts` seeds a realistic installation
  through the backend client (no model needed): providers, three agents with
  different avatars and one executor, a chat with a working directory and a
  document goal, and a transcript that contains every part kind the app renders —
  markdown with a table, a fenced code block, a reasoning block, tool-call /
  tool-result cards (one errored), a diff block, file-ref chips, system notices, a
  conclusion-style closing message if that part exists on `main` when you run, a
  pending permission card (emit the event through whatever test seam exists; if
  none, render the card's component state through the store). It captures
  full-window screenshots of chats, agents (list and editor), every settings
  section (providers with a sign-in panel, MCP with the gallery open, skills,
  timeouts, appearance, developer, about) and the onboarding card, in **both
  themes**, into `test-results/theme-review/`. It asserts nothing visual; it is
  the instrument. **Look at every screenshot** and list what you fixed.
- **Fix through tokens only.** No hex colour outside `index.css` (a unit test
  greps the renderer for hex literals outside `index.css`, the brand mark and the
  stored-data migration table, and fails on a new one). Every new token gets a
  light override; the S5.8 test keeps passing.
- **Avatars follow the theme.** Replace the eight hard-coded
  `{ color, textColor }` pairs with a palette index: tokens `--color-avatar-1-bg`
  / `-fg` … `--color-avatar-8-bg` / `-fg`, tuned for each theme and no longer
  derived from the old amber. `Agent.avatar` gains `palette?: 1..8`; new agents
  store the index. Stored agents that carry a legacy hex are mapped to the nearest
  palette index **at render time** by a pure, tested function (no database write,
  no migration). The user avatar tokens are reviewed the same way. Provider logo
  tiles get the same treatment (a background token per theme; brand marks keep
  their own colours).
- **Accessibility preferences**: under `@media (prefers-contrast: more)`
  strengthen borders and the muted/faint foreground steps in both themes; under
  `prefers-reduced-transparency` remove the translucent surfaces if any exist.
  Record the AA contrast ratios of the foreground steps on every background token,
  per theme, in `docs/features/ui-shell/frontend.md`, computed by a small test
  helper rather than by hand.
- Unit tests: the hex-literal guard; the legacy-hex → palette mapping (each of the
  eight old pairs, and an unknown hex); the contrast helper asserting AA for the
  text steps that carry body copy; the token-override test extended to the new
  tokens. e2e: run `e2e/theme-review.spec.ts`, `e2e/theme.spec.ts`,
  `e2e/ui-shell.spec.ts` and `e2e/agents.spec.ts` only (do not run the whole
  suite; other agents share this machine's Ollama).
Acceptance: every screenshot in `test-results/theme-review/` is readable in both
themes and the write-up says what was wrong and what changed; avatars and provider
tiles change with the theme; the tests above pass. Docs: `docs/features/ui-shell/`
and `docs/features/agents/` (all four each), `docs/features/providers/frontend.md`.
Done: the review found **nine** things, eight of them defects in the app and one
of them the harness lying about the app. Per screen:

| Screen | What was wrong | What changed |
|---|---|---|
| Chat transcript, light | Every avatar in the **message list** was still a dark slab with a pale monogram, while the member panel beside it had already gone pale — the two columns disagreed about the same five agents on one screen | `message-item.tsx` was the last component reading `agent.avatar.color`; it asks `avatarStyle` now. It was missed by the first sweep because its call site spells the props differently from the other six |
| Chat transcript, both | A **passed / skipped** row was drawn at `opacity-50`: its name measured 3.26:1 in light and 4.33:1 in dark, and its `modelId · provider` line 2.17:1 and 2.37:1 — under the floor for any meaningful pixel, in *both* appearances. It had been that way since S2.x | `opacity-70`. A normal row is 13:1 or better, so the row still reads as superseded at a glance; it just no longer crosses into unreadable |
| Every row with a hover state | `fg-dim` and `fg-faint` were 4.00:1 and **2.74:1** on `bg-hover` in dark, 4.41:1 and 3.39:1 in light. Hovering a chat row, an agent row or a settings section took that row's own timestamps and hints below their bar | `fg-dim` → `#969189` / `#665f55`, `fg-faint` → `#7c776e` / `#756f63`. `--color-status-idle` moved with `fg-dim` (it was 4.22:1 on its own surface) and `--color-presence-offline` with `fg-faint` |
| Provider list, preset grid, onboarding tiles | The eight provider monograms were a fixed dark chip in both themes. On the near-white settings page they read as stickers applied to the cards rather than as part of them | `providerLogo` returns a slot from the shared eight-token palette. Two of the eight slots change hue (the two lists had drifted); the hash is untouched, so a preset keeps its slot number |
| Agent editor | The avatar swatch marked as *pressed* was matched by **colour**, which cannot work once one slot is two different hexes | Matched by index, with `data-palette` on each swatch |
| Hovered rows in six components | `hover:bg-bg-hover/50` and `/60` written into six files: the app's only translucent surface was also the one no stylesheet could answer for | One `--color-bg-subtle` token, which is what `prefers-reduced-transparency` now replaces |
| Message error detail, permission card, input focus ring | `text-danger/80` (4.27:1 in light) and two `border-*/60` borders at 2.8–2.9:1 | Solid tokens. The permission card's full-strength accent border is also the better reading for a card demanding a decision |
| Light theme, hovered danger | `--color-danger` was 4.47:1 on `bg-hover` — a hovered row's Delete button just under AA | `#a93636` (4.90:1) |
| The harness itself | Several settings shots caught the 150ms `transition-colors` mid-flight, so the header named one section and the highlight was still on the previous one; and the light pass photographed a provider editor and a permission card the dark pass had left open | The walk reloads the renderer before each appearance, settles 350 ms before each shot, and sends `permission.resolved` after photographing the card |

**The avatar palette is an index, not a migration.** `InitialAvatar.palette` is
`1..8` and the stylesheet holds twenty tokens (eight pairs, a neutral pair, the
human's own). That shape was chosen over the two obvious alternatives for one
reason: the *choice* is data and a small integer stores it exactly, while the
colour has to differ between the appearances — slot 3 is a deep violet in dark and
a pale one in light, and no single stored hex can be both. Rewriting
`agents.avatar` would have made the appearance a **database** concern, with a
migration to write, a downgrade to think about and a half-converted table if the
app were killed during it; instead `nearestAvatarPalette` resolves an old record
to its slot **as it is drawn**, which costs one pure function and cannot fail.
The eight amber-era hexes stay in `agent-display.ts` as the table that mapping
measures against — and as the compatibility shadow a *new* record still writes
into `avatar.color`, so an older build, an export or the future server always has
a colour. They are also why that file is one of three the hex guard exempts, the
others being `index.css` and the brand mark. Provider tiles were folded into the
same eight slots rather than given a second theme-aware list, because the two
lists were already copies that had drifted in two places.

**The contrast is arithmetic now, not a claim.** `lib/contrast.ts` is twenty
lines of WCAG relative luminance; `theme.test.ts` reads both palette blocks as
text and asserts the body-copy steps are AA-normal on all six surfaces, the small
print at least 3:1, every monogram AA on its own tile, every status pill on its
own surface, every presence dot 3:1 on `bg-panel`, and the light foreground steps
no quieter than the dark ones. The full matrix is printed in
`docs/features/ui-shell/frontend.md`, generated from the same function rather than
typed. `contrast.test.ts` pins the instrument against WCAG's own worked example
and makes an unparseable colour **throw** — a silent `NaN` would have made every
one of those assertions pass for the wrong reason.

**The two media queries are each written twice**, once for `:root` and once for
`:root[data-theme='light']`. That is not duplication to tidy up: the light
selector is specificity (0,2,0) and outranks a bare `:root` however late the query
appears, so a single unqualified block would have strengthened the dark theme and
silently done nothing in light — exactly the class of bug this whole step exists
to find. `prefers-contrast: more` moves only the three quiet foreground steps and
the two borders (`fg-faint` 3.30 → 5.32 dark, 3.80 → 6.69 light); the hues that
carry meaning are left alone, because shifting green to gain contrast it does not
need would only make the two appearances disagree about what green means.
`prefers-reduced-transparency` has exactly one surface to answer for, and
`theme.test.ts` asserts `--color-bg-subtle` is the only token with an alpha
channel so a second one cannot appear without the query growing to match.

`e2e/theme-review.spec.ts` reaches around the app in exactly one place and says
so: there is no `messages.append` method and there should not be one, so the
transcript is written into `witena.db` with `node:sqlite` while the app is closed
(`node:sqlite` and not `better-sqlite3`, because `postinstall` rebuilds that one
for Electron's ABI and the Playwright runner is plain Node). Everything else is
honest: records go through `providers.create` / `agents.create` / `chats.create`,
and the pending permission card is a real `permission.requested` sent down
`witena:event` from the main process — `PermissionGate`'s own path through
preload, `event-bridge` and the store. Forty-two screenshots, twenty-one screens
per appearance, all of them looked at; they are gitignored with the rest of
`test-results/`. One note for whoever runs it: the provider sign-in panel shows
the **machine's real** `ant` login state, so a shot of that screen has the
developer's own account in it.

Not done, and why: `about-section.tsx` keeps a `border-border/60` divider on its
licence rows — S7.4's branch owns that file this batch and a one-class change was
not worth the conflict. Nothing measures a *rendered* pixel, so the two remaining
composites (`opacity-70` on a dimmed row, `opacity-45` on a disabled control) were
checked by hand; a guard would need a real browser and a colour sampler. A
streaming cursor and a live presence sweep are still only visible with a model
attached, which is `e2e/presence.spec.ts`'s job. Docs in
`docs/features/{ui-shell,agents}/` (all four each) and
`docs/features/providers/frontend.md`.


## Phase 6: Backlog (decided, not yet scheduled)

Everything below is agreed work that is deliberately **not** in Phase 5. Each
item becomes a numbered step, with acceptance criteria in the Phase 5 shape,
when it is picked up; until then the order here is a suggestion, not a
commitment. A Phase 5 step that leaves something unverified or out of scope
adds a line here in the same commit.

### Provider authentication beyond Anthropic

- **OpenAI sign-in.** "Sign in with ChatGPT" is a gated program for
  third-party apps; the Codex CLI's own ChatGPT login is not licensed for
  reuse. S5.3 ships the `auth` field and a disabled control for OpenAI; enable
  it once program access exists, using the same `auth: 'oauth'` shape and a
  provider-specific fetch wrapper. Verify the policy at implementation time.
- **A Gemini request through a signed-in Google provider, on an account whose ADC
  has the scope the API wants.** S5.13 ships the whole path and proves every part
  of it that can be proved offline, but `GET /v1beta/models` with a default ADC
  token answers 403 `ACCESS_TOKEN_SCOPE_INSUFFICIENT` — the token carries
  `cloud-platform`, which that endpoint apparently does not accept. The likely fix
  is `gcloud auth application-default login
  --scopes=openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/generative-language.retriever`,
  which needs verifying at a real consent screen before `google-cli.ts` starts
  passing `--scopes` — a scope the screen refuses would leave users unable to sign
  in at all. Verify, then decide whether Witena requests the scope itself or the
  panel tells the user which command to run.
- **A Google provider with a quota project, end to end.** The development machine
  has ADC but no project, so "Test connection lists models and a chat turn
  completes" is unverified for Google as well. Needs a GCP project with the
  Generative Language API enabled and billing attached; `providers.setQuotaProject`
  is the control that names it.
- **Vertex AI instead of the public Gemini API.** S5.13 bills the user's own
  project through `x-goog-user-project` on `generativelanguage.googleapis.com`.
  Vertex is the other shape of the same idea — a different endpoint, per-region
  model ids and `@ai-sdk/google-vertex` — and belongs with the cloud-platform
  providers below rather than beside this.
- **A chat turn through a signed-in provider, on an account with API credit.**
  S5.3 proved the headers as far as the API accepts them — `/v1/models` answers
  200 through the OAuth wrapper — but the account used for verification has no
  credit, so `/v1/messages` is refused with `invalid_request_error` ("your credit
  balance is too low") for a bare `curl` as well as through the app. Run the
  acceptance sentence again on a funded account before treating the generation
  path as proven.
- **Several logins of one vendor.** S5.13 added the second vendor's CLI, so
  `providers.authStatus` names which one with `{ type }` — but *within* a vendor
  each CLI still has one active profile, so the status stays a fact about the
  machine. Supporting two `ant` profiles, or two Google accounts, means naming
  which login a provider uses and a picker to choose it.
- **Cloud-platform providers.** Claude on Vertex AI and Amazon Bedrock, GPT on
  Azure, authenticated with the platform's own credentials or SSO rather than
  a vendor key (`@ai-sdk/google-vertex`, `@ai-sdk/amazon-bedrock`,
  `@ai-sdk/azure`). This is the enterprise route to "closed models without a
  key" and reuses the provider registry; it needs its own presets and a
  credential-source model per platform.

### Executor safety and reach

- **The sandbox confines writes, not reads.** S5.15 closed half of S5.4's gap:
  an approved command runs under `sandbox-exec` and can no longer write outside
  the working directory, the temp directories and the null-ish devices. It can
  still read anything the user can read and send it anywhere, so the permission
  prompt is still the whole boundary for that half and the command line is still
  shown verbatim. Confining reads needs a policy for what a build legitimately
  reads (`~/.npmrc`, `~/.cargo`, the toolchain) and is a step of its own; a
  container, or delegating to a coding agent that has one, is the other route.
- **The temp directories are writable, so a working directory inside `/tmp` is
  not usefully confined against the rest of `/tmp`** (S5.15). The allowance is
  deliberate — a compiler that cannot write a temp file fails unreadably — but a
  chat bound to a scratch folder under `/tmp` gets less than the setting's name
  suggests.
- **`sandbox-exec` is deprecated by Apple** (S5.15) and macOS-only, while
  remaining the only thing of its kind on the platform. When it is absent the
  command runs unconfined behind one `notices.sandboxUnavailable` line; a macOS
  that removes it turns the setting into a no-op, and the replacement (an App
  Sandbox entitlement, or a container) is its own step.
- **The command policy can be defeated by a variable or a script** (S5.15). An
  assignment and an expansion is one way round it, and a `./deploy.sh` is not
  read at all. It is a guard rail against the common accident, not a boundary;
  the docs, the module header and the Settings copy all say so, and that has to
  stay true of any rule added to it.
- **Nothing tells the user the policy exists until it fires.** There is no list
  of what is blocked or always asked about, in Settings or anywhere else — the
  first a user learns of it is a refused command or a warning row.
- **A revoked grant does not un-answer a call already in flight** (S5.15). A
  tool released by a grant a millisecond before the revoke landed still runs.
  Holding every gated call until a revoke could not arrive would slow the common
  case down to protect a case that is a race by definition.
- **`search_files` is a substring scan**, with a hard-coded prune list and no
  regular expression or glob. Once `run_command` exists the executor can reach
  for `rg` itself, so the question is whether the built-in should grow or go.
- **`run_command` assumes `/bin/sh`**, which is correct for the macOS-only build
  and needs a branch before any Windows or Linux packaging.
- **A pending prompt is invisible from another chat.** S5.5's card is drawn per
  chat, so a user looking at a different chat is not told that an executor is
  waiting on them — the run simply appears to have stalled until they come back.
  A count on the chat-list row, or a rail badge, is the obvious shape.
- **The `write_file` card previews content, not a diff.** The tool computes the
  patch only *after* the grant (deliberately: the file it would diff against can
  change while the user decides), so the card shows the first 1 200 characters of
  what will be written. `edit_file` already sends its patch. "Allow, but show me
  the diff first" is the open question `docs/features/executor/context.md`
  carries.
- **`maxAutoRounds: 1` buys an implementation but no review.** S5.6's two rounds
  count towards the cap like any others, so a chat capped at one round stops
  after the executor with the `maxRoundsReached` notice. Exempting the review
  round was rejected — the cap is the user's promise that the chat will not run
  away, and a hand-off is the most expensive thing in the product to let run
  away — but a hand-off that *knows* it needs two rounds could say so before it
  starts, or the cap could be raised for the duration with a notice.
- **A hand-off cannot be queued.** It is refused with `handoff_run_active` while
  a run is in flight, and the button is disabled in that state. "Hand it over
  when this round finishes" is the obvious shape, and needs a second pending
  slot in the runner rather than the boolean it has.
- **The review round reads the patches through the tool results**, not through
  the `DiffPart`s: `history.ts` renders `text`, `tool-result` and
  `system-notice` parts, and a `write_file` result already carries its `patch`
  (capped at 4 KB). Rendering the diff blocks into the prompt as well would put
  the same patch in twice; rendering them *instead* would mean parsing back what
  the model already read. Worth revisiting when a turn's tool results start
  being summarised rather than replayed.
- **Almost nothing emits a `FileRefPart`.** S5.12 added the first: the
  deliverable of a `document` goal, on the executor turn that produced it. Every
  other chip a user actually sees still comes from S5.7's text **detector**. A
  turn that reported the files it *read* as parts would be more precise than a
  regular expression over prose, and would make the chip work for a path the
  detector's extension rule refuses.

### Chat goal (S5.10)

- **The two native dialogs are not driven end to end.** `system.pickSavePath`
  and `system.pickPaths` open native modals, which Playwright cannot answer —
  the same gap `system.pickFolder` has had since S3.2. `e2e/executor.spec.ts`
  writes the goal through the backend client instead, and the conversion those
  buttons perform is unit-tested (`relativeToWorkdir`, `pickDeliverable`,
  `pickMaterials`). The buttons themselves, and the `defaultDir` they open in,
  were verified by reading rather than by clicking.
- **The goal chip's click is not driven either**, for exactly the reason S5.7
  records below: `shell.openExternal` would launch the developer's real editor
  and `window.witena` cannot be stubbed from the page. The spec asserts the chip
  is a button carrying the path; the backend accepting that call is asserted
  separately by `e2e/editor.spec.ts`.
- **"Delivered" is polled, not watched.** `chats.goalStatus` runs when a chat is
  opened, on every `chat.updated` for it, and — since S5.12 — at every round
  boundary and at the end of a run, so a deliverable written by something that is
  not this app is noticed at the next such moment rather than immediately. A
  filesystem watcher would make it immediate and would be the first one in the
  product. It is also asked only for the chat that is **open**: a hand-off
  finishing in a chat the user is not looking at leaves that chat's chip stale
  until they open it.
- **`relativeToWorkdir` compares paths exactly.** Both strings come from one
  dialog rooted at the folder, so a case-insensitive volume cannot make them
  differ — but a path assembled some other way, on such a volume, with different
  case, is refused as outside the folder. Case-folding it here would be a guess
  about the volume it lives on.
- **A goal has no history and no per-round scope.** It is one row, replaced in
  place, so a chat that changes what it is for loses what it used to be for —
  including from the briefings of the messages already in the transcript, which
  were written under the old one. Whether that matters is a real question once a
  chat runs for days.
- **There is one way out of a goal: empty its description.** That is deliberate
  (a goal *is* its description, so the way out is the way in) but it is not
  discoverable, and a user who wants to keep the text while turning the goal off
  has to delete it and paste it back.
- **A `discussion` goal may carry materials** as long as the chat has a folder.
  Since S5.11 reads them that is a useful combination rather than an inert one,
  but whether it should exist at all is still an open question in
  `docs/features/chats/context.md`.

### Goal-aware delivery (S5.12)

- **The review round is briefed, not verified.** Reviewers are told to judge the
  executor's change against the goal; nothing checks that they did, and a
  `[PASS]` from every one of them ends the run as an approval nobody wrote. A
  structured verdict — approve / change requested, per reviewer — is the obvious
  shape, and is what a "the group approved this" state would need.
- **A `deliver` hand-off is not told whether it worked.** The review round is
  scheduled whether or not the deliverable appeared; it is the turn's own
  `FileRefPart` and the header chip that say so. A hand-off that ended with
  nothing written could say so in a notice rather than leaving the reviewers to
  notice.
- **The two-line summary is asked for, not enforced.** `DELIVER_BRIEFING` asks
  the executor to close with the path and one sentence; a model that writes six
  paragraphs instead is not corrected, and the review round reads whatever it
  wrote.
- **The deliverable's chip is not driven end to end.** `e2e/executor.spec.ts`
  asserts that the header chip is a real button carrying `data-path` after a
  delivery, and the transcript chip is covered by the unit suite; the **click**
  of either is not driven, for the reason S5.7 records below —
  `shell.openExternal` would launch the developer's real editor and
  `window.witena` cannot be stubbed from the page.
- **A `codebase` hand-off names the branch but cannot hold it.** The executor is
  told which branch the working tree is on and asked not to switch; nothing stops
  `run_command` from doing so, and nothing re-checks the branch afterwards. The
  permission prompt is the only boundary, which is the same gap the shell has.

### Discussion closure (S5.14)

- **Agreement depends on a model following the briefing.** A model that never
  writes `[AGREED]` never closes a discussion, and the chain ends the way it did
  before S5.14. Small local models are unreliable here: `e2e/closure.spec.ts`
  measures roughly three runs in four for `qwen2.5:3b` **with a system prompt
  written for the purpose**, and `qwen2.5:1.5b` does not manage it at all. The
  spec therefore asks up to three times in fresh chats; a product answer would be
  a structured verdict the runner asks for rather than a token it hopes for — the
  same shape S5.12's review round wants, and the two should be designed together.
- **`[AGREED]` is stripped from the history.** Like `[PASS]`, so a later speaker
  cannot see who has already agreed, and cannot learn the protocol from the
  transcript either. Whether the closure markers should survive the history
  transform while `[PASS]` does not is an open question in
  `docs/features/orchestration/context.md`.
- ~~**`mention-only` has no closure rule.**~~ **Closed by S5.16**: `#agreed` no
  longer asks which mode the chat is in. A `mention-only` round whose speakers all
  wrote `[AGREED]` and mentioned nobody closes exactly as a `roundrobin` one does;
  a round that mentions somebody carries on, through the rule that mode already
  had.
- ~~**The closing turn is always the first member in speaking order.**~~
  **Closed by S5.16**, as far as a *choice* goes: `ChatSettings.closingAgentId`
  names the member that closes, and the first eligible one is the fallback.
  Nothing yet **derives** the speaker from the discussion — the member the group
  deferred to, or the one with the largest context window — which would still
  need a second model call or a signal the transcript does not carry.
- ~~**The conclusion is not marked as one.**~~ **Closed by S5.16**: the closing
  turn's message carries a `ConclusionPart` — a flag part, not a `MessageKind` and
  not a column — which the transcript draws as a card, the header chip scrolls to,
  the chat list previews and a `deliver` hand-off quotes.
- **What S5.16 left unverified or out of scope.**
  - The two model-gated cases of `e2e/closure.spec.ts` and all four of
    `e2e/orchestration.spec.ts` **skipped** in S5.16's run: no Ollama was
    running on the machine at the time. The S5.16 case itself needs no model and
    passed.
  - The e2e seeds its conclusion by pushing a `message.created` down the app's
    own event channel, because **no backend method creates an agent message**. It
    is therefore not persisted, and no test reloads the window onto a stored
    conclusion.
  - **The chat-list preview only covers loaded transcripts.** It is computed in
    the renderer from the messages store, so a chat that has not been opened in
    this session shows the member count it always did. Covering every chat needs a
    query of its own — the same shape a "conclusions across chats" view would
    want.
  - **A chat that agreed twice has one current conclusion.** The header chip, the
    preview and the quoted `deliver` instruction all mean the latest; the earlier
    cards stay in the transcript with no way to pin one.
  - **Copy fails silently** when the window may not write to the clipboard: the
    button simply does not say "Copied".
  - **`closingAgentId` is not checked against membership** when it is written.
    Removing that member leaves the id stored, the select shows the default and
    the runner falls back to it, so re-adding the member restores the preference.
  - Exporting a conclusion anywhere other than the clipboard and the chat's own
    deliverable — a file, a share sheet, a cross-chat list of decisions — was
    deliberately left out.
- **A `rounds` cap has no UI of its own.** It is reachable only through "Start a
  vote", which hard-codes `1`. There is no way to say "answer twice and stop" from
  the composer, and no indication in the transcript that a chain was capped until
  the `voteClosed` line appears at the end of it.
- **Hidden thinking is discarded, not counted.** A `reasoning-delta` the agent
  does not show leaves no trace beyond the provider's own usage figures, so the
  transcript cannot offer "thought for 400 tokens" or a way to fetch it back. A
  count on the message would be cheap; storing the text behind a lazy expander
  would not.
- **Changing an agent's provider does not re-apply the Show thinking default.**
  Once the record holds a boolean it holds it, so a Claude agent moved to Ollama
  keeps streaming its thinking into the transcript until the user turns it off.

### Workspace briefing and materials (S5.11)

- **The folder is walked once per turn, not once per round.** The tree is
  memoised inside a turn, so a tool-rejection retry does not walk twice, but four
  members in one round walk the same folder four times and read the same
  materials four times. A per-run cache keyed on the folder is the obvious shape
  and needs an invalidation rule an executor's own writes would trip.
- **Only the folder's own `.gitignore` is read.** Nested ignore files,
  `.git/info/exclude` and the user's global excludes are not, so a monorepo that
  ignores per package lists a few files it would not have. The always-skipped set
  covers the folders that matter, and nothing here decides what may be *read*.
- **The materials panel says nothing about what will fit.** How much of a list
  reaches a model is decided per turn, per model, and the only feedback the user
  gets is the `materialsTruncated` notice after the fact. A size hint next to
  each row would be honest but is a guess until a member is chosen — and two
  members with different context windows genuinely inline different amounts.
- **A material deleted after it was saved is dropped silently.** The panel still
  lists it, the prompt does not mention it, and nothing tells the user which of
  the two is right. The same filesystem watcher the goal chip wants would fix
  both.
- **The tree is a listing, not a map.** It carries no file sizes, no line counts
  and no symbol index, so a model picking what to `read_file` is choosing by
  name. A `search_files` call is the current answer and is a round trip.
- **`git_diff` is attached to every member of a chat with a folder**, including
  in a `document` or `discussion` chat where the git state is deliberately kept
  out of the briefing. It is read-only and harmless, but the set of four is not
  currently narrowed by the goal's kind; whether it should be is open.

### Editor integration (S5.7)

- **The click is not covered end to end.** `system.openInEditor` ends in
  `shell.openExternal`, which would launch the developer's real editor during a
  test run, and `window.witena` is a `contextBridge` object whose methods cannot
  be replaced from the page — so there is no way to intercept the call.
  `e2e/editor.spec.ts` asserts the chip is a real button carrying the path and
  the line, and separately that the backend accepts exactly that call. A test
  hook in the developer settings that stubs the method (S5.7's own suggestion,
  which was not built) would close it; so would a fake editor binary and a
  `custom` command driven through the UI.
- **The acceptance sentence was read, not clicked.** "With VS Code installed,
  clicking a chip in a chat bound to a folder opens that file at that line" is
  proved in pieces — the URL is unit-tested, the round trip is end-to-end-tested
  through a custom command — but no automated run has opened VS Code.
- **The detector cannot tell whether a file exists.** It draws a chip on
  `src/typo.ts:3` and refuses `Makefile` and any path containing a space. A
  cheap batched `exists` check per message, cached per chat, would fix both
  directions; the renderer has no filesystem, so it has to come from the backend.
- **No editor is probed.** Choosing Cursor on a machine without Cursor is
  accepted and fails two seconds at a time on a red chip. Probing at settings
  time, or after the first failure, would be friendlier.
- **A path in a chat with no folder is never clickable**, even when it is
  absolute and unambiguous, because the detector returns nothing without a folder
  to confine against.
- **`{line}` cannot be omitted from a custom template.** A reference with no line
  substitutes 1, because the default template welds `:{line}` on; a template that
  wanted "open the file, no line" has no way to say so.

### Appearance

- ~~**The light theme has not been reviewed on a full transcript.**~~ **Done in
  S5.17.** `e2e/theme-review.spec.ts` seeds a transcript holding every part kind
  and photographs twenty-one screens per appearance. It found four defects in the
  app — the message list's avatars, a dimmed row at 3.26:1, `fg-dim` / `fg-faint`
  under their bar on `bg-hover`, and five components carrying alpha utilities —
  all listed and fixed in that step's `Done:` paragraph.
- ~~**Avatar and provider-logo colours stay dark in both themes.**~~ **Done in
  S5.17**, and the premise turned out to be the mistake: what a record stores is
  the *choice*, which is a palette index, and the colour belongs in `index.css`
  where it can differ between the appearances. No rows were rewritten — a legacy
  hex is mapped to its slot at render time.
- ~~**`prefers-contrast` and `prefers-reduced-transparency` are not honoured.**~~
  **Done in S5.17**, for the three quiet foreground steps, both borders and the
  one translucent token. There is still no *separate* high-contrast palette: the
  media query nudges the existing one rather than replacing it, which is enough
  for `more` and would not be enough for a genuine forced-colours mode
  (`forced-colors: active`, the Windows High Contrast path). Nothing in the app
  is Windows-facing yet, so that stays open.
- ~~**The new accent has not been seen on every accent surface (S7.1).**~~ **Done
  in S5.17** for the permission card, the `@mention` chips and the "Jump to
  latest" pill, all of which the review photographs in both appearances. The
  **streaming cursor** is the one accent surface still unseen: it only exists
  while a model is producing tokens, so it needs Ollama and belongs to
  `e2e/presence.spec.ts` rather than to a seeded transcript. The note about the
  accent reading warm next to `presence-working` stands — the two are 1.15:1
  apart, fine for a dot beside text and wrong if they ever had to be told apart
  on their own.
- **Nothing measures a rendered pixel.** The contrast matrix in
  `docs/features/ui-shell/frontend.md` is computed from token values, so it is
  exact for text on a plain surface and blind to anything composited over it —
  which is how a passed row at `opacity-50` stayed sub-AA from S2.x to S5.17. The
  two remaining composites were checked by hand; a guard would need a real
  browser and a colour sampler.
- **`about-section.tsx` still carries one `border-border/60` divider.** The only
  alpha utility left in the renderer after S5.17, skipped because another branch
  owned that file in the same batch. One class to change.
- **The mark is only drawn at 28 px and up inside the app (S7.1).** Below roughly
  20 px the six blades merge into a ring; the application icon's 16 px variant is
  re-rendered with a thickened stroke for exactly that reason, and no in-app
  surface renders it smaller than the rail's 28 px today. A favicon, a menu-bar
  item or a notification icon would be the first thing that does, and would need
  the same treatment or a simplified mark.
- ~~**The agent avatar palette was left on the amber-era hues (S7.1).**~~ **Done
  in S5.17**, and without the migration this entry assumed was the price: the
  eight pairs became twenty tokens, a record stores the slot number, and the old
  hexes stayed in `agent-display.ts` as the table an existing agent is resolved
  through. Nothing was restyled behind the user's back and nothing was written to
  SQLite.
- **The nearest-hex mapping is plain RGB distance.** The eight legacy values
  round-trip exactly, which is the case that matters. A colour the picker could
  never have produced gets a stable but not especially pretty answer — the table
  it measures against is eight dark slabs, so a bright orange lands on the olive
  slot. A perceptual space would fix it and is more colour science than a
  fallback for impossible data deserves.
- **The dmg has no custom background.** S7.1's brief allowed for one; nothing was
  added, because `dmg.background` also fixes the window size and the icon
  positions, and the default Finder layout electron-builder produces is correct
  today. It is a design task rather than a packaging one.

### Server and editor

- **Server and multi-user** (PLAN "Reserved server capability"): ~~lift the
  main-process business logic into a Node server~~ (done, S8.1), swap the
  `BackendClient` implementation for HTTP + WebSocket (S8.3), real `userId`s
  (S8.2), a server-side `SecretStore` (S8.4), and — only if several server
  instances or worker processes exist — an `EventBus` / `MessageRepository`
  implementation over Redis Streams, Postgres LISTEN/NOTIFY or NATS. Phase 8
  now owns the scheduled half; what stays here is the last item, which nothing
  needs until there is more than one process.
- **Make `Repositories` asynchronous (S8.1).** The blocker between the Postgres
  dialect and the Postgres *database*: better-sqlite3 is synchronous and drizzle's
  Postgres driver is not, so the repositories, the handlers that call them,
  `resolveTimeouts`, the `AgentSupervisor`'s accessors and `probeAgentProvider`
  all have to return and await promises before Postgres can be more than a
  tested schema. Every one of those callers is already inside an `async`
  function, so it looks mechanical; it has not been attempted, and it is a
  cross-cutting diff that wants a branch to itself. The alternatives that were
  rejected — a worker-thread synchronous driver, and a duplicated per-dialect
  repository layer — are in `docs/features/server/context.md`.
- **The Postgres schema has never run (S8.1).** `docker-compose.yml` and
  `src/main/db/postgres/migrations/0000_init.sql` are written and reviewed but
  were authored on a machine with neither Docker nor Postgres, so the Postgres
  half of `src/main/db/dialects.test.ts` has only ever been skipped. The first
  `docker compose up -d postgres` followed by
  `DATABASE_URL=postgres://witena:witena@localhost:5432/witena npm test` is its
  first real execution and may need a second commit.
- **CI runs SQLite only (S8.1).** Adding a Postgres `services:` block to
  `ci.yml` is one change; it is deliberately left until S8.5, when there is a
  deployment whose migrations are worth gating on. Until then "CI proves
  Postgres works" is not a claim this repository makes.
- **The server has no CORS, no TLS, no WebSocket keepalive and no idle timeout
  (S8.1).** It binds `127.0.0.1` and S8.5 puts an ALB in front of it, but a
  browser on another origin cannot call it until S8.3 decides what
  `Access-Control-Allow-Origin` should say, and a dead client that never sent a
  FIN holds an entry in the fan-out set until the OS notices (S8.4).
- **stdio MCP servers still spawn child processes on the Node host (S8.1).**
  PLAN's "Online version" says they must not on a shared one; nothing stops them
  yet, and the switch belongs with S8.3's capabilities.
- **`pg` and `ws` ship in the dmg (S8.1).** Nothing in the Electron bundle
  imports either, but they must be `dependencies` — the server needs them at
  runtime and `vite.server.config.ts` derives its externals from that list — so
  electron-builder copies them into every bundle. A few hundred kilobytes, and
  the fix is the same `files` exclusion the `better-sqlite3` prebuilds want,
  with `npm run e2e:packaged` run afterwards to prove nothing resolved through
  them.
- **VS Code extension** embedding the chat panel over that server backend
  (PLAN "Future extension", point 3, step two). Depends on the item above.

### Release workflow (S7.2)

- **CI does not sign yet (S7.3).** The Developer ID certificate lives only in
  the developer's login keychain. `release.yml` signs and notarizes as soon as
  `CSC_LINK` (the exported `.p12`, base64), `CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` exist as repository
  secrets; until then a tag still produces unsigned dmgs and signed releases
  are built locally with `npm run dist:signed`.

- **Neither workflow has executed.** `ci.yml` and `release.yml` are validated by
  `actionlint` and by reading only; GitHub has never run them. The first push
  and the first `v*` tag are the first executions, and three things are most
  likely to need a second commit: whether `npm ci`'s `postinstall` Electron
  rebuild fits the runner's patience, whether electron-builder infers
  `owner`/`repo` from the checkout's git remote as expected, and whether the
  draft Release created by the first artifact upload is reused by the rest.
  Until a tag has been pushed, "a tag produces a draft Release" is a design, not
  an observation.
- **A local `npm run dist` exits 1 after writing both dmgs.** Found while
  verifying S7.3 and **not caused by it** — the identical crash reproduces with
  the pre-S7.3 `electron-builder.yml` from `origin/main`. Both dmgs and both
  blockmaps are written correctly, then app-builder-lib's `computeChannelNames`
  throws `TypeError: Cannot read properties of null (reading 'channel')` while
  building `latest-mac.yml`, because a local run has no publish configuration to
  name a channel from. S7.2 added the `publish:` block but only ever verified
  `npm run dist:dir` and `npx electron-builder --mac --dir --x64` locally, so a
  full local `dist` was never run. `dist:dir` is unaffected, and the workflow's
  `--publish always` with a `GH_TOKEN` probably is too — but that is inference,
  because the workflows have never run. The likely fix is `--publish never` on
  the local script.
- **The x64 dmg has never been opened on an Intel Mac.** It packages correctly
  (an x86_64 `Witena.app` carrying `prebuilds/darwin-x64.node`), but running it
  needs hardware this project does not have. `e2e/packaged.spec.ts` is only ever
  run against the arm64 bundle.
- **`actionlint` is pinned to 1.7.12 with a hand-copied SHA-256**, and nothing
  updates either. A dependency bot or a scheduled check would notice a release;
  today a human does or nobody does.
- **Every bundle ships all eight `better-sqlite3` prebuilds** — 16 MB, of which
  the 14 MB for Windows, Linux and the other macOS architecture is dead weight
  in each dmg. A `files` exclusion could drop it, and would need the packaged
  spec run afterwards to prove `node-gyp-build` still resolves the one that is
  left.
- **Release notes are written by hand** into the draft. Nothing derives them
  from the commits between two tags.
- **`npm run e2e` is not in CI** (it needs Ollama) and `npm run e2e:packaged` is
  not either (it needs a built dmg). Both remain a human's pre-release step, so
  a release whose author skips them is packaged and uploaded exactly as one
  whose author does not.

### Auto-update (S7.4)

- **The GitHub feed has never been read, because the repository is private.**
  This is the one thing standing between S7.4 and a user who never downloads a
  dmg again. `electron-updater`'s GitHub provider fetches
  `releases/download/<tag>/latest-mac.yml` unauthenticated, and GitHub answers
  404 for a private repository's release assets whether or not they exist. The
  fix is to **make the repository public**, which is what the owner intends and
  what `provider: github` is already correct for. It is explicitly *not* to put
  a `token:` in `electron-builder.yml`'s publish block: that block is copied
  verbatim into `app-update.yml` inside every dmg, so the token would ship to
  everyone who downloads the app — `src/main/packaging.test.ts` asserts the
  block holds nothing but `provider` and `releaseType`. Until then a check ends
  in `state: 'error'` with GitHub's own 404 sentence under it in Settings →
  About, which is honest but is not a feature.
- **The whole path was proven locally, and only locally.** Two signed bundles,
  0.1.0 and 0.2.0, a static local feed, download, `Squirrel.Mac` validation,
  "Restart to update", relaunch into 0.2.0 — all of it on this machine on
  2026-09-17 (the procedure is in `docs/features/packaging/backend.md`,
  "Auto-update"). What that leaves untested is everything GitHub adds:
  redirects to `objects.githubusercontent.com`, the `latest-mac.yml` a *draft*
  release serves, differential (blockmap) downloads over a real CDN, and both
  architectures rather than arm64 alone.
- **Neither test bundle was notarized.** Squirrel does not check for a ticket —
  it checks that the new signature matches the running one — so the update path
  does not need notarization. Gatekeeper's behaviour *after* an update, on a
  bundle that was notarized when it was downloaded as a dmg and then replaced
  in place, has not been observed.
- **`autoInstallOnAppQuit` is on and nothing tells the user.** Once an update is
  downloaded, quitting the app installs it, whether or not the notice bar was
  dismissed — "Not now" means "not this restart", not "not at all". That is
  `electron-updater`'s default and it is the behaviour most apps have, but the
  copy does not say so, and a user who dismissed the bar and quit will find a
  different version next morning.
- **The notice bar has never been reviewed in the light theme.** It was read and
  clicked in dark mode at 1440×900 during the manual run; `e2e/theme.spec.ts`'s
  light screenshots cannot reach the `downloaded` state, so nobody has looked at
  the strip on a white ground. Recorded again in
  `docs/features/ui-shell/implement.md`.
- **There is no "download now" and no way to defer for longer than a session.**
  `autoDownload` is on, so an `available` update starts a 150 MB transfer with no
  consent, on whatever network the user is on. A metered-connection or
  "ask before downloading" setting is the obvious next decision, and it is a
  product decision rather than a bug.
- **A failed check is invisible unless the user opens Settings → About.** There
  is deliberately no error event (see
  `docs/features/backend-client/context.md`), so an app whose feed has been
  broken for a month looks exactly like one that is up to date until somebody
  looks. Acceptable while the alternative is nagging; worth revisiting if the
  feed is ever expected to fail for a reason the user can fix.
- **The six-hour timer is `setInterval`, not a wall-clock schedule.** A laptop
  that sleeps for two days checks once when it wakes and then six hours later,
  rather than catching up. Harmless, and named here so nobody reads the constant
  and assumes otherwise.

### First run and About (S7.5)

- **The licence list carries names, versions and SPDX ids, not licence texts.**
  MIT, BSD and Apache-2.0 all ask for the licence text (and, for Apache, a
  NOTICE) to travel with a binary distribution. Settings → About links each
  package's homepage instead. Collecting 244 `LICENSE` files into the bundle and
  rendering them — or shipping one concatenated `THIRD-PARTY-NOTICES.txt` next
  to the app — is a packaging decision of its own, and it should be made before
  the first public dmg rather than after.
- **The generated list is never regenerated while the app is running.** The
  hooks run at `predev` / `prebuild`, so a dependency installed mid-session
  appears at the next start. Fine for a file that changes only when
  `package.json` does; worth remembering when a licence question is urgent.
- **A dependency that `node_modules` does not hold is warned about and
  omitted.** An `npm ci --omit=optional` or a platform-specific package that is
  not installed on the machine doing the build therefore never reaches the
  screen. A stricter mode — fail the build instead — is the alternative, and it
  is the right one once the list is a legal artifact rather than a courtesy.
- **The first-run card and the settings provider editor share one draft.**
  Filling half the card, then opening Settings → Providers and pressing "Add
  provider", discards what the card held — the same silent discard as switching
  between two providers in the editor, and it needs the same dirty-state guard
  the editor has never had.
- **Skip cannot be undone from the UI.** `onboardingDismissed` is written once
  and nothing writes it back: a user who skips and then wants the walkthrough
  has no control for it. A "show the first-run steps again" row in Settings →
  About is the obvious shape, and costs one action.
- **The three agent templates were not reviewed by anyone but their author.**
  Their prompts are short and plausible; whether Assistant / Critic / Planner is
  the *right* first trio — and whether `modelHints` picks sensible models on a
  provider other than Ollama — has not been tried against a real discussion.
- **`e2e/chat.spec.ts` still races a warm Ollama.** Its cursor assertion reads
  `data-status` and then checks the cursor, and a 1.5B model can finish between
  the two lines; it failed once in the S7.5 full-suite run and passed on a
  re-run. The file's other assertions already avoid the race (see the commit
  that introduced them); this one line did not get the same treatment.

### API keys and the key file (S7.6)

- **The dmg-over-dmg case is verified by hand, not by a spec.** The end-to-end
  suite proves the two halves separately — a key survives a relaunch on the same
  `userData`, and a row the build cannot decrypt is left alone and explained —
  because producing a genuine reinstall needs two differently packaged unsigned
  dmgs and a Gatekeeper prompt. The first S7.6 dmg that replaces an older one is
  the first real observation.
- ~~**Nothing re-wraps an existing key file when the build becomes signed**~~ —
  **done in S7.3.** `rewrapKeyFile` rewrites a plain `fkkey1:` file as `fkkey1w:`
  on the first signed launch, atomically and with the same 32 bytes. It is done
  without asking, which reverses S7.6's position: the reasoning is that it
  rewrites the **container, not the contents**, so no provider key is
  re-encrypted and there is no observable outcome a confirmation could be about.
  What is still open is only that it has never run against a real `safeStorage`
  — see S7.3's remaining list.
- ~~**`WITENA_SIGNED_BUILD` has to reach the packaged app**~~ — **done in S7.3.**
  The variable is gone. The flag is `witenaSignedBuild` in the packaged
  `package.json`, written by electron-builder's `extraMetadata` and read back
  with `app.getAppPath()`; `isSignedBuild` takes the parsed manifest, so
  `secrets.ts` stays Electron-free.
- **The key is never rotated**, and there is no way to re-encrypt every stored
  key under a new one. Nothing needs it today; a compromised key file would.
- **A copy of `witena.db` alone is no longer a complete backup.** Every `fk1:`
  value in it needs `secrets.key`. Whatever S4.x builds for export and backup has
  to take the key file with it, or exclude the keys deliberately and say so on
  the screen that offers it.
- **A key written on another machine is indistinguishable from a corrupted one.**
  Both read as `key_unreadable`, and the sentence names the likely cause (an
  update) rather than the certain one. Telling them apart would mean storing the
  key file's identity beside every ciphertext.

### Open questions carried from the feature documents

- `mcp`: subscribe to `notifications/tools/list_changed`; per-tool selection
  per agent instead of all-or-nothing; tune `MAX_TOOL_STEPS = 8` on a real
  multi-step task; render `McpPreset.docsUrl`; record the README tour through
  the connector gallery (`e2e/demo.record.ts` still types the command).
- `memory`: pruning, deduplication, search with stemming or synonyms, and
  validation of the index on write.
- `skills`: a filesystem watcher for `SKILL.md` edited outside the app, and a
  per-skill file allowlist for `read_skill_file`.
- `providers`: replace the hand-written `fetchModels` per provider family
  with the SDK's own listing where one exists; Google's list endpoint
  authenticates with a query parameter.
- `executor`: whether the permission prompt should be able to answer "allow,
  but show me the diff first" for `write_file` — the tool computes the patch
  only *after* the grant today, so the card previews the content it was given
  rather than the diff (`edit_file` already sends the patch in its input).

## Phase 7: Local release (PLAN "Local release and online version")

A double-click app. Steps S7.3 and S7.4 need an Apple Developer account; S7.1
and S7.2 do not and come first.

### S7.1 Brand mark and application icon `[x] (2026-09-13)`
What: replace the placeholder "W" tile with the chosen mark.
- Pick one of the proposed marks (modern, minimal; see the proposal page
  linked in the `Done:` paragraph) and commit it as `build/icon.svg`; render
  `build/icon.png` (1024 px) and `build/icon.icns` with the documented
  pipeline; use the same mark for the rail avatar in `ui-shell`, the README
  header and the dmg background if one is added. Both themes must keep the
  mark legible (S5.8).
- Tests: the existing icon pipeline check; a unit test that the rail avatar
  renders the mark component rather than a letter.
Acceptance: `npm run dist:dir` produces an app whose Dock and Finder icon is
the new mark at 16–1024 px; the rail shows it in both themes. Docs:
`docs/features/packaging/` and `docs/features/ui-shell/` (all four each).
Done: the mark is the **Aperture** — six near-black blades closing on a single
terracotta point inside a hexagon whose corners are eased with a 52 px radius.
The design record is the proposal page
<https://claude.ai/code/artifact/f20594f0-f036-43fc-83b6-ba891bd36df8>, where it
was picked from the alternatives; "Aperture" is the internal name for the drawing
and the product is still Witena. It reads as what the app does — many separate
members converging on one answer — which is the only reason to prefer it to a
letter.

**One drawing, two cuts.** `build/icon.svg` is the tiled version the application
icon is rendered from; `components/ui/brand-mark.tsx` inlines the identical
geometry with no tile, so the rail can colour the blades `currentColor` and the
mark becomes ink on the light palette and near-white on the dark one with no
branch, no `data-theme` lookup and no second asset — the same argument S5.8 makes
for the whole theme. The two are held together by `brand-mark.test.ts`, which
compares the hexagon path, all six blade endpoints, the point and the stroke
weight against `build/icon.svg` read as text. That is the **only** gate the icon
has: nothing in `npm test` rasterises anything, so without it the Dock icon and
the app's own rail could drift apart silently. The same file asserts the S7.1
acceptance criterion against `nav-rail.tsx`'s source — `<BrandMark` is rendered,
the `W` tile's exact classes are gone — because the repository has **no DOM test
setup** (`vitest.config.ts` is `environment: 'node'`, no jsdom, no
testing-library), and `PresenceDot` had already established the answer: export the
checkable part as values and test those.

**The accent became the brand colour.** `--color-accent` is the mark's terracotta
`#d97757` in the dark palette (5.79:1 on `bg-base`, 4.71:1 at worst on `bg-hover`)
with `--color-accent-hover` lightened to `#e1937a` (7.45:1); the light palette
darkens the same hue to `#a13917` (6.15:1 on `bg-base`, 6.75:1 on `bg-elevated`,
5.14:1 at worst on `bg-hover`) with `#812e12` as its hover (8.20:1). Every pair is
AA on every one of the six surface tokens, in both directions where the accent is
a background carrying `text-bg-base`. Keeping the old amber beside a terracotta
mark was the alternative and it is the wrong one: two warm colours a hue apart do
not read as a palette. **No other token moved.** The presence, status and danger
hues are a different axis (green / red / amber / grey as *states*) and none of them
was derived from the accent; the eight agent-avatar pairs are stored data, so
re-picking them would restyle new agents and leave existing ones behind — both are
recorded under "Appearance" in Phase 6 with the reasoning.

`--color-brand-point` is new and is the **one** token deliberately identical in
both palettes. It is an identity, not a role, and a mark whose colour shifted with
the appearance would be two marks. S5.8's palette test says every token is
overridden *and* every override differs, so the second half gained a named
exception set, `CONSTANT_TOKENS`, plus a new assertion that a constant token is
still *declared* in both blocks — exempting it from the difference check without
exempting it from the existence check, which is the half that catches a token
silently staying dark.

**Rasterisation was the part with real content.** `sips` cannot render an SVG, so
the pipeline S4.4 documented — Chromium in `node_modules` as the rasteriser,
captured at 2048 and downsampled to 1024 — is exactly right, and every iconset
size is a downscale of that 1024 bitmap rather than a fresh render at a tiny size.
`shape-rendering="geometricPrecision"` was added to both SVGs and to the inlined
component, because every edge in this mark is a diagonal meeting another at a
shallow angle and the default lets a renderer snap them to the pixel grid. The
tile carries **no border**: the proposal drew a hairline on its light-rail preview
and it is not in the shipped mark, because a hairline is invisible on a light Dock
and grey fuzz at 16 px. The 1024 px render was checked pixel by pixel across the
tile edge — transparent, one pixel at alpha 198, then opaque white, with no colour
fringe.

One variant needed help. 30 px of stroke on a 1024 canvas is 0.47 px at 16, and
the blades averaged to a uniform grey smudge — smooth, but unreadable.
`icon_16x16.png` alone is now re-rendered from the same `icon.svg` with
`stroke-width` substituted to **56** (~0.9 px at 16), chosen by rendering 44 / 56 /
68 / 80 and looking at all four blown up: 44 is still washed out, 68 and up close
the white gaps into a blob. It is a `sed` over the committed SVG rather than a
second committed file, so there is still exactly one drawing. Nothing from 32 px
up is touched.

**Verified.** `npm run typecheck` clean; `npm test` 90 files / 1441 tests passed.
`npm run dist:dir` built `dist/mac-arm64/Witena.app`, whose
`Contents/Resources/icon.icns` is byte-identical to `build/icon.icns` (same
SHA-256) and whose `Info.plist` names `icon.icns`. The icns round-trips through
`iconutil -c iconset` to all ten expected PNGs, and the 16 / 32 / 64 / 128 px
variants were blown up with nearest-neighbour and looked at: anti-aliased
diagonals, no stair-stepping, no halo, the point still a point. `e2e/ui-shell.spec.ts`
and `e2e/theme.spec.ts` pass (9 tests), the former with a new case that screenshots
the rail into `test-results/shots/rail-{dark,light}.png`, asserts the mark's box is
exactly 28x28 CSS pixels, and reads the computed colours back — the point is
`rgb(217, 119, 87)` in both themes and the blades are not. Both crops were looked
at. The README header now carries `build/icon.png` at 96 px, checked against
GitHub's light, dark and dark-dimmed page grounds.

**Deviations from the brief, both deliberate.** The geometry is byte-for-byte the
approved file except for `shape-rendering="geometricPrecision"` on the `<svg>`
root, which the "no rough edges" instruction asked for explicitly and which
changes no coordinate. And the rail avatar had **no** test id to keep — the old
tile was an `aria-hidden` div with none — so `data-testid="brand-mark"` was added,
which is what the new e2e case addresses. Docs in `docs/features/packaging/` and
`docs/features/ui-shell/` (all four each).

### S7.2 Release workflow `[x] (2026-09-13)`
What: a tag builds the dmg.
- `.github/workflows/ci.yml`: on every push and pull request — `npm ci`,
  `npm run typecheck`, `npm test`, `npm run build`; e2e stays local (it needs
  Ollama) and is documented as such.
- `.github/workflows/release.yml`: on a `v*` tag — the same checks, then
  `npm run dist` for `arm64` and `x64` on a macOS runner, and a **draft**
  GitHub Release carrying both dmgs, `latest-mac.yml` and the blockmaps.
  Signing and notarization run only when the secrets exist (S7.3), so the
  workflow is complete now and gains signing later without changes.
- `electron-builder.yml`: add `x64`; `publish: github` so `electron-updater`
  has a feed (S7.4); the version comes from `package.json`, bumped by an
  `npm version` step documented in the packaging docs.
- Tests: the workflow files are validated with `actionlint` in CI; a unit
  test checks `electron-builder.yml` lists both arches and the publish
  provider.
Acceptance: pushing a tag on a fork produces a draft Release with two dmgs;
`ci.yml` is green on the PR. Docs: `docs/features/packaging/` (all four).
Done: `.github/workflows/ci.yml` runs `npm ci`, `npm run typecheck`, `npm test`
and `npm run build` on `macos-latest` for every push and pull request — macOS
because `postinstall` rebuilds `better-sqlite3` against the Electron ABI and the
artifact is a macOS bundle — plus a second job on `ubuntu-latest` that lints
both workflow files with **actionlint 1.7.12, pinned by version and SHA-256** of
the release tarball rather than by an npm dependency or a third-party action
tag. `npm run e2e` is deliberately absent: the specs that prove anything need a
local Ollama, and a suite that skips its own assertions is worse than one that
is honestly local; it stays step 1 of the release procedure.

`.github/workflows/release.yml` runs on `v*`: the same checks, then
`npm run dist -- --publish always` — one electron-builder invocation for **both
architectures**, because `latest-mac.yml` describes a release rather than an
architecture and two parallel jobs would each upload a feed naming only their
own dmg. The upload is electron-builder's own GitHub publisher (`GH_TOKEN`,
`permissions: contents: write`) rather than `softprops/action-gh-release`: the
blockmaps and the update feed are computed while it packages, and S7.4's
`electron-updater` reads exactly that feed. `publish: {provider: github,
releaseType: draft}` in `electron-builder.yml` makes the Release a **draft**;
`owner`/`repo` are left out so they come from the checkout's git remote and a
tag on a fork publishes to the fork.

The signing seam is wired and gated. **`secrets` is not an available context in
an `if:` expression at either job or step level**, so the gate is a step that
reads `CSC_LINK` into `env` and writes `enabled=true|false` to `$GITHUB_OUTPUT`;
`steps.signing.outputs.enabled` then guards the `codesign --verify --deep
--strict` / `spctl --assess` verification and supplies
`CSC_IDENTITY_AUTO_DISCOVERY`, which keeps an unsigned CI build from picking up
a runner keychain identity. All `CSC_*` / `APPLE_*` secrets are passed through
unconditionally and are ignored while empty, so S7.3 adds secrets and edits
`electron-builder.yml` (`identity`, `hardenedRuntime`, `notarize`) without
touching the workflow. `mac.target[0].arch` is now `[arm64, x64]`; `identity:
null` and `hardenedRuntime: false` stay until S7.3.

A release is now `npm version <patch|minor|major>` → `git push --follow-tags` →
publish the draft. `preversion` reruns typecheck and the tests, and the `version`
lifecycle script (`scripts/sync-version.mjs`) rewrites `APP_VERSION` in
`src/shared/version.ts` from the manifest and stages it, so the tagged commit
carries one version number in two files rather than two numbers.
`src/main/packaging.test.ts` parses `electron-builder.yml` — with
**gray-matter**, already a dependency for `SKILL.md` frontmatter, rather than a
new YAML devDependency — and asserts both arches, `${arch}` in `artifactName`,
the draft publish provider, the still-`null` identity and that `APP_VERSION`
equals `package.json`'s version.

Verified locally: `npm run typecheck`, `npm test` (`Test Files 86 passed`,
`Tests 1379 passed`), `npm run build`, `npm run dist:dir`, and — because `--dir`
replaces the configured target and builds only the host architecture —
`npx electron-builder --mac --dir --x64`, which produced an x86_64
`Witena.app`. Cross-architecture packaging costs nothing because
`better-sqlite3` 13 ships **N-API** prebuilds, ABI-stable across Node and
Electron, so `@electron/rebuild` has nothing to compile. Both workflow files
pass `actionlint` 1.7.12 locally. **Neither workflow has ever run** — GitHub has
not executed them — and the x64 dmg has never been opened on an Intel Mac; both
are in the Phase 6 backlog. Docs: `docs/features/packaging/` (all four) and the
README's build section.

### S7.3 Signing and notarization `[x]` (2026-09-17)
What: the dmg opens on a double-click on any Mac.
- Developer ID Application certificate in CI secrets (`CSC_LINK`,
  `CSC_KEY_PASSWORD`), `hardenedRuntime: true`, an entitlements file for the
  native module (`allow-unsigned-executable-memory`,
  `disable-library-validation` only if `better-sqlite3` needs it — verify),
  `notarize` with `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`;
  `identity: null` removed; the README's Gatekeeper note deleted.
- Verification in CI: `codesign --verify --deep --strict`, `spctl -a -vv`
  reporting `Notarized Developer ID`, and `e2e/packaged.spec.ts` against the
  signed app.
Acceptance: a fresh Mac with default Gatekeeper opens the downloaded app
with no dialog. Docs: `docs/features/packaging/` (all four).

Done: **the first signed and notarized build was produced and verified on
2026-09-17** with the certificate `Developer ID Application: Shijie Huang
(CHLLA4N24C)` and a `notarytool` keychain profile. Both architectures were
accepted by Apple; `spctl -a -vv` reports `source=Notarized Developer ID` and
`xcrun stapler validate` passes for `mac-arm64/Witena.app` and
`mac/Witena.app`; `codesign --verify --deep --strict` passes on the installed
app. Under the hardened runtime the `better-sqlite3` prebuild
(`prebuilds/darwin-arm64.node`) loads and the database opens with only
`allow-jit` and `allow-unsigned-executable-memory` — `disable-library-validation`
is not needed, because electron-builder signs the native module with the same
Team ID. On its first run the signed build rewrote `secrets.key` from the plain
`fkkey1:` form to the `safeStorage`-wrapped `fkkey1w:` form, mode `0600` kept,
every `fk1:` provider ciphertext untouched and still readable (the S7.6
hand-off, observed on the real files). Two things the first attempt taught:
**a signed build must not be staged inside an iCloud "Desktop & Documents"
folder** — File Provider attaches extended attributes that make `codesign` fail
with "resource fork, Finder information, or similar detritus not allowed", so
`npm run dist:signed` now writes to `${WITENA_DIST_DIR:-~/Library/Caches/witena-dist}`
— and **a new developer account's first notarization is slow** (55 minutes here;
the second, 5). What remains is CI: the five GitHub secrets are not set yet, so
`release.yml` still produces unsigned dmgs; recorded in Phase 6. The
configuration notes that follow were written before the certificate existed.

Configuration notes: the configuration is in place.
`security find-identity -v -p codesigning` reports `0 valid identities found` on
this machine and the repository has no signing secrets, so everything below is
written and reasoned but unexercised — which is why this step is `[~]` and not
`[x]`.

`electron-builder.yml` no longer carries `identity` **at all**. Not `null` and
not a name: its absence is what makes one file produce both builds, because
electron-builder looks for a Developer ID Application certificate and either
signs with it or logs `skipped macOS application code signing`. `null` means
"never sign" and would need a second config to override; a name ties the file to
one keychain. Alongside it: `hardenedRuntime: true` (notarization refuses a
bundle that is not hardened), `gatekeeperAssess: false` (spelled out because
`spctl --assess` *during* packaging fails on every correctly signed bundle that
is not yet notarized), `entitlements` / `entitlementsInherit` pointing at the new
`build/entitlements.mac.plist`, and `notarize: true` — a **boolean** in
electron-builder 26, verified against `node_modules/app-builder-lib`'s own types
rather than guessed; there is no sub-object and every credential lives in the
environment (`APPLE_KEYCHAIN_PROFILE` locally, `APPLE_ID` +
`APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` in CI).

The entitlements file grants **two** keys, `com.apple.security.cs.allow-jit` and
`com.apple.security.cs.allow-unsigned-executable-memory`, and deliberately not
`disable-library-validation`, which is in electron-builder's own default
template. The reasoning: library validation only rejects code signed by a
*different* team, and `better_sqlite3.node` is signed by this build with this
project's identity, because @electron/osx-sign walks `Contents/` and signs every
Mach-O it finds there. Same team, so validation passes and the exception would
widen what the app may load in exchange for nothing. **That is reasoning, not an
observation, and it is the claim a certificate could overturn** — if the first
signed build fails to open its database with a `Library not loaded` / `code
signature` error naming the module, the fix is that one key. The plist says so in
its own comment. The file is also shorter than @electron/osx-sign's default,
which asks for the camera, microphone, Bluetooth, USB, printing and location —
none of which Witena touches.

**The unsigned path still works, and that was verified rather than assumed.**
`npm run dist:dir` on this machine logs `skipped macOS application code signing
… 0 identities found` and exits 0; `codesign -dv` on the result reports
`Identifier=Electron`, `flags=0x20002(adhoc,linker-signed)`,
`TeamIdentifier=not set` — byte-for-byte what S4.4 documented. Two independent
reasons it cannot break: `findSigningIdentity` warns and returns null unless
`forceCodeSigning` is set, which this project never sets; and
`notarizeIfProvided` is only reached *after* a successful signature and skips
itself again when no credential variable is present, so notarization cannot fire
on an unsigned build whatever the environment holds.

A full `npm run dist` writes both dmgs and both blockmaps correctly and then
exits 1 on a `TypeError: Cannot read properties of null (reading 'channel')` in
app-builder-lib's `computeChannelNames` — a local run has no publish
configuration to name a channel from. **Pre-existing, not S7.3**: the identical
crash reproduces with the pre-S7.3 `electron-builder.yml` from `origin/main`. It
dates from S7.2, which added the `publish:` block but only ever verified
`dist:dir` locally. Recorded in the Phase 6 backlog under "Release workflow
(S7.2)".

**Both S7.6 hand-offs are closed.** `WITENA_SIGNED_BUILD` is gone: the flag is
now `witenaSignedBuild` in the packaged `package.json`, written by
electron-builder's `extraMetadata` and read back through `app.getAppPath()` by
`signedBuild()` in `src/main/index.ts`. `isSignedBuild` takes the **parsed
manifest** and returns a boolean, so `src/main/secrets.ts` stays Electron-free
and the function is testable with a literal; a checkout answers "not signed"
because the repository's own manifest has no such field, and so does any failure
to read one. The flag is passed by the new `npm run dist:signed` and by the
release workflow only when `steps.signing.outputs.enabled` is true, which
`src/main/packaging.test.ts` asserts. And `rewrapKeyFile` moves an existing plain
`fkkey1:` key file to `fkkey1w:` on the first signed launch — same 32 bytes, so
every `fk1:` ciphertext stays readable — written atomically (temp file, `fsync`,
`rename`) and failing soft to the plain file with one warning. S7.6 declined this
as "rewriting the user's stored secrets"; what changed the answer is that it
rewrites the **container, not the contents**, so there is no observable outcome
to ask about. Five outcomes unit-tested with a fake wrapper.

`.github/workflows/release.yml` gained the `extraMetadata` argument behind the
existing gate and `xcrun stapler validate` beside the existing `codesign` /
`spctl` checks; both workflow files pass `actionlint` 1.7.12. The README's
Gatekeeper note now distinguishes a released dmg from one you build yourself
rather than claiming the project has no certificate. `npm run typecheck` and
`npm test` pass (`Test Files 93 passed`, `Tests 1584 passed`).

What remains before this is `[x]`:
- A first **signed and notarized dmg**, verified with `spctl -a -vv` reporting
  `source=Notarized Developer ID` and `xcrun stapler validate`.
- **`better_sqlite3.node` loading under the hardened runtime** without
  `disable-library-validation` — the one entitlement decision that is reasoning
  rather than evidence.
- **The re-wrap observed on a real signed build**, against the real `safeStorage`
  rather than the fake, including the refusal path (a locked keychain, a Deny).
- **The secrets added to GitHub** (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) and one tagged release that
  actually uses them.
- `e2e/packaged.spec.ts` run against the signed app, and a fresh Mac with default
  Gatekeeper opening it with no dialog, which is the acceptance criterion.

Docs: `docs/features/packaging/` and `docs/features/providers/` (all four each),
plus the README.

### S7.4 Auto-update `[x] (2026-09-17)`
What: the app updates itself from GitHub Releases.
- `electron-updater` in the main process behind an injected interface (rule
  5: the updater is electron and lives in `src/main/ipc/` or `index.ts`),
  checking on launch and every 6 hours; `system.updateStatus` /
  `system.installUpdate` methods and a `update.available` /
  `update.downloaded` event pair; Settings → About shows the version, the
  channel and "Check for updates"; a notice bar offers "Restart to update".
- Tests: the status state machine with a fake updater; e2e for the About
  block with the updater stubbed absent.
Acceptance: an older installed build sees a newer draft-published Release,
downloads it and restarts into it. Docs: `docs/features/packaging/` and the
settings owner (all four each).

Done: **the acceptance criterion was met against a local feed rather than a
Release, because the repository is private** — and that is the one fact this step
is designed around. `electron-updater`'s GitHub provider fetches
`releases/download/<tag>/latest-mac.yml` unauthenticated and GitHub answers 404
for a private repository's assets. The fix is to make the repository public,
which the owner intends and which `provider: github` is already correct for; the
fix is **not** a `token:` in the publish block, because electron-builder copies
that block verbatim into `app-update.yml` **inside the dmg**, so the token would
ship to everyone who downloads the app. `src/main/packaging.test.ts` now asserts
the block holds nothing but `provider` and `releaseType`, so nobody can take the
other route by accident.

What *was* exercised, on this machine on 2026-09-17: two signed bundles (0.1.0
and 0.2.0, the same `Developer ID Application: Shijie Huang (CHLLA4N24C)` S7.3
used, neither notarized — Squirrel checks that the new signature matches the
running one, not that a ticket exists), a static local feed on
`127.0.0.1:45999`, and the whole walk. The older app found 0.2.0, downloaded the
150 MB zip, `Squirrel.Mac` validated and staged it, the notice bar appeared
reading *"Version 0.2.0 is ready to install."*, Settings → About showed
`data-state="downloaded"`, and clicking **Restart to update** quit and relaunched
into a bundle whose `CFBundleShortVersionString` is `0.2.0`. The procedure is
written down in `docs/features/packaging/backend.md`, "Auto-update", including
the two things that cost an attempt each: the downloaded zip is cached in
`~/Library/Caches/witena-updater/pending/`, so a second run never asks the feed
again; and `autoInstallOnAppQuit` means **quitting installs the update whether or
not anyone pressed Restart**, so the old bundle has to be rebuilt between
attempts. What GitHub would add on top — redirects to
`objects.githubusercontent.com`, a draft release's asset URLs, differential
downloads over a CDN, x64 — is untested and is in the Phase 6 backlog.

**The seam is an injected port, not the `handlers/system.ts` + `src/main/ipc/`
overlay S5.8 established.** Every earlier electron exception is a one-line call
with no state behind it, so an overlay that rejects everywhere else costs
nothing. The updater has a cached status, a six-hour timer and two emitted
events, and putting those in `src/main/ipc/` would put them in the one directory
no unit test can enter. So `src/shared/updates.ts` holds the status and the
normalised `UpdateEvent` union, `src/main/updates/state.ts` is the reducer,
`src/main/updates/service.ts` owns the status, the schedule, the emissions and
the refusal, and `src/main/ipc/updater.ts` is the **only** file that imports
`electron-updater` — which is electron in everything but the package name, since
it reads `app.getVersion()`, the bundle's `app-update.yml` and the code signature
of what it downloaded. `ctx.updates` is a real `UpdateService` in every build; a
context built without a port (every unit test, a future server) answers
`{ state: 'unsupported', reason }` and opens no socket and no timer.

**`unsupported` is a status rather than a rejection**, which is the decision the
UI depends on. The `pick*` methods reject because nothing renders their failure —
the caller treats it as a cancel. Here the screen's whole job is to answer "am I
on the newest version, and if you do not know, why not", and `internal` carries
no reason a user can act on. So an unsigned bundle says *"This build is not
signed, so macOS cannot replace it with an update"* and a checkout says *"This is
a development build"*, and the button is visibly disabled rather than missing.
The signed flag is S7.3's `witenaSignedBuild`, read in `src/main/index.ts` where
`app.isPackaged` is also readable; the gate's order is the order of the reasons,
since a checkout is a checkout whether or not it would have been signed.

Two rules in `reduceUpdate` exist only because the check repeats every six hours.
**`downloaded` is terminal**: a later check must not move the state back to
`checking` or `up-to-date`, because the downloaded bundle is still installable and
a notice bar that vanished on its own would strand the user one restart away from
a version they can no longer reach; only a `downloaded` event for a *different*
version replaces it. **`unsupported` is terminal** too. Both are unit-tested by
identity — the reducer returns the same object — which is also what keeps
`update.downloaded` from being emitted twice when the library re-reports itself.

**Two events, and deliberately no third.** `update.available` and
`update.downloaded` are the moments that change what the user can *do*, and both
fire on the transition rather than the state. There is no `update.progress`: a
percentage changes dozens of times over a 150 MB download for a screen almost
nobody has open, and the one screen that does re-reads `system.updateStatus` when
it mounts. The percentage therefore exists in the status and never in an event.

**`electron-builder.yml` gained the `zip` target**, which S4.4 had explicitly
declined ("the zip exists for auto-update, which the MVP does not have"). There is
nothing to weigh: `Squirrel.Mac` replaces a bundle from a zip and nothing else,
and `latest-mac.yml` is generated from whatever targets were built, so a release
carrying only dmgs is a feed the updater downloads and then cannot apply. The dmg
stays what a human downloads. A related trap worth recording: electron-builder
writes `app-update.yml` into the bundle **only when a dmg or zip target is
built**, so an app packaged with `--dir` fails at download time with
`ENOENT … app-update.yml` however well the rest is configured.

`WITENA_UPDATE_FEED` points the updater at a generic feed **and lifts the
packaged/signed gate**, because its entire purpose is to run the updater on a
build that would otherwise refuse to look. It is a developer's environment
variable: nothing in the UI writes it and nothing reads it back.

The UI is two surfaces over one store. Settings → About grew an **Updates** block
directly under the version — the question it answers — with one sentence per
state, a "Check for updates" button that is disabled while a check or a download
is running, and "Restart to update" once there is something to restart into. The
**notice bar** is a strip along the **bottom** of `AppShell`, not the top:
`titleBarStyle: 'hiddenInset'` leaves the traffic lights floating over the
top-left of the content, and the bottom edge belongs to nobody. It is dismissable
per **version** rather than by a boolean, in the renderer rather than in the
settings row, because a dismissal that survived a restart would hide an update
that restart did not install. `lib/updates.ts` spells all eight state keys out in
a `switch` rather than assembling `'settings.about.updates.' + state`, so the
usage guard can see them; `lib/updates.test.ts` walks `UPDATE_STATES` and asserts
each key resolves in `en.json`, which is the other direction. The updater's own
failure text is interpolated as **data** into `settings.about.updates.error` —
there is no fixed set of network failures to write copy for, the same call
`notices.providerError` already makes.

One interop trap cost a launch: `electron-updater` is CommonJS and this project
is ESM, so `import { autoUpdater } from 'electron-updater'` type-checks and then
fails at runtime with `Named export 'autoUpdater' not found`. The default import
plus a destructure is the documented fix and the error message recommends it.

Verified: `npm run typecheck` clean; `npm test` **Test Files 97 passed, Tests
1626 passed**; `npm run build`; and `npx playwright test e2e/smoke.spec.ts
e2e/updates.spec.ts e2e/ui-shell.spec.ts` — **9 passed** (`ui-shell` because
`AppShell` became a column for the bar). The rest of the e2e suite was not run:
other agents were sharing this machine's Ollama. Docs:
`docs/features/{packaging,backend-client,ui-shell,i18n}/` (all four each) and the
`docs/README.md` index.

### S7.5 First run `[x] (2026-09-13)`
What: a new user reaches a working chat without reading the README.
- When no provider exists, the chats page shows an onboarding card: pick a
  preset, paste a key or sign in (S5.3), fetch models, create the first agent
  from a template, start a chat — each step done in place, dismissable.
- Settings → About: version, licenses of bundled dependencies, links.
Acceptance: e2e from an empty `userData` to a streamed reply through the
card alone. Docs: `docs/features/ui-shell/` and `docs/features/providers/`
(all four each).
Done: the card is **not a second provider form**. The three blocks that matter
were extracted out of `provider-editor.tsx` into `provider-credential.tsx` and
`provider-models.tsx` (the preset grid was already one), and both screens render
those same components against the one draft in `stores/providers.ts`. The rules
that could have been re-implemented subtly differently are exactly the ones a
first-time user would be hurt by — an empty key field *clears* a stored key, a
fetch *replaces* the model list, sign-in *replaces* the field rather than sitting
beside it — so there is one implementation and two layouts. The extraction cost
one new store action: `ensureDraft`, which makes a draft without touching `mode`.
`startCreate` sets `mode` too, and `e2e/providers.spec.ts` caught the
consequence within a minute — a user who had never visited Settings → Providers
found the Add form already open on it, because a card on the *chat* page had
opened it. `mode` is the settings editor's own state; only the settings editor
sets it.

`lib/onboarding.ts` is the whole state machine, pure and unit-tested: five steps,
the current one is the first incomplete one, and completion is read from the
stores rather than counted. The first three steps are complete the moment a
provider is **stored** — not when the draft looks full — which is what makes the
card correct for a user who added a provider in Settings and never saw step one,
and which is why the models step's action is Save. Visibility reconciles the two
sentences in this step: it *appears* because no provider exists and *disappears*
once a chat has a member, and the card has to survive the four steps in between
or it would vanish the moment the first provider was saved and leave the user on
an empty screen three clicks from a working chat. `dismissed === null` (settings
still loading) renders nothing rather than flashing a card that is about to be
hidden.

Two smaller decisions the walk forced. `chats.create` grew an optional
`memberAgentIds` because the backend only adds the bootstrap agent while the
agents table is **empty** — by step five it holds the template agent, so a
card that said nothing would have produced a chat with no members and a first
send refused with "this chat has no members". And `agentsStore.createFromTemplate`
deliberately does **not** open the editor, unlike every other way an agent is
created: its caller is on the chat page, and a draft left behind on the Agents
page is a surprise the next time someone goes there. It uniquifies the name with
the same `<name> copy` rule Duplicate uses, because `agents.create` refuses a
clash and a refusal on a first-run card explains nothing.

`@shared/agent-templates.ts` is static data beside `presets.ts` and
`mcp-presets.ts`: three entries — Assistant, Critic, Planner — each with a name,
a description, a system prompt, `modelHints` and a palette index. **The name and
the prompt are stored content, not copy**, so they are English literals exactly
like `DEFAULT_AGENT_NAME`: the name goes into `agents.name`, `@mentions` resolve
against it and every model sees it, and a name that changed with the UI language
would break both. Only the one-line description is a key
(`agents.templates.<id>`), and because it is a *runtime* key the usage guard
cannot see it, `locales.test.ts` checks the subtree against the table in both
directions — the shape S5.1 established for the connector gallery. `modelHints`
is ordered lowercase substrings rather than model ids, because a template cannot
know whether the user's provider is Ollama or Anthropic; `suggestedModel` falls
back to the provider's first model, which is what `default-agent.ts` does too.

Skip is `AppSettings.onboardingDismissed`, a settings row rather than
`localStorage`: it is a fact about the installation, it must survive cleared web
storage, and Phase 8 will want it per account. It needed **no migration** —
settings reads merge the stored object over `DEFAULT_APP_SETTINGS`, so a row
written by an older version answers `false` — and it is validated like `theme`
and `editor` rather than trusted like the language, because it is read back as a
boolean by code with no other branch and a stored `'no'` is truthy. It is
one-way on purpose; nothing writes `false` back, and the "show it again" control
that would is in the Phase 6 backlog.

**Settings → About** is `about` in `SETTINGS_SECTIONS`, directly above
`developer`. The version and the repository URL come from `@shared/version`
(`APP_REPOSITORY_URL` is new beside `APP_VERSION`); the licences are
**generated, not maintained**. `scripts/generate-licenses.mjs` walks the
transitive closure of `package.json`'s `dependencies` through
`node_modules/*/package.json` — 244 packages here — reads both of npm's licence
spellings, writes `UNKNOWN` rather than hiding a package that declares neither,
warns about a declared dependency that is not installed, and produces
`src/renderer/src/generated/licenses.json`. That file is **gitignored**: it is
derived, a hand-maintained copy would be wrong the first time a dependency moved
and *nothing would fail*, and committing it would mean reviewing a 244-entry
diff on every `npm update`. It exists everywhere it is needed because
`package.json` runs the script from `pretypecheck`, `pretest`, `pretest:watch`,
`predev` and `prebuild` — which is what lets a clean `npm ci && npm run
typecheck` on CI work without the workflow file being touched. `licenses.test.ts`
drives the script as an **executable** against a fixture `node_modules`, the way
`anthropic-cli.test.ts` drives a fake `ant`, because what ships is the script and
because a plain `.mjs` under `scripts/` belongs to neither TypeScript project.
About prints the version, the package rows and the URL as **data** with
translated labels around them: an identifier is the same in both languages, the
call `ANT_INSTALL_COMMAND` already made. The repository is a real
`target="_blank"` anchor, which `setWindowOpenHandler` in `src/main/index.ts`
hands to the system browser and otherwise denies — the path a link in a message
body already takes.

Verified: `npm run typecheck` clean, `npm test` `Test Files 89 passed`,
`Tests 1426 passed`, `npm run build`, and `e2e/onboarding.spec.ts` **9 passed**
against a real local Ollama — an empty `userData` to a streamed `Hello!` from
`qwen2.5:1.5b` through the card alone, the card staying gone after a restart,
Skip hiding it on a second installation across a restart, and About showing the
manifest's version, a GitHub link and a non-trivial licence list. The full
`npm run e2e` is 91 passed with one re-run: `e2e/chat.spec.ts`'s cursor
assertion raced a warm Ollama (it reads `data-status` and then checks the
cursor, and a 1.5B model can finish between the two lines) and passed on its own
immediately afterwards; that pre-existing race is recorded in the Phase 6
backlog rather than patched from inside this step. Docs:
`docs/features/{ui-shell,providers,chats,agents,i18n,packaging}/` (all four
each) and the `docs/README.md` index.

### S7.6 API keys that survive an unsigned update `[x] (2026-09-13)`
What: provider keys must not become unreadable when the app is rebuilt.
Today they are encrypted with Electron `safeStorage`, whose key lives in the
macOS Keychain item "Witena Safe Storage"; the Keychain grants access per
application identity, and an **unsigned** build has a new identity every
time it is packaged. After the S7.1 dmg replaced the S4.4 one, the stored
DeepSeek and Moonshot ciphertexts (`v10…`, real `safeStorage` output) could
no longer be decrypted, `resolve.ts` threw, and the UI showed "no key" and a
failed probe. The data was never lost; the key to it was.
- **A file-held key, wrapped by `safeStorage` only when that can be trusted.**
  New `FileKeySecretStore` in `src/main/secrets.ts` (Electron-free: `node:crypto`,
  `node:fs`): a random 32-byte key in `userData/secrets.key` (mode `0600`,
  created on first use), AES-256-GCM with a random 12-byte IV per value, a
  versioned prefix (`fk1:` + base64(iv‖tag‖ciphertext)). The main process uses
  it for every provider key. The `safeStorage` implementation in
  `src/main/ipc/secret-store.ts` is kept and becomes the **wrapper** for the
  file key on signed builds (S7.3): when `process.env.WITENA_SIGNED_BUILD` (set
  by the release workflow once signing exists) is present, `secrets.key` is
  stored wrapped; otherwise it is stored plain with `0600`. Document the trade
  in `docs/features/providers/context.md`: on an unsigned build an attacker
  who can read the user's files can read the key file — exactly what they
  could already do to the Keychain item of an unsigned app after one prompt —
  and the file survives updates, which the Keychain item does not.
- **Migration of existing rows, once, at startup**: for every provider whose
  `api_key_encrypted` is `safeStorage` ciphertext (base64 of `v10…`), try
  `safeStorage.decryptString`; on success re-encrypt with the file key and
  write the row back; on failure leave the row untouched and mark the provider
  `keyState: 'unreadable'` (a runtime field on `Provider`, not a column) so the
  UI can explain. Never overwrite a ciphertext that could not be read.
- **The UI says what happened.** A provider whose key is unreadable shows a
  translated line under its card and in the editor — "This key was saved by a
  previous version of the app and cannot be read after the update. Paste it
  again." — with the key field focused; probing and model fetching for such a
  provider return a `key_unreadable` error code rather than a generic failure.
  `resolve.ts` maps a decrypt failure to that code instead of throwing raw.
- Unit tests: round-trip and tamper detection for `FileKeySecretStore`; the
  key file's mode; the `fk1:` / `v10` / `plain:` discrimination; the migration
  with a fake `safeStorage` that succeeds, fails, or is absent; `resolve.ts`
  surfacing `key_unreadable`; the store and editor showing the notice.
- e2e: `e2e/providers.spec.ts` — save a key, restart the app, the key is
  still there and the probe passes (the file key survives a relaunch); a
  seeded `v10…` row the build cannot read shows the "paste it again" line.
Acceptance: a key saved in one unsigned build is readable by the next unsigned
build from the same `userData`; an unreadable legacy key is explained, not
reported as a failed probe. Docs: `docs/features/providers/` and
`docs/features/database/` (all four each), `docs/features/packaging/backend.md`
(the security posture and the S7.3 hand-off).
Done: `createFileKeySecretStore` in `src/main/secrets.ts` — AES-256-GCM with a
fresh 12-byte IV per value, under 32 random bytes in `userData/secrets.key`
(mode `0600`, created on first use, `wx` so two processes starting at once
cannot each write one), stored as `fk1:` + base64(iv‖tag‖ciphertext) and failing
with a typed `key_unreadable` on a wrong key, a failed tag, a truncated value or
a value that is not its own. `src/main/ipc/secret-store.ts` now exposes
`createSafeStorageStore()`, which returns the store **or `null`**, and is used
for exactly two things: reading the old rows, and wrapping the key file when
`WITENA_SIGNED_BUILD` is set. `migrateProviderSecrets`
(`src/main/providers/migrate-secrets.ts`, Electron-free, called from
`index.ts` after the context exists) re-encrypts every `djEw…` / `plain:` row
through the repository's own `encrypt`, skips anything already `fk1:` — so the
second launch writes nothing — and **never overwrites a ciphertext it could not
read**, collecting those ids in `AppContext.unreadableSecrets` instead.
`Provider.keyState` (`ok` / `unreadable` / `none`) is filled from that set by the
`providers.*` handlers and cleared by a patch that touches `apiKey`; it is a
runtime field, so there is no column and no migration.

**The key file records how it is stored** (`fkkey1:` versus `fkkey1w:`) rather
than trusting the environment variable at read time — the variable describes the
running build, not the file it found, and a mismatch would hand the wrong 32
bytes to AES, which fails exactly like "your keys are gone". **Wrapping is off
unless the build is signed**, because `safeStorage` on an unsigned build is
granted to an identity that changes with every package: wrapping there would
recreate the bug. `djEw` is not a magic string either — it is base64 of `v10`,
Chromium's `OSCrypt` prefix, which survives the encoding because base64 maps
three bytes to four characters; `djEx` is `v11`, Linux's keyring-less fallback.

`resolve.ts` maps a failed decrypt to `key_unreadable` (new `BackendErrorCode`,
translated in the renderer) and marks the provider, so a probe, a model fetch and
a chat turn all say the same thing — and the card and the editor explain it with
nothing probed at all: one line under the card, one above the key field, the
field focused, and the "a key is stored" hint replaced rather than shown beside
it, because it would be true and reassuring. The renderer store also stopped
flattening a **rejected** probe to `internal`, which is what made the new code
visible under the Test button.

Verified: `npm test` (93 files, 1521 tests, all passing) and `npm run typecheck`,
plus the full Playwright suite (99 passed) with a local Ollama running, so
`e2e/providers.spec.ts`'s new "a key saved in one launch is still readable by the
next" really does save a key, relaunch the app on the same `userData` and probe
green through the restored key — and its companion seeds a `djEw…` row with the
`sqlite3` CLI while the app is closed and watches the UI ask for it again. What
is **not** verified is the reinstall itself: that needs two differently packaged
unsigned dmgs, so the relaunch is the automated half and the dmg-over-dmg case
stays a manual check. Recorded, with the two follow-ups the step deliberately did
not do, in "API keys and the key file (S7.6)" in the Phase 6 backlog.

## Phase 8: Online version (PLAN "Local release and online version")

Ordered so that each step runs end to end on a laptop before AWS is involved.

### S8.1 Server host and Postgres `[x] (2026-09-17)`
What: the business logic runs in a plain Node process.
- `src/server/index.ts`: builds `AppContext` with injected storage, secrets
  and event bus, mounts every `BACKEND_METHODS` entry as `POST /api/<method>`
  (JSON in, JSON out, `BackendError` → HTTP status + body) and the event bus
  as `GET /ws` (WebSocket, one connection per client, events as JSON). No
  electron import anywhere under `src/server/` — enforced by a test.
- drizzle with the `pg` driver next to `better-sqlite3`; the schema stays
  one file; migrations generated per dialect or written dialect-neutral —
  decide, record it in `docs/features/database/`. Local dev runs Postgres in
  Docker (`docker-compose.yml`).
- Tests: every handler test runs against both dialects through a shared
  fixture; an HTTP contract test drives `chat.send` and watches the WebSocket.
Acceptance: `npm run server` + the existing renderer over a
`HttpBackendClient` (S8.3) streams a reply. Docs: new feature `server`
(`docs/features/server/`), `docs/features/database/`, `backend-client`.
Done: `src/server/` is the second host and it is genuinely only a host — six
files (`config.ts`, `context.ts`, `http.ts`, `user.ts`, `index.ts`, and the build
config beside them) that read the environment instead of asking electron, build
the **same** `AppContext` through `createAppContext`, and mount the **same**
`buildHandlers()` map. The route is computed from the path rather than declared
in a table, exactly as `registerIpc` validates the method name it is handed, so
there is no second list of methods to fall out of step with `BACKEND_METHODS`.
The body is the IPC envelope unchanged — `{ ok, value }` / `{ ok, error }` from
`ipc-protocol.ts`, which imports no electron and was always shared — with a
status derived from `BackendError.code` by a table that is total over the union,
because a proxy should see something truthful while the body stays the authority.
`GET /ws` is one `ws` connection per client and **one** bus subscription for the
whole process: the event is serialised once and written to each socket, so a
streaming run does not pay N `JSON.stringify` calls per token. The five
electron-only methods are mounted like every other one and answer with the
rejection `handlers/system.ts` already wrote for exactly this case;
`openInEditor` with a `custom` command actually works here, because that branch
is `node:child_process`.
The **HTTP stack is `node:http` + `ws`**, decided rather than defaulted: the
routing surface is one literal prefix, one table lookup and two fixed paths, with
no path parameter and no middleware chain, so Fastify or Hono would add a
dependency (plus a WebSocket plugin that reaches for `ws` anyway) to save about
thirty lines of `if`. Fastify's schema validation was the one real temptation and
was refused for a better reason than size: the handlers already validate their
own input because IPC needs them to, and a second validation layer on one
transport is how two transports start disagreeing. One new runtime dependency,
`ws`.
`npm run server` is a Vite build into `out/server/` and then `node`, not
`node src/server/index.ts`, because both migrators inline their SQL with
`import.meta.glob(… '?raw')`; three toolchains now resolve that primitive, so all
three hosts run the same migration code rather than two of them running it and
the third approximating it. Verified by running it: `/healthz` answers,
`system.ping` answers, `chats.get` on a missing id answers 404 with the envelope,
and `SIGTERM` closes the sockets, the runners, the MCP children and the database.
**Postgres is beside SQLite, not under the repositories, and that is the
step's one deliberate deviation.** `Repositories` is a *synchronous* interface —
better-sqlite3 is, and the handlers, `ChatRunner`, `AgentTurn` and the supervisor
are all written against that — while drizzle's Postgres driver is asynchronous
with no synchronous escape. "The same repository interfaces over Postgres" and
"the repositories' public types must not change" cannot both hold, and the three
ways out were weighed and written down (`docs/features/server/context.md`,
"Postgres is not the server's database yet"): making the interface async is the
right eventual answer and is a cross-cutting refactor this step was told not to
do; a worker-thread sync driver would block the event loop of a server whose job
is concurrent streaming; a second repository implementation is ~800 lines of
duplicated patch semantics on a path nothing runs, which is not coverage but a
second place to be wrong. So what shipped is the dialect *underneath* the
repositories, complete: `src/main/db/postgres/` with the schema, the migrations,
`openPostgresDatabase` and the migrator, `docker-compose.yml` for Postgres 16 on
loopback, and `DATABASE_URL` selecting it. The server says so at startup when the
variable is set instead of silently opening SQLite.
Two sub-decisions inside that. **Two schema files kept in step by a test**, not
one description emitting both: a generated description cannot carry drizzle's
`$type<…>()` typing, which is what turns a change in `shared/types.ts` into a
compile error in the schema, and it would rewrite the file every other open
branch is editing — while `postgres/schema-drift.test.ts` compares the two
through drizzle's own metadata (tables, columns, nullability, defaults, primary
keys, enum values), needs no database, and runs in 400 ms. And **migrations
generated per dialect**, not neutral SQL, because there is no neutral spelling:
`created_at` holds `Date.now()`, which fits SQLite's dynamically sized `integer`
and does not fit Postgres's four-byte one, so it has to be `bigint` — with
`boolean` against `integer` and `jsonb` against `text` on top. The two dialects
also have different histories: `0001`–`0003` exist to add a column to a database
already on somebody's laptop, and nothing predates `postgres/0000_init.sql`.
Tests: `src/main/db/dialects.ts` is the shared fixture and `dialects.test.ts` the
suite — one body, SQLite always, Postgres when `DATABASE_URL` is set and
otherwise a skip whose *name* carries the compose command. It asserts the
storage contract the repositories stand on: parsed JSON, real booleans, an
epoch-millisecond timestamp surviving intact (the assertion that would otherwise
have found `integer` in production), the goal document replaced and cleared,
ordering by `seq` rather than insertion, both cascades. The fixture is a small
row gateway rather than `Repositories` for the reason above, and handler tests
against Postgres are therefore **not** part of this step — they cannot be until
the interface goes async. `src/server/http.test.ts` is the contract test: a real
server on an ephemeral port, `providers.create` → `agents.create` →
`chats.create` → `chat.send` against a `MockLanguageModelV4` injected through
`runner.createModel` the way `agent-turn.test.ts` does, asserting that
`message.created`, `message.delta` and `run.finished` arrive over the WebSocket
and that the deltas reassemble into the model's own text. `no-electron.test.ts`
walks the whole transitive import closure of `src/server/` — which reaches
`app-context.ts`, `chat-runner.ts` and the handler registry — and fails on any
`electron` specifier, with a guard on itself proving the scanner recognises all
five spellings.
What is **not** verified: the Postgres path has never executed. This machine has
neither Docker nor Postgres, so `dialects.test.ts`'s Postgres half is skipped and
`0000_init.sql` has never been applied — it is checked against the schema it must
produce by the drift test, and by review. CI keeps running SQLite only, which is
stated in `docs/features/server/implement.md` under "What CI does not run"; a
Postgres service there is a one-line `services:` block and is left until S8.5,
when there is a deployment whose migrations are worth gating on. The acceptance
criterion's second half — the renderer over an `HttpBackendClient` — is S8.3's by
construction: S8.1 builds only the server side and drives it with `fetch` and a
`ws` client. `npm test` 1616 passed / 11 skipped, `npm run typecheck` clean, and
`e2e/smoke.spec.ts` green so the desktop app still launches over the shared
`migrate.ts`. Recorded in the Phase 6 backlog under "Server and editor".

### S8.2 Accounts `[ ]`
What: sign in, and everything is yours only.
- Cognito user pool (hosted UI, email + password, optional Google), JWT
  verified by the server on every request and at WebSocket connect;
  `userId` = `sub`; the `local` user disappears from the server path.
- Renderer: a sign-in page, token storage (memory + refresh), sign-out,
  and the `Authorization` header in `HttpBackendClient`.
- Tests: an unauthenticated request is refused; two users cannot see each
  other's chats (handler tests with two `userId`s); token refresh.
Acceptance: two accounts on one server each see only their own data.
Docs: `server`, `backend-client`, `ui-shell`.

### S8.3 Web client and capabilities `[ ]`
What: the renderer runs in a browser.
- A Vite web build target for `src/renderer/` producing a static SPA;
  `HttpBackendClient` + WebSocket subscription; `system.capabilities`
  returned by every host (`{ pickFolder, openInEditor, stdioMcp, workdir,
  antSignIn, nativeTheme }`) and used by the pages to hide what the host
  lacks — no page imports anything Electron-specific (rule 6 holds).
- Materials online: uploaded files stored per chat (S3), listed the way
  folder materials are, so document goals still work without a folder.
- Tests: the capabilities gate per control; a Playwright run of the SPA
  against the local server.
Acceptance: the same chat flows in Chrome against the local server as in
the desktop app, minus the hidden features. Docs: `server`,
`backend-client`, `chats`, `ui-shell`.

### S8.4 Secrets, limits and observability `[ ]`
What: what a hosted product must have before strangers use it.
- `KmsSecretStore` (envelope encryption, one data key per user); per-user
  spend and rate limits enforced in `ChatRunner` (the usage tables exist);
  structured logs and a `/healthz`; an audit log of sign-ins and key changes.
Acceptance: keys at rest are ciphertext; a user over their cap gets a
translated notice, not a 500. Docs: `server`, `providers`, `usage`.

### S8.5 AWS deployment `[ ]`
What: it is on the internet.
- `infra/` CDK app: VPC, RDS Postgres, ECS Fargate service (the server
  image), ALB with WebSocket, S3 + CloudFront for the SPA, ACM, Route 53,
  Cognito; GitHub Actions builds the image and deploys on a `cloud-v*` tag;
  migrations run as a one-off task before the service flips.
Acceptance: `https://<domain>` signs in, streams a reply, survives a redeploy
without dropping a running chat's events for longer than the WebSocket
reconnect. Docs: `server` and a new `infra` feature.

### S8.6 Desktop app signs in to the cloud `[ ]`
What: the promise in "Reserved server capability".
- A "Witena Cloud" mode in the desktop app: sign in, and the app swaps its
  `BackendClient` to the HTTP one; local-only features stay available when
  in local mode; switching modes is explicit and never merges data.
Acceptance: the same chat opened on the web and in the app shows the same
messages live. Docs: `backend-client`, `ui-shell`.

### S8.7 Cloud workspaces `[ ]` (later)
The executor online: a per-user container with the folder, the same seven
tools over a small agent inside it, the permission prompt unchanged.

