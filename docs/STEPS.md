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

### S5.3 Anthropic sign-in `[ ]`
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

### S5.4 Executor tools and the permission gate `[ ]`
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

### S5.5 Permission prompt, diff and file-ref rendering `[ ]`
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

### S5.6 Hand to executor and the review loop `[ ]`
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

### S5.7 Open in editor `[ ]`
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
- **Cloud-platform providers.** Claude on Vertex AI and Amazon Bedrock, GPT on
  Azure, authenticated with the platform's own credentials or SSO rather than
  a vendor key (`@ai-sdk/google-vertex`, `@ai-sdk/amazon-bedrock`,
  `@ai-sdk/azure`). This is the enterprise route to "closed models without a
  key" and reuses the provider registry; it needs its own presets and a
  credential-source model per platform.

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
