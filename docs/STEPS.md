# Witena 分步执行清单

`PLAN.md` 是最终目标形态,本文件把它拆成可以一步步执行、一步步检验的小步。每一步的规则:

- 做完必须满足"验收"里的每一条才算完成,然后更新对应子功能的四份文档、跑 `npm test`、提交一次 commit。
- 状态标记:`[ ]` 未开始、`[~]` 进行中、`[x]` 完成(附完成日期)。
- 只按顺序做,不跳步;某步发现方案要改,先改 `PLAN.md` 再继续。

---

## 阶段 0:准备

### S0.1 项目骨架 `[ ]`
做什么:package.json、tsconfig、electron-vite 配置、Tailwind、vitest;一个空窗口。
验收:
- `npm install` 成功,better-sqlite3 针对 Electron 重编译成功
- `npm run dev` 弹出窗口,标题栏和页面显示 Witena
- `npm run typecheck` 通过
- `npm test` 跑通一个冒烟测试

### S0.2 文档骨架与项目约定 `[ ]`
做什么:`docs/README.md` 索引、`docs/features/` 目录与四份文档模板、根目录 `CLAUDE.md` 写明约定(四份文档、测试门禁、i18n 禁止硬编码文案)。
验收:文件存在,CLAUDE.md 能被后续会话读到。

### S0.3 首次提交并推送 `[ ]`
验收:`git log` 有 commit,GitHub 仓库 main 分支能看到代码。

---

## 阶段 1:骨架(对应 PLAN 里程碑 1)

### S1.1 共享契约 `[ ]`
做什么:`src/shared/types.ts`(领域类型)、`events.ts`(带类型的事件)、`backend.ts`(BackendClient 接口)。
验收:typecheck 通过;文档 `docs/features/backend-client/` 四份写好。

### S1.2 数据库 `[ ]`
做什么:drizzle schema(providers、agents、mcp_servers、chats、chat_members、messages、settings,全部带 userId / UUID / 时间戳)、migrations、打开 `userData/witena.db`。
验收:
- 单测用临时文件库跑各表 CRUD
- `npm run dev` 后 userData 目录下出现 witena.db

### S1.3 IPC 与 BackendClient 的 Electron 实现 `[ ]`
做什么:preload 暴露 `invoke` 与 `subscribe`;renderer 的 `lib/backend.ts` 实现 BackendClient;主进程 handler 注册表。
验收:renderer 调 `system.ping` 返回 pong;主进程发一个测试事件,renderer 能收到。

### S1.4 i18n `[ ]`
做什么:i18next + react-i18next,`locales/zh-CN.json` 与 `en.json`,语言存 settings 表,首次跟随系统语言。
验收:
- 单测:两份语言文件 key 集合完全一致
- 设置页切换语言即时生效,重启后保持

### S1.5 UI shell `[ ]`
做什么:左侧导航栏、三个页面壳(Chats / Agents / Settings)、三栏布局、深色主题按 mockup 配色。
验收:截图与 mockup 对照,布局与配色一致;文档 `docs/features/ui-shell/`。

### S1.6 Providers `[ ]`
做什么:`shared/presets.ts` 预设;设置页增删改 provider;SecretStore(safeStorage)加密 key;拉取 `/models`;测试连接;`providers/registry.ts` 创建模型实例。
验收:
- 添加 Ollama(本地)和一个 OpenAI 兼容预设,能拉到模型列表,测试连接显示成功
- key 在 DB 里是密文
- 单测:预设表完整、registry 对四种 type 都能构造实例

### S1.7 单 agent 对话跑通 `[ ]`
做什么:chats CRUD 与左栏列表;最简 ChatRunner(只有一个 agent);AgentTurn 用 streamText 流式;消息落库;输入框与停止按钮。
验收:
- 新建 chat,发消息,看到逐字流式回复
- 停止按钮能中断
- 重启应用后消息还在
- 集成测试:用 mock 模型跑一次完整的发送、流式、落库

---

## 阶段 2:多 agent(对应 PLAN 里程碑 2)

### S2.1 Agents CRUD 与配置页 `[ ]`
做什么:agents 表 CRUD;配置页的基本信息、provider 与模型下拉、参数、system prompt;列表页。
验收:建 3 个挂不同 provider 的 agent,重启后还在;单测 CRUD。

### S2.2 群成员与群设置 `[ ]`
做什么:chat_members 增删与排序;右栏成员面板;群设置(模式、依次 / 并行、最大轮数、超时)。
验收:能把 agent 拉进群、移出、拖拽排序;群设置持久化。

### S2.3 编排引擎 `[ ]`
做什么:ChatRunner 完整版:roundrobin / mention-only、sequential / parallel、@解析、PASS、maxAutoRounds、屏障、停止;历史转换(署名前缀、角色映射、连续合并)。
验收:
- 单测:@解析、下一轮发言者计算、历史转换、屏障等齐
- mock 模型集成测试:两种模式跑完整多轮
- 真实模型:3 个 agent,依次模式下后者引用前者;并行模式同时输出;@ 触发第二轮;到上限停止

### S2.4 Presence 与心跳 `[ ]`
做什么:AgentSession、AgentSupervisor 每秒 tick、stall / hard 超时、跳过并插入系统消息、provider 探活;圆点显示在成员列表和消息头像。
验收:
- 单测:状态机四种状态的转换
- 集成测试:mock 一个卡住的 agent,30s 变橙、120s 变灰并被跳过,轮次继续
- UI 上圆点实时变色

### S2.5 消息渲染与输入打磨 `[ ]`
做什么:markdown 与代码高亮、思考折叠、工具卡片、轮次与"回应 @谁"标签、PASS 弱化、@ 自动补全、Enter / Shift+Enter。
验收:与 mockup 对照。

---

## 阶段 3:能力(对应 PLAN 里程碑 3)

### S3.1 MCP `[ ]`
做什么:设置页 MCP servers(stdio / http、测试连接);MCPManager 懒连接与工具发现;agent 绑定 servers;工具调用与结果卡片。
验收:注册 `@modelcontextprotocol/server-everything`,agent 能列出并调用工具;单测工具 schema 转换。

### S3.2 Skills `[ ]`
做什么:扫描 `userData/skills`;导入文件夹;agent 勾选;system prompt 注入 name / description;`read_skill`、`read_skill_file` 工具。
验收:放一个示例 SKILL.md,agent 需要时读到全文;单测 frontmatter 解析。

### S3.3 Memory `[ ]`
做什么:`userData/memory/<agentId>/MEMORY.md` 与 notes;`memory_save`、`memory_search` 工具;配置页查看与编辑。
验收:chat A 记住一个事实,chat B 能回忆;单测索引读写。

---

## 阶段 4:打磨(对应 PLAN 里程碑 4)

### S4.1 用量与费用 `[ ]`
验收:每条消息、每个成员、每个 chat 的 token 统计正确;顶部显示。

### S4.2 上下文截断 `[ ]`
验收:单测超长历史被从最早开始丢弃且保留 system。

### S4.3 自动标题与搜索 `[ ]`
验收:第一条消息后自动起标题;左栏搜索能过滤。

### S4.4 打包 `[ ]`
验收:electron-builder 产出 mac dmg,安装后能启动并完成一次对话。

---

## 阶段 5:后续(MVP 之后,见 PLAN 第"后续扩展"节)

连接器市场、执行者 agent 与工作目录、VS Code 打开与扩展、服务端与多用户。
