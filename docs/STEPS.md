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

### S1.2 Database `[ ]`
What: drizzle schema (providers, agents, mcp_servers, chats, chat_members, messages, settings; all with userId / UUID / timestamps), migrations, opening `userData/witena.db`.
Acceptance:
- Unit tests run CRUD on every table against a temporary database file
- After `npm run dev`, witena.db appears under the userData directory

### S1.3 IPC and the Electron BackendClient implementation `[ ]`
What: preload exposes `invoke` and `subscribe`; renderer `lib/backend.ts` implements BackendClient; main-process handler registry.
Acceptance: the renderer calls `system.ping` and receives pong; the main process emits a test event and the renderer receives it.

### S1.4 i18n `[ ]`
What: i18next + react-i18next, `locales/zh-CN.json` and `en.json`, language persisted in the settings table, follows the system language on first launch.
Acceptance:
- Unit test: both locale files have identical key sets
- Switching the language in settings takes effect immediately and survives a restart

### S1.5 UI shell `[ ]`
What: navigation rail, three page shells (Chats / Agents / Settings), three-column layout, dark theme with the mockup colours.
Acceptance: a screenshot matches the mockup in layout and colours; docs under `docs/features/ui-shell/`.

### S1.6 Providers `[ ]`
What: `shared/presets.ts`; settings page to add / edit / delete providers; SecretStore (safeStorage) encrypting keys; fetch `/models`; test connection; `providers/registry.ts` creating model instances.
Acceptance:
- Add Ollama (local) and one OpenAI-compatible preset, fetch their model lists, test connection reports success
- Keys are stored encrypted in the DB
- Unit tests: the preset table is complete; the registry constructs an instance for all four provider types

### S1.7 Single-agent chat end to end `[ ]`
What: chats CRUD and the left column list; minimal ChatRunner (one agent); AgentTurn streaming via streamText; messages persisted; composer and Stop button.
Acceptance:
- Create a chat, send a message, see a token-by-token streaming reply
- Stop interrupts the reply
- Messages survive an app restart
- Integration test: a mock model runs one full send → stream → persist cycle

---

## Phase 2: Multi-agent (PLAN milestone 2)

### S2.1 Agents CRUD and configuration page `[ ]`
What: agents table CRUD; configuration page with basic info, provider and model dropdowns, parameters, system prompt; list page.
Acceptance: create 3 agents on different providers, they survive a restart; unit tests for CRUD.

### S2.2 Chat members and chat settings `[ ]`
What: chat_members add / remove / reorder; member panel on the right; chat settings (mode, sequential / parallel, max rounds, timeouts).
Acceptance: agents can be added to, removed from and reordered within a chat; chat settings persist.

### S2.3 Orchestration engine `[ ]`
What: full ChatRunner: roundrobin / mention-only, sequential / parallel, @parsing, PASS, maxAutoRounds, barrier, stop; history transform (name prefixes, role mapping, merging consecutive messages).
Acceptance:
- Unit tests: @parsing, next-round speakers, history transform, barrier completion
- Mock-model integration tests: full multi-round runs in both modes
- Real models: 3 agents; in sequential mode later agents cite earlier ones; parallel mode streams simultaneously; an @mention triggers round 2; the chain stops at the limit

### S2.4 Presence and heartbeat `[ ]`
What: AgentSession, AgentSupervisor ticking every second, stall / hard timeouts, skip with a system message, provider probing; dots shown in the member panel and on message avatars.
Acceptance:
- Unit tests: transitions between the four states
- Integration test: a mocked stuck agent turns orange at 30 s, grey at 120 s, is skipped, and the round continues
- Dots change colour live in the UI

### S2.5 Message rendering and composer polish `[ ]`
What: markdown and code highlighting, collapsible reasoning, tool cards, round and "replying to @who" labels, dimmed PASS, @ autocomplete, Enter / Shift+Enter.
Acceptance: matches the mockup.

---

## Phase 3: Capabilities (PLAN milestone 3)

### S3.1 MCP `[ ]`
What: MCP servers settings page (stdio / http, test connection); MCPManager lazy connection and tool discovery; agent ↔ server binding; tool call and result cards.
Rule: servers flagged `sideEffects` are only attached to `executor` agents; `participant` agents receive read-only tools only (see "Future extension" in PLAN.md). The settings page shows the flag and explains it.
Acceptance: register `@modelcontextprotocol/server-everything`; an agent lists and calls its tools; unit test for tool schema conversion.

### S3.2 Skills `[ ]`
What: scan `userData/skills`; import a folder; agents select skills; system prompt injects name / description; `read_skill` and `read_skill_file` tools.
Acceptance: drop in a sample SKILL.md; the agent reads the full text when needed; unit test for frontmatter parsing.

### S3.3 Memory `[ ]`
What: `userData/memory/<agentId>/MEMORY.md` and notes; `memory_save` and `memory_search` tools; viewer and editor on the configuration page.
Acceptance: a fact remembered in chat A is recalled in chat B; unit tests for index read/write.

---

## Phase 4: Polish (PLAN milestone 4)

### S4.1 Usage and cost `[ ]`
Acceptance: token counts per message, per member and per chat are correct and shown in the header.

### S4.2 Context truncation `[ ]`
Acceptance: unit test shows an over-long history is dropped oldest-first while keeping the system prompt.

### S4.3 Automatic titles and search `[ ]`
Acceptance: a title is generated after the first message; the left column search filters chats.

### S4.4 Packaging `[ ]`
Acceptance: electron-builder produces a macOS dmg; after installation the app launches and completes one conversation.

---

## Phase 5: Later (post-MVP, see "Future extension" in PLAN.md)

Connector gallery, executor agent with a working directory, VS Code open and extension, server and multi-user.
