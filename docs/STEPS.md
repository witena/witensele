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
