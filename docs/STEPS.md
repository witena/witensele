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
- **Google sign-in.** Standard OAuth 2.0 with PKCE and a loopback redirect is
  technically straightforward, but billing decides the design: the Gemini API
  bills the project that owns the OAuth client (the developer's), while
  Vertex AI bills the user's own project through `x-goog-user-project`. Decide
  which before building; the user needs a GCP project with billing either way.
- **A chat turn through a signed-in provider, on an account with API credit.**
  S5.3 proved the headers as far as the API accepts them — `/v1/models` answers
  200 through the OAuth wrapper — but the account used for verification has no
  credit, so `/v1/messages` is refused with `invalid_request_error` ("your credit
  balance is too low") for a bare `curl` as well as through the app. Run the
  acceptance sentence again on a funded account before treating the generation
  path as proven.
- **Several logins, or a second vendor's CLI.** `providers.authStatus` takes no
  argument because `ant` has one active profile, so the status is a fact about
  the machine. Supporting profiles, or OpenAI's and Google's own CLIs, means
  naming which login a provider uses and a picker to choose it.
- **Cloud-platform providers.** Claude on Vertex AI and Amazon Bedrock, GPT on
  Azure, authenticated with the platform's own credentials or SSO rather than
  a vendor key (`@ai-sdk/google-vertex`, `@ai-sdk/amazon-bedrock`,
  `@ai-sdk/azure`). This is the enterprise route to "closed models without a
  key" and reuses the provider registry; it needs its own presets and a
  credential-source model per platform.

### Executor safety and reach

- **The shell is not sandboxed.** S5.4's `run_command` runs `/bin/sh -c` as the
  user, with the user's environment and `PATH`; only `cwd` is confined, so
  `cat ../../secret` *inside a command* is not stopped by `executor/paths.ts`.
  The permission prompt is the entire boundary, which is why S5.5 must show the
  command line verbatim and never summarised. A real sandbox — a container, a
  restricted `PATH`, a seccomp profile, or delegating to a coding agent that has
  one — is a step of its own, and it is the one item here that should be picked
  up before the executor is recommended for an unfamiliar folder.
- **No prompt timeout of its own.** A pending `permission.requested` is ended
  only by a reply, by Stop, or by the turn's hard timeout, which then records the
  turn as `skipped` rather than as "nobody answered". A prompt-specific timeout
  with its own notice would read better.
- **`allowAlways` is not visible or revocable.** It lives in a `Set` for the life
  of the process, so a user who granted it cannot see what they granted or take
  it back without quitting. A chat-settings row listing the grants, with a
  "forget" button, is the obvious shape.
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
- **Nothing emits a `FileRefPart`.** S5.5 renders one as a `path:line` chip and
  S5.7 makes that chip open the file, but every chip a user actually sees comes
  from S5.7's text **detector**: no backend code writes the part. A turn that
  reported the files it read as parts would be more precise than a regular
  expression over prose, and would make the chip work for a path the detector's
  extension rule refuses.

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

- **The light theme has not been reviewed on a full transcript.** S5.8 looked at
  the chat, settings, agents, providers and agent-editor screens, and at one real
  reply with a highlighted code block, but the screens that only exist while
  something is running — a streaming message, a tool card, an error message, the
  four presence dots side by side, S5.5's permission card and diff block — were
  read from their tokens rather than seen. They use no colour of their own, so
  the risk is a *step* that is too subtle rather than an unreadable screen.
- **Avatar and provider-logo colours stay dark in both themes.** They are data,
  not tokens: an agent's `avatar.color` is stored in its record and
  `provider-logo.ts` picks from a fixed palette, so a dark tile with a light
  monogram is what both themes show. It reads as a brand chip on white and was
  left alone deliberately — theming it means either rewriting stored rows or a
  second palette keyed by theme, which is a step of its own.
- **`prefers-contrast` and `prefers-reduced-transparency` are not honoured**, and
  there is no high-contrast variant of either palette.

### Server and editor

- **Server and multi-user** (PLAN "Reserved server capability"): lift the
  main-process business logic into a Node server, swap the `BackendClient`
  implementation for HTTP + WebSocket, real `userId`s, a server-side
  `SecretStore`, and — only if several server instances or worker processes
  exist — an `EventBus` / `MessageRepository` implementation over Redis
  Streams, Postgres LISTEN/NOTIFY or NATS.
- **VS Code extension** embedding the chat panel over that server backend
  (PLAN "Future extension", point 3, step two). Depends on the item above.

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
