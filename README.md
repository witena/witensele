<h1 align="center">
  <a href="https://github.com/witena/witensele"><img src="build/icon.png" alt="Witena" width="64" valign="middle" /></a> Witena
</h1>

<p align="center">
  <a href="https://github.com/witena/witensele"><img src="https://img.shields.io/github/stars/witena/witensele?style=flat&amp;label=%E2%98%85&amp;color=d97757" alt="GitHub stars" /></a>
  <a href="https://github.com/witena/witensele/actions/workflows/ci.yml"><img src="https://github.com/witena/witensele/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <img src="https://img.shields.io/badge/license-MIT-d97757?style=flat" alt="License: MIT" />
  <img src="https://img.shields.io/badge/macOS-Apple%20silicon%20%7C%20Intel-4493F8?style=flat-square" alt="Supported platforms: macOS on Apple silicon and Intel" />
</p>

<p align="center">
  <sub><a href="docs/readme/README.zh-CN.md">中文</a></sub>
</p>

<p align="center">
  <strong>A group chat for AI models.</strong><br/>
  Put Claude, GPT, Gemini, DeepSeek, Qwen and your local Ollama models in one room — they read each other, argue by name, and hand you one answer.
</p>

<h3 align="center"><a href="https://github.com/witena/witensele/releases/latest"><ins>Download Witena</ins></a></h3>

<p align="center">
  <a href="docs/assets/demo.mp4"><img src="docs/assets/demo.gif" alt="A tour of Witena: adding a provider, configuring two agents, and a multi-model discussion in one chat" width="960" /></a>
</p>

## Features

<table>
<tr>
<td width="50%" valign="middle">

### One Room, Many Models

Every agent sees the whole transcript and replies to the others by name. An `@mention` schedules the next round; when everyone writes `[AGREED]`, the discussion closes and the conclusion is delivered to you.

[Docs →](docs/features/orchestration/context.md)

</td>
<td width="50%">
  <a href="docs/features/orchestration/context.md"><img src="docs/assets/features/discussion.gif" alt="Two agents on different models discussing a question in one chat" width="100%" /></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Sequential or Parallel Rounds

Sequential lets later speakers read earlier ones. Parallel streams every member at once behind a round barrier, with a presence dot per agent — available, working, stalled, offline — and a hard timeout that skips a dead model instead of hanging the group.

[Docs →](docs/features/presence/context.md)

</td>
<td width="50%">
  <a href="docs/features/presence/context.md"><img src="docs/assets/features/parallel.gif" alt="Two agents streaming their replies at the same time" width="100%" /></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### An Agent Is a Configuration

Model, parameters and system prompt, plus the skills it may read, the MCP servers it may call, and a markdown memory that carries across chats. Build a roster once, pull members into any chat.

[Docs →](docs/features/agents/context.md)

</td>
<td width="50%">
  <a href="docs/features/agents/context.md"><img src="docs/assets/features/agents.gif" alt="Configuring an agent: model, system prompt, memory and skills" width="100%" /></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Every Provider at One Table

Add a provider from a preset, fetch or type its models, and test the connection before you save. API keys are encrypted with the system keychain; Anthropic can sign in through the browser with no key at all.

[Docs →](docs/features/providers/context.md)

</td>
<td width="50%">
  <a href="docs/features/providers/context.md"><img src="docs/assets/features/providers.gif" alt="Adding the Ollama preset, two models, and testing the connection" width="100%" /></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### MCP Tools, Read-Only by Default

Connect stdio and Streamable HTTP servers and tool calls show up as cards in the transcript. Servers flagged as having side effects are kept away from discussion agents — the group reads, one executor writes.

[Docs →](docs/features/mcp/context.md)

</td>
<td width="50%">
  <a href="docs/features/mcp/context.md"><img src="docs/assets/features/mcp.gif" alt="Adding an MCP server and testing it" width="100%" /></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### One-Click Actions

Ask any member to summarize the discussion so far, or hand the conclusion to the executor and get a diff back for the group to review.

[Docs →](docs/features/chats/context.md)

</td>
<td width="50%">
  <a href="docs/features/chats/context.md"><img src="docs/assets/features/summary.gif" alt="Asking one agent to summarize the discussion" width="100%" /></a>
</td>
</tr>
</table>

**Also in the box:**

- **[Executor agent](docs/features/executor/context.md)** — One writer per chat, confined to a working directory, with file, search, shell and git tools. Every side-effecting call passes a permission prompt, and the finished turn posts its diffs back.
- **[Agent Skills](docs/features/skills/context.md)** — Drop a `SKILL.md` folder in, tick it on an agent, and the agent pulls the full text with `read_skill` only when it needs it.
- **[Memory](docs/features/memory/context.md)** — Per-agent markdown notes behind a `MEMORY.md` index, written by the agent with `memory_save` and editable by hand.
- **[Open in your editor](docs/features/editor/context.md)** — Click any `path:line`, diff header or file tool card to jump there in VS Code, Cursor or a custom command.
- **[Token and cost read-outs](docs/features/chats/context.md)** — Per member and per chat, from a built-in price and context-window table.
- **[Bilingual UI](docs/features/i18n/context.md)** — English and Simplified Chinese, switchable without a restart. The briefing the models receive follows the UI language.
- **[Dark and light](docs/features/ui-shell/context.md)** — Both palettes, or follow the system.
- **Local first** — One SQLite file in the app's data directory. No account, no telemetry; the only network traffic is the model calls you configured and the update check.

---

## Supported Providers

Works with **any OpenAI-compatible endpoint** — if it speaks `/chat/completions`, it can sit at the table.

