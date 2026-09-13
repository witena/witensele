# Witena: Multi-Agent Group Chat Desktop App — MVP Plan

This document describes the **target end state**. The step-by-step execution list lives in `STEPS.md`; per-feature details live in `docs/features/<feature>/`.

## Context

Witena is a "multi-agent group chat" application. The user opens a chat, invites several agents into it, and lets them discuss a hard problem together so that collective intelligence produces a better answer. Each agent has its own model, skills, MCP tools, and memory. The UI follows the familiar three-column layout (chats on the left, the conversation in the middle, group members on the right), plus an agent configuration screen and global settings. Both closed models (Anthropic, OpenAI, Google), Chinese providers (DeepSeek, Qwen, Zhipu, ...) and local open models (Ollama) are supported.

Repository: `/Users/huangjay/Documents/Witena`, remote `git@github.com:witena/witensele.git`.

Decisions already made:
- Single-user desktop application, data stored locally. The MVP has no server and no accounts, but the architecture must leave room for both (see "Reserved server capability").
- TypeScript end-to-end, packaged with Electron, agent runtime built on the Vercel AI SDK.
- Default orchestration: a user message triggers one round in which every agent replies; agents follow up on each other via @mentions; a maximum number of automatic rounds applies. Within a round, both "sequential" and "parallel" speaking are supported and switchable per chat.
- Conversation only: no built-in file / shell / git tools. All capabilities come from MCP servers.
- First providers: Anthropic, OpenAI, Google, Ollama, a generic OpenAI-compatible provider, plus presets for DeepSeek, Qwen (DashScope), Zhipu, Moonshot, OpenRouter and others.

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Desktop shell | Electron + electron-vite | Main process runs Node; AI SDK, MCP stdio child processes and SQLite all live there |
| Frontend | React + TypeScript + Tailwind + zustand | Dark three-column layout, see the mockup |
| Model access | `ai` + `@ai-sdk/anthropic` `@ai-sdk/openai` `@ai-sdk/google` `@ai-sdk/openai-compatible` | Chinese providers, Ollama and OpenRouter all go through openai-compatible with preset base URLs |
| MCP | `@modelcontextprotocol/sdk` official client | stdio and Streamable HTTP transports; tools wrapped with the AI SDK `jsonSchema()` helper |
| Storage | better-sqlite3 + drizzle-orm | Database file at `app.getPath('userData')/witena.db` |
| Secrets | Electron `safeStorage` | API keys encrypted before being stored in the DB |
| Rendering | react-markdown + shiki, react-virtuoso for virtualized lists | |
| Tests | vitest | Unit tests for orchestration, context transformation, @mention parsing |

## Directory layout

```
src/
  main/
    index.ts              # Electron entry, window
    ipc/                  # one handler file per domain, registered centrally
    db/                   # drizzle schema + migrations
    providers/            # provider registry, presets, LanguageModel factory
    orchestration/        # ChatRunner: round scheduling, @parsing, PASS, cancel
    agents/               # AgentTurn: system prompt assembly, history transform, streamText
    mcp/                  # MCPManager: connection pool, tool discovery, execution
    skills/               # SKILL.md scanning and parsing
    memory/               # per-agent markdown memory directory + built-in tools
  preload/index.ts        # contextBridge, typed api
  renderer/src/
    pages/                # ChatPage, AgentsPage, SettingsPage
    components/           # chat/, members/, agents/, settings/, ui/
    stores/               # zustand: chats, messages (streaming), agents, settings
    lib/backend.ts        # BackendClient implementation over preload api
  shared/
    types.ts              # domain types + IPC contract (shared by main and renderer)
    mentions.ts           # the @name matching rule, shared by ChatRunner and the composer
    presets.ts            # provider presets (name, baseUrl, default model list)
```

## Data model (SQLite)

