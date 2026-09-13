# Witena:多 agent 群聊桌面应用 MVP 方案

## Context

用户想做一个"多 agent 群聊"软件:用户开一个 chat,把配置了不同模型、skills、MCP tools 和记忆的 agent 拉进群,让多个模型一起讨论复杂问题,用群体智慧得到更好的结果。界面参考 Claude Code 桌面版:主界面三栏(左 chats、中对话、右群成员),另有 agent 配置界面和全局设置。同时接入闭源模型(Anthropic、OpenAI、Google)、国内厂商(DeepSeek、通义、智谱等)和本地开源模型(Ollama)。

仓库 `/Users/huangjay/Documents/Witena`,远程 `git@github.com:witena/witensele.git`。本文件是项目总方案,子功能细节见 `docs/features/<feature>/`。

已确认的决策:
- 单用户桌面应用,数据存本地。MVP 不做服务端和账号,但架构必须预留:后续可以加服务端与多用户(见"预留服务端能力")。
- TypeScript 全栈,Electron 打包,agent 运行时用 Vercel AI SDK。
- 默认编排:用户发言触发一轮全员回复,agent 之间用 @提及 追问,设最大自动轮数。同一轮内"依次发言"和"并行发言"两种都做,群设置里切换。
- 纯对话,不内建文件/命令/git 工具,能力全靠 MCP 外挂。
- 首批 provider:Anthropic、OpenAI、Google、Ollama、通用 OpenAI 兼容接口,并带 DeepSeek、通义、智谱、Moonshot、OpenRouter 等预设。

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面壳 | Electron + electron-vite | 主进程跑 Node,AI SDK、MCP stdio 子进程、SQLite 都在主进程 |
| 前端 | React + TypeScript + Tailwind + shadcn/ui + zustand | 仿 Claude Code 桌面版的深浅色三栏布局 |
| 模型接入 | `ai` + `@ai-sdk/anthropic` `@ai-sdk/openai` `@ai-sdk/google` `@ai-sdk/openai-compatible` | 国内厂商、Ollama、OpenRouter 全部走 openai-compatible 加预设 base URL |
| MCP | `@modelcontextprotocol/sdk` 官方 client | stdio 与 Streamable HTTP 两种 transport;工具用 AI SDK 的 `jsonSchema()` 包成 tool |
| 存储 | better-sqlite3 + drizzle-orm | 库文件放 `app.getPath('userData')/witena.db` |
| 密钥 | Electron `safeStorage` | API key 加密后存 DB |
| 渲染 | react-markdown + shiki,react-virtuoso 虚拟列表 | |
| 测试 | vitest | 编排逻辑、上下文转换、@解析做单测 |

## 目录结构

```
src/
  main/
    index.ts              # Electron 入口、窗口
    ipc/                  # 每个领域一个 handler 文件,统一注册
    db/                   # drizzle schema + migrations
    providers/            # provider 注册表、预设、创建 LanguageModel 实例
    orchestration/        # ChatRunner:轮次调度、@解析、PASS、取消
    agents/               # AgentTurn:拼 system prompt、历史转换、streamText
    mcp/                  # MCPManager:连接池、工具发现、执行
    skills/               # SKILL.md 扫描与解析
    memory/               # 每个 agent 的 markdown 记忆目录 + 内置工具
  preload/index.ts        # contextBridge,暴露类型化 api
  renderer/src/
    pages/                # ChatPage、AgentsPage、SettingsPage
    components/           # chat/、members/、agents/、settings/、ui/
    stores/               # zustand:chats、messages(流式)、agents、settings
    lib/ipc.ts            # 调用 preload api 的封装
  shared/
    types.ts              # 领域类型 + IPC 契约(main 与 renderer 共用)
    presets.ts            # provider 预设(名称、baseUrl、默认模型列表)
```

## 数据模型(SQLite)

- `providers`:id、type(anthropic | openai | google | openai-compatible)、name、baseUrl、apiKeyEncrypted、models(json)、presetId
- `agents`:id、name、avatar、description、systemPrompt、providerId、modelId、params(json:temperature、maxTokens)、skillNames(json)、mcpServerIds(json)、memoryEnabled
- `mcp_servers`:id、name、transport(stdio | http)、command、args(json)、env(json)、url、enabled
- `chats`:id、title、settings(json:mode = roundrobin | mention-only,speaking = sequential | parallel,maxAutoRounds,memberOrder)
- `chat_members`:chatId、agentId、position
- `messages`:id、chatId、senderType(user | agent | system)、senderId、parts(json:text | reasoning | tool-call | tool-result)、status(streaming | done | error | passed)、round、usage(json)、createdAt

skills 和 memory 不进 DB,放文件系统:`userData/skills/<name>/SKILL.md`、`userData/memory/<agentId>/MEMORY.md` 加 `notes/*.md`。

