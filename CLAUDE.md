# Witena

Witena is a single-user macOS desktop app for multi-agent group chat: you create a
chat, pull in agents that each have their own model, skills, MCP tools and memory,
and let them discuss a problem together so the group reaches a better answer than
any one model would.

Read `docs/PLAN.md` (the target architecture) and `docs/STEPS.md` (the ordered
execution checklist) before doing anything. This file covers the rules that apply
to every change.

## Tech stack

| Layer | Choice |
|---|---|
| Shell | Electron + electron-vite (ESM, `"type": "module"`) |
| Frontend | React 19 + TypeScript + Tailwind v4 + zustand |
| Models | Vercel AI SDK (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`) |
| Tools | `@modelcontextprotocol/sdk` (stdio + Streamable HTTP) |
| Storage | better-sqlite3 + drizzle-orm, database at `app.getPath('userData')/witena.db` |
| Secrets | Electron `safeStorage`, behind a `SecretStore` interface |
| i18n | i18next + react-i18next (`zh-CN`, `en`) |
| Tests | vitest (unit), `@playwright/test` driving Electron (end to end) |

## Directory layout

```
src/
  main/
    index.ts        # Electron entry and window creation
    ipc/            # One handler file per domain, registered together
    db/             # drizzle schema + migrations
    providers/      # Provider registry, presets, LanguageModel construction
    orchestration/  # ChatRunner: round scheduling, @ resolution, PASS, cancel
    agents/         # AgentTurn: system prompt assembly, history conversion, streamText
    mcp/            # MCPManager: connection pool, tool discovery, execution
    skills/         # SKILL.md scanning and parsing
    memory/         # Per-agent markdown memory and its built-in tools
  preload/
    index.ts        # contextBridge, exposes the typed api as window.witena
    index.d.ts      # Ambient declaration of that api
  renderer/
    index.html
    src/            # pages/, components/, stores/, locales/, lib/
  shared/           # types.ts, events.ts, backend.ts, presets.ts, version.ts
docs/               # PLAN.md, STEPS.md, README.md, features/<feature>/
```

Path alias `@shared/*` → `src/shared/*` works in main, preload and renderer.
`@renderer/*` → `src/renderer/src/*` in the renderer only.

## Hard rules

These are not style preferences. A change that breaks one of them is not done.

1. **Everything committed to the repository is in English** — documentation, code
   comments, identifiers, commit messages and PR text. A Chinese version of a
   document uses the `.zh.md` suffix (`docs/README.zh.md`) and is gitignored;
   `CLAUDE.local.md` is the Chinese copy of this file. The only Chinese that is
   committed is product content in `src/renderer/src/locales/zh-CN.json`.

2. **Every feature keeps four documents in sync.** Any change to a feature must
   update `docs/features/<feature>/context.md`, `implement.md`, `frontend.md` and
   `backend.md` in the same commit as the code. Read those four before changing a
   feature. Start a new feature by copying `docs/features/_template/` and adding a
   row to the index table in `docs/README.md`.

3. **`npm test` and `npm run typecheck` must pass before anything is delivered.**
   Write the tests for the behaviour you add; a feature whose tests do not pass is
   not finished. Orchestration, context conversion and `@` parsing in particular
   are covered by unit tests, and integration tests use the AI SDK's
   `MockLanguageModelV2` rather than real network calls.

4. **All user-facing copy goes through i18n `t()`.** No hardcoded Chinese or
   English strings inside components. Both `zh-CN.json` and `en.json` are updated
   together — a test asserts their key sets are identical. User-visible text
   produced by the main process (system messages, errors) is sent as a message key
   plus parameters and translated in the renderer.

5. **Main-process business logic must not import electron.** Only
   `src/main/index.ts` and `src/main/ipc/` may. Everything else (ChatRunner,
   AgentTurn, MCPManager, memory, providers) receives its storage, secret store and
   event bus by injection, so the whole layer can be lifted into a Node server
   later without a rewrite.

6. **The renderer reaches the backend only through the `BackendClient`
   abstraction** (`src/shared/backend.ts`). No component calls `window.witena`,
   `ipcRenderer` or anything Electron-specific directly. The current
   implementation is backed by Electron IPC; swapping in HTTP + WebSocket must not
   require touching page code.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the Vite dev server and launch Electron with HMR |
| `npm run build` | Build main, preload and renderer into `out/` |
| `npm run typecheck` | Type-check both projects (`tsconfig.node.json`, `tsconfig.web.json`) |
| `npm test` | Run the vitest suite once |
| `npm run test:watch` | Run vitest in watch mode |
| `npm run e2e` | Build, then run the Playwright Electron end-to-end harness in `e2e/` (no browser download needed) |
| `npm install` | Install dependencies; `postinstall` rebuilds better-sqlite3 for Electron |

If Electron fails to start with `Error: Electron uninstall`, its binary was never
downloaded: run `node node_modules/electron/install.js`.

## PLAN.md and STEPS.md

- `docs/PLAN.md` is the target architecture — what the finished product looks like,
  including decisions already settled and capabilities deliberately left for later.
  It is the reference for any design question.
- `docs/STEPS.md` breaks that plan into small steps that can each be executed and
  verified on their own. Work strictly in order, do not skip ahead, and satisfy
  every acceptance criterion of a step before moving on. Mark progress with `[ ]`,
  `[~]` and `[x]` plus the completion date.
- If a step shows the plan is wrong, change `PLAN.md` first and then write the code.