<p>
  <a href="https://www.anthropic.com"><kbd><img src="https://www.google.com/s2/favicons?domain=anthropic.com&sz=64" alt="Anthropic logo" width="16" valign="middle" /> Anthropic</kbd></a> &nbsp;
  <a href="https://platform.openai.com"><kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" alt="OpenAI logo" width="16" valign="middle" /> OpenAI</kbd></a> &nbsp;
  <a href="https://ai.google.dev"><kbd><img src="https://www.google.com/s2/favicons?domain=ai.google.dev&sz=64" alt="Google logo" width="16" valign="middle" /> Google</kbd></a> &nbsp;
  <a href="https://www.deepseek.com"><kbd><img src="https://www.google.com/s2/favicons?domain=deepseek.com&sz=64" alt="DeepSeek logo" width="16" valign="middle" /> DeepSeek</kbd></a> &nbsp;
  <a href="https://bailian.console.aliyun.com"><kbd><img src="https://www.google.com/s2/favicons?domain=qwen.ai&sz=64" alt="Qwen logo" width="16" valign="middle" /> Qwen</kbd></a> &nbsp;
  <a href="https://open.bigmodel.cn"><kbd><img src="https://www.google.com/s2/favicons?domain=bigmodel.cn&sz=64" alt="Zhipu GLM logo" width="16" valign="middle" /> Zhipu GLM</kbd></a> &nbsp;
  <a href="https://platform.moonshot.cn"><kbd><img src="https://www.google.com/s2/favicons?domain=moonshot.cn&sz=64" alt="Moonshot logo" width="16" valign="middle" /> Moonshot</kbd></a> &nbsp;
  <a href="https://www.minimax.io"><kbd><img src="https://www.google.com/s2/favicons?domain=minimax.io&sz=64" alt="MiniMax logo" width="16" valign="middle" /> MiniMax</kbd></a> &nbsp;
  <a href="https://www.volcengine.com/product/ark"><kbd><img src="https://www.google.com/s2/favicons?domain=volcengine.com&sz=64" alt="Volcengine logo" width="16" valign="middle" /> Volcengine Ark</kbd></a> &nbsp;
  <a href="https://siliconflow.cn"><kbd><img src="https://www.google.com/s2/favicons?domain=siliconflow.cn&sz=64" alt="SiliconFlow logo" width="16" valign="middle" /> SiliconFlow</kbd></a> &nbsp;
  <a href="https://openrouter.ai"><kbd><img src="https://www.google.com/s2/favicons?domain=openrouter.ai&sz=64" alt="OpenRouter logo" width="16" valign="middle" /> OpenRouter</kbd></a> &nbsp;
  <a href="https://ollama.com"><kbd><img src="https://www.google.com/s2/favicons?domain=ollama.com&sz=64" alt="Ollama logo" width="16" valign="middle" /> Ollama</kbd></a> &nbsp;
  <a href="https://lmstudio.ai"><kbd><img src="https://www.google.com/s2/favicons?domain=lmstudio.ai&sz=64" alt="LM Studio logo" width="16" valign="middle" /> LM Studio</kbd></a> &nbsp;
  <kbd>+ any OpenAI-compatible endpoint</kbd>
</p>

---

## Install

### Desktop — macOS

- **[Download the latest release](https://github.com/witena/witensele/releases/latest)** — one dmg for Apple silicon, one for Intel. Released builds are signed with a Developer ID and notarized, so they open on a double-click.
- Apple silicon is what Witena is developed and tested on. The Intel dmg is built from the same source but has not been run on Intel hardware.

_Or build it from source:_

```bash
git clone https://github.com/witena/witensele.git
cd witensele
npm install        # rebuilds better-sqlite3 for Electron
npm run dist       # → dist/Witena-<version>-{arm64,x64}.dmg
```

A dmg you build yourself is unsigned, so macOS refuses its first launch. Right-click `Witena.app` → **Open** and confirm once, or clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/Witena.app
```

### Server — Node

The same backend runs without Electron: every method over `POST /api/<method>`, the event bus over a WebSocket, SQLite or Postgres underneath. There is no web client yet — see the [server docs](docs/features/server/context.md).

```bash
npm run server
```

---

## How It Works

- **The message stream is the source of truth.** No agent holds a long-lived conversation. Before every turn it rebuilds its own view from the shared transcript, with the other members' messages prefixed `[Name]:`.
- **A round is the unit of scheduling.** A user message starts round 1 with the speakers the chat's mode selects. The round ends only when every speaker is done, passed, skipped or errored; the `@mentions` in the finished replies pick the next round's speakers.
- **A supervisor ticks once a second** over every active turn, driving the presence dots and enforcing the stall and hard timeouts.

Further reading: [`docs/PLAN.md`](docs/PLAN.md) for the target architecture, [`docs/STEPS.md`](docs/STEPS.md) for the ordered build log, and [`docs/README.md`](docs/README.md) for the per-feature documentation index.

---

## Developing

Requirements: macOS and Node 24. [Ollama](https://ollama.com) is optional for the app and required for the end-to-end suite.

```bash
npm install
npm run dev          # Vite dev server + Electron with HMR
npm run typecheck
npm test             # vitest
npm run e2e          # Playwright driving the real Electron build (needs Ollama)
```

Every push and pull request runs typecheck, the unit tests and a build on a macOS runner. A `v*` tag builds both dmgs and uploads them to a draft GitHub Release — see [`docs/features/packaging/implement.md`](docs/features/packaging/implement.md).

The media on this page is filmed from the real app: `npm run demo` drives a scripted tour against local Ollama models, and `node scripts/render-demo.mjs` turns the frames into the MP4 and the GIFs.

## License

Witena is free and open source under the [MIT License](LICENSE).