## 核心机制

### 编排(ChatRunner,主进程)

1. 用户发消息后开始第 1 轮。roundrobin 模式下发言者是群里全部 agent(按 memberOrder);mention-only 模式下只有被 @ 的 agent。
2. sequential:逐个执行 AgentTurn,后面的 agent 能看到前面的回复。parallel:`Promise.all` 同时执行,本轮互不可见。
3. 一轮结束后,扫描本轮 agent 消息里的 `@名字`,得到下一轮发言者(去重、排除自己)。没有 @ 或轮数达到 maxAutoRounds 就停,把控制权还给用户。
4. 每个 chat 一个 AbortController,UI 的停止按钮可以随时中断整条链。
5. agent 回复正文只有 `[PASS]` 时视为弃权,消息状态标 passed,UI 弱化显示。

### 轮次屏障与 agent 会话(保证人人看到全部回答)

- 消息流是唯一真相源。每个 agent 没有独立的长期对话对象,而是每次发言前从共享消息流重建自己的视角(历史转换见下),所以一定包含到当前为止其他所有 agent 的回答。
- 一轮的结束条件是"本轮所有发言者都 done、passed、skipped 或 error"。parallel 模式用屏障(barrier)等齐;sequential 模式天然满足。下一轮才开始,任何 agent 都不会在别人还没答完时进入下一轮。
- 每个 (chat, agent) 维护一个 `AgentSession` 运行时对象:presence 状态、lastActivityAt、当前 AbortController、本 chat 累计 usage。

### 心跳、超时与在线状态(AgentSupervisor)

主进程有一个 supervisor,每秒 tick 一次,检查所有活动的 AgentSession。状态与颜色仿 Teams:

| 状态 | 颜色 | 进入条件 |
|---|---|---|
| available | 绿 | provider 健康检查通过,当前空闲 |
| working | 红 | 正在请求模型、流式输出或执行工具;每收到一个 chunk / 工具事件就刷新 lastActivityAt |
| away | 橙 | working 中超过 `stallTimeout`(默认 30s)没有任何新活动,例如 provider 排队、工具卡住 |
| offline | 灰 | 超过 `hardTimeout`(默认 120s)仍无活动、连续 N 次请求失败、或 provider 健康检查失败(定期用 `/models` 或轻量请求探活) |

处理规则:
- away 只是提示,不打断。
- 到达 hardTimeout:abort 该 agent 的请求,消息状态标 `skipped`,群里插入一条 system 消息"X 未响应,本轮已跳过",屏障视其为完成,轮次继续。
- offline 的 agent 在后续轮次自动排除,右栏灰显;provider 探活恢复后回到 available。用户也可以手动"重试该 agent"。
- 超时阈值可在群设置和全局设置里调整;工具执行有独立的 `toolTimeout`。
- 状态变化通过 IPC 事件推给 renderer,右栏成员面板实时显示彩色圆点。

### 单个 agent 的一次发言(AgentTurn)

- system prompt 拼接顺序:agent 自己的 systemPrompt;群聊说明(群成员名单、你是谁、其他人的发言会以 `[名字]:` 前缀出现、用 `@名字` 提及别人、没有新观点就回 `[PASS]`);已启用 skills 的 name 和 description 列表;记忆索引 MEMORY.md 全文。
- 历史转换:用户消息和其他 agent 的消息变成 user 角色并加 `[名字]:` 前缀,本 agent 自己的消息保持 assistant 角色,连续的 user 角色消息合并成一条。
- tools:该 agent 挂的所有 MCP server 的工具,加内置的 `read_skill`、`read_skill_file`,memory 开启时再加 `memory_save`、`memory_search`。
- 用 `streamText` 加 `stopWhen: stepCountIs(n)` 跑工具循环,增量通过 `webContents.send` 推给 renderer,结束后把 parts 和 usage 落库。
- 上下文超长:MVP 用字符数估算 token,从最早的消息开始丢,保留 system。后续再做摘要压缩。

### Provider 层

`providers/registry.ts` 根据 provider 记录创建 AI SDK 的 model 实例。`shared/presets.ts` 里放预设:DeepSeek、通义(dashscope compatible-mode)、智谱、Moonshot、MiniMax、火山方舟、SiliconFlow、OpenRouter、Ollama(localhost:11434/v1)、LM Studio。设置页里"添加 provider"时先选预设,自动填 baseUrl 和默认模型,也支持点"拉取模型列表"调 `/models`。

### MCP(MCPManager)

按 server id 缓存 client,首次用到时懒连接,拉取 `listTools` 并转成 AI SDK tool。执行结果转成文本或 JSON 返回。MVP 工具调用自动放行,UI 展示工具卡片;权限确认放到后续版本。

### Skills