- `providers`: id, type (anthropic | openai | google | openai-compatible), name, baseUrl, apiKeyEncrypted, models (json), presetId
- `agents`: id, name, avatar, description, systemPrompt, providerId, modelId, params (json: temperature, maxTokens), skillNames (json), mcpServerIds (json), memoryEnabled
- `mcp_servers`: id, name, transport (stdio | http), command, args (json), env (json), url, enabled
- `chats`: id, title, settings (json: mode = roundrobin | mention-only, speaking = sequential | parallel, maxAutoRounds, memberOrder)
- `chat_members`: chatId, agentId, position
- `messages`: id, chatId, seq, senderType (user | agent | system), senderId, parts (json: text | reasoning | tool-call | tool-result), status (streaming | done | error | passed | skipped), round, mentions (json), inReplyTo (json, nullable: who asked for this reply), usage (json), error, createdAt
- `settings`: userId, data (json: the whole `AppSettings` object), updatedAt

Every table also carries `userId`, a UUID primary key and `createdAt` / `updatedAt` as epoch milliseconds (see "Reserved server capability"). `messages.seq` is a per-chat monotonic counter assigned at insert: parallel agents in one round can be persisted within the same millisecond, so `createdAt` alone does not define a stable transcript order. Details in `docs/features/database/`.

Skills and memory are not stored in the DB; they live on the filesystem: `userData/skills/<name>/SKILL.md`, `userData/memory/<agentId>/MEMORY.md` plus `notes/*.md`.

## Core mechanisms

### Orchestration (ChatRunner, main process)

1. A user message starts round 1. In roundrobin mode the speakers are all agents in the chat (by memberOrder); in mention-only mode only the @mentioned agents speak.
2. Sequential: AgentTurns run one after another, so later agents see earlier replies. Parallel: `Promise.all`, replies within the round are not visible to each other.
3. When a round ends, agent messages of that round are scanned for `@name` mentions; the mentioned agents (deduplicated, self excluded) become the next round's speakers. If there are none, or maxAutoRounds is reached, control returns to the user.
4. One AbortController per chat; the Stop button in the UI can interrupt the whole chain at any time.
5. A reply whose body is exactly `[PASS]` counts as abstaining: the message status becomes passed and the UI renders it dimmed.

### Round barrier and agent sessions (everyone sees every answer)

- The message stream is the single source of truth. An agent has no long-lived conversation object; before every turn it rebuilds its own view from the shared stream (see history transform below), so it always includes every other agent's answer so far.
- A round ends only when every speaker is done, passed, skipped or errored. Parallel mode waits on a barrier; sequential mode satisfies this naturally. No agent enters the next round while others are still answering.
- Each (chat, agent) pair has an `AgentSession` runtime object: presence state, lastActivityAt, current AbortController, cumulative usage for this chat.

### Heartbeat, timeouts and presence (AgentSupervisor)

A supervisor in the main process ticks every second and checks all active AgentSessions. States and colours follow the Teams convention:

| State | Colour | Condition |
|---|---|---|
| available | green | provider health check passes, currently idle |
| working | red | requesting the model, streaming, or running a tool; every chunk / tool event refreshes lastActivityAt |
| away | orange | working but no activity for more than `stallTimeout` (default 30 s), e.g. provider queueing or a stuck tool |
| offline | grey | still no activity after `hardTimeout` (default 120 s), N consecutive request failures, or a failed provider health check (periodic `/models` or lightweight probe) |

Rules:
- away is informational only and never interrupts.
- On hardTimeout: abort that agent's request, mark the message `skipped`, insert a system message "X did not respond and was skipped this round", the barrier treats it as complete and the round continues.
- offline agents are excluded from later rounds and greyed out in the member panel; when the provider probe recovers they return to available. The user can also "retry this agent" manually.
- Thresholds are adjustable in chat settings and global settings; tool execution has its own `toolTimeout`.
- State changes are pushed to the renderer as IPC events; the member panel shows coloured dots in real time.

### One agent turn (AgentTurn)