扫描 `userData/skills/*/SKILL.md`,用 gray-matter 解析 frontmatter。渐进披露:system prompt 只放 name 和 description,agent 需要时通过 `read_skill` 工具拿全文,`read_skill_file` 读附带的资源文件。设置页支持"导入 skill 文件夹"。

### Memory

Claude Code 式:`MEMORY.md` 是索引,`notes/` 下一条一个文件。`memory_save(title, content)` 写文件并追加索引行,`memory_search(query)` 做文本搜索。agent 配置页可以查看和手动编辑记忆。

## 界面

- **侧边导航**:Chats、Agents、Settings 三个入口,风格参考 Claude Code 桌面版。
- **主界面**:左栏 chat 列表(新建、重命名、删除、搜索);中栏消息流(头像、名字、模型标签、可折叠的思考与工具调用、流式光标、passed 消息弱化)和输入框(`@` 自动补全成员、Enter 发送、Shift+Enter 换行、运行中显示停止按钮);右栏成员面板(每个 agent 的状态 idle / thinking / streaming、本 chat 的 token 用量;从 agent 库添加或移除成员;群设置:模式、依次或并行、最大自动轮数、发言顺序拖拽)。
- **Agent 配置页**:左侧 agent 列表,右侧表单:基本信息、provider 与模型下拉、参数、system prompt、skills 多选、MCP servers 多选、memory 开关与记忆查看。
- **设置页**:providers(预设选择、key、模型列表)、MCP servers(stdio 命令或 HTTP URL、测试连接)、skills(列表、导入)、超时与心跳、外观与语言、数据与备份。
- **在线状态点**:右栏成员列表和中栏每条消息的头像右下角都显示 presence 圆点(绿 / 红 / 橙 / 灰),颜色来自 AgentSupervisor 推送的事件,消息里的点反映该 agent 当前状态而不是发消息时的状态。
- **界面 mockup**:https://claude.ai/code/artifact/6730ad03-5843-4e6a-8adb-7b70bfa3405e(三个画板:群聊主界面、Agent 配置、设置),实现时以它为视觉基准。

## 双语界面(i18n)

- 用 `i18next` + `react-i18next`,语言文件放 `src/renderer/src/locales/zh-CN.json` 和 `en.json`,所有界面文案通过 `t('key')` 取,禁止在组件里写死中英文。
- 设置页"外观与语言"里切换,也在设置导航左下角放一个快捷切换;切换即时生效不用重启,选择持久化到 settings 表,首次启动跟随系统语言。
- 主进程产生的用户可见文案(系统消息如"X 未响应,本轮已跳过"、错误提示)不直接写字符串,而是发 message key 加参数,由 renderer 翻译。
- 注入给模型的群聊说明也提供中英两版,按界面语言选择,便于英文模型理解。
- 测试:一个单测检查两个语言文件 key 集合一致,避免漏翻。

## 后续扩展:执行者与外部系统(不在 MVP,但现在预留接口)

讨论的产出最终要落地到代码、文档、邮件,分三层接入:

1. **连接器 = MCP servers**。git、GitHub、文件系统、Gmail、Google Drive、Notion、Slack、Word(通过 Microsoft Graph)等都已有 MCP server,MVP 的 MCP 机制天然覆盖。后续在设置页加"连接器市场":带预设命令和说明的常用 server 一键添加,并区分"只读"和"会产生副作用"的工具。
2. **执行者 agent(Executor)**。一种特殊角色的 agent,绑定 chat 的本地工作目录,拥有读写文件、执行命令、git 操作的内置工具,并有权限确认 UI(每次写文件或跑命令前弹确认,可"本次 chat 内始终允许")。工作流是"讨论 → 用户点'交给执行者' → 执行者按群里的结论实施 → 把 diff 摘要发回群里 → 其他 agent 评审 → 再改"。执行者的实现两条路:自己用 AI SDK 写工具循环,或直接接 Claude Agent SDK / Codex CLI / Aider 这类现成编码 agent 作为后端,先做前者,后者作为可选 provider。
3. **编辑器集成**。第一步是从消息里的文件路径和 diff 一键在 VS Code 打开(`code -g file:line` 或 `vscode://` 链接);第二步是做 VS Code 扩展,把聊天面板嵌进编辑器侧边栏,复用同一个后端。这正是"业务逻辑不依赖 Electron、前端只依赖 BackendClient 抽象"要预留的原因。

MVP 里为此预留的字段和接口:`chats.workdir`(可空)、`agents.role`(`participant` | `executor`)、消息 parts 里增加 `diff` 和 `file-ref` 两种类型、工具执行前的 `permission` 事件与回复通道、MCP server 记录上的 `sideEffects` 标记。

## 预留服务端能力

MVP 全部跑在本地,但按以下约束写,以后加服务端和账号时不用重构:

- renderer 只依赖一个抽象的 `BackendClient` 接口(`shared/backend.ts`):请求/响应方法加一个事件订阅通道。MVP 的实现走 Electron IPC;以后换成 HTTP + WebSocket 实现即可,页面代码不动。
- 所有表都有 `userId`(MVP 固定为本地用户 `local`)、UUID 主键、`createdAt` / `updatedAt`。消息带 `senderType` / `senderId`,已经能表达多个真人。
- 流式输出、状态变化、presence 变化全部定义成带类型的事件(`shared/events.ts`),而不是散落的 IPC 通道,以后能原样通过 WebSocket 转发。
- 主进程里的业务逻辑(ChatRunner、AgentTurn、MCPManager、memory)不 import 任何 Electron API,只依赖注入的存储与事件总线,以后可以整块搬到 Node 服务端。
- API key 的读写走一个 `SecretStore` 接口,MVP 用 Electron `safeStorage`,服务端版本换成后端密钥管理。

## 测试门禁

交付任何子功能之前,先过自己写的测试;测试不过不算完成。

- 单元测试(vitest):@提及解析、下一轮发言者计算、历史转换的角色与前缀、上下文截断、presence 状态机、屏障等齐逻辑、skills frontmatter 解析、memory 索引读写。
- 集成测试(vitest,用 AI SDK 的 `MockLanguageModelV2` 模拟模型):sequential 与 parallel 两种模式跑完整轮次;模拟一个 agent 卡住触发 away 到 offline 再被跳过;模拟工具调用往返;模拟 provider 报错。
- 端到端(Playwright for Electron):启动应用、添加 provider、建 agent、发消息、看到多 agent 回复、成员面板状态变色。
- 每个子功能的 `implement.md` 里列出对应的测试文件;`npm test` 一条命令跑全部,CI 后续接 GitHub Actions。

## 文档约定(每个子功能必须配套)

每个子功能在 `docs/features/<feature>/` 下维护四份文档,和代码同一个 commit 更新,后续改子功能时先读这四份再动手:

| 文件 | 内容 |
|---|---|
| `context.md` | 这个子功能解决什么问题、边界在哪、依赖哪些其他子功能、已确认的决策和取舍 |
| `implement.md` | 整体实现思路、数据流(用户操作 → renderer → IPC → main → 落库/模型)、关键类型与 IPC 契约、已知限制与 TODO |
| `frontend.md` | 涉及的页面与组件文件、zustand store 字段、调用了哪些 IPC、交互状态(loading / streaming / error) |
| `backend.md` | 主进程里的模块与文件、DB 表与字段、IPC handler 列表、外部依赖(AI SDK / MCP SDK)的用法与坑 |

子功能划分(与目录结构对应):`providers`、`agents`、`chats`、`orchestration`、`agent-turn`、`presence`(心跳、超时、在线状态)、`mcp`、`skills`、`memory`、`backend-client`(IPC 抽象与事件)、`ui-shell`(布局与导航)。另在 `docs/README.md` 放一份索引,列出所有子功能及其四份文档的链接。

## 里程碑

1. **骨架**:electron-vite 脚手架、DB 与 migrations、i18n 框架与语言切换、三栏布局、providers 设置页、单 agent 流式对话跑通。
2. **多 agent**:agent 配置页、成员面板、ChatRunner 的 roundrobin 与 mention-only、sequential 与 parallel、@解析、PASS、maxAutoRounds、停止、AgentSupervisor 心跳与 presence 圆点。
3. **能力**:MCP servers 设置与工具调用、skills 加载与 read_skill、memory 工具与查看编辑。
4. **打磨**:用量统计、上下文截断、自动起标题、electron-builder 打包 mac 版。
5. **后续**(MVP 之后):连接器市场、执行者 agent 与工作目录、VS Code 打开与扩展、服务端与多用户。

## 验证

- `npm run dev` 启动,在设置页添加至少两个 provider(例如 Anthropic 和 DeepSeek 预设)并拉取模型列表。
- 建 3 个 agent 挂不同 provider,拉进同一个 chat,发一个问题:sequential 下依次回复且后者引用前者观点;切 parallel 后同时流式输出;agent 回复里 @ 另一个 agent 能触发第二轮;达到 maxAutoRounds 后停止;停止按钮能中断。
- MCP:用 `npx -y @modelcontextprotocol/server-everything` 注册一个 stdio server,agent 能列出并调用其工具,UI 显示工具卡片。
- Skills:放一个示例 SKILL.md,agent 在需要时调用 read_skill 读到全文。
- Memory:在 chat A 让 agent 记住一个事实,新开 chat B 询问能回忆起来,且 `userData/memory/<agentId>/` 下有文件。
- vitest 覆盖:@解析、下一轮发言者计算、历史转换的角色与前缀、上下文截断。