- System prompt assembly order: the agent's own systemPrompt; the group briefing (member list, who you are, other members' messages appear prefixed with `[name]:`, use `@name` to mention others, reply `[PASS]` if you have nothing new to add); the name and description of enabled skills; the full MEMORY.md index.
- History transform: user messages and other agents' messages become the user role with a `[name]:` prefix; this agent's own messages keep the assistant role; consecutive user-role messages are merged.
- Tools: every tool from the agent's MCP servers, plus built-in `read_skill` and `read_skill_file`, plus `memory_save` and `memory_search` when memory is enabled.
- `streamText` with `stopWhen: stepCountIs(n)` runs the tool loop; deltas are pushed to the renderer via `webContents.send`; parts and usage are persisted when the turn ends.
- Context overflow: the MVP estimates tokens by character count and drops the oldest messages first, keeping the system prompt. Summarization comes later.

### Provider layer

`providers/registry.ts` creates AI SDK model instances from provider records. `shared/presets.ts` holds presets: DeepSeek, Qwen (DashScope compatible mode), Zhipu, Moonshot, MiniMax, Volcengine Ark, SiliconFlow, OpenRouter, Ollama (localhost:11434/v1), LM Studio. "Add provider" in settings starts from a preset, prefills baseUrl and default models, and can fetch the model list from `/models`.

### MCP (MCPManager)

Clients are cached by server id, connected lazily on first use, `listTools` results are converted into AI SDK tools. Results are returned as text or JSON. In the MVP tool calls run without confirmation and the UI shows a tool card; permission prompts come in a later version.

### Skills

Scan `userData/skills/*/SKILL.md`, parse frontmatter with gray-matter. Progressive disclosure: the system prompt only carries name and description; the agent fetches the full text with the `read_skill` tool and bundled resources with `read_skill_file`. Settings supports "import skill folder".

### Memory

Claude Code style: `MEMORY.md` is the index, `notes/` holds one file per entry. `memory_save(title, content)` writes a file and appends an index line; `memory_search(query)` does a text search. The agent configuration page can view and edit memory by hand.

## User interface

- **Navigation rail**: Chats, Agents, Settings.
- **Main view**: left column chat list (new, rename, delete, search); middle column message stream (avatar, name, model badge, collapsible reasoning and tool calls, streaming cursor, dimmed passed messages) and composer (`@` autocomplete for members, Enter to send, Shift+Enter for newline, Stop button while running); right column member panel (each agent's state, token usage in this chat; add / remove members from the agent library; chat settings: mode, sequential or parallel, max auto rounds, drag-to-reorder speaking order).
- **Agent configuration page**: agent list on the left, form on the right: basic info, provider and model dropdowns, parameters, system prompt, skills multi-select, MCP servers multi-select, memory toggle and viewer.
- **Settings page**: providers (preset picker, key, model list), MCP servers (stdio command or HTTP URL, test connection), skills (list, import), timeouts and heartbeat, appearance and language, data and backup.
- **Presence dots**: both the member panel and the avatar of every message show a presence dot (green / red / orange / grey). Colours come from AgentSupervisor events; the dot on a message reflects the agent's *current* state, not its state when the message was sent.
- **UI mockup**: https://claude.ai/code/artifact/6730ad03-5843-4e6a-8adb-7b70bfa3405e (three artboards: group chat, agent configuration, settings). It is the visual reference for implementation.

## Bilingual UI (i18n)

- `i18next` + `react-i18next`; locale files at `src/renderer/src/locales/zh-CN.json` and `en.json`. Every UI string goes through `t('key')`; hard-coded Chinese or English in components is forbidden.
- Switchable under Settings → Appearance & Language, with a quick toggle at the bottom of the settings navigation. Takes effect immediately without restart, persisted in the settings table, follows the system language on first launch.
- User-visible text produced by the main process (system messages such as "X did not respond and was skipped", error messages) is sent as a message key plus parameters and translated by the renderer.
- The group briefing injected into models exists in both Chinese and English and follows the UI language, so English-first models understand it.
- Test: a unit test asserts that both locale files have identical key sets.

## Future extension: executors and external systems (not in the MVP, interfaces reserved now)

Discussion output must eventually land in code, documents and email. Three layers:

1. **Connectors are MCP servers.** git, GitHub, filesystem, Gmail, Google Drive, Notion, Slack, Word (via Microsoft Graph) all have MCP servers already; the MVP's MCP mechanism covers them. Later, settings gets a "connector gallery": common servers with preset commands, one-click add, and a distinction between read-only tools and tools with side effects.
2. **Executor agent.** A special agent role bound to the chat's local working directory, with built-in file read/write, shell and git tools and a permission-confirmation UI (confirm before every write or command, with "always allow in this chat"). Workflow: discuss → user clicks "hand to executor" → the executor implements the group's conclusion → posts a diff summary back to the chat → other agents review → iterate. Two implementation paths: our own tool loop on the AI SDK, or an existing coding agent (Claude Agent SDK / Codex CLI / Aider) as a backend. Build the former first; the latter becomes an optional provider.

   **Decision: discussion agents are read-only; all writes go through one executor.** Participant agents may be given read-only tools (a filesystem MCP server in read-only mode, search, git log / diff) so they can ground their discussion in the real code, but they never write files, run commands or commit. Every side-effecting change is made by a single executor agent per chat, after the discussion, with permission prompts and a diff posted back for review. Rationale: several models writing to the same directory overwrite each other and nothing is reviewable; one writer plus a diff-review loop keeps the chain clean. Enforcement: `mcp_servers.sideEffects` marks servers whose tools mutate state; the MCP layer (S3.1) refuses to expose those tools to `participant` agents and only attaches them to `executor` agents. Until the executor exists, users should attach only read-only MCP servers to agents, because MVP tool calls run without confirmation.
3. **Editor integration.** Step one: open file paths and diffs from a message directly in VS Code (`code -g file:line` or `vscode://` links). Step two: a VS Code extension embedding the chat panel in the sidebar, reusing the same backend. This is exactly why business logic must not depend on Electron and the frontend must only depend on the BackendClient abstraction.

Fields and interfaces reserved in the MVP for this: `chats.workdir` (nullable), `agents.role` (`participant` | `executor`), `diff` and `file-ref` message part types, a `permission` event and reply channel before tool execution, and a `sideEffects` flag on MCP server records.

## Reserved server capability

The MVP runs entirely locally, but is written under these constraints so that a server and accounts can be added later without a rewrite:

- The renderer depends on a single abstract `BackendClient` interface (`shared/backend.ts`): request/response methods plus an event subscription channel. The MVP implementation goes over Electron IPC; later it can be swapped for HTTP + WebSocket without touching page code.
- Every table has `userId` (fixed to the local user `local` in the MVP), UUID primary keys, `createdAt` / `updatedAt`. Messages carry `senderType` / `senderId`, so multiple humans are already representable.
- Streaming output, state changes and presence changes are all typed events (`shared/events.ts`) rather than scattered IPC channels, so they can be forwarded over WebSocket unchanged.
- Business logic in the main process (ChatRunner, AgentTurn, MCPManager, memory) never imports Electron APIs; it depends only on injected storage and an event bus, so it can move to a Node server as a block.
- API key access goes through a `SecretStore` interface: Electron `safeStorage` in the MVP, backend secret management in the server version.
- Concurrency and messaging middleware: the MVP needs none. All agent concurrency lives inside the single main process (parallel turns are concurrent promises, the round barrier is `Promise.all`), SQLite has one writer, and events reach the renderer through an in-process bus. Business logic depends only on two injected interfaces, `EventBus` and `MessageRepository`. Redis Streams / pub-sub (or Postgres LISTEN/NOTIFY, NATS) become relevant only in the server version when there are multiple server instances or agent workers in separate processes; at that point they are alternative implementations of those two interfaces, not a change to ChatRunner.

## Test gate

Nothing ships before its own tests pass; failing tests mean the feature is not done.

- Unit tests (vitest): @mention parsing, next-round speaker computation, history transform roles and prefixes, context truncation, presence state machine, barrier completion, skills frontmatter parsing, memory index read/write.
- Integration tests (vitest with the AI SDK mock language model): full rounds in sequential and parallel mode; a stuck agent going away → offline → skipped; tool call round trips; provider errors.
- End-to-end (Playwright for Electron): launch the app, add a provider, create an agent, send a message, see multiple agents reply, watch the member panel change colour.
- Each feature's `implement.md` lists its test files; `npm test` runs everything; GitHub Actions CI comes later.

## Documentation convention (mandatory per feature)

Every feature keeps four documents under `docs/features/<feature>/`, updated in the same commit as the code. Before changing a feature, read these four first:

| File | Content |
|---|---|
| `context.md` | The problem this feature solves, its boundaries, dependencies on other features, decisions and trade-offs already made |
| `implement.md` | Overall approach, data flow (user action → renderer → IPC → main → DB / model), key types and IPC contract, known limitations and TODOs |
| `frontend.md` | Pages and component files involved, zustand store fields, IPC calls used, interaction states (loading / streaming / error) |
| `backend.md` | Main-process modules and files, DB tables and fields, IPC handler list, usage notes and pitfalls of external dependencies (AI SDK / MCP SDK) |

Feature list (mirrors the directory layout): `providers`, `agents`, `chats`, `orchestration`, `agent-turn`, `presence` (heartbeat, timeouts, presence), `mcp`, `skills`, `memory`, `backend-client` (IPC abstraction and events, *infrastructure*), `database` (schema, migrations and repositories, *infrastructure*), `ui-shell` (layout and navigation), `i18n`. Infrastructure features have no UI of their own; their `frontend.md` says so and points at the feature that does. `docs/README.md` holds an index linking every feature's four documents.

Language rule: everything committed to the repository (docs, code comments, commit messages, PR text) is in English. Chinese versions of docs use the `.zh.md` suffix and are gitignored; `CLAUDE.local.md` is the Chinese copy of `CLAUDE.md`.

## Milestones

1. **Skeleton**: electron-vite scaffold, DB and migrations, i18n framework and language switch, three-column layout, providers settings page, single-agent streaming chat working end to end.
2. **Multi-agent**: agent configuration page, member panel, ChatRunner with roundrobin and mention-only, sequential and parallel, @parsing, PASS, maxAutoRounds, stop, AgentSupervisor heartbeat and presence dots.
3. **Capabilities**: MCP server settings and tool calls, skills loading and read_skill, memory tools and viewer.
4. **Polish**: usage statistics, context truncation, automatic titles, electron-builder packaging for macOS.
5. **Later** (post-MVP): connector gallery, executor agent and working directory, VS Code open and extension, server and multi-user.

## Verification

- `npm run dev`; add at least two providers in settings (e.g. Anthropic and the DeepSeek preset) and fetch their model lists.
- Create 3 agents on different providers, put them in one chat, ask a question: in sequential mode they reply in order and later ones cite earlier ones; in parallel mode they stream simultaneously; an @mention in a reply triggers a second round; the chain stops at maxAutoRounds; Stop interrupts it.
- MCP: register `npx -y @modelcontextprotocol/server-everything` as a stdio server; an agent can list and call its tools and the UI shows tool cards.
- Skills: drop in a sample SKILL.md; the agent calls read_skill when it needs the full text.
- Memory: have an agent remember a fact in chat A, ask in a new chat B and it recalls it; files appear under `userData/memory/<agentId>/`.
- vitest coverage: @parsing, next-round speakers, history transform roles and prefixes, context truncation.
